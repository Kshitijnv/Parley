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
const sessions = [...new Set(rows.filter((r) => r.sessionId && (r.event === 'answer_timing' || r.event === 'stt_final')).map((r) => r.sessionId))]
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
// Revision 7: rows per engine. Logs from before revision 7 have no sttEngine: they're local.
// Local finals logged while cloud text was shown are the standby's, kept for comparison.
const engine = (r) => r.sttEngine ?? 'local'
for (const eng of ['speechmatics', 'local']) {
  const mineEng = (r) => r.speaker === 'them' && engine(r) === eng
  if (!mine.some((r) => (r.event === 'stt_final' || r.event === 'stt_timing') && mineEng(r))) continue
  console.log(`Speech (them lane, ${eng === 'speechmatics' ? 'cloud: Speechmatics' : 'local'})`)
  console.log(`  words spoken -> on screen ms   ${stat(of('stt_timing', 'partialLagMs', mineEng))}`)
  console.log(`  text update interval ms        ${stat(of('stt_timing', 'partialEveryMs', mineEng))}`)
  console.log(`  speech end -> final ms         ${stat(of('stt_final', 'sttMs', mineEng))}`)
  console.log(`  backlog ms (max/5 s)           ${stat(of('stt_timing', 'backlogMs', mineEng))}`)
  if (eng === 'local') {
    const standby = of('stt_final', 'sttMs', (r) => mineEng(r) && r.outcome === 'standby').length
    if (standby) console.log(`  (${standby} of these finals were the hot standby, not shown)`)
  }
}
if (mine.some((r) => ['stt_connect', 'stt_error', 'stt_switch'].includes(r.event))) {
  console.log('\nCloud speech')
  console.log(`  connects ok                    ${mine.filter((r) => r.event === 'stt_connect' && r.outcome === 'ok').length}  (key slots: ${[...new Set(mine.filter((r) => r.event === 'stt_connect' && r.outcome === 'ok').map((r) => r.keySlot))].join(', ') || '-'})`)
  console.log(`  connect -> started ms          ${stat(of('stt_connect', 'latencyMs', (r) => r.outcome === 'ok'))}`)
  console.log(`  failure -> next session up ms  ${stat(of('stt_connect', 'switchMs'))}`)
  console.log(`  replayed audio ms              ${stat(of('stt_connect', 'replayMs'))}`)
  console.log(`  vocabulary items               ${stat(of('stt_connect', 'vocabCount'))}`)
  const errs = mine.filter((r) => r.event === 'stt_error').map((r) => `${r.errorType ?? r.status ?? '?'}→${r.outcome}`)
  if (errs.length) console.log(`  errors                         ${errs.join(', ')}`)
  const sw = mine.filter((r) => r.event === 'stt_switch').map((r) => `${r.sttEngine}${r.outcome ? `(${r.outcome})` : ''}`)
  if (sw.length) console.log(`  lane switches                  ${sw.join(' → ')}`)
}
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
