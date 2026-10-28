// AnswerEngine (architecture.md revision 2 §7, revision 4 A4): runs one request the
// RequestGate accepted. Inserts the row and emits answer:start, streams through the
// QUESTION/--- header split with offsets, writes the result and its stage timings. It
// applies no policy: the one live retry it may make (before the first token) follows
// the §6 table, and the opt-in fallback switch follows A4.3 (before the first token,
// at most once, same answerId, never two provider requests at the same time).
import type { ModelMessage } from 'ai'
import { leadEnd } from '@shared/answerBlocks'
import type { AnswerEndReason, AnswerTiming, AnswerTrigger, FallbackReason } from '@shared/types'
import { all, get, run, tx } from '../db/client'
import { answerFromRow, findResume, getAnswer, getSettings, now, uuid, type SessionDb } from '../db/repo'
import { changed, emit } from '../events'
import { AppError } from '../errors'
import { liveLines } from '../live'
import { log } from '../log'
import { captureScreen } from '../capture/screenshot'
import { healthOf, noteSlowSwitch, reportError, reportSuccess, stickyFallback } from './health'
import { answerSystemPrompt, chatMessage, maxTokensFor, screenshotMessage, splitReply, transcriptMessage, type AnswerContext } from './prompts'
import { ProviderError } from './provider'
import { resolveModel, type ResolvedModel } from './providers'
import { fallbackForBlocked, routing, usableFallback } from './routing'
import { describe, Stop, Watchdog } from './run'

export interface EndInfo {
  sessionId: string
  answerId: string
  status: 'done' | 'failed' | 'cancelled'
  endReason: AnswerEndReason
  prevCursor?: { seq: number; partialUtt: number | null; partialWords: number }
}

interface Flight {
  answerId: string
  sessionId: string
  seq: number
  trigger: AnswerTrigger
  ctrl: AbortController
  acc: string
  header: 'pending' | 'split' | 'none'
  answerStart: number
  question: string | null
  sentQuestion: string | null
  sentAnswer: string
  firstTokenAt: number | null
  startedAt: number
  timer: ReturnType<typeof setTimeout> | null
  /** Revision 4: the current provider attempt (1-based), questions a merged request answers, timings. */
  attempt: number
  questions: number
  timing: Partial<AnswerTiming>
  firstRequestAt: number | null
  attemptAt: number
  ttft: Array<number | null>
  firstAnswerAt: number | null
  /** Revision 5 D5: provider deltas, the gap between them, and when the lead paragraph completed. */
  chunks: number
  lastChunkAt: number | null
  maxChunkGap: number
  leadAt: number | null
}

const flights = new Map<string, Flight>()
const endHooks = new Set<(e: EndInfo) => void>()
const firstTokenHooks = new Set<(e: { sessionId: string; answerId: string }) => void>()

export function onAnswerEnd(fn: (e: EndInfo) => void) {
  endHooks.add(fn)
}

/** The first token of an answer arrived (the gate clears its waiting state). */
export function onFirstToken(fn: (e: { sessionId: string; answerId: string }) => void) {
  firstTokenHooks.add(fn)
}

const round = (n: number) => Math.round(n)

function timingOf(f: Flight): AnswerTiming {
  const t: AnswerTiming = { ...f.timing, ttftMs: f.ttft.map((x) => (x === null ? null : round(x))), attempts: f.attempt }
  if (f.firstRequestAt !== null) t.buildMs = round(f.firstRequestAt - f.startedAt)
  if (f.firstTokenAt !== null && f.firstAnswerAt !== null) t.headerMs = round(f.firstAnswerAt - f.firstTokenAt)
  if (f.firstAnswerAt !== null) t.streamMs = round(performance.now() - f.firstAnswerAt)
  if (f.chunks) {
    t.chunks = f.chunks
    t.maxChunkGapMs = round(f.maxChunkGap)
  }
  if (f.leadAt !== null && f.firstAnswerAt !== null) t.leadMs = round(f.leadAt - f.firstAnswerAt)
  return t
}

/** One numbers-only log line per finished answer (A4.1). */
function logTiming(f: Flight, t: AnswerTiming, servedModel: string | null) {
  log('answer_timing', {
    sessionId: f.sessionId,
    answerId: f.answerId,
    trigger: f.trigger,
    attempt: t.attempts,
    servedModel: servedModel ?? undefined,
    sttMs: t.sttMs,
    settleMs: t.settleMs,
    gateWaitMs: t.gateWaitMs,
    queueWaitMs: t.queueWaitMs,
    pressToAcceptMs: t.pressToAcceptMs,
    buildMs: t.buildMs,
    ttftMs: t.ttftMs.at(-1) ?? undefined,
    headerMs: t.headerMs,
    streamMs: t.streamMs,
    chunks: t.chunks,
    maxChunkGapMs: t.maxChunkGapMs,
    leadMs: t.leadMs,
  })
}

function ended(e: EndInfo) {
  endHooks.forEach((f) => f(e))
}

const WINDOW_MIN_MS = 20_000
const WINDOW_MAX_MS = 120_000
const HEADER_MAX_CHARS = 160
const HEADER_MAX_MS = 1500
const BATCH_MS = 40

// ---------- context and excerpt ----------

export function contextFor(s: SessionDb): AnswerContext {
  const resume = s.resumeId ? findResume(s.resumeId) : null
  const documents = all<{ title: string; raw_text: string }>(
    `select d.title, d.raw_text from session_documents sd join documents d on d.id = sd.document_id
     where sd.session_id = ? and d.text_status = 'ready' order by sd.created_at`,
    s.id,
  ).map((d) => ({ title: d.title, text: d.raw_text }))
  return {
    type: s.type,
    company: s.companyName,
    role: s.roleTitle,
    jobDescription: s.jobDescription,
    resumeMd: resume?.mdStatus === 'ready' ? resume.contentMd : null,
    documents,
    instructions: s.instructions,
    prefs: s.answerPrefs,
  }
}

/**
 * Lines since the last answer (at least 20 s, at most 120 s), after any Clear.
 * 'manual' adds the words still being spoken; 'auto' never sends partial text;
 * 'force' (regenerate) takes the last 120 s regardless of earlier answers.
 * There's no fallback to older lines: the gate refuses a request with nothing new.
 */
export function excerptFor(s: SessionDb, mode: 'auto' | 'manual' | 'force'): string {
  const t = now()
  const lastAnswerAt = Number(get<{ t: number | null }>(`select max(created_at) as t from answers where session_id = ? and status in ('done','streaming')`, s.id)?.t ?? 0)
  const from = mode === 'force' ? t - WINDOW_MAX_MS : Math.min(Math.max(lastAnswerAt, t - WINDOW_MAX_MS), t - WINDOW_MIN_MS)
  const since = Math.max(from, s.transcriptCursorAt ?? 0)
  const { lines, partial } = liveLines(s.id, since)
  const use = lines.length || mode !== 'force' ? lines : liveLines(s.id, s.transcriptCursorAt ?? 0).lines.slice(-6)
  const out = use.map((l) => `${l.speaker === 'you' ? 'You' : 'Them'}: ${l.text}`)
  if (mode !== 'auto') for (const p of partial) out.push(`${p.speaker === 'you' ? 'You' : 'Them'}: ${p.text}`)
  return out.join('\n')
}

function history(sessionId: string, exclude: string): ModelMessage[] {
  const rows = all<Record<string, unknown>>(`select * from answers where session_id = ? and status = 'done' and answer_md <> '' and id <> ? order by seq desc limit 3`, sessionId, exclude)
    .map(answerFromRow)
    .reverse()
  const out: ModelMessage[] = []
  for (const a of rows) {
    const asked = a.trigger === 'chat' ? chatMessage(a.userPrompt ?? '', '') : a.trigger === 'screenshot' ? '(I shared a screenshot of my screen.)' : transcriptMessage(a.transcriptExcerpt.slice(-1500))
    out.push({ role: 'user', content: asked }, { role: 'assistant', content: `QUESTION: ${a.question ?? ''}\n---\n${a.answerMd.slice(0, 2000)}` })
  }
  return out
}

// ---------- lifecycle ----------

export function beginAnswer(o: {
  session: SessionDb
  trigger: AnswerTrigger
  text?: string
  turnId: string | null
  questionKey: string | null
  questionDraft: string | null
  excerptMode: 'auto' | 'manual' | 'force'
  retryOf?: string
  /** Questions a merged request answers (revision 4 A3). */
  questions?: number
  /** The user chose "Answer with <fallback>", or the primary is blocked and the fallback serves. */
  useFallback?: boolean
  timing?: Partial<AnswerTiming>
}): { answerId: string; seq: number } {
  const s = o.session
  const modelId = o.trigger === 'screenshot' ? getSettings().visionModel : s.model
  const excerpt = o.trigger === 'chat' ? excerptFor(s, 'manual').split('\n').slice(-6).join('\n') : o.trigger === 'screenshot' ? excerptFor(s, 'manual') : excerptFor(s, o.excerptMode)
  const id = uuid()
  const t = now()
  const retryOf = o.retryOf && getAnswer(o.retryOf)?.sessionId === s.id ? o.retryOf : null
  const seq = tx(() => {
    const n = Number(get<{ n: number | null }>('select max(seq) as n from answers where session_id = ?', s.id)?.n ?? -1) + 1
    run(
      `insert into answers (id, session_id, seq, trigger, status, transcript_excerpt, user_prompt, screenshot_path, question, answer_md, model, answer_prefs, turn_id, question_key, attempts, retry_of, created_at, updated_at)
       values (?, ?, ?, ?, 'streaming', ?, ?, ?, null, '', ?, ?, ?, ?, 1, ?, ?, ?)`,
      id,
      s.id,
      n,
      o.trigger,
      excerpt,
      o.trigger === 'chat' ? (o.text ?? '') : null,
      o.trigger === 'screenshot' ? `screenshots/${id}.png` : null,
      modelId,
      JSON.stringify(s.answerPrefs),
      o.turnId,
      o.questionKey,
      retryOf,
      t,
      t,
    )
    return n
  })
  const f: Flight = {
    answerId: id,
    sessionId: s.id,
    seq,
    trigger: o.trigger,
    ctrl: new AbortController(),
    acc: '',
    header: 'pending',
    answerStart: 0,
    question: null,
    sentQuestion: null,
    sentAnswer: '',
    firstTokenAt: null,
    startedAt: performance.now(),
    timer: null,
    attempt: 1,
    questions: o.questions ?? 1,
    timing: o.timing ?? {},
    firstRequestAt: null,
    attemptAt: 0,
    ttft: [],
    firstAnswerAt: null,
    chunks: 0,
    lastChunkAt: null,
    maxChunkGap: 0,
    leadAt: null,
  }
  flights.set(id, f)
  const draft = o.trigger === 'chat' ? (o.text ?? null) : o.questionDraft
  emit('answer:start', { answerId: id, sessionId: s.id, seq, trigger: o.trigger, turnId: o.turnId, questionDraft: draft, model: modelId, createdAt: t })
  void stream(f, s, modelId, excerpt, o.trigger, o.text, !!o.useFallback)
  return { answerId: id, seq }
}

/** The answer text streamed so far (answers:get resync). */
export function liveTextOf(answerId: string): string | undefined {
  const f = flights.get(answerId)
  return f ? answerText(f) : undefined
}

function answerText(f: Flight): string {
  if (f.header === 'split') return f.acc.slice(f.answerStart)
  if (f.header === 'none') return splitReply(f.acc, true).answer
  return ''
}

function finishRow(f: Flight, status: 'failed' | 'cancelled', endReason: AnswerEndReason, message: string | null) {
  const text = answerText(f).trim()
  const q = f.question
  const timing = timingOf(f)
  run(
    `update answers set status = ?, error = ?, end_reason = ?, answer_md = case when ? <> '' then ? else answer_md end, question = coalesce(?, question), timing = ?, updated_at = ?
     where id = ? and status = 'streaming'`,
    status,
    status === 'failed' ? (message ?? 'Failed') : null,
    endReason,
    text,
    text,
    q,
    JSON.stringify(timing),
    now(),
    f.answerId,
  )
  logTiming(f, timing, null)
  return text
}

/** Stop an answer: the user pressed Stop, a newer request superseded it, or the call ended. */
export function cancelAnswer(answerId: string, reason: 'user_cancel' | 'superseded' | 'session_end' = 'user_cancel') {
  const f = flights.get(answerId)
  if (!f) return
  flights.delete(answerId)
  if (f.timer) clearTimeout(f.timer)
  f.ctrl.abort()
  const partial = finishRow(f, 'cancelled', reason, null)
  emit('answer:error', { answerId, sessionId: f.sessionId, code: 'cancelled', message: 'Stopped', endReason: reason, partial })
  log('answer_end', { sessionId: f.sessionId, answerId, trigger: f.trigger, status: 'cancelled', reason })
  changed('transcript')
  ended({ sessionId: f.sessionId, answerId, status: 'cancelled', endReason: reason })
}

export function cancelSessionAnswers(sessionId: string, reason: 'session_end' | 'superseded' = 'session_end') {
  for (const [id, f] of [...flights]) if (f.sessionId === sessionId) cancelAnswer(id, reason)
}

// ---------- streaming ----------

function pump(f: Flight, final = false) {
  f.timer = null
  if (flights.get(f.answerId) !== f) return
  if (f.header === 'pending') {
    const t = f.acc.replace(/^\s+/, '')
    const head = /^\**\s*question\s*\**\s*:/i
    const sep = f.acc.match(/\n\s*-{3,}\s*\n/)
    if (head.test(t) && sep && sep.index !== undefined) {
      f.header = 'split'
      f.question = f.acc.slice(0, sep.index).replace(/^\s+/, '').replace(head, '').replace(/\*+/g, '').trim() || null
      f.answerStart = sep.index + sep[0].length
    } else {
      const looksLikeHeader = head.test(t) || (t.length < 12 && /^\**\s*q?u?e?s?t?i?o?n?$/i.test(t))
      const late = f.acc.length > HEADER_MAX_CHARS || (f.firstTokenAt !== null && performance.now() - f.firstTokenAt > HEADER_MAX_MS)
      // A malformed header never holds the answer back.
      if (!looksLikeHeader || late || final) {
        f.header = 'none'
        const r = splitReply(f.acc, true)
        f.question = r.question
      }
    }
  }
  if (f.question && f.question !== f.sentQuestion) {
    f.sentQuestion = f.question
    emit('answer:delta', { answerId: f.answerId, sessionId: f.sessionId, seq: f.seq, part: 'question', offset: 0, text: f.question, attempt: f.attempt })
  }
  const a = answerText(f)
  if (a.length > f.sentAnswer.length && a.startsWith(f.sentAnswer)) {
    if (f.firstAnswerAt === null) f.firstAnswerAt = performance.now()
    emit('answer:delta', { answerId: f.answerId, sessionId: f.sessionId, seq: f.seq, part: 'answer', offset: f.sentAnswer.length, text: a.slice(f.sentAnswer.length), attempt: f.attempt })
    f.sentAnswer = a
  }
  // The lead paragraph is complete once a block boundary follows it (or the reply ends).
  if (f.leadAt === null && f.sentAnswer && leadEnd(f.sentAnswer, final) !== null) f.leadAt = performance.now()
}

function onText(f: Flight, d: string) {
  const at = performance.now()
  if (f.lastChunkAt !== null && f.chunks > 0) f.maxChunkGap = Math.max(f.maxChunkGap, at - f.lastChunkAt)
  f.lastChunkAt = at
  f.chunks++
  if (f.firstTokenAt === null) {
    f.firstTokenAt = performance.now()
    f.ttft[f.attempt - 1] = f.firstTokenAt - f.attemptAt
    firstTokenHooks.forEach((h) => h({ sessionId: f.sessionId, answerId: f.answerId }))
  }
  f.acc += d
  // Until the header is resolved and the first answer text is out, handle every chunk
  // at once; after that, 40 ms batches.
  if (f.header === 'pending' || f.sentAnswer === '') {
    if (f.timer) clearTimeout(f.timer)
    f.timer = null
    pump(f)
    return
  }
  f.timer ??= setTimeout(() => pump(f), BATCH_MS)
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })

async function stream(f: Flight, s: SessionDb, modelId: string, excerpt: string, trigger: AnswerTrigger, text?: string, useFallback = false) {
  const alive = () => flights.get(f.answerId) === f
  let m: ResolvedModel | undefined
  let usage: { input: number | null; output: number | null } | undefined
  const cfg = routing()
  let switched = false
  let servedModel: string | null = null
  // Move this answer to the fallback model (revision 4 A4.3). Only before any text, once.
  const toFallback = async (fb: string, reason: FallbackReason | null) => {
    switched = true
    servedModel = fb
    m = await resolveModel(fb)
    run('update answers set served_model = ?, fallback_reason = ?, updated_at = ? where id = ?', fb, reason, now(), f.answerId)
    log('answer_route', { sessionId: f.sessionId, answerId: f.answerId, trigger, attempt: f.attempt, servedModel: fb, fallbackReason: reason ?? undefined })
    emit('answer:route', { answerId: f.answerId, sessionId: f.sessionId, attempt: f.attempt, servedModel: fb, reason: reason ?? 'slow_first_token' })
  }
  try {
    m = await resolveModel(modelId)
    let messages: ModelMessage[]
    if (trigger === 'screenshot') {
      const shot = await captureScreen(f.answerId, getSettings().privateMode)
      if (!alive()) return
      messages = [...history(s.id, f.answerId), { role: 'user', content: [{ type: 'image', image: shot.png, mediaType: 'image/png' }, { type: 'text', text: screenshotMessage(excerpt) }] }]
    } else if (trigger === 'chat') {
      messages = [...history(s.id, f.answerId), { role: 'user', content: chatMessage(text ?? '', excerpt) }]
    } else {
      if (!excerpt.trim()) throw new AppError('Nothing new to answer yet. Wait for a question, or press Chat to type one.', 'empty')
      messages = [...history(s.id, f.answerId), { role: 'user', content: transcriptMessage(excerpt, f.questions) }]
    }
    const system = answerSystemPrompt(contextFor(s))
    // Start on the fallback when the user asked for it, the primary's key is rejected, or
    // the primary has been slow repeatedly (sticky window). Otherwise the primary first.
    const startFb = usableFallback(modelId, trigger)
    if (startFb) {
      const blocked = fallbackForBlocked(modelId, trigger)
      if (useFallback) await toFallback(startFb, null)
      else if (blocked) await toFallback(blocked.model, blocked.reason)
      else if (stickyFallback(modelId)) await toFallback(startFb, 'slow_first_token')
    }
    for (let attempt = 1; ; attempt++) {
      f.attempt = attempt
      if (attempt > 1) run('update answers set attempts = ? where id = ? and status = ?', attempt, f.answerId, 'streaming')
      const dog = new Watchdog({ firstMs: 25_000, idleMs: 20_000, totalMs: 150_000 }, f.ctrl.signal)
      // No first token from the primary by fallbackAfterMs: abort it and switch (A4.3).
      const slowFb = !switched && cfg.switchOn.slowFirstToken ? usableFallback(modelId, trigger) : null
      const slowTimer = slowFb ? setTimeout(() => f.firstTokenAt === null && dog.stop('switch'), cfg.fallbackAfterMs) : null
      f.attemptAt = performance.now()
      f.firstRequestAt ??= f.attemptAt
      f.ttft[attempt - 1] = null
      log('provider_request', { sessionId: s.id, answerId: f.answerId, trigger, provider: m.provider.id, model: m.catalogId, attempt })
      try {
        for await (const ev of m.provider.stream({ model: m.model, system, messages, maxOutputTokens: maxTokensFor(s.answerPrefs.length) }, dog.signal)) {
          if (dog.reason) throw dog.reason
          if (!alive()) return
          if (ev.type === 'text') {
            dog.tick()
            onText(f, ev.text)
          } else {
            usage = ev.usage
          }
        }
        if (dog.reason) throw dog.reason
        if (!alive()) return
        reportSuccess(m.catalogId)
        break
      } catch (raw) {
        const e = dog.reason ?? raw
        if (!alive() || (e instanceof Stop && e.kind === 'cancelled')) return
        if (e instanceof Stop && e.kind === 'switch') {
          // The primary request has ended (aborted, its loop exited) before the fallback starts.
          const fb = usableFallback(modelId, trigger)
          log('provider_slow', { sessionId: s.id, answerId: f.answerId, trigger, provider: m.provider.id, model: m.catalogId, attempt, ttftMs: cfg.fallbackAfterMs })
          if (!fb) throw new Stop('timeout')
          noteSlowSwitch(modelId, cfg.stickyAfterSlow, cfg.stickyWindowMs)
          await toFallback(fb, 'slow_first_token')
          if (!alive()) return
          continue
        }
        // A break after the first token says nothing about the model's limits: no cooling.
        if (e instanceof ProviderError && e.kind !== 'timeout' && f.firstTokenAt === null) reportError(m.catalogId, e)
        const pe = e instanceof ProviderError ? e : null
        log('provider_error', { sessionId: s.id, answerId: f.answerId, trigger, provider: m.provider.id, model: m.catalogId, attempt, errorKind: pe?.kind ?? (e instanceof Stop ? 'timeout' : 'unknown'), status: pe?.status, quotaPeriod: pe?.quotaPeriod, retryAfterMs: pe?.retryAfterMs })
        // After the first token, a retry would bill again and repeat text: keep the partial.
        if (f.firstTokenAt !== null) throw Object.assign(new ProviderError(pe?.kind ?? 'unknown'), { interrupted: true })
        // Before the first token: switch to the fallback for these errors (A4.3). Never for a
        // daily quota, a bad request or the network; never a second switch.
        if (!switched) {
          const why: FallbackReason | null =
            pe?.kind === 'overloaded' && cfg.switchOn.overloaded
              ? 'overloaded'
              : pe?.kind === 'rate_limited' && pe.quotaPeriod !== 'day' && cfg.switchOn.rateLimited
                ? 'rate_limited'
                : pe?.kind === 'auth' && cfg.switchOn.auth
                  ? 'auth'
                  : pe?.kind === 'not_found' && cfg.switchOn.notFound
                    ? 'not_found'
                    : null
          const fb = why ? usableFallback(modelId, trigger) : null
          if (why && fb) {
            await toFallback(fb, why)
            if (!alive()) return
            continue
          }
        }
        // The fallback attempt is final: no retry after it.
        if (switched) throw e
        const manual = trigger !== 'auto'
        const minuteLimit = pe?.kind === 'rate_limited' && pe.quotaPeriod !== 'day'
        // The third 429 in a row marks the model exhausted (§6): no automatic retry then.
        const exhausted = healthOf(m.catalogId).state === 'exhausted'
        if (attempt === 1 && manual && minuteLimit && !exhausted && (pe.retryAfterMs ?? Infinity) <= 10_000) {
          await sleep(pe.retryAfterMs ?? 0, f.ctrl.signal)
          if (!alive()) return
          continue
        }
        if (attempt === 1 && pe?.kind === 'overloaded') {
          await sleep(1500 + Math.round((Math.random() - 0.5) * 600), f.ctrl.signal)
          if (!alive()) return
          continue
        }
        throw e
      } finally {
        dog.dispose()
        if (slowTimer) clearTimeout(slowTimer)
      }
    }
    if (f.timer) clearTimeout(f.timer)
    pump(f, true)
    const answer = answerText(f).trim()
    if (!answer) throw new AppError('The model returned an empty answer. Try again.', 'empty')
    flights.delete(f.answerId)
    const firstTokenMs = f.firstTokenAt === null ? null : Math.round(f.firstTokenAt - f.startedAt)
    const latencyMs = Math.round(performance.now() - f.startedAt)
    const timing = timingOf(f)
    run(
      `update answers set status = 'done', end_reason = 'completed', question = ?, answer_md = ?, first_token_ms = ?, latency_ms = ?, input_tokens = ?, output_tokens = ?, timing = ?, error = null, updated_at = ?
       where id = ? and status = 'streaming'`,
      f.question ?? (trigger === 'chat' ? (text ?? null) : null),
      answer,
      firstTokenMs,
      latencyMs,
      usage?.input ?? null,
      usage?.output ?? null,
      JSON.stringify(timing),
      now(),
      f.answerId,
    )
    logTiming(f, timing, servedModel)
    log('answer_end', { sessionId: s.id, answerId: f.answerId, trigger, status: 'done', firstTokenMs, latencyMs, inputTokens: usage?.input ?? undefined, outputTokens: usage?.output ?? undefined })
    const done = getAnswer(f.answerId)
    if (done) emit('answer:done', done)
    changed('transcript')
    ended({ sessionId: s.id, answerId: f.answerId, status: 'done', endReason: 'completed' })
  } catch (e) {
    if (f.timer) clearTimeout(f.timer)
    if (!alive()) return
    flights.delete(f.answerId)
    const interrupted = (e as { interrupted?: boolean }).interrupted === true
    const d = e instanceof AppError && e.code === 'empty' ? { code: 'provider_error' as const, endReason: 'provider_error' as const, message: e.message } : describe(e, m)
    const code = interrupted ? 'interrupted' : d.code
    const endReason: AnswerEndReason = interrupted ? 'interrupted' : d.endReason
    const message = interrupted ? 'The answer was interrupted. The text so far is kept; Retry asks again.' : d.message
    const partial = finishRow(f, 'failed', endReason, message)
    const pe = e instanceof ProviderError ? e : null
    const retryAt = pe?.retryAfterMs !== undefined && pe.kind === 'rate_limited' ? Date.now() + pe.retryAfterMs : undefined
    // A daily quota is never switched automatically: offer the fallback as a one-press choice (A4.3).
    const offer = code === 'quota_exhausted' && !switched ? (usableFallback(modelId, trigger) ?? undefined) : undefined
    emit('answer:error', { answerId: f.answerId, sessionId: s.id, code, message, endReason, partial, retryAt, retryAfterS: retryAt ? Math.ceil((retryAt - Date.now()) / 1000) : undefined, fallbackModel: offer })
    log('answer_end', { sessionId: s.id, answerId: f.answerId, trigger, status: 'failed', reason: endReason })
    changed('transcript')
    ended({ sessionId: s.id, answerId: f.answerId, status: 'failed', endReason })
  }
}
