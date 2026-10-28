// LiveSession (architecture.md revision 2 §1–§3): owns the speech-to-text worker for
// the one live session, turns its finals into transcript segments (seq assigned here,
// single writer), drops mic echoes of the other side, batches segment writes every
// 2 s, and forwards "them" speech to the TurnDetector. It decides nothing about answers.
import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { DEFAULT_AUTO_POLICY } from '@shared/catalog'
import type { AutoPolicy, Segment, Speaker, SttStatus } from '@shared/types'
import { get, tx } from './db/client'
import { findSession, getSettings, insertSegments, nextSegmentSeq, now, requireSession, uuid } from './db/repo'
import { changed, emit } from './events'
import { AppError } from './errors'
import { log } from './log'
import { TurnDetector, type Candidate } from './live/turns'
import { filesOf, markCorrupt, modelForLanguage, type Manifest } from './stt/registry'

interface Final {
  speaker: Speaker
  text: string
  at: number
  seq: number
}

interface Held {
  seg: Omit<Segment, 'seq'>
  timer: ReturnType<typeof setTimeout>
}

/** A worker process with one loaded model. */
interface Worker {
  proc: UtilityProcess
  modelId: string
  language: string
  state: SttStatus['state']
  error?: string
  loadMs?: number
  ready: Promise<void>
  sessionId: string
  idleTimer: ReturnType<typeof setTimeout> | null
  onMessage: ((m: WorkerMsg) => void) | null
}

interface WorkerMsg {
  type: string
  speaker?: Speaker
  text?: string
  utteranceId?: number
  rev?: number
  startMs?: number
  endMs?: number
  modelId?: string
  language?: string
  loadMs?: number
  message?: string
}

interface LanePartial {
  utteranceId: number
  rev: number
  text: string
  sentAt: number
  pending: ReturnType<typeof setTimeout> | null
}

interface Live {
  sessionId: string
  t0: number
  base: number
  worker: Worker | null
  finals: Final[]
  partial: Record<Speaker, LanePartial | null>
  pending: Segment[]
  held: Held[]
  seq: number
  flushTimer: ReturnType<typeof setInterval>
  onFlushed: (() => void) | null
  stopping: boolean
  detector: TurnDetector
}

let live: Live | null = null
let prepared: Worker | null = null
let candidateHook: ((c: Candidate) => void) | null = null

const ECHO_WINDOW_MS = 4000
const HOLD_YOU_MS = 3000
const PARTIAL_EVERY_MS = 150
const PREPARED_IDLE_MS = 60_000
const READY_TIMEOUT_MS = 30_000

export function onCandidate(fn: (c: Candidate) => void) {
  candidateHook = fn
}

export const liveSessionId = () => live?.sessionId ?? null

function workerStatus(w: Worker | null): SttStatus {
  if (!w) return { state: 'stopped' }
  return { state: w.state, error: w.error, modelId: w.modelId, language: w.language, loadMs: w.loadMs }
}

export function sttStatus(): SttStatus {
  return live ? workerStatus(live.worker) : prepared ? workerStatus(prepared) : { state: 'stopped' }
}

/** Model ids currently loaded by a worker (deleting them is refused). */
export function loadedModelIds(): string[] {
  // A worker whose model failed to load holds nothing: Verify files / Reinstall must work.
  return [live?.worker, prepared].filter((w): w is Worker => !!w && w.state !== 'error' && w.state !== 'stopped').map((w) => w.modelId)
}

function publish(w: Worker | null) {
  emit('stt:status', workerStatus(w))
}

function policy(): AutoPolicy {
  try {
    return { ...DEFAULT_AUTO_POLICY, ...getSettings().autoPolicy }
  } catch {
    return DEFAULT_AUTO_POLICY
  }
}

/** The STT model writes UPPER CASE without punctuation in some models; cased output is kept. */
export function tidy(text: string): string {
  let t = text.replace(/\s+/g, ' ').trim()
  if (/[a-z]/.test(t)) return t
  t = t.toLowerCase().replace(/\bi\b/g, 'I').replace(/\bi'(m|ve|d|ll)\b/g, "I'$1")
  return t.charAt(0).toUpperCase() + t.slice(1)
}

function words(t: string): Set<string> {
  return new Set(t.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter((w) => w.length > 1))
}

export function similar(a: string, b: string): number {
  const A = words(a)
  const B = words(b)
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const w of A) if (B.has(w)) hit++
  return hit / Math.min(A.size, B.size)
}

// ---------- worker ----------

function spawnWorker(sessionId: string, m: Manifest, language: string): Worker {
  const proc = utilityProcess.fork(join(import.meta.dirname, 'sttWorker.js'), [], { serviceName: 'Parley speech-to-text', stdio: 'pipe' })
  // Worker stderr only with PARLEY_DEBUG_STT=1 (§9).
  if (process.env['PARLEY_DEBUG_STT'] === '1') proc.stderr?.on('data', (d: Buffer) => console.error('[stt]', d.toString().trim()))
  else proc.stderr?.on('data', () => {})
  let resolveReady!: () => void
  let rejectReady!: (e: Error) => void
  const w: Worker = {
    proc,
    modelId: m.id,
    language: m.language ?? language,
    state: 'starting',
    ready: new Promise<void>((res, rej) => {
      resolveReady = res
      rejectReady = rej
    }),
    sessionId,
    idleTimer: null,
    onMessage: null,
  }
  w.ready.catch(() => {})
  proc.on('message', (msg: WorkerMsg) => {
    if (msg.type === 'ready') {
      w.state = 'listening'
      w.loadMs = msg.loadMs
      log('stt_ready', { sessionId, sttModelId: msg.modelId, language: msg.language, loadMs: msg.loadMs })
      resolveReady()
      publish(w)
    } else if (msg.type === 'load_error') {
      w.state = 'error'
      w.error = 'The speech model failed to load. Verify or reinstall it in Settings › Speech models.'
      markCorrupt(m.id)
      log('stt_load_failed', { sessionId, sttModelId: m.id })
      rejectReady(new AppError(w.error, 'stt_model_corrupt'))
      publish(w)
    } else if (msg.type === 'error') {
      w.state = 'error'
      w.error = 'The speech model stopped responding. Press Restart transcription.'
      publish(w)
    }
    w.onMessage?.(msg)
  })
  proc.on('exit', (code) => {
    if (w.state === 'starting') rejectReady(new AppError('The speech model process exited while loading.', 'stt_failed'))
    const stopping = live?.worker === w ? live.stopping : prepared !== w
    if (!stopping && w.state !== 'stopped') {
      w.state = 'error'
      w.error = `The speech model stopped unexpectedly (exit ${code}). Press Restart transcription.`
      publish(w)
    }
    if (prepared === w) prepared = null
  })
  proc.postMessage({ type: 'init', modelId: m.id, language: m.language ?? language, files: filesOf(m), threads: 2 })
  return w
}

function killWorker(w: Worker | null) {
  if (!w) return
  if (w.idleTimer) clearTimeout(w.idleTimer)
  w.state = 'stopped'
  w.onMessage = null
  w.proc.kill()
}

function modelOrThrow(language: string): Manifest {
  const m = modelForLanguage(language)
  if (!m) {
    const hi = language.toLowerCase().startsWith('hi')
    throw new AppError(hi ? 'Hindi transcription is not available yet.' : 'Install the English speech model first (Settings › Speech models).', 'stt_model_missing', 'language')
  }
  return m
}

/** S12: load the session's model before Start. Stops by itself after 60 s unused. */
export async function prepareStt(sessionId: string): Promise<SttStatus> {
  const s = requireSession(sessionId)
  if (live?.sessionId === sessionId) return workerStatus(live.worker)
  if (live) throw new AppError('Another call is live. End it first.', 'conflict')
  const m = modelOrThrow(s.language)
  if (prepared && (prepared.sessionId !== sessionId || prepared.modelId !== m.id || prepared.state === 'error')) {
    killWorker(prepared)
    prepared = null
  }
  if (!prepared) prepared = spawnWorker(sessionId, m, s.language)
  const w = prepared
  if (w.idleTimer) clearTimeout(w.idleTimer)
  w.idleTimer = setTimeout(() => {
    if (prepared === w) {
      killWorker(w)
      prepared = null
      publish(null)
    }
  }, PREPARED_IDLE_MS)
  publish(w)
  try {
    await w.ready
  } catch {
    // reported through the status
  }
  return workerStatus(w)
}

async function waitReady(w: Worker) {
  let t: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([w.ready, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new AppError('The speech model took too long to load.', 'stt_failed')), READY_TIMEOUT_MS)))])
  } finally {
    if (t) clearTimeout(t)
  }
}

// ---------- lines ----------

function commit(l: Live, seg: Omit<Segment, 'seq'>, toDetector = true) {
  const full: Segment = { ...seg, seq: l.seq++ }
  l.finals.push({ speaker: full.speaker, text: full.text, at: full.spokenAt, seq: full.seq })
  if (l.finals.length > 2000) l.finals.splice(0, l.finals.length - 2000)
  const s = findSession(l.sessionId)
  if (s?.saveTranscript) l.pending.push(full)
  emit('transcript:final', full)
  if (toDetector) {
    if (full.speaker === 'them') l.detector.onThemFinal(full.seq, full.text)
    else l.detector.onYouFinal(full.text)
  }
  return full
}

function onFinal(l: Live, speaker: Speaker, raw: string, durMs: number) {
  const text = tidy(raw)
  if (!text) return
  const endMs = Math.round(l.base + (performance.now() - l.t0))
  const seg = { id: uuid(), sessionId: l.sessionId, speaker, text, startMs: Math.max(0, endMs - durMs), endMs, spokenAt: now() }
  if (speaker === 'them') {
    // The mic heard the speakers: drop the held "you" copy of this line.
    l.held = l.held.filter((h) => {
      if (similar(h.seg.text, text) >= 0.6) {
        clearTimeout(h.timer)
        return false
      }
      return true
    })
    commit(l, seg)
    return
  }
  const echoOf = l.finals.some((f) => f.speaker === 'them' && seg.spokenAt - f.at < ECHO_WINDOW_MS && similar(f.text, text) >= 0.6)
  if (echoOf) return
  const h: Held = {
    seg,
    timer: setTimeout(() => {
      if (live !== l) return
      l.held = l.held.filter((x) => x !== h)
      commit(l, seg)
    }, HOLD_YOU_MS),
  }
  l.held.push(h)
}

function sendPartial(l: Live, speaker: Speaker) {
  const p = l.partial[speaker]
  if (!p) return
  p.pending = null
  p.sentAt = performance.now()
  emit('transcript:partial', { sessionId: l.sessionId, speaker, text: p.text, utteranceId: p.utteranceId, rev: p.rev })
}

function onPartial(l: Live, speaker: Speaker, utteranceId: number, rev: number, raw: string) {
  const text = tidy(raw)
  const prev = l.partial[speaker]
  const p: LanePartial = { utteranceId, rev, text, sentAt: prev?.utteranceId === utteranceId ? prev.sentAt : 0, pending: prev?.pending ?? null }
  l.partial[speaker] = p
  if (speaker === 'them') l.detector.onThemPartial(text)
  // At most one partial per lane every 150 ms (latest wins); clearing is sent at once.
  const since = performance.now() - p.sentAt
  if (!text || since >= PARTIAL_EVERY_MS) {
    if (p.pending) clearTimeout(p.pending)
    sendPartial(l, speaker)
  } else {
    p.pending ??= setTimeout(() => live === l && sendPartial(l, speaker), PARTIAL_EVERY_MS - since)
  }
}

function flushSegments(l: Live) {
  if (!l.pending.length) return
  const batch = l.pending.splice(0)
  try {
    tx(() => insertSegments(batch))
    changed('transcript')
  } catch (e) {
    log('segment_write_failed', { sessionId: l.sessionId, errorName: (e as Error).name })
    l.pending.unshift(...batch)
  }
}

function attach(l: Live, w: Worker) {
  l.worker = w
  if (w.idleTimer) clearTimeout(w.idleTimer)
  w.idleTimer = null
  w.onMessage = (m) => {
    if (live !== l || l.worker !== w) return
    if (m.type === 'partial') onPartial(l, m.speaker!, m.utteranceId ?? 0, m.rev ?? 0, m.text ?? '')
    else if (m.type === 'final') {
      const p = l.partial[m.speaker!]
      if (p?.pending) clearTimeout(p.pending)
      l.partial[m.speaker!] = null
      if (m.speaker === 'them') l.detector.onThemPartial('')
      onFinal(l, m.speaker!, m.text ?? '', Math.max(0, (m.endMs ?? 0) - (m.startMs ?? 0)))
    } else if (m.type === 'flushed') l.onFlushed?.()
  }
}

/** Start (or restart) transcription for a live session; resolves when the model is loaded. */
export async function startLive(sessionId: string) {
  const s = requireSession(sessionId)
  if (live && live.sessionId !== sessionId) await stopLive(live.sessionId)
  const m = modelOrThrow(s.language)
  if (live && live.sessionId === sessionId) {
    // Restart after an error: keep the transcript buffer, replace the worker.
    killWorker(live.worker)
    const w = spawnWorker(sessionId, m, s.language)
    attach(live, w)
    publish(w)
    await waitReady(w)
    return
  }
  let w = prepared && prepared.sessionId === sessionId && prepared.modelId === m.id && prepared.state !== 'error' ? prepared : null
  prepared = null
  if (!w) w = spawnWorker(sessionId, m, s.language)
  const last = get<{ e: number | null }>('select max(end_ms) as e from transcript_segments where session_id = ?', sessionId)
  const l: Live = {
    sessionId,
    t0: performance.now(),
    base: Number(last?.e ?? 0),
    worker: null,
    finals: [],
    partial: { you: null, them: null },
    pending: [],
    held: [],
    seq: nextSegmentSeq(sessionId),
    flushTimer: setInterval(() => live === l && flushSegments(l), 2000),
    onFlushed: null,
    stopping: false,
    detector: new TurnDetector(sessionId, policy, (c) => candidateHook?.(c)),
  }
  live = l
  attach(l, w)
  publish(w)
  try {
    await waitReady(w)
  } catch (e) {
    await stopLive(sessionId)
    throw e
  }
}

/** Stop transcription: finalise in-flight words, write pending segments, end the worker. */
export async function stopLive(sessionId: string) {
  const l = live
  if (!l || l.sessionId !== sessionId) return
  l.stopping = true
  if (l.worker && l.worker.state === 'listening') {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1500)
      l.onFlushed = () => {
        clearTimeout(t)
        resolve()
      }
      l.worker!.proc.postMessage({ type: 'flush' })
    })
  }
  for (const h of l.held.splice(0)) {
    clearTimeout(h.timer)
    commit(l, h.seg, false)
  }
  for (const sp of ['you', 'them'] as Speaker[]) if (l.partial[sp]?.pending) clearTimeout(l.partial[sp]!.pending!)
  clearInterval(l.flushTimer)
  flushSegments(l)
  l.detector.dispose()
  killWorker(l.worker)
  l.worker = null
  live = null
  emit('stt:status', { state: 'stopped' })
}

const MAX_FRAME_BYTES = 64 * 1024
// Speech energy on the "them" lane for the TurnDetector: above about -38 dBFS counts as
// voice; it ends after 300 ms below, so pauses between words don't flicker it.
const VOICE_RMS = 0.0125
const VOICE_HANGOVER_MS = 300
let voiceUntil = 0

function frameRms(bytes: Uint8Array): number {
  const view = bytes.byteOffset % 2 === 0 ? new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1) : new Int16Array(bytes.slice().buffer)
  let sum = 0
  for (let i = 0; i < view.length; i++) sum += view[i]! * view[i]!
  return Math.sqrt(sum / Math.max(1, view.length)) / 32768
}

export function feedAudio(speaker: unknown, pcm: unknown) {
  const l = live
  if (!l || !l.worker || l.worker.state !== 'listening') return
  if (speaker !== 'you' && speaker !== 'them') return
  const bytes = pcm instanceof ArrayBuffer ? new Uint8Array(pcm) : pcm instanceof Uint8Array ? pcm : null
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_FRAME_BYTES || bytes.byteLength % 2) return
  if (speaker === 'them') {
    const t = performance.now()
    if (frameRms(bytes) > VOICE_RMS) voiceUntil = t + VOICE_HANGOVER_MS
    l.detector.onThemVoice(t < voiceUntil)
  }
  l.worker.proc.postMessage({ type: 'audio', speaker, pcm: bytes })
}

// ---------- read access for the engine and the gate ----------

/** Finals since `since` (epoch ms) plus the words still being spoken (manual requests). */
export function liveLines(sessionId: string, since: number): { lines: Final[]; partial: Array<{ speaker: Speaker; text: string }> } {
  if (!live || live.sessionId !== sessionId) return { lines: [], partial: [] }
  const held = live.held.map((h) => ({ speaker: h.seg.speaker, text: h.seg.text, at: h.seg.spokenAt, seq: Infinity }))
  const lines = [...live.finals, ...held].filter((f) => f.at > since).sort((a, b) => a.at - b.at)
  const partial = (['them', 'you'] as Speaker[]).filter((s) => live!.partial[s]?.text).map((s) => ({ speaker: s, text: live!.partial[s]!.text }))
  return { lines, partial }
}

/** Transcript position for the gate's "new material" rule (§5). */
export function liveMaterial(sessionId: string): { themFinals: Array<{ seq: number; text: string }>; youFinals: number; latestSeq: number; themPartial: { utteranceId: number; text: string } | null } {
  if (!live || live.sessionId !== sessionId) return { themFinals: [], youFinals: 0, latestSeq: -1, themPartial: null }
  const cursorAt = findSession(sessionId)?.transcriptCursorAt ?? 0
  const visible = live.finals.filter((f) => f.at > cursorAt)
  const p = live.partial.them
  return {
    themFinals: visible.filter((f) => f.speaker === 'them').map((f) => ({ seq: f.seq, text: f.text })),
    youFinals: visible.filter((f) => f.speaker === 'you').length,
    latestSeq: live.seq - 1,
    themPartial: p?.text ? { utteranceId: p.utteranceId, text: p.text } : null,
  }
}

export function currentTurn(sessionId: string) {
  return live?.sessionId === sessionId ? live.detector.current() : null
}

export function noteAnswered(sessionId: string) {
  if (live?.sessionId === sessionId) live.detector.noteAnswered()
}

export function clearLive(sessionId: string) {
  if (live?.sessionId === sessionId) live.finals = []
}

/** F08: the AI interviewer's question joins the transcript as a complete "them" turn. */
export function injectThem(sessionId: string, text: string): Segment | null {
  const l = live
  if (!l || l.sessionId !== sessionId) return null
  const endMs = Math.round(l.base + (performance.now() - l.t0))
  const seg = commit(l, { id: uuid(), sessionId, speaker: 'them', text, startMs: endMs, endMs, spokenAt: now() }, false)
  if (seg) l.detector.onMockQuestion(seg.seq, text)
  return seg ?? null
}
