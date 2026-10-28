// Shared helpers for model calls: the watchdog (first-token, idle and total timeouts
// linked to an outer abort), and short user-facing messages for a ProviderError.
import { modelLabel } from '@shared/catalog'
import type { AnswerErrorCode, AnswerEndReason } from '@shared/types'
import { AppError } from '../errors'
import { log } from '../log'
import { ProviderError } from './provider'
import { providerLabel, type ResolvedModel } from './providers'

export class Stop extends Error {
  /** 'switch': the engine ends a slow primary attempt to move to the fallback (revision 4 A4.3). */
  constructor(public kind: 'timeout' | 'cancelled' | 'switch') {
    super(kind)
  }
}

/** Abort controller with first-token, idle and total timeouts, linked to an outer signal. */
export class Watchdog {
  readonly ctrl = new AbortController()
  private timers: ReturnType<typeof setTimeout>[] = []
  private idle: ReturnType<typeof setTimeout> | null = null
  reason: Stop | null = null

  constructor(
    private opts: { firstMs: number; idleMs: number; totalMs: number },
    outer?: AbortSignal,
  ) {
    this.timers.push(setTimeout(() => this.stop('timeout'), opts.totalMs))
    this.idle = setTimeout(() => this.stop('timeout'), opts.firstMs)
    if (outer?.aborted) this.stop('cancelled')
    else outer?.addEventListener('abort', () => this.stop('cancelled'), { once: true })
  }

  get signal() {
    return this.ctrl.signal
  }

  tick() {
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => this.stop('timeout'), this.opts.idleMs)
  }

  stop(kind: Stop['kind']) {
    if (this.reason) return
    this.reason = new Stop(kind)
    this.ctrl.abort(this.reason)
  }

  dispose() {
    this.timers.forEach(clearTimeout)
    if (this.idle) clearTimeout(this.idle)
  }
}

export interface Failure {
  code: AnswerErrorCode
  endReason: AnswerEndReason
  message: string
}

/** A short message with no provider body text and no transcript (§8). */
export function describe(e: unknown, m?: Pick<ResolvedModel, 'providerId' | 'catalogId'>): Failure {
  const who = m ? providerLabel(m.providerId) : 'The provider'
  const model = m ? modelLabel(m.catalogId) : 'this model'
  if (e instanceof Stop) return e.kind === 'timeout' ? { code: 'timeout', endReason: 'timeout', message: 'No reply from the model in time. Try again, or pick a faster model.' } : { code: 'cancelled', endReason: 'user_cancel', message: 'Stopped' }
  if (e instanceof AppError) return { code: e.code === 'no_key' ? 'no_key' : 'provider_error', endReason: 'provider_error', message: e.message }
  if (e instanceof ProviderError) {
    if (process.env['PARLEY_DEBUG_AI'] === '1') log('ai_error_debug', { errorKind: e.kind, status: e.status, quotaPeriod: e.quotaPeriod, retryAfterMs: e.retryAfterMs })
    switch (e.kind) {
      case 'quota_exhausted':
        return { code: 'quota_exhausted', endReason: 'quota_exhausted', message: `${who}'s daily limit is used up for ${model}. Auto answers are paused. Switch the model or try later.` }
      case 'rate_limited':
        return { code: 'rate_limited', endReason: 'rate_limited', message: `${who} is rate limiting ${model} right now.` }
      case 'overloaded':
        return { code: 'overloaded', endReason: 'overloaded', message: `${who} is busy (${e.status ?? 503}). Try again or switch model.` }
      case 'auth':
        return { code: 'auth', endReason: 'auth', message: `${who} rejected the API key. Check it in Settings.` }
      case 'offline':
        return { code: 'offline', endReason: 'offline', message: 'No connection. The transcript keeps running; answers need the internet.' }
      case 'not_found':
        return { code: 'provider_error', endReason: 'provider_error', message: `${who} doesn't offer ${model} to your key. Pick another model.` }
      case 'bad_request':
        return { code: 'provider_error', endReason: 'provider_error', message: `${who} refused the request (400). Try a shorter context or another model.` }
      case 'timeout':
        return { code: 'timeout', endReason: 'timeout', message: 'No reply from the model in time.' }
      default:
        return { code: 'provider_error', endReason: 'provider_error', message: `${who} returned an error. Try again.` }
    }
  }
  return { code: 'provider_error', endReason: 'provider_error', message: 'The model returned an unexpected error. Try again.' }
}
