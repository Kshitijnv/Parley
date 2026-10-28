// Revision 5 verification (test-plan.md §14), fake provider, 0 real calls. For three
// answer shapes it measures, per section: when main sent it (tap on webContents.send) and
// when it became visible (an in-page interval sampler). It reports time to first visible
// useful content (the lead) separately from provider time to first token and from total
// completion, and checks each section appears exactly once, in order.
import { expect, test } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Harness, WORK } from './harness'

const CHUNK = 160
const FILE = join(WORK, 'report-verify-progressive.json')
const save = (k: string, v: unknown) => {
  const cur = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {}
  cur[k] = v
  writeFileSync(FILE, JSON.stringify(cur, null, 2))
}
function pad(block: string, tail = '\n\n'): string {
  const body = block.replace(/\n+$/, '')
  if (body.length + tail.length > CHUNK) throw new Error(`block too long: ${body.length}`)
  return body + ' '.repeat(CHUNK - body.length - tail.length) + tail
}
const HEADER = pad('QUESTION: What is polymorphism, and how would you implement it in C#?', '\n---\n')
const LEAD = pad('M_LEAD Polymorphism lets one interface stand for many forms: a call runs the method of the object’s real type.')
const EXPL = [1, 2, 3, 4, 5, 6].map((i) => pad(`M_EXPL${i} In C# you declare a virtual or abstract member on a base type and override it in derived types; callers use the base type.`))
const CODE = [
  pad('```csharp\nabstract class Shape { public abstract double Area(); } // M_CODE', '\n'),
  pad('class Circle : Shape { public double R; public override double Area() => Math.PI * R * R; }', '\n'),
  pad('class Square : Shape { public double S; public override double Area() => S * S; } // M_END\n```', '\n'),
]
const LONG = HEADER + LEAD + EXPL.join('') + CODE.join('')
const MARKS = ['M_LEAD', 'M_EXPL1', 'M_EXPL3', 'M_EXPL6', 'M_CODE', 'M_END']
const SIMPLE = 'QUESTION: What is polymorphism?\n---\nM_LEAD Polymorphism means one interface, many implementations: the object’s real type decides which method runs. M_END'

async function instrument(h: Harness) {
  // main: when each marker was sent to the window
  await h.app.evaluate(({ BrowserWindow }) => {
    const g = globalThis as any
    g.__sent = []
    const w = BrowserWindow.getAllWindows()[0]!
    const wc = w.webContents as any
    if (wc.__verifyTapped) return
    wc.__verifyTapped = true
    const orig = wc.send.bind(wc)
    wc.send = (ch: string, name: string, p: any) => {
      if (ch === 'event' && name === 'answer:delta' && p?.part === 'answer') g.__sent.push({ t: Date.now(), id: p.answerId, offset: p.offset, len: p.text.length, text: p.text, marks: (p.text.match(/M_[A-Z0-9]+/g) ?? []) })
      if (ch === 'event' && (name === 'answer:done' || name === 'answer:error')) g.__sent.push({ t: Date.now(), id: p.answerId ?? p.id, end: name })
      return orig(ch, name, p)
    }
  })
  // renderer: when each marker became visible
  await h.page.evaluate(() => {
    const w = window as any
    clearInterval(w.__vTimer)
    w.__seen = {}
    w.__vTimer = setInterval(() => {
      const t = document.querySelector('[aria-label="Answer text"]')?.textContent ?? ''
      for (const m of t.match(/M_[A-Z0-9]+/g) ?? []) w.__seen[m] ??= Date.now()
    }, 10)
  })
}

async function measure(h: Harness, sessionId: string, question: string) {
  await instrument(h)
  const t0 = Date.now()
  const r = await h.gen(sessionId, 'chat', { text: question })
  const id = r.value?.answerId as string
  const end = await h.waitEnd(id, 40_000)
  await h.page.waitForTimeout(300)
  const sent = ((await h.app.evaluate(() => (globalThis as any).__sent)) as any[]).filter((x) => x.id === id)
  const seen = (await h.page.evaluate(() => (window as any).__seen)) as Record<string, number>
  const finalText = ((await h.page.getByLabel('Answer text').textContent()) ?? '')
  const row = (await h.call('answers.get', { answerId: id })).value
  const sentAt: Record<string, number> = {}
  for (const s of sent) for (const m of s.marks ?? []) sentAt[m] ??= s.t
  const doneAt = sent.find((x) => x.end)?.t
  const found = finalText.match(/M_[A-Z0-9]+/g) ?? []
  // offsets contiguous: no gap and no overlap in what main sent
  let len = 0
  let contiguous = true
  for (const s of sent.filter((x) => x.len !== undefined)) {
    if (s.offset !== len) contiguous = false
    len += s.len
  }
  return {
    end: end?.n,
    providerTtftMs: row?.timing?.ttftMs?.[0] ?? null,
    firstVisibleUsefulMs: seen.M_LEAD ? seen.M_LEAD - t0 : null,
    completionMs: doneAt ? doneAt - t0 : null,
    leadVisibleBeforeDoneMs: seen.M_LEAD && doneAt ? doneAt - seen.M_LEAD : null,
    sections: Object.fromEntries(Object.keys(sentAt).map((m) => [m, { sentMs: sentAt[m]! - t0, visibleMs: seen[m] ? seen[m]! - t0 : null, sentToVisibleMs: seen[m] ? seen[m]! - sentAt[m]! : null }])),
    markersInFinalDom: found,
    duplicates: found.length !== new Set(found).size,
    contiguousOffsets: contiguous,
    sentChars: len,
    storedChars: (row?.answerMd ?? '').length,
    // the engine stores the answer trimmed (Built); the streamed text must equal it after trimming
    streamedEqualsStored: sent.filter((x) => x.text !== undefined).map((x) => x.text).join('').trim() === (row?.answerMd ?? '').trim(),
    timing: row?.timing,
  }
}

test('V-1..V-3: time to first useful content vs provider TTFT vs completion; sections once, in order', async () => {
  const h = await new Harness('verify-pd').launch()
  const out: Record<string, any> = {}
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    const s = await h.createSession({ autoGenerate: false })
    await h.goLive(s.id)

    // V-1 simple: one short paragraph, fast provider
    h.setScript({ default: { text: SIMPLE, firstTokenMs: 300, chunkChars: 24, chunkMs: 30 } })
    await h.page.waitForTimeout(300)
    out.simple = await measure(h, s.id, 'What is polymorphism?')
    out.simple.blocks = await h.page.locator('[aria-label="Answer text"] .md-block').count()
    out.simple.leadStyled = (await h.page.locator('[aria-label="Answer text"] .md-lead').count()) === 1
    out.simple.moreBelowShown = await h.page.getByRole('button', { name: 'More below' }).isVisible().catch(() => false)

    // V-2 long: lead, 6 explanation paragraphs, a 3-chunk C# fence, a chunk every 500 ms
    h.setScript({ default: { text: LONG, firstTokenMs: 300, chunkChars: CHUNK, chunkMs: 500 } })
    await h.page.waitForTimeout(300)
    out.long = await measure(h, s.id, 'What is polymorphism, and how would you implement it in C#?')

    // V-3 the real-meeting shape: 12 s to first token, then the whole answer in ~0.6 s
    h.setScript({ default: { text: LONG, firstTokenMs: 12_000, chunkChars: 42, chunkMs: 40 } })
    await h.page.waitForTimeout(300)
    out.burst = await measure(h, s.id, 'Polymorphism in C#, with code?')
    await h.call('sessions.end', { id: s.id, mode: 'leave' })
  } finally {
    save('run', out)
    await h.close()
  }
  const { simple, long, burst } = out
  // simple
  expect.soft(simple.end, 'V-1 done').toBe('answer:done')
  expect.soft(simple.blocks, 'V-1 a simple answer stays one block (no forced sections)').toBe(1)
  expect.soft(simple.leadStyled, 'V-1 the lead is marked').toBe(true)
  expect.soft(simple.moreBelowShown, 'V-1 no "More below" for a short answer').toBe(false)
  // long: lead before the rest finishes; every section once and in order; ≤ 100 ms send → visible
  expect.soft(long.end, 'V-2 done').toBe('answer:done')
  expect.soft(long.leadVisibleBeforeDoneMs, 'V-2 the lead is visible ≥ 4 s before completion').toBeGreaterThanOrEqual(4000)
  for (const m of MARKS) expect.soft(long.sections[m]?.sentToVisibleMs ?? 999, `V-2 ${m} visible ≤ 100 ms after main sent it`).toBeLessThanOrEqual(100)
  expect.soft(long.markersInFinalDom, 'V-2 every section once, in order').toEqual(['M_LEAD', 'M_EXPL1', 'M_EXPL2', 'M_EXPL3', 'M_EXPL4', 'M_EXPL5', 'M_EXPL6', 'M_CODE', 'M_END'])
  expect.soft(long.contiguousOffsets, 'V-2 no gap or overlap in deltas').toBe(true)
  expect.soft(long.streamedEqualsStored, 'V-2 streamed text = stored text (after trimming)').toBe(true)
  expect.soft(simple.streamedEqualsStored && burst.streamedEqualsStored, 'V-1/V-3 streamed text = stored text').toBe(true)
  // burst: first useful content tracks provider TTFT, not the app
  expect.soft(burst.end, 'V-3 done').toBe('answer:done')
  expect.soft((burst.firstVisibleUsefulMs ?? 0) - (burst.providerTtftMs ?? 0), 'V-3 lead visible ≤ 300 ms after the provider\'s first token').toBeLessThanOrEqual(300)
  expect.soft(burst.markersInFinalDom.length, 'V-3 all sections once').toBe(9)
  expect.soft(burst.duplicates, 'V-3 no duplicates').toBe(false)
})
