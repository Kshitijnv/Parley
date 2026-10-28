// RequestGate (architecture.md revision 2 §5, revision 4 A1–A3): the only place that
// decides whether a live-answer model call happens, for auto, Answer, Chat and
// Screenshot. It owns dedupe, cooldowns, caps, the one-slot queue (which merges fresh
// questions instead of dropping them) and supersede. Every detected question ends in
// exactly one recorded outcome (`candidate_end`). It never builds prompts or calls a
// provider: an accepted request goes to the AnswerEngine.
import { DEFAULT_AUTO_POLICY } from '@shared/catalog'
import type { AnswerTiming, AnswerTrigger, AutoPolicy, GateReason, GateStatus, GenerateResult } from '@shared/types'
import { all, get } from '../db/client'
import { getSettings, requireSession, type SessionDb } from '../db/repo'
import { emit } from '../events'
import { AppError } from '../errors'
import { currentTurn, liveMaterial, liveSessionId, onCandidate, noteAnswered } from '../live'
import { isShortQuestion, keySimilarity, questionKey, type Candidate } from '../live/turns'
import { log } from '../log'
import { beginAnswer, cancelAnswer, onAnswerEnd, onFirstToken, type EndInfo } from './engine'
import { healthOf, onHealthChange, takeExhaustedManualTry, toEpoch } from './health'
import { fallbackForBlocked, usableFallback } from './routing'
import { isVisionModel, providerLabel } from './providers'
import { modelLabel, providerOf } from '@shared/catalog'

const providerName = (modelId: string) => providerLabel(providerOf(modelId))

interface InFlight {
  answerId: string
  turnId: string | null
  questionKey: string | null
  trigger: AnswerTrigger
  startedAt: number
  candidate: Candidate | null
  /** The cursor before this request consumed the transcript; restored if it fails. */
  prevCursor: Cursor
}

interface Recent {
  answerId: string
  turnId: string | null
  questionKey: string | null
  trigger: AnswerTrigger
  text?: string
  at: number
}

interface Cursor {
  seq: number
  partialUtt: number | null
  partialWords: number
}

/** A queued candidate, possibly standing for several merged questions (revision 4 A3). */
interface Member {
  candidateId: string
  turnId: string
  questionKey: string
  detectedAt: number
}

interface Queued extends Candidate {
  /** Every question this request answers, oldest first; the last one is the candidate itself. */
  members: Member[]
  queuedAt: number
}

const memberOf = (c: Candidate): Member => ({ candidateId: c.candidateId, turnId: c.turnId, questionKey: c.questionKey, detectedAt: c.detectedAt })

const WAITING_AFTER_MS = 3000

interface SessionGate {
  sessionId: string
  inFlight: InFlight | null
  queued: Queued | null
  /** Candidates that already have their terminal record. */
  ended: Set<string>
  waiting?: GateStatus['waiting']
  waitTimer: ReturnType<typeof setTimeout> | null
  autoStarts: number[]
  autoCount: number
  recent: Recent[]
  cursor: Cursor
  clientIds: Map<string, { answerId: string; at: number }>
  lastManual: { at: number; answerId: string } | null
  lastNoMaterial: { at: number; answerId: string } | null
  budgetPaused: boolean
  counts: GateStatus['counts']
  last?: GateStatus['last']
  timer: ReturnType<typeof setTimeout> | null
}

const gates = new Map<string, SessionGate>()
const mono = () => performance.now()
const CLIENT_ID_TTL = 60_000

export function policy(): AutoPolicy {
  try {
    return { ...DEFAULT_AUTO_POLICY, ...getSettings().autoPolicy }
  } catch {
    return DEFAULT_AUTO_POLICY
  }
}

const words = (t: string) => t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length

function modelFor(s: SessionDb, trigger: AnswerTrigger): string {
  return trigger === 'screenshot' ? getSettings().visionModel : s.model
}

/** Rebuilt from answers rows when a session goes live (rejoin keeps dedupe and counts). */
export function openGate(sessionId: string) {
  const t = mono()
  const nowEpoch = Date.now()
  const rows = all<{ id: string; turn_id: string | null; question_key: string | null; trigger: AnswerTrigger; user_prompt: string | null; created_at: number }>(
    `select id, turn_id, question_key, trigger, user_prompt, created_at from answers where session_id = ? and status in ('done','streaming','cancelled') order by seq desc limit 20`,
    sessionId,
  )
  const autoCount = Number(get<{ n: number }>(`select count(*) as n from answers where session_id = ? and trigger = 'auto'`, sessionId)?.n ?? 0)
  const latestSeq = Number(get<{ s: number | null }>('select max(seq) as s from transcript_segments where session_id = ?', sessionId)?.s ?? -1)
  const g: SessionGate = {
    sessionId,
    inFlight: null,
    queued: null,
    ended: new Set(),
    waitTimer: null,
    autoStarts: [],
    autoCount,
    recent: rows.reverse().map((r) => ({ answerId: r.id, turnId: r.turn_id, questionKey: r.question_key, trigger: r.trigger, text: r.user_prompt ?? undefined, at: t - (nowEpoch - Number(r.created_at)) })),
    cursor: { seq: latestSeq, partialUtt: null, partialWords: 0 },
    clientIds: new Map(),
    lastManual: null,
    lastNoMaterial: null,
    budgetPaused: false,
    counts: { auto: 0, manual: 0, suppressed: 0, merged: 0, replaced: 0, stale: 0 },
    timer: null,
  }
  const old = gates.get(sessionId)
  if (old?.timer) clearTimeout(old.timer)
  if (old?.waitTimer) clearTimeout(old.waitTimer)
  gates.set(sessionId, g)
  publish(g)
}

export function closeGate(sessionId: string) {
  const g = gates.get(sessionId)
  if (g?.timer) clearTimeout(g.timer)
  if (g?.waitTimer) clearTimeout(g.waitTimer)
  // A question still waiting when the call ends is recorded, not forgotten.
  if (g?.queued) endAll(g, g.queued, 'dropped', 'session_end')
  gates.delete(sessionId)
}

export function gateStatus(sessionId: string): GateStatus | null {
  const g = gates.get(sessionId)
  return g ? statusOf(g) : null
}

function statusOf(g: SessionGate): GateStatus {
  let s: SessionDb | null = null
  try {
    s = requireSession(g.sessionId)
  } catch {
    // session deleted
  }
  const h = s ? healthOf(s.model) : { state: 'ok' as const }
  // A rejected key pauses auto as its own state, unless the opt-in fallback serves (A1).
  const viaFallback = !!s && (h.state === 'auth_failed' || h.state === 'cooling') && !!fallbackForBlocked(s.model, 'auto')
  const auto: GateStatus['auto'] = !s?.autoGenerate
    ? 'off'
    : g.budgetPaused
      ? 'paused_budget'
      : h.state === 'exhausted'
        ? 'paused_quota'
        : h.state === 'auth_failed' && !viaFallback
          ? 'paused_auth'
          : h.state === 'offline'
          ? 'paused_offline'
          : g.queued
            ? 'queued'
            : h.state === 'cooling' || (g.autoStarts.length > 0 && mono() - g.autoStarts.at(-1)! < policy().autoCooldownMs)
              ? 'cooldown'
              : 'on'
  return { sessionId: g.sessionId, auto, route: viaFallback ? 'fallback' : 'primary', provider: h.state, retryAt: 'retryAt' in h ? h.retryAt : undefined, counts: { ...g.counts }, last: g.last, waiting: g.waiting }
}

function publish(g: SessionGate) {
  emit('gate:status', statusOf(g))
}

onHealthChange(() => gates.forEach(publish))

function record(g: SessionGate, trigger: AnswerTrigger, r: GenerateResult): GenerateResult {
  if (r.outcome === 'suppressed') g.counts.suppressed++
  g.last = { outcome: r.outcome, reason: r.reason, at: Date.now() }
  log('gate_decision', { sessionId: g.sessionId, trigger, outcome: r.outcome, reason: r.reason, answerId: r.answerId })
  publish(g)
  return r
}

/** The terminal record of a detected question (revision 4 A3). Logged once per candidate, no text. */
function endCandidate(g: SessionGate, c: Member, outcome: 'accepted' | 'merged' | 'replaced' | 'suppressed' | 'dropped', reason?: GateReason, into?: string) {
  if (g.ended.has(c.candidateId)) return
  g.ended.add(c.candidateId)
  if (g.ended.size > 500) g.ended = new Set([...g.ended].slice(-200))
  if (outcome === 'merged') g.counts.merged++
  if (outcome === 'replaced') g.counts.replaced++
  if (reason === 'stale') g.counts.stale++
  log('candidate_end', { sessionId: g.sessionId, candidateId: c.candidateId, turnId: c.turnId, outcome, reason, into, waitMs: Math.round(mono() - c.detectedAt) })
}

/**
 * End a candidate and every question merged into it. Merged questions stay open until
 * the request that carries them is decided: accepted → `merged` into it; otherwise the
 * same outcome and reason as the request.
 */
function endAll(g: SessionGate, c: Candidate, outcome: 'accepted' | 'suppressed' | 'dropped', reason?: GateReason) {
  const members = 'members' in c ? (c as Queued).members : []
  for (const m of members) if (m.candidateId !== c.candidateId) endCandidate(g, m, outcome === 'accepted' ? 'merged' : outcome, outcome === 'accepted' ? 'merged' : reason, c.candidateId)
  endCandidate(g, memberOf(c), outcome, reason)
}

/** The latest key an answer used: a short question is new only if it differs from this. */
function lastAnsweredKey(g: SessionGate): string | null {
  return [...g.recent].reverse().find((r) => r.questionKey)?.questionKey ?? null
}

/** New "them" material since the cursor (§5): finals' content words, or an unused partial. */
function newMaterial(g: SessionGate, sessionId: string): { finalsWords: number; partialWords: number; enough: boolean; latestSeq: number; partial: { utteranceId: number; text: string } | null } {
  const m = liveMaterial(sessionId)
  const p = policy()
  const finalsWords = m.themFinals.filter((f) => f.seq > g.cursor.seq).reduce((n, f) => n + words(f.text), 0)
  const pw = m.themPartial ? words(m.themPartial.text) : 0
  const partialWords = m.themPartial ? (m.themPartial.utteranceId === g.cursor.partialUtt ? Math.max(0, pw - g.cursor.partialWords) : pw) : 0
  let enough = finalsWords >= p.minWords || (partialWords >= p.minWords && pw >= p.minWords)
  if (!enough && finalsWords + partialWords > 0) {
    // Revision 4 A2: a new short question ("What is polymorphism?") is new material too,
    // unless it's the question the last answer already covered.
    const fresh = [...m.themFinals.filter((f) => f.seq > g.cursor.seq).map((f) => f.text), partialWords ? (m.themPartial?.text ?? '') : ''].join(' ').trim()
    const last = lastAnsweredKey(g)
    const recent = g.recent.length > 0 && mono() - g.recent.at(-1)!.at <= p.followupWindowMs
    if (isShortQuestion(fresh, p.shortQuestionMinWords, recent) && (!last || keySimilarity(questionKey(fresh), last) < p.similarity)) enough = true
  }
  return { finalsWords, partialWords, enough, latestSeq: m.latestSeq, partial: m.themPartial }
}

function moveCursor(g: SessionGate, sessionId: string) {
  const m = liveMaterial(sessionId)
  g.cursor = { seq: Math.max(g.cursor.seq, m.latestSeq), partialUtt: m.themPartial?.utteranceId ?? null, partialWords: m.themPartial ? words(m.themPartial.text) : 0 }
}

/** Text the manual request is about: new "them" words, else the open turn. */
function manualSubject(g: SessionGate, sessionId: string): { turnId: string | null; key: string | null; draft: string | null } {
  const m = liveMaterial(sessionId)
  const fresh = [...m.themFinals.filter((f) => f.seq > g.cursor.seq).map((f) => f.text), m.themPartial?.text ?? ''].join(' ').trim()
  const turn = currentTurn(sessionId)
  const text = fresh || turn?.text || ''
  return { turnId: turn?.turnId ?? null, key: text ? questionKey(text) : null, draft: text ? text.slice(-300) : null }
}

function accept(
  g: SessionGate,
  s: SessionDb,
  a: { trigger: AnswerTrigger; text?: string; turnId: string | null; questionKey: string | null; draft: string | null; mode: 'auto' | 'manual' | 'force'; candidate: Candidate | null; retryOf?: string; useFallback?: boolean; submittedAt?: number },
): GenerateResult {
  const t0 = mono()
  const q = a.candidate as Queued | null
  const members = q?.members ?? (a.candidate ? [memberOf(a.candidate)] : [])
  const timing: Partial<AnswerTiming> = {}
  if (a.candidate) {
    const c = a.candidate
    if (c.voicedEndAt !== undefined && c.finalAt >= c.voicedEndAt) timing.sttMs = Math.round(c.finalAt - c.voicedEndAt)
    timing.settleMs = Math.round(c.detectedAt - c.finalAt)
    timing.gateWaitMs = Math.round(t0 - c.detectedAt)
    if (q?.queuedAt !== undefined) timing.queueWaitMs = Math.round(t0 - q.queuedAt)
  } else if (a.submittedAt !== undefined) timing.pressToAcceptMs = Math.round(t0 - a.submittedAt)
  const { answerId, seq } = beginAnswer({ session: s, trigger: a.trigger, text: a.text, turnId: a.turnId, questionKey: a.questionKey, questionDraft: a.draft, excerptMode: a.mode, retryOf: a.retryOf, questions: Math.max(1, members.length), useFallback: a.useFallback, timing })
  const t = mono()
  g.inFlight = { answerId, turnId: a.turnId, questionKey: a.questionKey, trigger: a.trigger, startedAt: t, candidate: a.candidate, prevCursor: { ...g.cursor } }
  // Every merged key counts for dedupe, so a repeat of any of them is caught later.
  const keys = members.length > 1 ? members.map((m) => m.questionKey) : [a.questionKey]
  g.recent = [...g.recent, ...keys.map((k) => ({ answerId, turnId: a.turnId, questionKey: k, trigger: a.trigger, text: a.text, at: t }))].slice(-20)
  if (a.candidate) endAll(g, a.candidate, 'accepted')
  armWaiting(g, answerId, s)
  if (a.trigger !== 'chat' && a.trigger !== 'screenshot') moveCursor(g, s.id)
  if (a.trigger === 'auto') {
    g.autoStarts = [...g.autoStarts.filter((x) => t - x < 60_000), t]
    g.autoCount++
    g.counts.auto++
  } else {
    g.counts.manual++
  }
  if (a.trigger === 'answer') g.lastManual = { at: t, answerId }
  return { outcome: 'started', answerId, seq }
}

/** After 3 s with no first token, tell the user who they're waiting for (A4.1). */
function armWaiting(g: SessionGate, answerId: string, s: SessionDb) {
  if (g.waitTimer) clearTimeout(g.waitTimer)
  g.waiting = undefined
  const since = Date.now()
  const model = g.inFlight?.trigger === 'screenshot' ? getSettings().visionModel : s.model
  g.waitTimer = setTimeout(() => {
    g.waitTimer = null
    if (g.inFlight?.answerId !== answerId) return
    g.waiting = { answerId, model, since }
    publish(g)
  }, WAITING_AFTER_MS)
}

function clearWaiting(g: SessionGate, answerId: string) {
  if (g.inFlight && g.inFlight.answerId !== answerId) return
  if (g.waitTimer) clearTimeout(g.waitTimer)
  g.waitTimer = null
  if (g.waiting) {
    g.waiting = undefined
    publish(g)
  }
}

onFirstToken((e) => {
  const g = gates.get(e.sessionId)
  if (g) clearWaiting(g, e.answerId)
})

const MSG: Partial<Record<GateReason, string>> = {
  no_new_material: 'Nothing new since the last answer. Press again to regenerate it.',
  joined: 'Already answering this question.',
  duplicate: 'That question was just answered.',
}

// ---------- manual requests (Answer, Chat, Screenshot) ----------

export function submitManual(input: { sessionId: string; trigger: 'answer' | 'chat' | 'screenshot'; text?: string; force?: boolean; clientRequestId: string; retryOf?: string; useFallback?: boolean }): GenerateResult {
  const s = requireSession(input.sessionId)
  const g = gates.get(s.id)
  // 1. not live
  if (s.status !== 'live' || liveSessionId() !== s.id || !g) throw new AppError('Answers work while the call is live.', 'conflict')
  const t = mono()
  const p = policy()
  for (const [k, v] of g.clientIds) if (t - v.at > CLIENT_ID_TTL) g.clientIds.delete(k)
  // 2. repeated invoke
  const seen = g.clientIds.get(input.clientRequestId)
  if (seen) return record(g, input.trigger, { outcome: 'reused', answerId: seen.answerId })
  const remember = (r: GenerateResult) => {
    if (r.answerId) g.clientIds.set(input.clientRequestId, { answerId: r.answerId, at: t })
    return record(g, input.trigger, r)
  }

  const modelId = modelFor(s, input.trigger)
  if (input.trigger === 'screenshot' && !isVisionModel(modelId)) throw new AppError(`${modelLabel(modelId)} can't read images. Pick a vision model in Settings.`, 'validation')
  const h = healthOf(modelId)
  const fallback = usableFallback(modelId, input.trigger)
  // "Answer with <fallback>": the user chose the other model; the primary's state doesn't block it.
  const useFallback = !!input.useFallback && !!fallback
  if (input.useFallback && !fallback) return remember({ outcome: 'suppressed', reason: 'not_live', message: 'The fallback model is not available right now. Check it in Settings › Answers.' })
  // A blocked primary (rejected key, cooling) is served by the fallback when one is set (A4.3).
  const servedByFallback = useFallback || !!fallbackForBlocked(modelId, input.trigger)
  // 3a. rejected key (revision 4 A1): its own reason, never the quota one.
  if (h.state === 'auth_failed' && !servedByFallback) {
    return remember({ outcome: 'suppressed', reason: 'auth_failed', message: `${providerName(modelId)} rejected the API key. Check it in Settings, or switch model.` })
  }
  // 3b. daily quota used up: no call, except one manual try every 10 minutes. Never an
  // automatic switch: the user picks "Answer with <fallback>" (useFallback).
  if (!useFallback && h.state === 'exhausted' && !takeExhaustedManualTry(modelId)) {
    return remember({ outcome: 'suppressed', reason: 'quota_exhausted', message: `The daily limit is used up for ${modelLabel(modelId)}. Switch to a model from another provider, or try later.` })
  }
  // 4. cooling: no call, show the real retry time. `force` doesn't bypass this.
  if (!servedByFallback && h.state === 'cooling') return remember({ outcome: 'suppressed', reason: 'cooling', retryAt: h.retryAt, message: `${modelLabel(modelId)} is rate limited. Try again in ${Math.max(1, Math.ceil(((h.retryAt ?? Date.now()) - Date.now()) / 1000))} s.` })
  // 5. offline: try anyway (the network may be back).

  if (input.trigger === 'chat') {
    // 7. identical text within 3 s
    const dup = [...g.recent].reverse().find((r) => r.trigger === 'chat' && r.text === input.text && t - r.at < 3000)
    if (dup && !input.force && !input.retryOf) return remember({ outcome: 'reused', answerId: dup.answerId })
    if (g.inFlight) cancelAnswer(g.inFlight.answerId, 'superseded')
    return remember(accept(g, s, { trigger: 'chat', text: input.text, turnId: currentTurn(s.id)?.turnId ?? null, questionKey: questionKey(input.text ?? ''), draft: input.text ?? null, mode: 'manual', candidate: null, retryOf: input.retryOf, useFallback, submittedAt: t }))
  }

  if (input.trigger === 'screenshot') {
    const dup = [...g.recent].reverse().find((r) => r.trigger === 'screenshot' && t - r.at < 1500)
    if (dup && !input.force && !input.retryOf) return remember({ outcome: 'reused', answerId: dup.answerId })
    if (g.inFlight) cancelAnswer(g.inFlight.answerId, 'superseded')
    return remember(accept(g, s, { trigger: 'screenshot', turnId: null, questionKey: null, draft: null, mode: 'manual', candidate: null, retryOf: input.retryOf, useFallback, submittedAt: t }))
  }

  // Answer
  let force = !!input.force || !!input.retryOf || useFallback
  const subject = manualSubject(g, s.id)
  const mat = newMaterial(g, s.id)
  // A second press 0.3–2 s after a "nothing new" reply regenerates (§5 rule 8).
  if (!force && !mat.enough && g.lastNoMaterial && t - g.lastNoMaterial.at >= 300 && t - g.lastNoMaterial.at < 2000) force = true
  if (!force) {
    // 6. same question already streaming
    if (g.inFlight && ((subject.turnId && g.inFlight.turnId === subject.turnId && !mat.enough) || (subject.key && g.inFlight.questionKey && keySimilarity(subject.key, g.inFlight.questionKey) >= p.similarity))) {
      return remember({ outcome: 'joined', answerId: g.inFlight.answerId, reason: 'joined', message: MSG.joined })
    }
    // 7 + 8. nothing new since the last answer: reuse it.
    if (!mat.enough) {
      const latest = [...g.recent].reverse().find((r) => r.trigger !== 'chat' && r.trigger !== 'screenshot') ?? g.recent.at(-1)
      if (latest) {
        g.lastNoMaterial = { at: t, answerId: latest.answerId }
        return remember({ outcome: 'reused', answerId: latest.answerId, reason: 'no_new_material', message: MSG.no_new_material })
      }
      if (!subject.draft) return remember({ outcome: 'suppressed', reason: 'no_new_material', message: 'Nothing to answer yet. Wait for a question, or press Chat to type one.' })
    }
    // 10. duplicate click
    if (g.lastManual && t - g.lastManual.at < p.manualMinIntervalMs) return remember({ outcome: 'reused', answerId: g.lastManual.answerId, reason: 'too_soon' })
  }
  if (force && !subject.draft && !liveMaterial(s.id).themFinals.length && !liveMaterial(s.id).youFinals) {
    return remember({ outcome: 'suppressed', reason: 'no_new_material', message: 'Nothing to answer yet. Wait for a question, or press Chat to type one.' })
  }
  // 11. manual supersedes whatever is in flight (and takes over a queued candidate's turn).
  if (g.inFlight) cancelAnswer(g.inFlight.answerId, 'superseded')
  if (g.queued && (g.queued.turnId === subject.turnId || (subject.key && keySimilarity(subject.key, g.queued.questionKey) >= p.similarity))) g.queued = null
  g.lastNoMaterial = null
  return remember(accept(g, s, { trigger: 'answer', turnId: subject.turnId, questionKey: subject.key, draft: subject.draft, mode: force ? 'force' : 'manual', candidate: null, retryOf: input.retryOf, useFallback, submittedAt: t }))
}

// ---------- automatic requests ----------

function suppress(g: SessionGate, c: Candidate, reason: GateReason) {
  record(g, 'auto', { outcome: 'suppressed', reason })
  log('candidate_suppressed', { sessionId: g.sessionId, turnId: c.turnId, reason })
  endAll(g, c, 'suppressed', reason)
}

/**
 * Put a candidate in the one-slot queue (revision 4 A3). A fresh question already
 * waiting is merged into the newer one (recorded `merged`), up to maxMergedQuestions;
 * past that the oldest is `replaced`. A stale one is `suppressed(stale)`. Never a
 * silent overwrite.
 */
function queue(g: SessionGate, c: Candidate, recheckInMs?: number) {
  const p = policy()
  const t = mono()
  const old = g.queued
  let next: Queued = 'members' in c ? (c as Queued) : { ...c, members: [memberOf(c)], queuedAt: t }
  if (old && old.candidateId !== c.candidateId) {
    if (t - old.lastSpeechAt > p.staleCandidateMs) {
      endAll(g, old, 'suppressed', 'stale')
    } else {
      // The newer turn may already hold the older one's words (joined finals).
      const text = c.text.includes(old.text) ? c.text : `${old.text} ${c.text}`
      const members = [...old.members, ...next.members]
      let replaced = 0
      while (members.length > Math.max(1, p.maxMergedQuestions)) {
        endCandidate(g, members.shift()!, 'replaced', 'replaced', c.candidateId)
        replaced++
      }
      next = { ...next, text: text.length > p.maxTurnChars ? text.slice(text.length - p.maxTurnChars) : text, members, queuedAt: old.queuedAt }
      g.last = replaced ? { outcome: 'replaced', reason: 'replaced', at: Date.now(), count: replaced } : { outcome: 'merged', reason: 'merged', at: Date.now(), count: members.length }
      log('candidate_merged', { sessionId: g.sessionId, candidateId: c.candidateId, count: members.length })
    }
  }
  g.queued = next
  c = next
  if (recheckInMs !== undefined) {
    if (g.timer) clearTimeout(g.timer)
    g.timer = setTimeout(() => {
      g.timer = null
      drain(g.sessionId)
    }, Math.max(50, recheckInMs))
  }
  log('candidate_queued', { sessionId: g.sessionId, turnId: c.turnId })
  publish(g)
}

function submitAuto(c: Candidate, fromQueue = false) {
  const g = gates.get(c.sessionId)
  if (!g) return
  let s: SessionDb
  try {
    s = requireSession(c.sessionId)
  } catch {
    return
  }
  const t = mono()
  const p = policy()
  if (s.status !== 'live' || liveSessionId() !== s.id) return suppress(g, c, 'not_live')
  if (fromQueue && t - c.lastSpeechAt > p.staleCandidateMs) return suppress(g, c, 'stale')
  const h = healthOf(s.model)
  if (h.state === 'exhausted') return suppress(g, c, 'quota_exhausted')
  // A rejected key isn't a quota (A1): its own reason, or the fallback serves.
  const viaFallback = (h.state === 'auth_failed' || h.state === 'cooling') && !!fallbackForBlocked(s.model, 'auto')
  if (h.state === 'auth_failed' && !viaFallback) return suppress(g, c, 'auth_failed')
  if (h.state === 'cooling' && !viaFallback) {
    const freshAtRetry = h.retryAtMono !== undefined && h.retryAtMono - c.lastSpeechAt <= p.staleCandidateMs
    return freshAtRetry ? queue(g, c, h.retryAtMono! - t) : suppress(g, c, 'cooling')
  }
  if (h.state === 'offline') return suppress(g, c, 'offline')
  if (g.inFlight && (g.inFlight.turnId === c.turnId || (g.inFlight.questionKey && keySimilarity(c.questionKey, g.inFlight.questionKey) >= p.similarity))) return suppress(g, c, 'joined')
  // 7. similar to a recent answer (§5: by question key). A matching turnId alone is not a
  // duplicate: a turn that a manual press attached to can gain new questions afterwards;
  // with no new words since that answer, rule 8 below suppresses it.
  // A merged request is a duplicate only when every question in it is (A3).
  const keys = 'members' in c ? (c as Queued).members.map((m) => m.questionKey) : [c.questionKey]
  const isDup = (k: string) => g.recent.some((r) => t - r.at < p.dedupeWindowMs && r.questionKey && keySimilarity(k, r.questionKey) >= p.similarity)
  if (keys.every(isDup)) return suppress(g, c, 'duplicate')
  if (c.lastSeq <= g.cursor.seq) return suppress(g, c, 'no_new_material')
  if (!s.autoGenerate) return suppress(g, c, 'auto_off')
  if (g.budgetPaused || g.autoCount >= p.autoMaxPerSession) {
    g.budgetPaused = true
    return suppress(g, c, 'budget')
  }
  g.autoStarts = g.autoStarts.filter((x) => t - x < 60_000)
  if (g.autoStarts.length >= p.autoMaxPerMinute) return suppress(g, c, 'rate_cap')
  const sinceLast = g.autoStarts.length ? t - g.autoStarts.at(-1)! : Infinity
  if (sinceLast < p.autoCooldownMs) return queue(g, c, p.autoCooldownMs - sinceLast)
  // 11. auto never cancels: wait for the request in flight.
  if (g.inFlight) return queue(g, c)
  g.queued = null
  record(g, 'auto', accept(g, s, { trigger: 'auto', turnId: c.turnId, questionKey: c.questionKey, draft: c.text.slice(-300), mode: 'auto', candidate: c, useFallback: viaFallback }))
}

/** Re-check the queued candidate from rule 3 when the slot frees or a cooldown ends. */
function drain(sessionId: string) {
  const g = gates.get(sessionId)
  if (!g || !g.queued || g.inFlight) return
  const c = g.queued
  g.queued = null
  submitAuto(c, true)
}

onCandidate((c) => {
  log('candidate', { sessionId: c.sessionId, turnId: c.turnId, reason: c.kind })
  submitAuto(c)
})

onAnswerEnd((e: EndInfo) => {
  const g = gates.get(e.sessionId)
  if (!g) return
  clearWaiting(g, e.answerId)
  if (g.inFlight?.answerId === e.answerId) {
    const was = g.inFlight
    g.inFlight = null
    e.prevCursor = was.prevCursor
    if (e.status === 'done') noteAnswered(e.sessionId)
    // An auto request that hit a per-minute limit goes back in the queue if still fresh.
    if (was.trigger === 'auto' && e.endReason === 'rate_limited' && was.candidate && !g.queued) {
      const h = healthOf(requireSession(e.sessionId).model)
      if (h.retryAtMono !== undefined && h.retryAtMono - was.candidate.lastSpeechAt <= policy().staleCandidateMs) {
        // Not a duplicate of itself on the re-check.
        g.recent = g.recent.filter((r) => r.answerId !== e.answerId)
        g.cursor.seq = Math.min(g.cursor.seq, was.candidate.lastSeq - 1)
        queue(g, was.candidate, h.retryAtMono - performance.now())
        return
      }
    }
  }
  if (e.status === 'failed' && e.endReason !== 'interrupted') {
    // A request that produced nothing doesn't count as answered, and gives back the
    // transcript it consumed, so Retry and the next Answer can use it.
    g.recent = g.recent.filter((r) => r.answerId !== e.answerId)
    if (e.prevCursor) g.cursor = { ...e.prevCursor }
  }
  publish(g)
  setTimeout(() => drain(e.sessionId), 0)
})

