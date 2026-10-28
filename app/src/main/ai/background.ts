// callModel(): the one entry point for background model work (notes, resume
// conversion and parsing, preview, Ask AI, job import, mock interviewer). It applies
// the background column of the retry table (architecture.md revision 2 §6) and waits
// instead of spending calls while a model is cooling.
import type { ModelMessage } from 'ai'
import type { ZodType } from 'zod'
import { log } from '../log'
import { blocked, healthOf, reportError, reportSuccess } from './health'
import { ProviderError, type CompleteResult } from './provider'
import { resolveModel, type ResolvedModel } from './providers'
import { Stop, Watchdog } from './run'

/** Background purposes, for the log's `reason` field. */
export type Purpose = 'notes' | 'notes_chunk' | 'resume_convert' | 'resume_parse' | 'preview' | 'review' | 'job_import' | 'interviewer'

const MAX_WAIT_MS = 60_000
const OVERLOAD_RETRY_MS = 5_000

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })

/** Streaming background call (S09 preview, Ask AI): same health rules; retry only before the first token. */
export async function streamModel(opts: {
  modelId: string
  purpose: Purpose
  system: string
  messages: ModelMessage[]
  maxOutputTokens?: number
  onText: (delta: string) => void
  signal?: AbortSignal
}): Promise<{ text: string; m: ResolvedModel }> {
  const m = await resolveModel(opts.modelId)
  for (let attempt = 1; ; attempt++) {
    if (blocked(m.catalogId)) {
      const s = healthOf(m.catalogId).state
      throw new ProviderError(s === 'auth_failed' ? 'auth' : s === 'exhausted' ? 'quota_exhausted' : 'rate_limited', 429)
    }
    const dog = new Watchdog({ firstMs: 25_000, idleMs: 20_000, totalMs: 120_000 }, opts.signal)
    let text = ''
    log('provider_request', { provider: m.provider.id, model: m.catalogId, reason: opts.purpose, attempt })
    try {
      for await (const ev of m.provider.stream({ model: m.model, system: opts.system, messages: opts.messages, maxOutputTokens: opts.maxOutputTokens ?? 1200 }, dog.signal)) {
        if (dog.reason) throw dog.reason
        if (ev.type === 'text') {
          dog.tick()
          text += ev.text
          opts.onText(ev.text)
        }
      }
      if (dog.reason) throw dog.reason
      reportSuccess(m.catalogId)
      return { text, m }
    } catch (raw) {
      const e = dog.reason ?? raw
      if (e instanceof Stop && e.kind === 'cancelled') throw e
      const pe = e instanceof Stop ? new ProviderError('timeout') : e instanceof ProviderError ? e : new ProviderError('unknown')
      if (pe.kind !== 'timeout') reportError(m.catalogId, pe)
      log('provider_error', { provider: m.provider.id, model: m.catalogId, reason: opts.purpose, attempt, errorKind: pe.kind, status: pe.status, quotaPeriod: pe.quotaPeriod })
      if (text || attempt >= 2 || !(pe.kind === 'overloaded' || pe.kind === 'timeout')) throw pe
      await wait(OVERLOAD_RETRY_MS, opts.signal)
    } finally {
      dog.dispose()
    }
  }
}

export async function callModel<T = string>(opts: {
  modelId: string
  purpose: Purpose
  system: string
  messages: ModelMessage[]
  schema?: ZodType<T>
  maxOutputTokens?: number
  totalMs?: number
  /** Resume conversion: no per-call retry, so one upload makes at most 2 calls. */
  noRetry?: boolean
  signal?: AbortSignal
  m?: ResolvedModel
}): Promise<CompleteResult<T> & { m: ResolvedModel }> {
  const m = opts.m ?? (await resolveModel(opts.modelId))
  const maxAttempts = opts.noRetry ? 1 : 2
  for (let attempt = 1; ; attempt++) {
    // Wait out a short cooldown rather than calling into a 429; give up on long ones.
    const hs = healthOf(m.catalogId)
    if (hs.state === 'cooling' && hs.retryAtMono !== undefined) {
      const ms = hs.retryAtMono - performance.now()
      if (ms > MAX_WAIT_MS) throw new ProviderError('rate_limited', 429, ms, 'unknown')
      await wait(ms, opts.signal)
    }
    if (blocked(m.catalogId)) {
      const s = healthOf(m.catalogId).state
      throw new ProviderError(s === 'auth_failed' ? 'auth' : s === 'exhausted' ? 'quota_exhausted' : 'rate_limited', 429)
    }
    const dog = new Watchdog({ firstMs: opts.totalMs ?? 90_000, idleMs: opts.totalMs ?? 90_000, totalMs: opts.totalMs ?? 90_000 }, opts.signal)
    const t0 = performance.now()
    log('provider_request', { provider: m.provider.id, model: m.catalogId, reason: opts.purpose, attempt })
    try {
      const res = await m.provider.complete<T>({ model: m.model, system: opts.system, messages: opts.messages, maxOutputTokens: opts.maxOutputTokens ?? 4000, schema: opts.schema }, dog.signal)
      if (dog.reason) throw dog.reason
      reportSuccess(m.catalogId)
      log('provider_done', { provider: m.provider.id, model: m.catalogId, reason: opts.purpose, latencyMs: Math.round(performance.now() - t0), inputTokens: res.usage?.input ?? undefined, outputTokens: res.usage?.output ?? undefined })
      return { ...res, m }
    } catch (raw) {
      const e = dog.reason ?? raw
      if (e instanceof Stop && e.kind === 'cancelled') throw e
      const pe = e instanceof Stop ? new ProviderError('timeout') : e instanceof ProviderError ? e : new ProviderError('unknown')
      if (pe.kind !== 'timeout') reportError(m.catalogId, pe)
      log('provider_error', { provider: m.provider.id, model: m.catalogId, reason: opts.purpose, attempt, errorKind: pe.kind, status: pe.status, quotaPeriod: pe.quotaPeriod, retryAfterMs: pe.retryAfterMs })
      const retryable = pe.kind === 'rate_limited' || pe.kind === 'overloaded' || pe.kind === 'timeout'
      if (!retryable || attempt >= maxAttempts) throw pe
      if (pe.kind === 'overloaded') await wait(OVERLOAD_RETRY_MS, opts.signal)
      // rate_limited: the loop's cooldown wait above handles retryAt.
    } finally {
      dog.dispose()
    }
  }
}
