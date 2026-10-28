// REAL Gemini, run on purpose only (LAT-R1, replica/test-plan.md §11). At most 4
// requests: 3 in-app Chat answers (the app's real prompt: system + synthetic resume) and
// 1 minimal raw streaming call outside the app, to split prompt/app effects from the
// provider's own time to first token and to see whether Gemini reports thinking tokens.
// Stops at the first error; never retries. Records timings and token counts only; the
// key, prompts and answers are never written.
import { expect, test } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Harness, WORK } from '../electron/harness'

const QS = ['What is dependency injection?', 'What is the difference between a process and a thread?', 'How does a database index speed up reads?']
const MODEL = 'gemini-3.5-flash-lite' // providers.ts LIVE_MODEL_IDS: google:gemini-flash-lite (live answers)

test('LAT-R1 real Gemini: time to first token, in-app vs minimal raw call', async () => {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? ''
  test.skip(!key, 'no Gemini key in the environment')
  const report: any = { at: new Date().toISOString(), model: MODEL, app: [] }
  const h = await new Harness('latreal', { real: true }).launch()
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    const cv = await h.call('resumes.createFromText', { title: 'Synthetic CV', text: 'Synthetic test resume. Backend engineer, 5 years of C#, ASP.NET Core, SQL Server, Azure Service Bus and Kubernetes at a fictional logistics company. Led a migration from a monolith to services.' })
    const s = await h.createSession({ autoGenerate: false, resumeId: cv.value?.id })
    await h.goLive(s.id)
    for (const q of QS) {
      const t0 = Date.now()
      const r = await h.gen(s.id, 'chat', { text: q })
      const end = await h.waitEnd(r.value?.answerId, 40_000)
      const log = h.logLines().find((l) => l.event === 'answer_end' && l.answerId === r.value?.answerId)
      const vis = ((await h.page.evaluate(() => (window as any).__vis)) as Record<string, number>)[r.value?.answerId ?? '']
      report.app.push({ status: log?.status, reason: log?.reason, firstTokenMs: log?.firstTokenMs, latencyMs: log?.latencyMs, inputTokens: log?.inputTokens, outputTokens: log?.outputTokens, pressToVisibleMs: vis ? vis - t0 : null })
      if (end?.n === 'answer:error' || log?.status !== 'done') {
        report.stoppedEarly = log?.reason ?? end?.p?.code ?? 'unknown'
        break
      }
      await h.page.waitForTimeout(5000)
    }
    report.appRequests = h.realRequests().length
    report.keyInLogs = h.logText().includes(key) || h.stdout.includes(key)
    await h.call('sessions.end', { id: s.id, mode: 'leave' })
  } finally {
    await h.close()
  }
  if (!report.stoppedEarly) {
    // One raw streaming request with a tiny prompt and no system prompt.
    const t0 = performance.now()
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'In one sentence: what is dependency injection?' }] }], generationConfig: { maxOutputTokens: 120 } }),
    })
    const headersMs = Math.round(performance.now() - t0)
    let firstDataMs: number | null = null
    let usage: any = null
    let modelVersion: string | null = null
    if (res.ok && res.body) {
      const dec = new TextDecoder()
      let buf = ''
      for await (const chunk of res.body as any) {
        firstDataMs ??= Math.round(performance.now() - t0)
        buf += dec.decode(chunk, { stream: true })
      }
      for (const line of buf.split('\n')) {
        if (!line.startsWith('data:')) continue
        try {
          const j = JSON.parse(line.slice(5))
          if (j.usageMetadata) usage = j.usageMetadata
          if (j.modelVersion) modelVersion = j.modelVersion
        } catch {}
      }
    }
    report.raw = {
      status: res.status,
      headersMs,
      firstDataMs,
      totalMs: Math.round(performance.now() - t0),
      modelVersion,
      promptTokens: usage?.promptTokenCount ?? null,
      outputTokens: usage?.candidatesTokenCount ?? null,
      thoughtsTokens: usage?.thoughtsTokenCount ?? 0,
    }
  }
  report.totalRealRequests = report.appRequests + (report.raw ? 1 : 0)
  writeFileSync(join(WORK, 'report-latency-real.json'), JSON.stringify(report, null, 2))
  expect.soft(report.keyInLogs, 'API key never in logs or stdout').toBe(false)
  expect.soft(report.totalRealRequests, 'request budget').toBeLessThanOrEqual(4)
})
