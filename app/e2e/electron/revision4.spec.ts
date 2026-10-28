// Architecture revision 4 smoke (A6), scripted fake provider, 0 real provider calls.
// A build-stage check of the deterministic paths: BUG-006 auth state, BUG-011 short
// questions, BUG-012 question outcomes, the opt-in fallback switch and stage timings.
// /replica-test owns the full A6 run and the request-count verification.
import { expect, test } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Harness, WORK, type FakeStep } from './harness'

const FILE = join(WORK, 'report-revision4.json')
const save = (k: string, v: unknown) => {
  const cur = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {}
  cur[k] = v
  writeFileSync(FILE, JSON.stringify(cur, null, 2))
}

const FAST: FakeStep = { firstTokenMs: 200, chunkMs: 20 }
const PRIMARY = 'gemini-3.5-flash-lite' // google:gemini-flash-lite, pinned for live answers (providers.ts LIVE_MODEL_IDS)
const FALLBACK = 'gpt-5-mini' // openai:gpt-mini
const ends = (h: Harness, sessionId: string) => h.logLines().filter((l) => l.event === 'candidate_end' && l.sessionId === sessionId)
const gate = async (h: Harness, sessionId: string) => (await h.call('answers.gateStatus', { sessionId })).value

test('AR-01/02/04/05 + AR-03: rejected key is auth_failed, never quota; region 403 is not auth', async () => {
  const h = await new Harness('r4-auth').launch()
  const r: Record<string, unknown> = {}
  try {
    h.setScript({ default: FAST, steps: [{ error: 'auth_invalid_400' }] })
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    const s = await h.createSession({ autoGenerate: true })
    await h.goLive(s.id)
    await h.feedSlot(['q01'], 9000)
    const g1 = await gate(h, s.id)
    r.afterAuth = { calls: h.requests(s.id).length, auto: g1?.auto, provider: g1?.provider }
    expect.soft(h.requests(s.id).length, 'AR-01 one call, no retry').toBe(1)
    expect.soft(g1?.provider, 'AR-01 provider auth_failed').toBe('auth_failed')
    expect.soft(g1?.auto, 'AR-01 auto paused_auth').toBe('paused_auth')
    const press = await h.gen(s.id, 'chat', { text: 'What is a CDN?' })
    await h.feedSlot(['q03'], 9000)
    const g2 = await gate(h, s.id)
    r.whileBlocked = { press: press.value, calls: h.requests(s.id).length, lastReason: g2?.last?.reason, ends: ends(h, s.id).map((e) => [e.outcome, e.reason]) }
    expect.soft(press.value?.reason, 'AR-02 manual reason auth_failed').toBe('auth_failed')
    expect.soft(h.requests(s.id).length, 'AR-02 0 calls while blocked').toBe(1)
    expect.soft(ends(h, s.id).some((e) => e.reason === 'auth_failed'), 'AR-02 auto candidate_end auth_failed').toBe(true)
    const quotaWords = h.logText().split('\n').filter((l) => l.includes(s.id) && l.includes('quota_exhausted')).length
    r.quotaMentions = quotaWords
    expect.soft(quotaWords, 'AR-01 "quota_exhausted" 0 times for a rejected key').toBe(0)
    // AR-04: a new key lifts the block at once
    await h.call('keys.set', { provider: 'google', key: 'AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE00' })
    await h.page.waitForTimeout(800)
    const g3 = await gate(h, s.id)
    r.afterKey = { auto: g3?.auto, provider: g3?.provider }
    expect.soft(g3?.auto, 'AR-04 auto on within 1 s').toBe('on')
    // AR-03: a region 403 isn't auth; the provider stays usable
    h.setScript({ default: FAST, steps: [{ error: 'region_403' }] })
    await h.feedSlot(['q05'], 10_000)
    const g4 = await gate(h, s.id)
    r.afterRegion = { provider: g4?.provider, calls: h.requests(s.id).length }
    expect.soft(g4?.provider, 'AR-03 region 403 leaves the provider ok').toBe('ok')
    await h.feedSlot(['q08'], 10_000)
    r.afterRegionNext = { calls: h.requests(s.id).length }
    expect.soft(h.requests(s.id).length, 'AR-03 the next question is answered').toBe(3)
    await h.call('sessions.end', { id: s.id, mode: 'leave' })
  } finally {
    save('auth', r)
    await h.close()
  }
})

test('AR-06/09: short question after an answer needs one press; no new speech or a repeat makes no call', async () => {
  const h = await new Harness('r4-short').launch()
  const r: Record<string, unknown> = {}
  try {
    h.setScript({ default: FAST })
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    const s = await h.createSession({ autoGenerate: false })
    await h.goLive(s.id)
    await h.feed(['s3', 3500])
    const a1 = await h.gen(s.id, 'answer')
    await h.waitEnd(a1.value?.answerId)
    await h.feed(['s1', 3500])
    const a2 = await h.gen(s.id, 'answer')
    await h.waitEnd(a2.value?.answerId)
    await h.page.waitForTimeout(2500) // past the 2 s "press again to regenerate" window
    const a3 = await h.gen(s.id, 'answer')
    await h.page.waitForTimeout(2500)
    await h.feed(['s1', 3500])
    const a4 = await h.gen(s.id, 'answer')
    r.presses = [a1.value?.outcome, a2.value?.outcome, a3.value?.outcome, a4.value?.outcome]
    r.reasons = [a3.value?.reason, a4.value?.reason]
    r.calls = h.requests(s.id).length
    expect.soft(a2.value?.outcome, 'AR-06 one press answers "What is polymorphism?" after an answer').toBe('started')
    expect.soft(a3.value?.outcome, 'AR-09 no new speech: reused').toBe('reused')
    expect.soft(a4.value?.outcome, 'AR-09 the same short question again: reused').toBe('reused')
    expect.soft(h.requests(s.id).length, 'calls').toBe(2)
    await h.call('sessions.end', { id: s.id, mode: 'leave' })
  } finally {
    save('short', r)
    await h.close()
  }
})

test('AR-07: a short question auto-answers on a fresh call; AR-22 timing record on the row', async () => {
  const h = await new Harness('r4-shortauto').launch()
  const r: Record<string, unknown> = {}
  try {
    h.setScript({ default: FAST })
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    const s = await h.createSession({ autoGenerate: true })
    await h.goLive(s.id)
    await h.feedSlot(['s1'], 10_000)
    const calls1 = h.requests(s.id).length
    // informational: the second clip depends on what the recogniser writes ("Define" vs "Defined")
    await h.feedSlot(['s2'], 10_000)
    const finals = (await h.events()).filter((e) => e.n === 'transcript:final').map((e) => e.p.text)
    const list = ((await h.call('answers.list', { sessionId: s.id })).value ?? []) as any[]
    r.s1Calls = calls1
    r.s2 = { final: finals.at(-1), calls: h.requests(s.id).length - calls1 }
    r.timing = list.map((a) => a.timing)
    expect.soft(calls1, 'AR-07 "What is polymorphism?" alone: one auto answer').toBe(1)
    const t = list[0]?.timing
    for (const k of ['sttMs', 'settleMs', 'gateWaitMs', 'buildMs', 'headerMs', 'streamMs']) expect.soft(typeof t?.[k], `AR-22 timing.${k}`).toBe('number')
    expect.soft(Array.isArray(t?.ttftMs) && typeof t.ttftMs[0] === 'number', 'AR-22 timing.ttftMs per attempt').toBe(true)
    expect.soft(h.logLines().some((l) => l.event === 'answer_timing' && l.sessionId === s.id), 'AR-22 answer_timing logged').toBe(true)
    await h.call('sessions.end', { id: s.id, mode: 'leave' })
  } finally {
    save('shortAuto', r)
    await h.close()
  }
})

test('AR-11: questions asked during a slow answer are merged, none dropped silently', async () => {
  const h = await new Harness('r4-merge').launch()
  const r: Record<string, unknown> = {}
  try {
    h.setScript({ default: FAST, steps: [{ firstTokenMs: 23_000, chunkMs: 40 }] })
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    const s = await h.createSession({ autoGenerate: true })
    await h.goLive(s.id)
    await h.feed(['q03', 2500, 'q05', 2500, 'q08', 40_000])
    const cands = h.logLines().filter((l) => l.event === 'candidate' && l.sessionId === s.id)
    const e = ends(h, s.id)
    const byId = new Map<string, number>()
    for (const x of e) byId.set(x.candidateId, (byId.get(x.candidateId) ?? 0) + 1)
    const g = await gate(h, s.id)
    r.candidates = cands.length
    r.ends = e.map((x) => ({ outcome: x.outcome, reason: x.reason ?? null, into: x.into ? 'yes' : null }))
    r.calls = h.requests(s.id).length
    r.counts = g?.counts
    expect.soft(cands.length, 'three questions detected').toBe(3)
    expect.soft(e.length, 'AR-11 one candidate_end per candidate').toBe(cands.length)
    expect.soft([...byId.values()].every((n) => n === 1), 'AR-11 exactly one terminal each').toBe(true)
    expect.soft(e.filter((x) => x.outcome === 'merged').length, 'AR-11 q05 merged into q08').toBe(1)
    expect.soft(h.requests(s.id).length, 'AR-11 two calls (q03, then q05+q08)').toBe(2)
    expect.soft(g?.counts?.merged, 'AR-11 gate:status counts.merged').toBe(1)
    await h.call('sessions.end', { id: s.id, mode: 'leave' })
  } finally {
    save('merge', r)
    await h.close()
  }
})

test('AR-15/16/17/18/20/21: fallback switch rules (chat path)', async () => {
  const h = await new Harness('r4-fallback').launch()
  const r: Record<string, unknown> = {}
  const req = (sid: string) => h.requests(sid)
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    // AR-21: fallback off (default): an overload retries the primary as Built, no switch
    expect((await h.call('settings.get')).value.answerRouting.fallbackModel, 'fallback off by default').toBeNull()
    h.setScript({ default: FAST, models: { [PRIMARY]: { steps: [{ error: 'overloaded' }], default: FAST } } })
    const s = await h.createSession({ autoGenerate: false })
    await h.goLive(s.id)
    const off = await h.gen(s.id, 'chat', { text: 'What is a mutex?' })
    await h.waitEnd(off.value?.answerId)
    r.off = { calls: req(s.id).map((x) => x.model), routes: h.logLines().filter((l) => l.event === 'answer_route').length }
    expect.soft(req(s.id).map((x) => x.model), 'AR-21 off: primary twice (Built 1.5 s retry)').toEqual(['google:gemini-flash-lite', 'google:gemini-flash-lite'])

    await h.call('settings.update', { answerRouting: { fallbackModel: 'openai:gpt-mini', fallbackAfterMs: 6000 } })
    const n = () => req(s.id).length
    // AR-15: no first token from the primary by 6 s → switch, same answer
    h.setScript({ default: FAST, models: { [PRIMARY]: { default: { firstTokenMs: 30_000 } }, [FALLBACK]: { default: FAST } } })
    await h.page.waitForTimeout(1600)
    const before = n()
    const a = await h.gen(s.id, 'chat', { text: 'What is a semaphore?' })
    const end = await h.waitEnd(a.value?.answerId, 20_000)
    const rows = req(s.id).slice(before)
    const slow = h.logLines().find((l) => l.event === 'provider_slow' && l.answerId === a.value?.answerId)
    const starts = (await h.events()).filter((e) => e.n === 'answer:start' && e.p.answerId === a.value?.answerId).length
    const row = (await h.call('answers.get', { answerId: a.value?.answerId })).value
    r.slow = { end: end?.n, calls: rows.map((x) => x.model), switchAfterMs: slow && rows[0] ? slow.t - rows[0].t : null, starts, servedModel: row?.servedModel, reason: row?.fallbackReason, attempts: row?.attempts, fbAfterSlow: slow && rows[1] ? rows[1].t - slow.t : null }
    expect.soft(end?.n, 'AR-15 done').toBe('answer:done')
    expect.soft(rows.map((x) => x.model), 'AR-15 primary then fallback').toEqual(['google:gemini-flash-lite', 'openai:gpt-mini'])
    expect.soft(Math.abs((r.slow as any).switchAfterMs - 6000), 'AR-15 switch at 6.0 s ± 0.2 s').toBeLessThanOrEqual(200)
    expect.soft(starts, 'AR-15 one visible answer').toBe(1)
    expect.soft(row?.servedModel, 'AR-15 served_model').toBe('openai:gpt-mini')
    expect.soft((r.slow as any).fbAfterSlow, 'AR-15 fallback request only after the primary ended').toBeGreaterThanOrEqual(0)

    // AR-18: break after the first token → no switch, no retry, interrupted
    h.setScript({ default: FAST, models: { [PRIMARY]: { default: { firstTokenMs: 100, chunkMs: 30, failAfterChunks: 3 } }, [FALLBACK]: { default: FAST } } })
    await h.page.waitForTimeout(1600)
    const b18 = n()
    const a18 = await h.gen(s.id, 'chat', { text: 'What is a race condition?' })
    const e18 = await h.waitEnd(a18.value?.answerId)
    r.midStream = { end: e18?.p?.code, calls: req(s.id).slice(b18).map((x) => x.model) }
    expect.soft(e18?.p?.code, 'AR-18 interrupted').toBe('interrupted')
    expect.soft(req(s.id).slice(b18).map((x) => x.model), 'AR-18 one call, no switch').toEqual(['google:gemini-flash-lite'])

    // AR-16: primary 503 before the token → immediate switch, not a 1.5 s retry
    h.setScript({ default: FAST, models: { [PRIMARY]: { default: { error: 'overloaded' } }, [FALLBACK]: { default: FAST } } })
    await h.page.waitForTimeout(1600)
    const b16 = n()
    const a16 = await h.gen(s.id, 'chat', { text: 'What is a deadlock?' })
    await h.waitEnd(a16.value?.answerId)
    const r16 = req(s.id).slice(b16)
    r.overload = { calls: r16.map((x) => x.model), gapMs: r16[1] && r16[0] ? r16[1].t - r16[0].t : null }
    expect.soft(r16.map((x) => x.model), 'AR-16 switch on 503').toEqual(['google:gemini-flash-lite', 'openai:gpt-mini'])
    expect.soft((r.overload as any).gapMs, 'AR-16 no 1.5 s wait').toBeLessThan(1000)
    // while the primary cools after that 503, the next request goes straight to the fallback
    await h.page.waitForTimeout(1600)
    const bc = n()
    const ac = await h.gen(s.id, 'chat', { text: 'What is a livelock?' })
    await h.waitEnd(ac.value?.answerId)
    r.whileCooling = { outcome: ac.value?.outcome, calls: req(s.id).slice(bc).map((x) => x.model) }
    expect.soft(req(s.id).slice(bc).map((x) => x.model), 'cooling primary: fallback only').toEqual(['openai:gpt-mini'])

    // AR-17: daily quota → no automatic switch; the user's one press uses the fallback
    await h.page.waitForTimeout(15_500) // the primary's 15 s overload cooling ends
    h.setScript({ default: FAST, models: { [PRIMARY]: { default: { error: 'quota_exhausted' } }, [FALLBACK]: { default: FAST } } })
    await h.page.waitForTimeout(500)
    const b17 = n()
    const a17 = await h.gen(s.id, 'chat', { text: 'What is a thread pool?' })
    const e17 = await h.waitEnd(a17.value?.answerId)
    const calls17 = req(s.id).slice(b17).length
    await h.page.waitForTimeout(1600)
    const p17 = await h.gen(s.id, 'chat', { text: 'What is a thread pool, briefly?', useFallback: true })
    await h.waitEnd(p17.value?.answerId)
    r.quota = { code: e17?.p?.code, offer: e17?.p?.fallbackModel, callsBefore: calls17, press: p17.value?.outcome, after: req(s.id).slice(b17).map((x) => x.model) }
    expect.soft(e17?.p?.code, 'AR-17 quota_exhausted').toBe('quota_exhausted')
    expect.soft(calls17, 'AR-17 one call, no switch').toBe(1)
    expect.soft(e17?.p?.fallbackModel, 'AR-17 the card offers the fallback').toBe('openai:gpt-mini')
    expect.soft(req(s.id).slice(b17).map((x) => x.model), 'AR-17 the press uses the fallback').toEqual(['google:gemini-flash-lite', 'openai:gpt-mini'])
    await h.call('sessions.end', { id: s.id, mode: 'leave' })
  } finally {
    save('fallback', r)
    await h.close()
  }
})

test('AR-19/20: fallback also slow → timeout, no third attempt; sticky after 2 slow switches', async () => {
  const h = await new Harness('r4-sticky').launch()
  const r: Record<string, unknown> = {}
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    await h.call('settings.update', { answerRouting: { fallbackModel: 'openai:gpt-mini', fallbackAfterMs: 3000 } })
    const s = await h.createSession({ autoGenerate: false })
    await h.goLive(s.id)
    // AR-19
    h.setScript({ default: FAST, models: { [PRIMARY]: { default: { firstTokenMs: 30_000 } }, [FALLBACK]: { default: { firstTokenMs: 30_000 } } } })
    await h.page.waitForTimeout(500)
    const a = await h.gen(s.id, 'chat', { text: 'What is a heap?' })
    const e = await h.waitEnd(a.value?.answerId, 40_000)
    r.bothSlow = { code: e?.p?.code, calls: h.requests(s.id).map((x) => x.model) }
    expect.soft(e?.p?.code, 'AR-19 timeout').toBe('timeout')
    expect.soft(h.requests(s.id).length, 'AR-19 two calls, no third').toBe(2)
    // AR-20: that was slow switch 1; one more, then the next request skips the primary
    h.setScript({ default: FAST, models: { [PRIMARY]: { default: { firstTokenMs: 30_000 } }, [FALLBACK]: { default: FAST } } })
    await h.page.waitForTimeout(1600)
    const b = await h.gen(s.id, 'chat', { text: 'What is a stack?' })
    await h.waitEnd(b.value?.answerId, 20_000)
    await h.page.waitForTimeout(1600)
    const before = h.requests(s.id).length
    const c = await h.gen(s.id, 'chat', { text: 'What is a queue?' })
    await h.waitEnd(c.value?.answerId, 20_000)
    r.sticky = { third: h.requests(s.id).slice(before).map((x) => x.model) }
    expect.soft(h.requests(s.id).slice(before).map((x) => x.model), 'AR-20 straight to the fallback').toEqual(['openai:gpt-mini'])
    await h.call('sessions.end', { id: s.id, mode: 'leave' })
  } finally {
    save('sticky', r)
    await h.close()
  }
})
