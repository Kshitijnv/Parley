// Acceptance criteria §13 #1 (one request per question), #2 (settling), #3 (cross-path
// dedupe), #7 (streaming), #11 (English model status) and #13 (latency report), with
// real-time synthetic speech through the real local English model and the scripted fake
// provider: zero Gemini calls. Default auto policy (8 s cooldown, 4 a minute).
import { expect, test } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Harness, WORK } from './harness'

const QUESTIONS: Array<{ id: string; parts: Array<string | number>; must: RegExp[] }> = [
  { id: 'q01', parts: ['q01'], must: [/dependency injection/i] },
  { id: 'q02', parts: ['q02a', 1200, 'q02b'], must: [/REST API/i, /versioning/i] },
  { id: 'q03', parts: ['q03'], must: [/process/i, /thread/i] },
  { id: 'q04', parts: ['q04a', 1200, 'q04b'], must: [/tell me about a time/i, /conflict/i] },
  { id: 'q05', parts: ['q05'], must: [/garbage/i] },
  { id: 'q06', parts: ['q06'], must: [/shortener/i] },
  { id: 'q07', parts: ['q07a', 1200, 'q07b'], must: [/describe/i, /index/i] },
  { id: 'q08', parts: ['q08'], must: [/message/i] },
  { id: 'q09', parts: ['q09'], must: [/theorem/i] },
  { id: 'q10', parts: ['q10'], must: [/unit tests/i] },
]
const NON = ['n1', 'n2', 'n3', 'n4', 'n5']
const SLOT_MS = 17_000

test('auto pipeline: §13 #1 #2 #3 #7 #11 #13 (fake provider, real speech model)', async () => {
  const h = await new Harness('auto').launch()
  const report: Record<string, unknown> = {}
  try {
    h.setScript({ default: { firstTokenMs: 300, chunkMs: 40 } })
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    const s = await h.createSession({ autoGenerate: true })
    const prep = await h.goLive(s.id)

    // #11: status reports what the worker actually loaded.
    expect.soft(prep.modelId, '#11 modelId').toBe('en-kroko-2025-08-06')
    expect.soft(prep.language, '#11 language').toBe('en')
    expect.soft(typeof prep.loadMs, '#11 loadMs').toBe('number')
    report.stt = { modelId: prep.modelId, language: prep.language, loadMs: prep.loadMs }

    // ---------- #1 + #2: 10 questions (3 split by a 1.2 s pause) and 5 non-questions ----------
    const r0 = h.requests(s.id).length
    const perQ: any[] = []
    for (let i = 0; i < QUESTIONS.length; i++) {
      const q = QUESTIONS[i]!
            const startsBefore = (await h.events()).filter((e) => e.n === 'answer:start').length
      const nonQ = i < NON.length ? NON[i]! : null
      const marks = await h.feedSlot([...q.parts, ...(nonQ ? [6000, nonQ] : [])], SLOT_MS)
      const speechEnd = marks[q.parts.filter((p) => typeof p === 'string').at(-1) as string]!
      const ev = await h.events()
      const starts = ev.filter((e) => e.n === 'answer:start').slice(startsBefore)
      const st = starts[0]?.p
      const finalEv = ev.find((e) => e.n === 'transcript:final' && e.p.speaker === 'them' && e.t > speechEnd - 4000 && q.must.at(-1)!.test(e.p.text))
      perQ.push({ id: q.id, starts: starts.length, triggers: starts.map((x) => x.p.trigger), draft: st?.questionDraft, answerId: st?.answerId, speechEnd, finalAt: finalEv?.t, startAt: starts[0]?.t, nonQ })
    }
    const ev = await h.events()
    const autoIds = perQ.map((p) => p.answerId).filter(Boolean)
    const reqs = h.requests(s.id).slice(r0)
    report.criterion1 = { perQ: perQ.map(({ id, starts, draft }) => ({ id, starts, draft })), providerRequests: reqs.length }
    expect.soft(reqs.length, '#1 provider requests == 10 distinct questions').toBe(10)
    for (const p of perQ) {
      expect.soft(p.starts, `#1 ${p.id} (+${p.nonQ ?? 'no non-question'}) answer starts`).toBe(1)
      expect.soft(p.triggers.every((t: string) => t === 'auto'), `#1 ${p.id} trigger auto`).toBe(true)
    }
    for (const id of autoIds) expect.soft(reqs.filter((r) => r.answerId === id).length, `#1 one attempt for ${id}`).toBe(1)
    // #2: the split questions arrive as one request with both halves.
    for (const q of QUESTIONS.filter((x) => x.parts.length > 1)) {
      const p = perQ.find((x) => x.id === q.id)
      for (const re of q.must) expect.soft(re.test(p?.draft ?? ''), `#2 ${q.id} draft has ${re}: "${p?.draft}"`).toBe(true)
    }
    // #1: the provider receives no partial text: every excerpt line of an auto answer is a final.
    const finals = ev.filter((e) => e.n === 'transcript:final').map((e) => `${e.p.speaker === 'you' ? 'You' : 'Them'}: ${e.p.text}`)
    const list = (await h.call('answers.list', { sessionId: s.id })).value as any[]
    for (const a of list.filter((x) => x.trigger === 'auto')) {
      const lines = String(a.transcriptExcerpt).split('\n').filter(Boolean)
      expect.soft(lines.length > 0 && lines.every((l) => finals.includes(l)), `#1 auto excerpt has finals only (${a.id})`).toBe(true)
    }

    // ---------- #7: streaming ----------
    const mainEv = await h.mainEvents()
    const vis: Record<string, number> = await h.page.evaluate(() => (window as any).__vis)
    const visLag: number[] = []
    for (const id of autoIds) {
      const firstChunk = mainEv.find((e) => e.n === 'answer:delta' && e.id === id && e.part === 'answer')
      if (firstChunk && vis[id]) visLag.push(vis[id]! - firstChunk.t)
      expect.soft(!!firstChunk && !!vis[id], `#7 auto answer ${id} visible while streaming`).toBe(true)
      // offsets are contiguous, so the store never needs a resync
      const ds = ev.filter((e) => e.n === 'answer:delta' && e.p.answerId === id && e.p.part === 'answer')
      let len = 0
      let gap = false
      for (const d of ds) {
        if (d.p.offset !== len) gap = true
        len += d.p.text.length
      }
      const done = ev.find((e) => e.n === 'answer:done' && e.p.id === id)
      expect.soft(gap, `#7 no offset gap (resync) for ${id}`).toBe(false)
      expect.soft(done?.p.answerMd?.length, `#7 streamed text equals stored text for ${id}`).toBe(len)
      const startT = ev.find((e) => e.n === 'answer:start' && e.p.answerId === id)!.t
      expect.soft(ds.every((d) => d.t >= startT), `#7 start precedes deltas for ${id}`).toBe(true)
      if (done) expect.soft(ds.at(0)!.t < done.t, `#7 first chunk renders before the stream finishes ${id}`).toBe(true)
    }
    visLag.sort((a, b) => a - b)
    report.criterion7 = { visibleLagMs: visLag, max: visLag.at(-1) }
    expect.soft(visLag.length, '#7 measured answers').toBeGreaterThanOrEqual(8)
    expect.soft(visLag.at(-1) ?? 999, '#7 first visible text within 100 ms of first chunk in main').toBeLessThanOrEqual(100)
    const panel = await h.page.getByLabel(/^Answer \d+ of \d+$/).getAttribute('aria-label')
    expect.soft(panel, '#7 the newest answer is current').toBe(`Answer ${list.length} of ${list.length}`)

    // ---------- #13 latency report ----------
    const logs = h.logLines()
    const lat = perQ.map((p) => {
      const cand = logs.find((l) => l.event === 'candidate' && l.sessionId === s.id && l.t >= (p.finalAt ?? 0) - 50 && l.t <= (p.startAt ?? 0) + 50)
      const req = logs.find((l) => l.event === 'provider_request' && l.answerId === p.answerId)
      const end = logs.find((l) => l.event === 'answer_end' && l.answerId === p.answerId)
      const first = mainEv.find((e) => e.n === 'answer:delta' && e.id === p.answerId)
      return {
        id: p.id,
        speechEndToFinal: p.finalAt ? p.finalAt - p.speechEnd : null,
        finalToCandidate: cand && p.finalAt ? cand.t - p.finalAt : null,
        candidateToRequest: cand && req ? req.t - cand.t : null,
        requestToFirstToken: end?.firstTokenMs ?? null,
        firstTokenToVisible: first && vis[p.answerId] ? vis[p.answerId] - first.t : null,
        speechEndToVisible: vis[p.answerId] ? vis[p.answerId] - p.speechEnd : null,
      }
    })
    report.criterion13 = lat
    report.criterion11 = { speechEndToFinalMs: lat.map((l) => l.speechEndToFinal) }

    // ---------- #3a: a question repeated word for word within 60 s: 0 extra requests ----------
    const r3 = h.requests(s.id).length
    await h.feedSlot(['q10'], 10_000)
    const dupDecision = h.logLines().filter((l) => l.event === 'gate_decision' && l.trigger === 'auto').at(-1)
    report.criterion3_repeat = { extraRequests: h.requests(s.id).length - r3, decision: dupDecision }
    expect.soft(h.requests(s.id).length - r3, '#3 verbatim repeat within 60 s: 0 extra requests').toBe(0)
    expect.soft(dupDecision?.reason, '#3 repeat suppressed as duplicate').toBe('duplicate')

    // ---------- #3b: Answer while auto streams the same question returns joined ----------
    await h.feedSlot([], 12_000) // let the per-minute window and cooldown pass
    h.setScript({ default: { firstTokenMs: 3000, chunkMs: 40 } })
    const r4 = h.requests(s.id).length
    const n4 = (await h.events()).filter((e) => e.n === 'answer:start').length
    const feeding = h.feedSlot(['c5'], 9000)
    const auto2 = await h.until((ev) => ev.filter((e) => e.n === 'answer:start').length > n4 && ev.filter((e) => e.n === 'answer:start').at(-1)!.p, 15_000)
    const joined = auto2 ? await h.gen(s.id, 'answer') : null
    await h.waitEnd(auto2?.answerId)
    await feeding
    report.criterion3_join = { joined: joined?.value, extraRequests: h.requests(s.id).length - r4 }
    expect.soft(auto2?.trigger, '#3 auto started').toBe('auto')
    expect.soft(joined?.value?.outcome, '#3 Answer during auto stream -> joined').toBe('joined')
    expect.soft(joined?.value?.answerId, '#3 joined returns the in-flight answerId').toBe(auto2?.answerId)
    expect.soft(h.requests(s.id).length - r4, '#3 0 extra requests').toBe(1)

    expect.soft(h.realRequests().length, 'zero real provider calls').toBe(0)
    expect.soft(h.errors, 'no console errors').toEqual([])
  } finally {
    writeFileSync(join(WORK, 'report-auto.json'), JSON.stringify(report, null, 2))
    await h.close()
  }
})
