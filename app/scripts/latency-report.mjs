// Latency summary of a real call (architecture.md revision 6 L0/L8), from the app's own
// numbers-only log. Prints medians and ranges per stage; reads no transcript text.
//
//   node scripts/latency-report.mjs [log file]   (default: today's and yesterday's logs)
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(process.env.APPDATA ?? '', 'Parley', 'logs')
const day = (d) => join(dir, `main-${d.toISOString().slice(0, 10)}.log`)
const files = process.argv[2] ? [process.argv[2]] : [day(new Date(Date.now() - 864e5)), day(new Date())].filter(existsSync)
const rows = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean))

// Only the most recent session unless SESSION=<id> is given.
const sessions = [...new Set(rows.filter((r) => r.sessionId && r.event === 'answer_timing').map((r) => r.sessionId))]
const sid = process.env.SESSION ?? sessions.at(-1)
const mine = rows.filter((r) => !sid || r.sessionId === sid)

const stat = (xs) => {
  const a = xs.filter((x) => typeof x === 'number').sort((x, y) => x - y)
  if (!a.length) return '-'
  const p = (q) => a[Math.min(a.length - 1, Math.floor(q * a.length))]
  return `p50 ${p(0.5)}  p90 ${p(0.9)}  min ${a[0]}  max ${a.at(-1)}  n=${a.length}`
}
const of = (event, field, filter = () => true) => mine.filter((r) => r.event === event && filter(r)).map((r) => r[field])

console.log(`Session ${sid ?? '(all)'} from ${files.join(', ')}\n`)
console.log('Speech (them lane)')
console.log(`  words spoken -> on screen ms   ${stat(of('stt_timing', 'partialLagMs', (r) => r.speaker === 'them'))}`)
console.log(`  text update interval ms        ${stat(of('stt_timing', 'partialEveryMs', (r) => r.speaker === 'them'))}`)
console.log(`  speech end -> final ms         ${stat(of('stt_final', 'sttMs', (r) => r.speaker === 'them'))}`)
console.log(`  worker backlog ms (max/5 s)    ${stat(of('stt_timing', 'backlogMs'))}`)
console.log('\nAnswers')
for (const trig of ['auto', 'answer', 'chat', 'screenshot']) {
  const t = (f) => of('answer_timing', f, (r) => r.trigger === trig)
  if (!t('attempt').length) continue
  console.log(`  [${trig}]`)
  if (trig === 'auto') {
    console.log(`    speech end -> final ms       ${stat(t('sttMs'))}`)
    console.log(`    final -> candidate ms        ${stat(t('settleMs'))}`)
  }
  console.log(`    request -> first token ms    ${stat(t('ttftMs'))}`)
  console.log(`    first token -> answer ms     ${stat(t('headerMs'))}`)
  console.log(`    input tokens                 ${stat(t('inputTokens'))}`)
  console.log(`    cached tokens                ${stat(t('cachedTokens'))}`)
  console.log(`    thinking tokens              ${stat(t('reasoningTokens'))}`)
}
console.log(`\nWarm-ups                          ${stat(of('provider_warm', 'latencyMs'))}`)
const errs = mine.filter((r) => r.event === 'provider_error').map((r) => `${r.errorKind}${r.errorCode ? `/${r.errorCode}` : ''}`)
if (errs.length) console.log(`Provider errors: ${errs.join(', ')}`)
