// Real-time answer latency, stage by stage (replica/test-plan.md §11, LAT-01..05), with
// the scripted fake provider, so provider time is fixed and everything else is the app.
// Times come from main's structured log (candidate, candidate_queued/_suppressed,
// provider_request, answer_end) and main's send time of answer:* events, joined by
// answerId / order; speech end is the last voiced 10 ms of each clip. Nothing here
// records transcript, prompt or answer text. Zero real provider calls.
import { expect, test } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Harness, WORK, type FakeStep } from './harness'

type Row = Record<string, number | string | null>
// Merged into the file after every test: a failed test restarts the worker and its memory.
const FILE = join(WORK, 'report-latency.json')
const report = new Proxy({} as Record<string, unknown>, {
  set(_t, k, v) {
    const cur = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {}
    cur[k as string] = v
    writeFileSync(FILE, JSON.stringify(cur, null, 2))
    return true
  },
})

const FAST: FakeStep = { firstTokenMs: 300, chunkMs: 40 }
const med = (xs: Array<number | null>) => {
  const v = xs.filter((x): x is number => typeof x === 'number').sort((a, b) => a - b)
  return v.length ? { n: v.length, median: v[Math.floor((v.length - 1) / 2)]!, min: v[0]!, max: v.at(-1)! } : null
}

/** Per answer: main-side timeline from the logs and the tapped answer:* sends. */
async function timeline(h: Harness, sessionId: string) {
  const logs = h.logLines().filter((l) => l.sessionId === sessionId)
  const mainEv = await h.mainEvents()
  const vis = (await h.page.evaluate(() => (window as any).__vis)) as Record<string, number>
  const starts = mainEv.filter((e) => e.n === 'answer:start')
  return {
    logs,
    answers: starts.map((st) => {
      const id = st.id
      const req = logs.find((l) => l.event === 'provider_request' && l.answerId === id)
      const end = logs.find((l) => l.event === 'answer_end' && l.answerId === id)
      const firstQ = mainEv.find((e) => e.n === 'answer:delta' && e.id === id)
      const firstA = mainEv.find((e) => e.n === 'answer:delta' && e.id === id && e.part === 'answer')
      const done = mainEv.find((e) => (e.n === 'answer:done' || e.n === 'answer:error') && e.id === id)
      return { id, startAt: st.t, reqAt: req?.t ?? null, firstChunkAt: firstQ?.t ?? null, firstAnswerAt: firstA?.t ?? null, visibleAt: vis[id] ?? null, doneAt: done?.t ?? null, status: end?.status ?? null, reason: end?.reason ?? null, trigger: end?.trigger ?? null }
    }),
  }
}

const d = (a: number | null | undefined, b: number | null | undefined) => (typeof a === 'number' && typeof b === 'number' ? a - b : null)

test('LAT-01 isolated auto questions: every stage', async () => {
  const h = await new Harness('lat01').launch()
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    h.setScript({ default: FAST })
    const s = await h.createSession({ autoGenerate: true })
    await h.goLive(s.id)
    const clips = ['q01', 'q03', 'q05', 'q08', 'q09', 'q06']
    const marks: Record<string, number> = {}
    // 16 s apart: past the 8 s cooldown and under 4 auto starts per minute (LAT-06 covers the cap)
    for (const c of clips) Object.assign(marks, await h.feedSlot([c], 16_000))
    await h.page.waitForTimeout(1500)
    const ev = await h.events()
    const { logs, answers } = await timeline(h, s.id)
    const cands = logs.filter((l) => l.event === 'candidate')
    const rows: Row[] = clips.map((c) => {
      const se = marks[c]!
      const fin = ev.filter((e) => e.n === 'transcript:final' && e.p.speaker === 'them' && e.t > se - 500 && e.t < se + 6000).at(-1)
      const cand = cands.find((l) => l.t >= (fin?.t ?? se) - 20 && l.t < se + 8000)
      const a = answers.find((x) => x.startAt >= (cand?.t ?? Infinity) - 5 && x.startAt < (cand?.t ?? 0) + 3000)
      return {
        clip: c,
        speechEndToFinal: d(fin?.t, se),
        finalToCandidate: d(cand?.t, fin?.t),
        candidateToGateAccept: d(a?.startAt, cand?.t),
        acceptToRequest: d(a?.reqAt, a?.startAt),
        requestToFirstChunk: d(a?.firstChunkAt, a?.reqAt),
        firstChunkToFirstAnswerText: d(a?.firstAnswerAt, a?.firstChunkAt),
        firstAnswerTextToVisible: d(a?.visibleAt, a?.firstAnswerAt),
        firstChunkToComplete: d(a?.doneAt, a?.firstChunkAt),
        speechEndToVisible: d(a?.visibleAt, se),
        status: a?.status ?? 'no answer',
      }
    })
    const keys = Object.keys(rows[0]!).filter((k) => k !== 'clip' && k !== 'status')
    report.lat01 = { provider: FAST, suppressed: logs.filter((l) => l.event === 'candidate_suppressed').map((l) => l.reason), rows, summary: Object.fromEntries(keys.map((k) => [k, med(rows.map((r) => r[k] as number | null))])) }
    expect.soft(rows.filter((r) => r.status === 'done').length, 'every isolated question answered').toBe(clips.length)
    await h.call('sessions.end', { id: s.id, mode: 'leave' })
  } finally {
    await h.close()
  }
})

test('LAT-02 second question while the first is answering: queue + 8 s cooldown', async () => {
  const h = await new Harness('lat02').launch()
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    // q1's answer streams for ~4 s, so q2's candidate arrives while it's in flight.
    h.setScript({ steps: [{ firstTokenMs: 1500, chunkMs: 250 }], default: FAST })
    const s = await h.createSession({ autoGenerate: true })
    await h.goLive(s.id)
    const marks = await h.feed(['q03', 3000, 'q05', 22_000])
    const { logs, answers } = await timeline(h, s.id)
    const cands = logs.filter((l) => l.event === 'candidate')
    const queued = logs.filter((l) => l.event === 'candidate_queued')
    const [a1, a2] = answers
    report.lat02 = {
      candidates: cands.length,
      queuedLogs: queued.length,
      suppressed: logs.filter((l) => l.event === 'candidate_suppressed').map((l) => l.reason),
      q1: { candidateToAccept: d(a1?.startAt, cands[0]?.t), firstChunkToComplete: d(a1?.doneAt, a1?.firstChunkAt), speechEndToVisible: d(a1?.visibleAt, marks.q03) },
      q2: {
        candidateToAccept: d(a2?.startAt, cands[1]?.t),
        q1DoneToQ2Accept: d(a2?.startAt, a1?.doneAt),
        q1AcceptToQ2Accept: d(a2?.startAt, a1?.startAt),
        speechEndToVisible: d(a2?.visibleAt, marks.q05),
        status: a2?.status ?? 'no answer',
      },
    }
    expect.soft(a2?.status, 'q2 eventually answered').toBe('done')
    await h.call('sessions.end', { id: s.id, mode: 'leave' })
  } finally {
    await h.close()
  }
})

test('LAT-03 slow provider (22–24 s first token, as measured on 2026-10-28): head-of-line blocking', async () => {
  const h = await new Harness('lat03').launch()
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    h.setScript({ steps: [{ firstTokenMs: 23_000, chunkMs: 40 }, { firstTokenMs: 23_000, chunkMs: 40 }], default: FAST })
    const s = await h.createSession({ autoGenerate: true })
    await h.goLive(s.id)
    // three questions about 4 s apart while the first answer hasn't started streaming
    const marks = await h.feed(['q03', 2500, 'q05', 2500, 'q08', 45_000])
    const { logs, answers } = await timeline(h, s.id)
    const cands = logs.filter((l) => l.event === 'candidate')
    report.lat03 = {
      provider: '23 s first token for the first 2 requests',
      candidates: cands.length,
      queuedLogs: logs.filter((l) => l.event === 'candidate_queued').length,
      suppressed: logs.filter((l) => l.event === 'candidate_suppressed').map((l) => l.reason),
      answers: answers.map((a, i) => ({ n: i + 1, status: a.status, candidateToAccept: i === 0 ? d(a.startAt, cands[0]?.t) : null, acceptToFirstChunk: d(a.firstChunkAt, a.startAt) })),
      speechEndToVisible: { q03: d(answers[0]?.visibleAt, marks.q03), lastAnswered: answers.length > 1 ? d(answers.at(-1)?.visibleAt, marks.q08) : null },
      questionsAnswered: answers.filter((a) => a.status === 'done').length,
      questionsAsked: 3,
    }
    await h.call('sessions.end', { id: s.id, mode: 'leave' })
  } finally {
    await h.close()
  }
})

test('LAT-04 manual Answer right after speech skips final + settling', async () => {
  const h = await new Harness('lat04').launch()
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    h.setScript({ default: FAST })
    const s = await h.createSession({ autoGenerate: false })
    await h.goLive(s.id)
    const rows: Row[] = []
    for (const c of ['q01', 'q03', 'q05']) {
      const marks = await h.feed([c, 300])
      const pressAt = Date.now()
      const r = await h.gen(s.id, 'answer')
      const id = r.value?.answerId
      await h.waitEnd(id)
      await h.page.waitForTimeout(300)
      const { answers } = await timeline(h, s.id)
      const a = answers.find((x) => x.id === id)
      rows.push({ clip: c, outcome: r.value?.outcome ?? r.error ?? null, speechEndToPress: pressAt - marks[c]!, pressToAccept: d(a?.startAt, pressAt), acceptToFirstChunk: d(a?.firstChunkAt, a?.startAt), speechEndToVisible: d(a?.visibleAt, marks[c]) })
      await h.feed([3000]) // let the final land before the next clip
    }
    report.lat04 = { rows, pressToAccept: med(rows.map((r) => r.pressToAccept as number)), speechEndToVisible: med(rows.map((r) => r.speechEndToVisible as number)) }
    expect.soft(rows.every((r) => r.outcome === 'started'), 'each press started a request').toBe(true)
    await h.call('sessions.end', { id: s.id, mode: 'leave' })
  } finally {
    await h.close()
  }
})

test('LAT-05 manual press supersedes a slow auto answer at once', async () => {
  const h = await new Harness('lat05').launch()
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    h.setScript({ steps: [{ firstTokenMs: 15_000, chunkMs: 40 }], default: FAST })
    const s = await h.createSession({ autoGenerate: true })
    await h.goLive(s.id)
    await h.feed(['q03', 4000]) // auto starts and waits on the slow provider
    const pressAt = Date.now()
    const r = await h.gen(s.id, 'answer', { force: true })
    await h.waitEnd(r.value?.answerId)
    await h.page.waitForTimeout(300)
    const { answers, logs } = await timeline(h, s.id)
    const manual = answers.find((a) => a.id === r.value?.answerId)
    report.lat05 = {
      outcome: r.value?.outcome,
      autoEnded: answers[0]?.status,
      autoReason: answers[0]?.reason,
      pressToAccept: d(manual?.startAt, pressAt),
      pressToVisible: d(manual?.visibleAt, pressAt),
      requests: logs.filter((l) => l.event === 'provider_request').length,
    }
    expect.soft(answers[0]?.status, 'auto cancelled').toBe('cancelled')
    expect.soft(manual?.status, 'manual done').toBe('done')
    await h.call('sessions.end', { id: s.id, mode: 'leave' })
  } finally {
    await h.close()
  }
})

test('LAT-06 questions 12 s apart: the 4-per-minute auto cap drops the 5th', async () => {
  const h = await new Harness('lat06').launch()
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    h.setScript({ default: FAST })
    const s = await h.createSession({ autoGenerate: true })
    await h.goLive(s.id)
    for (const c of ['q01', 'q03', 'q05', 'q08', 'q09']) await h.feedSlot([c], 12_000)
    await h.page.waitForTimeout(1500)
    const { logs, answers } = await timeline(h, s.id)
    report.lat06 = {
      asked: 5,
      candidates: logs.filter((l) => l.event === 'candidate').length,
      answered: answers.filter((a) => a.status === 'done').length,
      suppressed: logs.filter((l) => l.event === 'candidate_suppressed').map((l) => l.reason),
    }
    await h.call('sessions.end', { id: s.id, mode: 'leave' })
  } finally {
    await h.close()
  }
})
