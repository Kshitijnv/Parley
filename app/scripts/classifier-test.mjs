// Gemini 429 classifier test (architecture.md revision 2 §6 asks for a real body).
// fixtures/gemini-429-daily.json is a real 429 captured 2026-10-28 (identifiers
// redacted): a free-tier model with both per-day and per-minute violations.
// The per-minute case is derived from it by keeping only the per-minute violation.
//   node scripts/classifier-test.mjs      (Node 24 strips the TypeScript types)
import { readFileSync } from 'node:fs'
import { classify429 } from '../src/main/ai/gemini429.ts'

const real = JSON.parse(readFileSync(new URL('./fixtures/gemini-429-daily.json', import.meta.url), 'utf8')).body
const minuteOnly = structuredClone(real)
const qf = minuteOnly.error.details.find((d) => d['@type'].endsWith('QuotaFailure'))
qf.violations = qf.violations.filter((v) => /PerMinute/.test(v.quotaId) && /requests/.test(v.quotaMetric))
minuteOnly.error.details.find((d) => d['@type'].endsWith('RetryInfo')).retryDelay = '5s'

const cases = [
  ['real body (per-day + per-minute violations) -> quota_exhausted / day', classify429(JSON.stringify(real)), { kind: 'quota_exhausted', quotaPeriod: 'day', retryAfterMs: 84735000 }],
  ['derived per-minute body -> rate_limited / minute, retry 5 s', classify429(JSON.stringify(minuteOnly)), { kind: 'rate_limited', quotaPeriod: 'minute', retryAfterMs: 5000 }],
  ['no details + Retry-After header -> rate_limited / unknown', classify429('{"error":{"code":429}}', '7'), { kind: 'rate_limited', quotaPeriod: 'unknown', retryAfterMs: 7000 }],
  ['non-JSON body -> rate_limited / unknown', classify429('Too many requests'), { kind: 'rate_limited', quotaPeriod: 'unknown', retryAfterMs: undefined }],
]
let failed = 0
for (const [name, got, want] of cases) {
  const ok = got.kind === want.kind && got.quotaPeriod === want.quotaPeriod && got.retryAfterMs === want.retryAfterMs
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got ${JSON.stringify(got)}`}`)
}
console.log(`${cases.length - failed}/${cases.length} passed`)
process.exit(failed ? 1 : 0)
