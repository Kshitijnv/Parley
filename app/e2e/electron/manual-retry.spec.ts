// Acceptance criteria §13 #4 (no new material), #6 (429 handling), #8 (interrupted
// stream), #7 (supersede), #10 (no secrets in logs), plus the §6 retry table rows for
// 503, offline, auth and timeout, cancel, Chat and clientRequestId dedupe. Fake provider
// only: zero Gemini calls. Every failure path uses its own catalog model id so provider
// health (cooling / exhausted / auth) from one case can't leak into another.
import { expect, test } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Harness, SENTINEL, WORK } from './harness'

test('manual answers, retries, quota, streaming and logs (fake provider)', async () => {
  const h = await new Harness('manual').launch()
  const report: Record<string, unknown> = {}
  const step = (name: string, v: unknown) => (report[name] = v)
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    h.setScript({ default: { firstTokenMs: 200, chunkMs: 30 } })

    // sentinel in the key, the resume, the instructions; later a typed question and a transcript line (§13 #10)
    await h.call('keys.set', { provider: 'google', key: `AIzaFAKE-${SENTINEL}-key` })
    const resume = await h.call('resumes.createFromText', { title: 'Sentinel CV', text: `Backend engineer ${SENTINEL}. Built APIs in C# for five years.` })
    expect(resume.ok, resume.error).toBe(true)

    // ---------------- Session B: manual paths on flash-lite ----------------
    const B = await h.createSession({ autoGenerate: false, resumeId: resume.value.id, instructions: `Be brief. ${SENTINEL}` })
    await h.goLive(B.id)

    // nothing said yet: no call
    const empty = await h.gen(B.id, 'answer')
    expect.soft(empty.value?.outcome, 'M-01 Answer with an empty transcript is suppressed').toBe('suppressed')
    expect.soft(h.requests(B.id).length, 'M-01 0 calls').toBe(0)

    // #4: Answer, Answer again (no new speech) -> reused; press again within 2 s -> regenerate
    await h.feedSlot(['q03'], 6000)
    const a1 = await h.gen(B.id, 'answer')
    await h.waitEnd(a1.value?.answerId)
    const r1 = h.requests(B.id).length
    await h.page.waitForTimeout(2200) // past the manual 1.5 s double-click window
    const a2 = await h.gen(B.id, 'answer')
    expect.soft(a2.value?.outcome, '#4 second press with no new speech -> reused').toBe('reused')
    expect.soft(a2.value?.reason, '#4 reason no_new_material').toBe('no_new_material')
    expect.soft(a2.value?.answerId, '#4 reused returns the latest answer').toBe(a1.value?.answerId)
    expect.soft(h.requests(B.id).length - r1, '#4 0 calls for the reused press').toBe(0)
    await h.page.waitForTimeout(600)
    const a3 = await h.gen(B.id, 'answer')
    await h.waitEnd(a3.value?.answerId)
    expect.soft(a3.value?.outcome, '#4 a second press 0.6 s later regenerates').toBe('started')
    expect.soft(h.requests(B.id).length - r1, '#4 double press (force) -> 1 more call (2 total)').toBe(1)
    step('criterion4', { a1: a1.value, a2: a2.value, a3: a3.value, totalCalls: h.requests(B.id).length })

    // a key repeat (< 0.3 s) after "nothing new" doesn't count as a deliberate second press
    await h.page.waitForTimeout(2500)
    const k1 = await h.gen(B.id, 'answer')
    const k2 = await h.gen(B.id, 'answer')
    const rK = h.requests(B.id).length
    expect.soft([k1.value?.outcome, k2.value?.outcome], 'M-02 key repeat within 0.3 s -> reused, reused').toEqual(['reused', 'reused'])
    expect.soft(h.requests(B.id).length - rK, 'M-02 0 calls').toBe(0)

    // repeated invoke with the same clientRequestId -> reused, 0 calls
    await h.feedSlot(['q05'], 6000)
    const cid = crypto.randomUUID()
    const rC = h.requests(B.id).length
    const c1 = await h.call('answers.generate', { sessionId: B.id, trigger: 'answer', clientRequestId: cid })
    const c2 = await h.call('answers.generate', { sessionId: B.id, trigger: 'answer', clientRequestId: cid })
    await h.waitEnd(c1.value?.answerId)
    expect.soft(c2.value?.outcome, 'M-03 same clientRequestId -> reused').toBe('reused')
    expect.soft(c2.value?.answerId, 'M-03 same answerId').toBe(c1.value?.answerId)
    expect.soft(h.requests(B.id).length - rC, 'M-03 1 call').toBe(1)

    // double click on Answer with new speech (two distinct clicks 50 ms apart) -> 1 call
    await h.feedSlot(['q06'], 6000)
    const rD = h.requests(B.id).length
    const [d1, d2] = await Promise.all([h.gen(B.id, 'answer'), h.page.waitForTimeout(50).then(() => h.gen(B.id, 'answer'))])
    await h.waitEnd(d1.value?.answerId)
    expect.soft(h.requests(B.id).length - rD, `M-04 double click -> 1 call (${d1.value?.outcome}/${d2.value?.outcome})`).toBe(1)
    expect.soft(d2.value?.answerId, 'M-04 second click points at the same answer').toBe(d1.value?.answerId)

    // #6a: per-minute 429 with retryDelay 5 s -> exactly one retry, at least 5 s later
    h.setScript({ default: { firstTokenMs: 200, chunkMs: 30 }, steps: [{ error: 'rate_limited', retryAfterS: 5 }] })
    await h.feedSlot(['q08'], 6000)
    const rM = h.requests(B.id).length
    const m429 = await h.gen(B.id, 'answer')
    const end429 = await h.waitEnd(m429.value?.answerId, 30_000)
    const att = h.requests(B.id).slice(rM)
    const row429 = (await h.call('answers.get', { answerId: m429.value?.answerId })).value
    step('criterion6_minute_manual', { attempts: att.length, gapMs: att.length === 2 ? att[1].t - att[0].t : null, status: row429?.status, rowAttempts: row429?.attempts })
    expect.soft(att.length, '#6 per-minute: exactly 2 attempts (1 retry)').toBe(2)
    expect.soft(att.length === 2 ? att[1].t - att[0].t : 0, '#6 retry at least 5 s later').toBeGreaterThanOrEqual(5000)
    expect.soft(end429?.n, '#6 then succeeds').toBe('answer:done')
    expect.soft(row429?.attempts, '#6 attempts column = 2').toBe(2)

    // per-minute 429 with a long retry (40 s): no retry, fail rate_limited with the real retryAt, then no call while cooling
    h.setScript({ default: { firstTokenMs: 200, chunkMs: 30 }, steps: [{ error: 'rate_limited', retryAfterS: 40 }] })
    await h.feedSlot(['q09'], 6000)
    const rL = h.requests(B.id).length
    const mLong = await h.gen(B.id, 'answer')
    const endLong = await h.waitEnd(mLong.value?.answerId)
    await h.feedSlot(['q10'], 6000)
    const cool = await h.gen(B.id, 'answer')
    const forced = await h.gen(B.id, 'answer', { force: true })
    step('rate_limited_long', { error: endLong?.p, cool: cool.value, forced: forced.value, calls: h.requests(B.id).length - rL })
    expect.soft(endLong?.p.code, 'R-01 long retryDelay -> fail rate_limited, no retry').toBe('rate_limited')
    expect.soft(Math.abs((endLong?.p.retryAt ?? 0) - Date.now() - 40_000) < 15_000, 'R-01 retryAt is the real retry time (~40 s)').toBe(true)
    expect.soft(cool.value?.reason, 'R-02 next press while cooling -> suppressed cooling').toBe('cooling')
    expect.soft(forced.value?.reason, 'R-02 force does not bypass cooling').toBe('cooling')
    expect.soft(h.requests(B.id).length - rL, 'R-01/R-02 1 call in total').toBe(1)
    await h.call('sessions.end', { id: B.id, mode: 'end' })

    // ---------------- Session S: streaming paths on flash ----------------
    h.setScript({ default: { firstTokenMs: 200, chunkMs: 30 } })
    const S = await h.createSession({ autoGenerate: false, model: 'google:gemini-flash' })
    await h.goLive(S.id)

    // 503 once -> one retry after ~1.5 s, then success
    h.setScript({ default: { firstTokenMs: 200, chunkMs: 30 }, steps: [{ error: 'overloaded' }] })
    await h.feedSlot(['q01'], 7000)
    const r5 = h.requests(S.id).length
    const o1 = await h.gen(S.id, 'answer')
    const oEnd = await h.waitEnd(o1.value?.answerId)
    const oAtt = h.requests(S.id).slice(r5)
    step('overloaded_once', { attempts: oAtt.length, gapMs: oAtt[1] ? oAtt[1].t - oAtt[0].t : null, end: oEnd?.n })
    expect.soft(oAtt.length, 'R-03 503: 2 attempts').toBe(2)
    expect.soft(oAtt[1] ? oAtt[1].t - oAtt[0].t : 0, 'R-03 backoff ~1.5 s').toBeGreaterThanOrEqual(1100)
    expect.soft(oEnd?.n, 'R-03 then succeeds').toBe('answer:done')

    // #8 interrupted after 3 chunks -> partial kept, interrupted, no retry; Retry links retry_of
    await h.page.waitForTimeout(15_500) // the 503 cooled flash for 15 s
    h.setScript({ default: { firstTokenMs: 200, chunkMs: 30 }, steps: [{ failAfterChunks: 3, chunkMs: 40, chunkChars: 24 }] })
    await h.feedSlot(['q02a', 1200, 'q02b'], 8000)
    const rI = h.requests(S.id).length
    const i1 = await h.gen(S.id, 'answer')
    const iEnd = await h.waitEnd(i1.value?.answerId)
    const rowI = (await h.call('answers.get', { answerId: i1.value?.answerId })).value
    const gateI = (await h.call('answers.gateStatus', { sessionId: S.id })).value
    expect.soft(iEnd?.p.code, '#8 code interrupted').toBe('interrupted')
    expect.soft(rowI?.endReason, '#8 end_reason interrupted').toBe('interrupted')
    expect.soft((rowI?.answerMd ?? '').length, '#8 partial text kept').toBeGreaterThan(0)
    expect.soft(h.requests(S.id).length - rI, '#8 no automatic retry').toBe(1)
    expect.soft(gateI?.provider, '#8 an interruption does not cool the model').toBe('ok')
    await expect.soft(h.page.getByRole('alert'), '#8 the panel says interrupted').toContainText(/interrupted/i)
    await expect.soft(h.page.getByLabel('Answer text'), '#8 the partial text stays visible').toContainText(/Fake provider|QUESTION|direct/i)
    h.setScript({ default: { firstTokenMs: 200, chunkMs: 30 } })
    const retry = await h.gen(S.id, 'answer', { retryOf: i1.value?.answerId })
    await h.waitEnd(retry.value?.answerId)
    const rowR = (await h.call('answers.get', { answerId: retry.value?.answerId })).value
    step('criterion8', { code: iEnd?.p.code, endReason: rowI?.endReason, kept: rowI?.answerMd?.length, retry: retry.value, retryOf: rowR?.retryOf })
    expect.soft(retry.value?.outcome, '#8 Retry starts a new answer').toBe('started')
    expect.soft(rowR?.retryOf, '#8 retry_of = the interrupted answer').toBe(i1.value?.answerId)

    // supersede (#7): a newer request cancels the one in flight; no events after; newest stays current
    h.setScript({ default: { firstTokenMs: 100, chunkMs: 150, chunkChars: 8 } })
    const s1 = await h.gen(S.id, 'chat', { text: `Explain eventual consistency ${SENTINEL}` })
    await h.until((ev) => ev.some((e) => e.n === 'answer:delta' && e.p.answerId === s1.value?.answerId), 10_000, 50)
    const s2 = await h.gen(S.id, 'chat', { text: 'What is a covering index?' })
    const s1err = await h.until((ev) => ev.find((e) => e.n === 'answer:error' && e.p.answerId === s1.value?.answerId), 5000, 50)
    await h.waitEnd(s2.value?.answerId, 30_000)
    const ev = await h.events()
    const late = ev.filter((e) => e.n.startsWith('answer:') && (e.p.answerId ?? e.p.id) === s1.value?.answerId && e.t > (s1err?.t ?? 0)).length
    const mainLate = (await h.mainEvents()).filter((e) => e.id === s1.value?.answerId && e.t > (s1err?.t ?? 0)).length
    const rowS1 = (await h.call('answers.get', { answerId: s1.value?.answerId })).value
    const label = await h.page.getByLabel(/^Answer \d+ of \d+$/).getAttribute('aria-label')
    step('supersede', { endReason: s1err?.p.endReason, late, mainLate, s1Status: rowS1?.status, keptChars: rowS1?.answerMd?.length, label })
    expect.soft(s1err?.p.endReason, '#7 superseded').toBe('superseded')
    expect.soft(late + mainLate, '#7 no events after cancellation').toBe(0)
    expect.soft(rowS1?.status, '#7 superseded row cancelled').toBe('cancelled')
    expect.soft((rowS1?.answerMd ?? '').length, '#7 superseded partial text kept').toBeGreaterThan(0)
    expect.soft(label && /Answer (\d+) of \1$/.test(label), `#7 newest is current (${label})`).toBe(true)

    // Chat: identical text within 3 s -> reused
    h.setScript({ default: { firstTokenMs: 100, chunkMs: 30 } })
    const rCh = h.requests(S.id).length
    const ch1 = await h.gen(S.id, 'chat', { text: 'What is CQRS?' })
    const ch2 = await h.gen(S.id, 'chat', { text: 'What is CQRS?' })
    await h.waitEnd(ch1.value?.answerId)
    expect.soft(ch2.value?.outcome, 'M-05 identical chat within 3 s -> reused').toBe('reused')
    expect.soft(h.requests(S.id).length - rCh, 'M-05 1 call').toBe(1)

    // Stop: user cancel keeps the partial text and shows Stopped
    h.setScript({ default: { firstTokenMs: 100, chunkMs: 200, chunkChars: 8 } })
    const st = await h.gen(S.id, 'chat', { text: 'Explain sharding' })
    await h.until((ev) => ev.filter((e) => e.n === 'answer:delta' && e.p.answerId === st.value?.answerId && e.p.part === 'answer').length >= 2, 10_000, 50)
    await h.page.getByRole('button', { name: 'Stop' }).click()
    const stErr = await h.until((ev) => ev.find((e) => e.n === 'answer:error' && e.p.answerId === st.value?.answerId), 5000, 50)
    await expect.soft(h.page.getByText('Stopped', { exact: true }), 'M-06 Stopped badge').toBeVisible()
    expect.soft(stErr?.p.endReason, 'M-06 user_cancel').toBe('user_cancel')
    expect.soft((stErr?.p.partial ?? '').length, 'M-06 partial kept').toBeGreaterThan(0)

    // timeout: no first token in 25 s -> fail timeout, no automatic retry
    h.setScript({ default: { firstTokenMs: 100, chunkMs: 30 }, steps: [{ hang: true }] })
    const rT = h.requests(S.id).length
    const tq = await h.gen(S.id, 'chat', { text: 'What is a bloom filter?' })
    const tEnd = await h.waitEnd(tq.value?.answerId, 40_000)
    step('timeout', { code: tEnd?.p.code, calls: h.requests(S.id).length - rT })
    expect.soft(tEnd?.p.code, 'R-04 hang -> timeout').toBe('timeout')
    expect.soft(h.requests(S.id).length - rT, 'R-04 no automatic retry').toBe(1)
    await h.call('sessions.end', { id: S.id, mode: 'end' })

    // ---------------- three unclassified 429s -> exhausted (gpt-mini) ----------------
    h.setScript({ default: { firstTokenMs: 100, chunkMs: 30 }, steps: [{ error: 'unclassified_429', retryAfterS: 1 }, { error: 'unclassified_429', retryAfterS: 1 }, { error: 'unclassified_429', retryAfterS: 1 }] })
    const U = await h.createSession({ autoGenerate: false, model: 'openai:gpt-mini' })
    await h.goLive(U.id)
    const u1 = await h.gen(U.id, 'chat', { text: 'What is a monad?' }) // attempt 1 + 1 retry (retryDelay 1 s)
    await h.waitEnd(u1.value?.answerId)
    await h.page.waitForTimeout(1300)
    const u2 = await h.gen(U.id, 'chat', { text: 'What is a functor?' }) // third 429
    const u2End = await h.waitEnd(u2.value?.answerId)
    const u3 = await h.gen(U.id, 'chat', { text: 'What is an applicative?' })
    const gU = (await h.call('answers.gateStatus', { sessionId: U.id })).value
    step('three_unclassified', { calls: h.requests(U.id).length, u2: u2End?.p.code, u3: u3.value, provider: gU?.provider })
    expect.soft(h.requests(U.id).length, '#6 three unclassified 429s = 3 calls').toBe(3)
    expect.soft(gU?.provider, '#6 then the model counts as exhausted').toBe('exhausted')
    expect.soft(u3.value?.outcome, '#6 next request: no call').toBe('suppressed')
    await h.call('sessions.end', { id: U.id, mode: 'end' })

    // ---------------- daily quota with auto on (claude-haiku) ----------------
    h.setScript({ default: { firstTokenMs: 100, chunkMs: 30 }, steps: [{ error: 'quota_exhausted', retryAfterS: 84735 }] })
    const Q = await h.createSession({ autoGenerate: true, model: 'anthropic:claude-haiku' })
    await h.goLive(Q.id)
    const qAuto = h.feedSlot(['q03'], 9000)
    const qStart = await h.until((ev) => ev.find((e) => e.n === 'answer:start' && e.p.sessionId === Q.id)?.p, 15_000)
    const qEnd = await h.waitEnd(qStart?.answerId)
    await qAuto
    const rQ = h.requests(Q.id).length
    await h.feedSlot(['q05'], 9000) // a new question while exhausted: auto makes no call
    const qm = await h.gen(Q.id, 'answer') // manual: no call either
    const gQ = (await h.call('answers.gateStatus', { sessionId: Q.id })).value
    const autoSupp = h.logLines().filter((l) => l.event === 'candidate_suppressed' && l.sessionId === Q.id).map((l) => l.reason)
    const chip = await h.page.getByRole('status').filter({ hasText: /./ }).first().getAttribute('aria-label').catch(() => null)
    step('criterion6_daily', { firstCalls: rQ, error: qEnd?.p, afterCalls: h.requests(Q.id).length - rQ, manual: qm.value, gate: gQ, autoSupp, chip })
    expect.soft(rQ, '#6 daily quota: 1 call, 0 retries').toBe(1)
    expect.soft(qEnd?.p.code, '#6 code quota_exhausted').toBe('quota_exhausted')
    expect.soft(/daily limit/i.test(qEnd?.p.message ?? ''), `#6 clear message: "${qEnd?.p.message}"`).toBe(true)
    expect.soft(qEnd?.p.retryAt, '#6 the reset time is not claimed').toBeUndefined()
    expect.soft(h.requests(Q.id).length - rQ, '#6 no more calls (auto or manual)').toBe(0)
    expect.soft(gQ?.auto, '#6 auto paused').toBe('paused_quota')
    expect.soft(autoSupp, '#6 auto candidate suppressed quota_exhausted').toContain('quota_exhausted')
    expect.soft(qm.value?.reason, '#6 manual suppressed quota_exhausted').toBe('quota_exhausted')
    await h.call('sessions.end', { id: Q.id, mode: 'end' })

    // ---------------- auth and offline (groq) ----------------
    h.setScript({ default: { firstTokenMs: 100, chunkMs: 30 }, steps: [{ error: 'offline' }, { error: 'auth' }] })
    const N = await h.createSession({ autoGenerate: false, model: 'groq:llama-instant' })
    await h.goLive(N.id)
    const off = await h.gen(N.id, 'chat', { text: 'What is TCP slow start?' })
    const offEnd = await h.waitEnd(off.value?.answerId)
    const gOff = (await h.call('answers.gateStatus', { sessionId: N.id })).value
    const au = await h.gen(N.id, 'chat', { text: 'What is a CDN?' }) // offline: manual still tries
    const auEnd = await h.waitEnd(au.value?.answerId)
    const au2 = await h.gen(N.id, 'chat', { text: 'What is DNS?' })
    step('offline_auth', { off: offEnd?.p.code, gOff: gOff?.provider, auth: auEnd?.p.code, au2: au2.value, calls: h.requests(N.id).length })
    expect.soft(offEnd?.p.code, 'R-05 offline -> fail offline, no retry').toBe('offline')
    expect.soft(gOff?.provider, 'R-05 health offline').toBe('offline')
    expect.soft(auEnd?.p.code, 'R-06 manual tries while offline; 401 -> auth').toBe('auth')
    expect.soft(au2.value?.outcome, 'R-06 provider blocked after 401: no call').toBe('suppressed')
    expect.soft(h.requests(N.id).length, 'R-05/R-06 2 calls in total, no retries').toBe(2)
    await h.call('sessions.end', { id: N.id, mode: 'end' })

    // ---------------- transcript-line sentinel via the mock interviewer, auto on ----------------
    h.setScript({ default: { firstTokenMs: 100, chunkMs: 30, text: `What would you do about ${SENTINEL} in production?` } })
    const M = await h.createSession({ autoGenerate: true, model: 'anthropic:claude-sonnet' })
    await h.goLive(M.id)
    const mq = await h.call('mock.nextQuestion', { sessionId: M.id })
    const mStart = await h.until((ev) => ev.find((e) => e.n === 'answer:start' && e.p.sessionId === M.id)?.p, 10_000)
    await h.waitEnd(mStart?.answerId)
    step('mock', { injected: mq.ok, autoAnswered: !!mStart })
    expect.soft(mq.ok, `S-01 mock question injected (${mq.error})`).toBe(true)
    expect.soft(!!mStart, 'S-01 the injected mock question is answered automatically').toBe(true)
    await h.call('sessions.end', { id: M.id, mode: 'end' })

    // ---------------- #10: the sentinel never reaches logs, stdout or stderr ----------------
    await h.page.waitForTimeout(500)
    const logs = h.logText()
    const inLogs = (logs.match(new RegExp(SENTINEL, 'g')) ?? []).length
    const inOut = (h.stdout.match(new RegExp(SENTINEL, 'g')) ?? []).length
    step('criterion10', { inLogs, inOut, logBytes: logs.length })
    expect.soft(inLogs, '#10 sentinel in log files').toBe(0)
    expect.soft(inOut, '#10 sentinel in stdout/stderr').toBe(0)
    expect.soft(/dependency|garbage|versioning|process and a thread|eventual consistency/i.test(logs), '#10 no transcript or question text in logs').toBe(false)
    expect.soft(h.realRequests().length, 'zero real provider calls').toBe(0)
    expect.soft(h.errors, 'no console errors').toEqual([])
  } finally {
    writeFileSync(join(WORK, 'report-manual.json'), JSON.stringify(report, null, 2))
    await h.close()
  }
})
