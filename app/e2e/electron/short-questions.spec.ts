// Short questions (3 words, under autoPolicy.minWords 4) through the real speech model, auto on,
// fake provider. Revision 4 A2 (BUG-011): a short question counts by its shape, for auto
// detection and for a manual press; repeats are still deduplicated.
import { expect, test } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Harness, WORK } from './harness'

const SLOT_MS = 14_000

test('SQ: "What is polymorphism?" / "Define dependency injection." vs a 7-word control', async () => {
  const h = await new Harness('short').launch()
  const report: Record<string, unknown> = {}
  try {
    h.setScript({ default: { firstTokenMs: 200, chunkMs: 20 } })
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    const s = await h.createSession({ autoGenerate: true })
    await h.goLive(s.id)
    const starts = async () => (await h.events()).filter((e) => e.n === 'answer:start').length
    const finalsSince = async (t: number) => (await h.events()).filter((e) => e.n === 'transcript:final' && e.p.speaker === 'them' && e.t >= t).map((e) => e.p.text)

    // 1. on a fresh call: short questions alone
    const slot = async (clip: string) => {
      const t0 = Date.now()
      const b = await starts()
      const r = h.requests(s.id).length
      await h.feedSlot([clip], SLOT_MS)
      return { clip, finals: await finalsSince(t0 - 500), autoStarts: (await starts()) - b, requests: h.requests(s.id).length - r }
    }
    const s1 = await slot('s1')
    const s2 = await slot('s2')
    report.freshCall = [s1, s2]
    expect.soft(s1.autoStarts, 'SQ-01 (rev 4) "What is polymorphism?" auto-answers').toBe(1)
    // SQ-02 is recorded only: the recogniser writes "Define" or "Defined", and only "Define" opens a question.

    // 2. manual Answer on a call with no answer yet: works (the short question is the material)
    const m1 = await h.gen(s.id, 'answer')
    await h.waitEnd(m1.value?.answerId)
    const m1Draft = (await h.events()).find((e) => e.n === 'answer:start' && e.p.answerId === m1.value?.answerId)?.p.questionDraft
    report.manualFirst = { outcome: m1.value?.outcome, reason: m1.value?.reason, draft: m1Draft }
    // SQ-03 recorded only: whether anything is new depends on SQ-02's transcript.

    // 3. the 7-word control auto-answers
    await h.page.waitForTimeout(8500) // past the auto cooldown
    const s3 = await slot('s3')
    report.control = s3
    expect.soft(s3.autoStarts, 'SQ-04 "What is polymorphism in object oriented programming?" auto-answers').toBe(1)

    // 4. a short question AFTER an answer: auto ignores it; a manual press with 3 new words
    await h.page.waitForTimeout(2500)
    const s1b = await slot('s1')
    const m2 = await h.gen(s.id, 'answer')
    if (m2.value?.outcome === 'started') await h.waitEnd(m2.value?.answerId)
    report.afterAnswer = { auto: s1b, manual: { outcome: m2.value?.outcome, reason: m2.value?.reason } }
    expect.soft(s1b.autoStarts, 'SQ-05 (rev 4) the same short question again: auto skips it as a duplicate').toBe(0)
    expect.soft(m2.value?.outcome, 'SQ-05 (rev 4) one press answers the short question after another answer').toBe('started')
    // a second press (the documented "force" path) always regenerates
    await h.page.waitForTimeout(600)
    const m3 = await h.gen(s.id, 'answer')
    if (m3.value?.outcome === 'started') await h.waitEnd(m3.value?.answerId)
    report.forcePress = { outcome: m3.value?.outcome, reason: m3.value?.reason }
    report.totalRequests = h.requests(s.id).length
    expect(h.errors, 'no console errors').toEqual([])
  } finally {
    writeFileSync(join(WORK, 'report-short.json'), JSON.stringify(report, null, 2))
    await h.close()
  }
})
