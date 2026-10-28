// BUG-006 follow-up: a rejected API key (401) with auto answers on. Checks the message the user
// sees, that there are no retries, what the live status chip says, and that a new key lifts the
// block straight away (no quota-style wait). Fake provider, 0 Gemini calls.
import { expect, test } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Harness, WORK } from './harness'

test('AUTH: 401 with auto on: message, no retry, status chip, recovery on a new key', async () => {
  const h = await new Harness('auth').launch()
  const report: Record<string, unknown> = {}
  try {
    h.setScript({ default: { firstTokenMs: 200, chunkMs: 20 }, steps: [{ error: 'auth' }] })
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    const s = await h.createSession({ autoGenerate: true, model: 'groq:llama-instant' })
    await h.goLive(s.id)
    const chip = h.page.getByRole('toolbar', { name: 'Call controls' }).getByRole('status').first()

    // 1. an auto answer hits the 401
    await h.feedSlot(['q01'], 9000)
    const start = await h.until((ev) => ev.find((e) => e.n === 'answer:start')?.p, 8000)
    const end = await h.waitEnd(start?.answerId)
    await h.page.waitForTimeout(600)
    const card = await h.page.getByText(/rejected the API key/).first().textContent().catch(() => null)
    const gate1 = (await h.call('answers.gateStatus', { sessionId: s.id })).value
    report.afterFirst401 = { code: end?.p.code, message: end?.p.message, card, calls: h.requests(s.id).length, gate: { auto: gate1?.auto, provider: gate1?.provider, retryAt: gate1?.retryAt ?? null }, chipText: (await chip.textContent())?.trim(), chipLabel: await chip.getAttribute('aria-label') }
    expect.soft(end?.p.code, 'AUTH-01 answer fails with code auth').toBe('auth')
    expect.soft(card, 'AUTH-01 the card says the key was rejected').toMatch(/rejected the API key/)
    expect.soft(h.requests(s.id).length, 'AUTH-02 one call, no retry').toBe(1)
    expect.soft(gate1?.provider, 'AUTH-03 provider state auth_failed').toBe('auth_failed')
    expect.soft(gate1?.retryAt ?? null, 'AUTH-03 no retry time promised').toBeNull()

    // 2. while the key is rejected: a manual press and a new question make no call
    const chat = await h.gen(s.id, 'chat', { text: 'What is a CDN?' })
    await h.page.waitForTimeout(8500)
    await h.feedSlot(['q03'], 9000)
    const gate2 = (await h.call('answers.gateStatus', { sessionId: s.id })).value
    report.whileBlocked = { chat: chat.value, calls: h.requests(s.id).length, gateLast: gate2?.last, auto: gate2?.auto, chipText: (await chip.textContent())?.trim(), chipLabel: await chip.getAttribute('aria-label') }
    expect.soft(chat.value?.outcome, 'AUTH-04 manual press while blocked: suppressed').toBe('suppressed')
    expect.soft(chat.value?.message, 'AUTH-04 message names the key').toMatch(/rejected the (API )?key/)
    expect.soft(h.requests(s.id).length, 'AUTH-05 no calls while blocked (no retry storm)').toBe(1)
    const wb = report.whileBlocked as any
    expect.soft(wb.chipText, 'AUTH-08 (BUG-007) chip says the key was rejected, not "Quota used"').toBe('Key rejected')
    expect.soft(wb.chipLabel, 'AUTH-08 (BUG-007) chip help mentions no quota').not.toMatch(/quota/i)

    // 3. a new key lifts the block immediately; the next question is answered
    const k = await h.call('keys.set', { provider: 'groq', key: 'gsk_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE00' })
    await h.page.waitForTimeout(800)
    const gate3 = (await h.call('answers.gateStatus', { sessionId: s.id })).value
    await h.feedSlot(['q05'], 9000)
    const after = (await h.events()).filter((e) => e.n === 'answer:start').map((e) => e.p.trigger)
    report.afterNewKey = { keySet: k.ok, gate: { auto: gate3?.auto, provider: gate3?.provider }, starts: after, calls: h.requests(s.id).length, chipText: (await chip.textContent())?.trim() }
    expect.soft(gate3?.provider, 'AUTH-06 new key clears auth_failed').toBe('ok')
    expect.soft(gate3?.auto, 'AUTH-06 auto resumes').not.toBe('paused_quota')
    expect.soft(h.requests(s.id).length, 'AUTH-07 next question answered: 1 more call').toBe(2)

    // BUG-006 (open, S4): the reason/chip vocabulary has no auth value
    report.bug006 = { gateReason: chat.value?.reason, chipWhileBlocked: (report.whileBlocked as any).chipText }
    expect(h.errors, 'no console errors').toEqual([])
  } finally {
    writeFileSync(join(WORK, 'report-auth.json'), JSON.stringify(report, null, 2))
    await h.close()
  }
})
