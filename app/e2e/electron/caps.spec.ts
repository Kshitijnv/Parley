// Acceptance criterion §13 #5 (auto caps), plus "auto never cancels, it queues" and the
// per-session budget. Real-time synthetic speech, real local English model, fake
// provider: zero Gemini calls.
import { expect, test } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Harness, WORK } from './harness'

test('auto caps: 8 questions in ~30 s, queueing, budget (fake provider)', async () => {
  const h = await new Harness('caps').launch()
  const report: Record<string, unknown> = {}
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    h.setScript({ default: { firstTokenMs: 300, chunkMs: 40 } })
    const s = await h.createSession({ autoGenerate: true })
    await h.goLive(s.id)

    // ---------- #5: 8 distinct questions in about 30 s; Answer pressed in the middle ----------
    // Each question must be its own turn, so the measured voice gap has to exceed joinGapMs
    // (2.5 s): 2.4 s inserted + ~0.9 s clip tail - 0.3 s voice hang-over = ~3 s. Shorter gaps
    // join the questions into one turn by design (architecture §12, "two questions back to back").
    const parts: Array<string | number> = []
    for (const c of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8']) parts.push(c, 2400)
    const dur = Harness.durationMs(parts)
    const t0 = Date.now()
    const feeding = h.feedSlot(parts, dur + 45_000)
    // manual Answer still works while auto is capped
    await h.page.waitForTimeout(20_000)
    // nothing new since the auto answer -> reused (rule 8); a second press 0.6 s later regenerates
    const manualFirst = await h.gen(s.id, 'answer')
    await h.page.waitForTimeout(600)
    const manual = manualFirst.value?.outcome === 'started' ? manualFirst : await h.gen(s.id, 'answer')
    await feeding
    const logs = h.logLines().filter((l) => l.sessionId === s.id && l.t >= t0)
    const autoReq = h.requests(s.id).filter((r) => r.trigger === 'auto' && r.t >= t0)
    const gaps = autoReq.slice(1).map((r, i) => r.t - autoReq[i]!.t)
    const maxIn60 = Math.max(0, ...autoReq.map((r) => autoReq.filter((x) => x.t >= r.t && x.t - r.t < 60_000).length))
    const decisions = logs.filter((l) => l.event === 'gate_decision' && l.trigger === 'auto').map((l) => l.outcome === 'suppressed' ? `suppressed:${l.reason}` : l.outcome)
    const queued = logs.filter((l) => l.event === 'candidate_queued').length
    const candidates = logs.filter((l) => l.event === 'candidate').length
    const gate = (await h.call('answers.gateStatus', { sessionId: s.id })).value
    const statusEvents = (await h.events()).filter((e) => e.n === 'gate:status' && e.p.sessionId === s.id).map((e) => e.p.auto)
    report.criterion5 = { speechMs: Math.round(dur), candidates, autoRequests: autoReq.length, gapsMs: gaps, maxIn60, decisions, queued, manual: manual.value, gate, sawQueued: statusEvents.includes('queued'), sawCooldown: statusEvents.includes('cooldown') }
    // c4 "What is recursion?" and c8 "What is memoization?" are 3 words: below minWords (4) by design
    expect.soft(candidates, '#5 the detector proposed the 6 questions of 4+ words').toBeGreaterThanOrEqual(6)
    expect.soft(maxIn60, '#5 at most autoMaxPerMinute (4) auto requests in any 60 s').toBeLessThanOrEqual(4)
    expect.soft(Math.min(...gaps), '#5 auto requests never closer than 8 s').toBeGreaterThanOrEqual(8000)
    expect.soft(manual.value?.outcome, '#5 manual Answer still works').toBe('started')
    expect.soft(statusEvents.includes('queued') || statusEvents.includes('cooldown'), '#5 queue / cooldown visible in gate:status').toBe(true)
    // every candidate is accounted for: started, queued, or suppressed with a reason
    expect.soft(gate?.counts.suppressed, '#5 suppressed count visible in gate:status').toBeGreaterThan(0)

    // ---------- auto never cancels: a slow auto answer, then a new question -> queued, not cancelled ----------
    await h.call('sessions.end', { id: s.id, mode: 'end' })
    const s2 = await h.createSession({ autoGenerate: true, model: 'google:gemini-flash' })
    await h.goLive(s2.id)
    h.setScript({ default: { firstTokenMs: 300, chunkMs: 40 }, steps: [{ firstTokenMs: 3000, chunkMs: 400, chunkChars: 12 }] })
    const t1 = Date.now()
    await h.feedSlot(['q01', 6000, 'q09'], 40_000)
    const ev = (await h.events()).filter((e) => e.t >= t1)
    const starts = ev.filter((e) => e.n === 'answer:start' && e.p.sessionId === s2.id).map((e) => ({ id: e.p.answerId, t: e.t, trigger: e.p.trigger }))
    const ends = starts.map((st) => ev.find((e) => (e.n === 'answer:done' && e.p.id === st.id) || (e.n === 'answer:error' && e.p.answerId === st.id)))
    const q2 = h.logLines().filter((l) => l.sessionId === s2.id && l.event === 'candidate_queued')
    report.queue = { starts: starts.length, ends: ends.map((e) => e?.n + (e?.p.endReason ? `:${e.p.endReason}` : '')), secondStartAfterFirstEnd: starts[1] && ends[0] ? starts[1].t >= ends[0].t : null, queuedLogs: q2.length }
    expect.soft(starts.length, 'Q-01 both questions answered').toBe(2)
    expect.soft(ends[0]?.n, 'Q-01 the first (slow) auto answer was not cancelled').toBe('answer:done')
    expect.soft(q2.length, 'Q-01 the second candidate was queued').toBeGreaterThan(0)
    expect.soft(starts[1] && ends[0] ? starts[1].t >= ends[0].t : false, 'Q-01 the queued answer starts after the first finishes').toBe(true)
    await h.call('sessions.end', { id: s2.id, mode: 'end' })

    // ---------- per-session budget: autoMaxPerSession = 1 ----------
    const set = await h.call('settings.update', { autoPolicy: { autoMaxPerSession: 1 } })
    expect.soft(set.ok, `B-01 settings accept autoPolicy (${set.error})`).toBe(true)
    h.setScript({ default: { firstTokenMs: 300, chunkMs: 40 } })
    const s3 = await h.createSession({ autoGenerate: true, model: 'openai:gpt' })
    await h.goLive(s3.id)
    await h.feedSlot(['q03', 6000, 'q06'], 30_000)
    const b = h.requests(s3.id).filter((r) => r.trigger === 'auto').length
    const bg = (await h.call('answers.gateStatus', { sessionId: s3.id })).value
    const bReasons = h.logLines().filter((l) => l.sessionId === s3.id && l.event === 'candidate_suppressed').map((l) => l.reason)
    report.budget = { autoRequests: b, gate: bg?.auto, reasons: bReasons }
    expect.soft(b, 'B-01 1 auto request with a budget of 1').toBe(1)
    expect.soft(bReasons, 'B-01 next candidate suppressed budget').toContain('budget')
    expect.soft(bg?.auto, 'B-01 auto shows paused_budget').toBe('paused_budget')
    const bm = await h.gen(s3.id, 'answer', { force: true })
    expect.soft(bm.value?.outcome, 'B-01 manual still works after the budget').toBe('started')
    await h.waitEnd(bm.value?.answerId)
    await h.call('settings.update', { autoPolicy: { autoMaxPerSession: 100 } })
    await h.call('sessions.end', { id: s3.id, mode: 'end' })

    expect.soft(h.realRequests().length, 'zero real provider calls').toBe(0)
    expect.soft(h.errors, 'no console errors').toEqual([])
  } finally {
    writeFileSync(join(WORK, 'report-caps.json'), JSON.stringify(report, null, 2))
    await h.close()
  }
})
