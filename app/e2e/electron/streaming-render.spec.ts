// BUG-013 diagnosis (replica/test-plan.md §12): does an answer render progressively, or
// only when it completes? Fake provider only, 0 real calls. The fake sends fixed-size
// chunks every `chunkMs`, so each block below is padded to exactly CHUNK characters:
// chunk 1 = QUESTION header, chunk 2 = definition, chunk 3 = explanation, chunk 4 = code.
// A MutationObserver records when each block's marker first appears in the answer card.
import { expect, test } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Harness, WORK } from './harness'

const CHUNK = 160
const FILE = join(WORK, 'report-streaming.json')
const save = (k: string, v: unknown) => {
  const cur = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {}
  cur[k] = v
  writeFileSync(FILE, JSON.stringify(cur, null, 2))
}

/** Pad a block to exactly CHUNK characters, keeping its line ending. */
function pad(block: string, tail = '\n\n'): string {
  const body = block.replace(/\n+$/, '')
  if (body.length + tail.length > CHUNK) throw new Error(`block too long: ${body.length}`)
  return body + ' '.repeat(CHUNK - body.length - tail.length) + tail
}

const HEADER = pad('QUESTION: What is a closure in JavaScript?', '\n---\n')
const DEF = pad('**Definition.** DEFMARK A closure is a function that keeps access to the variables of the scope it was created in.')
const EXPL = pad('**Why it matters.** EXPLMARK It lets a function carry private state, which is how counters, caches and handlers work.')
const CODE = pad('```js\nfunction counter() { let n = 0; return () => ++n } // CODEMARK\n```', '\n')
const TEXT = HEADER + DEF + EXPL + CODE

async function watch(h: Harness) {
  await h.page.evaluate(() => {
    const w = window as any
    w.__marks = {}
    const obs = new MutationObserver(() => {
      const body = document.querySelector('[aria-label="Answer text"]')
      const t = body?.textContent ?? ''
      for (const m of ['DEFMARK', 'EXPLMARK', 'CODEMARK']) if (t.includes(m) && !w.__marks[m]) w.__marks[m] = Date.now()
    })
    obs.observe(document.body, { subtree: true, childList: true, characterData: true })
  })
}

async function run(h: Harness, sessionId: string, text: string) {
  await watch(h)
  const t0 = Date.now()
  const r = await h.gen(sessionId, 'chat', { text: 'What is a closure?' })
  const id = r.value?.answerId
  // what the user sees while waiting for the first token
  await h.page.waitForTimeout(4000)
  const chip = (await h.page.getByRole('toolbar', { name: 'Call controls' }).getByRole('status').first().textContent().catch(() => null))?.trim()
  const end = await h.waitEnd(id, 40_000)
  await h.page.waitForTimeout(300)
  const marks = (await h.page.evaluate(() => (window as any).__marks)) as Record<string, number>
  const main = (await h.mainEvents()).filter((e) => e.id === id)
  const firstQ = main.find((e) => e.n === 'answer:delta' && e.part === 'question')?.t
  const answerDeltas = main.filter((e) => e.n === 'answer:delta' && e.part === 'answer')
  const done = main.find((e) => e.n === 'answer:done')?.t
  const row = (await h.call('answers.get', { answerId: id })).value
  return { end: end?.n, t0, chipAt4s: chip, firstQ, answerDeltas: answerDeltas.map((d) => d.t), done, marks, timing: row?.timing, latencyMs: row?.latencyMs, md: (row?.answerMd ?? '').length, textLen: text.length }
}

test('SR-01 progressive: definition, explanation and code appear 1.5 s apart, not at completion', async () => {
  const h = await new Harness('stream-prog').launch()
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    h.setScript({ default: { text: TEXT, firstTokenMs: 300, chunkChars: CHUNK, chunkMs: 1500 } })
    const s = await h.createSession({ autoGenerate: false })
    await h.goLive(s.id)
    const r = await run(h, s.id, TEXT)
    const m = r.marks
    const out = {
      ...r,
      defToExplMs: m.EXPLMARK && m.DEFMARK ? m.EXPLMARK - m.DEFMARK : null,
      explToCodeMs: m.CODEMARK && m.EXPLMARK ? m.CODEMARK - m.EXPLMARK : null,
      defBeforeDoneMs: r.done && m.DEFMARK ? r.done - m.DEFMARK : null,
      mainToDomFirstMs: r.answerDeltas[0] && m.DEFMARK ? m.DEFMARK - r.answerDeltas[0] : null,
    }
    save('progressive', out)
    expect.soft(r.end, 'done').toBe('answer:done')
    expect.soft(out.mainToDomFirstMs ?? 999, 'SR-01a first answer text in the DOM within 100 ms of main sending it').toBeLessThanOrEqual(100)
    expect.soft(Math.abs((out.defToExplMs ?? 0) - 1500), 'SR-01b explanation ~1.5 s after the definition').toBeLessThanOrEqual(150)
    expect.soft(Math.abs((out.explToCodeMs ?? 0) - 1500), 'SR-01c code ~1.5 s after the explanation').toBeLessThanOrEqual(150)
    expect.soft(out.defBeforeDoneMs ?? 0, 'SR-01d the definition is visible well before the answer completes').toBeGreaterThanOrEqual(2500)
    await h.call('sessions.end', { id: s.id, mode: 'leave' })
  } finally {
    await h.close()
  }
})

test('SR-02 the real-meeting shape: 12 s to first token, then ~750 characters in ~0.74 s', async () => {
  const h = await new Harness('stream-burst').launch()
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    // 186 output tokens ≈ 750 characters; 18 chunks of 42 characters every 40 ms ≈ 0.74 s.
    h.setScript({ default: { text: TEXT, firstTokenMs: 12_000, chunkChars: 42, chunkMs: 40 } })
    const s = await h.createSession({ autoGenerate: false })
    await h.goLive(s.id)
    const r = await run(h, s.id, TEXT)
    const m = r.marks
    const vis = Object.values(m)
    const out = { ...r, firstToLastMarkMs: vis.length ? Math.max(...vis) - Math.min(...vis) : null, requestToFirstMarkMs: vis.length ? Math.min(...vis) - r.t0 : null, deltasSent: r.answerDeltas.length }
    save('burst', out)
    expect.soft(r.end, 'done').toBe('answer:done')
    expect.soft(out.deltasSent, 'SR-02a the app still sends many deltas (it streams)').toBeGreaterThan(5)
    expect.soft(out.firstToLastMarkMs ?? 9999, 'SR-02b but the whole answer appears within ~1 s: the burst is the provider').toBeLessThanOrEqual(1000)
    await h.call('sessions.end', { id: s.id, mode: 'leave' })
  } finally {
    await h.close()
  }
})
