// One Speechmatics real-time session (architecture.md revision 7 S2), written from
// Speechmatics' public real-time API reference: StartRecognition, binary audio,
// AddPartialTranscript / AddTranscript / EndOfUtterance, Error, EndOfStream.
// Runs in main with the user's key in an Authorization header; nothing here logs text.
import type { VocabItem } from './vocab'

export const SM_DEFAULT_URL = 'wss://global.rt.speechmatics.com/v2'
export const SM_KEY_TEST_URL = 'https://mp.speechmatics.com/v1/api_keys?type=rt'

export interface SmConfig {
  url: string
  key: string
  language: string
  maxDelayS: number
  eouSilenceS: number
  vocab: VocabItem[]
}

export type SmEvent =
  | { type: 'started' }
  | { type: 'partial'; text: string; endS: number }
  | { type: 'final'; text: string; startS: number; endS: number }
  | { type: 'eou'; endS: number }
  | { type: 'error'; errorType: string }
  | { type: 'closed'; code: number; opened: boolean }

interface Metadata {
  start_time?: number
  end_time?: number
  transcript?: string
}

export class SmSession {
  private ws: WebSocket
  private seq = 0
  private opened = false
  private ended: (() => void) | null = null
  private done = false

  constructor(
    readonly cfg: SmConfig,
    private on: (e: SmEvent) => void,
  ) {
    // Node's WebSocket (undici) accepts headers; the key never goes in the URL.
    const Ctor = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket
    this.ws = new Ctor(cfg.url, { headers: { Authorization: `Bearer ${cfg.key}` } })
    this.ws.binaryType = 'arraybuffer'
    this.ws.onopen = () => {
      this.opened = true
      this.ws.send(JSON.stringify(startMessage(cfg)))
    }
    this.ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      let m: { message?: string; metadata?: Metadata; type?: string }
      try {
        m = JSON.parse(ev.data)
      } catch {
        return
      }
      this.onMessage(m)
    }
    this.ws.onerror = () => {}
    this.ws.onclose = (ev) => {
      this.ended?.()
      if (this.done) return
      this.done = true
      this.on({ type: 'closed', code: ev.code, opened: this.opened })
    }
  }

  private onMessage(m: { message?: string; metadata?: Metadata; type?: string }) {
    const md = m.metadata ?? {}
    switch (m.message) {
      case 'RecognitionStarted':
        return this.on({ type: 'started' })
      case 'AddPartialTranscript':
        return this.on({ type: 'partial', text: md.transcript ?? '', endS: md.end_time ?? 0 })
      case 'AddTranscript':
        if (md.transcript?.trim()) this.on({ type: 'final', text: md.transcript, startS: md.start_time ?? 0, endS: md.end_time ?? 0 })
        return
      case 'EndOfUtterance':
        return this.on({ type: 'eou', endS: md.end_time ?? 0 })
      case 'Error':
        // The type is an enum (not_authorised, timelimit_exceeded, ...); the reason text is never kept.
        return this.on({ type: 'error', errorType: /^[a-z_]{1,40}$/.test(m.type ?? '') ? m.type! : 'unknown_error' })
      case 'EndOfTranscript':
        this.ended?.()
        return
    }
  }

  /** Bytes queued in the socket but not sent yet (backpressure, S4.4). */
  get buffered() {
    return this.ws.bufferedAmount
  }

  get isOpen() {
    return this.ws.readyState === WebSocket.OPEN
  }

  sendAudio(pcm: Int16Array) {
    if (this.ws.readyState !== WebSocket.OPEN || !pcm.length) return
    this.ws.send(pcm.slice().buffer)
    this.seq++
  }

  /** Ask for the last finals and wait up to `ms` for them, then close. */
  async end(ms = 2000) {
    if (this.done) return
    this.done = true
    if (this.ws.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms)
        this.ended = () => {
          clearTimeout(t)
          resolve()
        }
        this.ws.send(JSON.stringify({ message: 'EndOfStream', last_seq_no: this.seq }))
      })
    }
    this.close()
  }

  close() {
    this.done = true
    try {
      this.ws.close(1000)
    } catch {
      // already closed
    }
  }
}

export function startMessage(cfg: Omit<SmConfig, 'url' | 'key'>) {
  return {
    message: 'StartRecognition',
    audio_format: { type: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 },
    transcription_config: {
      language: cfg.language,
      model: 'enhanced',
      enable_partials: true,
      max_delay: cfg.maxDelayS,
      max_delay_mode: 'flexible',
      conversation_config: { end_of_utterance_silence_trigger: cfg.eouSilenceS },
      ...(cfg.vocab.length ? { additional_vocab: cfg.vocab } : {}),
    },
  }
}

/** Join final pieces: punctuation attaches to the previous word. */
export function joinText(acc: string, piece: string): string {
  const p = piece.trim()
  if (!p) return acc
  if (!acc) return p
  return /^[.,?!;:%)\]'’]/.test(p) ? acc + p : `${acc} ${p}`
}

export type SmOutcome = 'retry_same' | 'rotate_rate' | 'rotate_quota' | 'rotate_auth' | 'fatal_config'

/**
 * Error type or close code → what the pool does (S4.3). From the public API reference:
 * quota_exceeded is the concurrent-session limit (4005), timelimit_exceeded the usage
 * quota (4006), not_authorised a bad key (4001), not_allowed (4003) an action the
 * account can't perform. Anything else is retried on the same key, never treated as a
 * used-up key.
 */
export function classify(errorType: string | null, closeCode: number | null): SmOutcome {
  switch (errorType) {
    case 'not_authorised':
      return 'rotate_auth'
    case 'timelimit_exceeded':
    case 'not_allowed':
      return 'rotate_quota'
    case 'quota_exceeded':
      return 'rotate_rate'
    case 'invalid_message':
    case 'invalid_model':
    case 'invalid_language':
    case 'invalid_config':
    case 'invalid_audio_type':
    case 'invalid_output_format':
    case 'protocol_error':
      return 'fatal_config'
  }
  switch (closeCode) {
    case 4001:
      return 'rotate_auth'
    case 4003:
    case 4006:
      return 'rotate_quota'
    case 4005:
      return 'rotate_rate'
    case 1003:
    case 4004:
      return 'fatal_config'
  }
  return 'retry_same'
}

/** Errors the docs say to retry no sooner than 5–10 s. */
export const slowRetry = (errorType: string | null, closeCode: number | null) => errorType === 'job_error' || closeCode === 4013 || closeCode === 1011

/**
 * Check a key without sending audio: create a 60 s temporary real-time key.
 * 'auth' for 401/403, 'ok' for 2xx, 'error' for anything else (network, 5xx).
 */
export async function testSpeechmaticsKey(key: string, fetchFn: typeof fetch = fetch, url = SM_KEY_TEST_URL): Promise<{ result: 'ok' | 'auth' | 'error'; status?: number }> {
  try {
    const r = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ ttl: 60 }),
      signal: AbortSignal.timeout(8000),
    })
    await r.arrayBuffer().catch(() => null)
    if (r.ok) return { result: 'ok', status: r.status }
    return { result: r.status === 401 || r.status === 403 ? 'auth' : 'error', status: r.status }
  } catch {
    return { result: 'error' }
  }
}
