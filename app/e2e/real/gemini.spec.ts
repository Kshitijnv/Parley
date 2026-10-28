// REAL Gemini (Flash-Lite), run on purpose only: npx playwright test --project=real
// §13 #9 (direct answer first, reviewed by hand from the saved prefixes) and #13 (latency
// on the real provider), through the full auto path: synthetic speech -> local model ->
// TurnDetector -> RequestGate -> Gemini. Budget: 10 live requests (architecture: <= 30
// for the whole run). Stops at the first 429 / quota error. Synthetic resume only. The
// key comes from the developer's environment and is never printed or written.
import { expect, test } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Harness, WORK } from '../electron/harness'

const QS: Array<Array<string | number>> = [['q01'], ['q02a', 1200, 'q02b'], ['q03'], ['q05'], ['q06'], ['q07a', 1200, 'q07b'], ['q08'], ['q09'], ['q10'], ['q04a', 1200, 'q04b']]

test('real Gemini: 10 spoken questions, direct answer first, latency', async () => {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? ''
  test.skip(!key, 'no Gemini key in the environment')
  const h = await new Harness('real', { real: true }).launch()
  const report: any = { answers: [] }
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    // Count real HTTP requests to Google in main, to compare with the app's own attempt log
    // (shows the SDK makes no hidden retries). Only the host and time are kept.
    await h.app.evaluate(() => {
      const g = globalThis as any
      g.__http = []
      const orig = g.fetch
      g.fetch = (u: any, o: any) => {
        const url = String(u?.url ?? u)
        if (/generativelanguage\.googleapis\.com/.test(url)) g.__http.push({ t: Date.now(), stream: /stream/i.test(url) })
        return orig(u, o)
      }
    })
    const cv = await h.call('resumes.createFromText', { title: 'Synthetic CV', text: 'Synthetic test resume. Backend engineer, 5 years of C#, ASP.NET Core, SQL Server, Azure Service Bus and Kubernetes at a fictional logistics company. Led a migration from a monolith to services.' })
    const s = await h.createSession({ autoGenerate: true, resumeId: cv.value?.id })
    await h.goLive(s.id)
    for (const parts of QS) {
      const n = (await h.events()).filter((e) => e.n === 'answer:start').length
      const marks = await h.feedSlot(parts, 17_000)
      const ev = await h.events()
      const st = ev.filter((e) => e.n === 'answer:start').slice(n)[0]
      const end = st ? await h.waitEnd(st.p.answerId, 30_000) : null
      const row = st ? (await h.call('answers.get', { answerId: st.p.answerId })).value : null
      const speechEnd = marks[parts.filter((p) => typeof p === 'string').at(-1) as string]!
      const fin = ev.find((e) => e.n === 'transcript:final' && e.t > speechEnd - 500)
      const vis = st ? ((await h.page.evaluate(() => (window as any).__vis)) as Record<string, number>)[st.p.answerId] : undefined
      const md: string = row?.answerMd ?? ''
      const firstSentence = md.replace(/^[#>*\-\s]+/, '').split(/(?<=[.!?])\s|\n/)[0] ?? ''
      report.answers.push({
        clip: parts.join('+'),
        question: row?.question,
        status: row?.status,
        error: end?.n === 'answer:error' ? end.p.code : undefined,
        firstTokenMs: row?.firstTokenMs,
        speechEndToFinalMs: fin ? fin.t - speechEnd : null,
        speechEndToVisibleMs: vis ? vis - speechEnd : null,
        firstSentenceWords: firstSentence.split(/\s+/).filter(Boolean).length,
        prefix: md.slice(0, 400),
      })
      if (end?.n === 'answer:error' && /rate|quota/.test(end.p.code)) {
        report.stoppedEarly = end.p.code
        break
      }
    }
    const real = h.realRequests()
    report.geminiRequests = real.length
    report.httpRequestsToGoogle = (await h.app.evaluate(() => (globalThis as any).__http)).length
    expect.soft(report.httpRequestsToGoogle, 'HTTP requests == logged attempts (no hidden SDK retries)').toBe(real.length)
    const ft = report.answers.map((a: any) => a.firstTokenMs).filter((x: any) => typeof x === 'number').sort((a: number, b: number) => a - b)
    report.medianFirstTokenMs = ft.length ? ft[Math.floor(ft.length / 2)] : null
    const logs = h.logText()
    report.keyInLogs = key ? logs.includes(key) || h.stdout.includes(key) : null
    expect.soft(report.stoppedEarly, 'no quota error').toBeUndefined()
    expect.soft(real.length, 'one Gemini request per question').toBe(report.answers.length)
    expect.soft(report.answers.every((a: any) => a.status === 'done'), 'all answered').toBe(true)
    expect.soft(report.answers.every((a: any) => a.firstSentenceWords <= 30), '#9 first sentence <= 30 words').toBe(true)
    expect.soft(report.keyInLogs, 'API key never in logs or stdout').toBe(false)
    await h.call('sessions.end', { id: s.id, mode: 'leave' })
  } finally {
    writeFileSync(join(WORK, 'report-real.json'), JSON.stringify(report, null, 2))
    await h.close()
  }
})
