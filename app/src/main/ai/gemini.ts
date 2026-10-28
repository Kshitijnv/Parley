// Error classification for the AI SDK providers, with Gemini's 429 classifier.
// Gemini's 429 body carries standard google.rpc details: QuotaFailure violations whose
// quotaId names the period (".PerDay." / ".PerMinute.") and RetryInfo.retryDelay. The
// classifier is tested against a real, redacted body (scripts/fixtures/gemini-429-daily.json).
import { APICallError } from 'ai'
import type { Provider } from '@shared/types'
import { classify429 } from './gemini429'
import { ProviderError } from './provider'

const NET = /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|socket hang up|network/i

/** Classify a Gemini 429 body (logic in gemini429.ts, which the fixture test loads). */
export function classifyGemini429(body: string | undefined, retryAfterHeader?: string): ProviderError {
  const c = classify429(body, retryAfterHeader)
  return new ProviderError(c.kind, 429, c.retryAfterMs, c.quotaPeriod)
}

const KEY_TEXT = /API key not valid|invalid x-api-key|Incorrect API key/i
const KEY_REASONS = new Set(['API_KEY_INVALID', 'API_KEY_SERVICE_BLOCKED', 'API_KEY_HTTP_REFERRER_BLOCKED', 'API_KEY_IP_ADDRESS_BLOCKED'])

function auth(kind: 'invalid_key' | 'forbidden', status: number): ProviderError {
  const e = new ProviderError('auth', status)
  e.authKind = kind
  return e
}

/** google.rpc ErrorInfo.reason, or the error status, from a JSON error body. Only this short enum is read. */
export function errorInfoReason(body: string): string | null {
  try {
    const j = JSON.parse(body) as { error?: { status?: string; details?: Array<{ reason?: string }> } }
    const r = j.error?.details?.find((d) => typeof d.reason === 'string')?.reason ?? j.error?.status
    return typeof r === 'string' && /^[A-Z_]{3,60}$/.test(r) ? r : null
  } catch {
    return null
  }
}

/** Map any SDK / network error to a ProviderError, keeping no provider text. */
export function classify(err: unknown, provider: Provider): ProviderError {
  if (err instanceof ProviderError) return err
  let e: unknown = err
  if (e && typeof e === 'object' && 'lastError' in e && (e as { lastError?: unknown }).lastError) e = (e as { lastError: unknown }).lastError
  if (APICallError.isInstance(e)) {
    const s = e.statusCode ?? 0
    const body = e.responseBody ?? ''
    if (s === 429) {
      if (provider === 'google') return classifyGemini429(body, e.responseHeaders?.['retry-after'])
      const h = e.responseHeaders?.['retry-after']
      return new ProviderError('rate_limited', 429, h && /^\d+$/.test(h) ? Number(h) * 1000 : undefined, 'unknown')
    }
    // Revision 4 A1. Gemini answers a bad key with 400 API_KEY_INVALID, not 401. A 403 is
    // auth only when it's about the key; any other 403 (region, a paid-only model) must
    // not block a provider whose key works.
    const reason = errorInfoReason(body)
    if (s === 401 || reason === 'API_KEY_INVALID' || KEY_TEXT.test(body)) return auth('invalid_key', s || 401)
    if (s === 403) return KEY_REASONS.has(reason ?? '') || (reason === 'PERMISSION_DENIED' && /api key/i.test(body)) ? auth('forbidden', 403) : new ProviderError('bad_request', 403)
    if (s === 404) return new ProviderError('not_found', 404)
    if (s === 400) return new ProviderError('bad_request', 400)
    if (s >= 500) return new ProviderError('overloaded', s)
    if (!s && NET.test(`${e.message} ${String((e.cause as Error | undefined)?.message ?? '')}`)) return new ProviderError('offline')
    return new ProviderError('unknown', s || undefined)
  }
  const text = e instanceof Error ? `${e.name} ${e.message} ${String((e.cause as Error | undefined)?.message ?? '')}` : String(e)
  if (NET.test(text)) return new ProviderError('offline')
  return new ProviderError('unknown')
}
