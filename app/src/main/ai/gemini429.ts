// Gemini 429 classifier (architecture.md revision 2 §6), import-free so a plain Node test
// can load it (scripts/classifier-test.mjs). Gemini's 429 body carries standard google.rpc
// details: QuotaFailure violations whose quotaId names the period ("...PerDay..." /
// "...PerMinute...") and RetryInfo.retryDelay. Tested against a real, redacted body.

export interface Classified429 {
  kind: 'quota_exhausted' | 'rate_limited'
  quotaPeriod: 'day' | 'minute' | 'unknown'
  retryAfterMs?: number
}

interface RpcDetail {
  '@type'?: string
  retryDelay?: string
  violations?: Array<{ quotaId?: string; quotaMetric?: string }>
}

function parseDelay(s: string | undefined): number | undefined {
  const m = s?.match(/^(\d+(?:\.\d+)?)s$/)
  return m ? Math.round(Number(m[1]) * 1000) : undefined
}

export function classify429(body: string | undefined, retryAfterHeader?: string): Classified429 {
  let details: RpcDetail[] = []
  try {
    details = (JSON.parse(body ?? '{}') as { error?: { details?: RpcDetail[] } }).error?.details ?? []
  } catch {
    // not JSON: unclassified
  }
  const retry = details.find((d) => d['@type']?.endsWith('google.rpc.RetryInfo'))
  const quota = details.find((d) => d['@type']?.endsWith('google.rpc.QuotaFailure'))
  const ids = (quota?.violations ?? []).map((v) => `${v.quotaId ?? ''} ${v.quotaMetric ?? ''}`)
  const header = retryAfterHeader && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) * 1000 : undefined
  const retryAfterMs = parseDelay(retry?.retryDelay) ?? header
  // A per-day violation wins even when per-minute limits are listed next to it.
  if (ids.some((s) => /PerDay/i.test(s))) return { kind: 'quota_exhausted', quotaPeriod: 'day', retryAfterMs }
  if (ids.some((s) => /PerMinute/i.test(s))) return { kind: 'rate_limited', quotaPeriod: 'minute', retryAfterMs }
  return { kind: 'rate_limited', quotaPeriod: 'unknown', retryAfterMs }
}
