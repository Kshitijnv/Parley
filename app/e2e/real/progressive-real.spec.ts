// REAL Gemini, run on purpose only (test-plan.md §14, PD-12). At most 4 requests through
// the app's Chat path: 2 simple and 2 compound questions. Records only numbers and shape
// facts (lead words, whether code comes last, headings): never the answer text or the key.
// Stops at the first error; never retries.
import { expect, test } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { leadEnd } from '../../src/shared/answerBlocks'
import { Harness, WORK } from '../electron/harness'

const QS: Array<{ q: string; kind: 'simple' | 'compound' }> = [
  { q: 'What is polymorphism?', kind: 'simple' },
  { q: 'Why use caching?', kind: 'simple' },
  { q: 'What is polymorphism, and how would you implement it in C#?', kind: 'compound' },
  { q: 'What is dependency injection, and how do you set it up in ASP.NET Core? Show code.', kind: 'compound' },
]

test('PD-12 real model: answer shape and time to first useful content', async () => {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? ''
  test.skip(!key, 'no Gemini key in the environment')
  const h = await new Harness('pd-real', { real: true }).launch()
  const report: any = { at: new Date().toISOString(), model: 'google:gemini-flash-lite', answers: [] }
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    const s = await h.createSession({ autoGenerate: false })
    await h.goLive(s.id)
    for (const { q, kind } of QS) {
      await h.page.evaluate(() => {
        const w = window as any
        clearInterval(w.__rTimer)
        w.__lead = null
        w.__rTimer = setInterval(() => {
          if (!w.__lead && document.querySelector('[aria-label="Answer text"] .md-lead')) w.__lead = Date.now()
        }, 10)
      })
      const t0 = Date.now()
      const r = await h.gen(s.id, 'chat', { text: q })
      const end = await h.waitEnd(r.value?.answerId, 40_000)
      const leadSeen = await h.page.evaluate(() => (window as any).__lead as number | null)
      const row = (await h.call('answers.get', { answerId: r.value?.answerId })).value
      const md: string = row?.answerMd ?? ''
      const lead = leadEnd(md, true) ?? 0
      const fence = md.indexOf('```')
      report.answers.push({
        kind,
        status: row?.status,
        reason: row?.endReason,
        providerTtftMs: row?.timing?.ttftMs?.[0] ?? null,
        firstVisibleUsefulMs: leadSeen ? leadSeen - t0 : null,
        completionMs: row?.latencyMs ?? null,
        chunks: row?.timing?.chunks ?? null,
        maxChunkGapMs: row?.timing?.maxChunkGapMs ?? null,
        streamMs: row?.timing?.streamMs ?? null,
        outputTokens: row?.outputTokens ?? null,
        leadWords: lead > 0 ? md.slice(0, lead).trim().split(/\s+/).length : 0,
        hasCode: fence >= 0,
        codeAfterLead: fence < 0 ? null : fence >= lead && lead > 0,
        codeIsLastBlock: fence < 0 ? null : !/\S/.test(md.slice(md.lastIndexOf('```') + 3)),
        headings: (md.match(/^#{1,6}\s/gm) ?? []).length,
        listItems: (md.match(/^\s*([-*+]|\d+[.)])\s/gm) ?? []).length,
        words: md.split(/\s+/).filter(Boolean).length,
      })
      if (end?.n === 'answer:error' || row?.status !== 'done') {
        report.stoppedEarly = row?.endReason ?? end?.p?.code ?? 'unknown'
        break
      }
      await h.page.waitForTimeout(5000)
    }
    report.realRequests = h.realRequests().length
    report.keyInLogs = h.logText().includes(key) || h.stdout.includes(key)
    await h.call('sessions.end', { id: s.id, mode: 'leave' })
  } finally {
    writeFileSync(join(WORK, 'report-progressive-real.json'), JSON.stringify(report, null, 2))
    await h.close()
  }
  expect.soft(report.realRequests, 'budget ≤ 4').toBeLessThanOrEqual(4)
  expect.soft(report.keyInLogs, 'key never in logs').toBe(false)
})
