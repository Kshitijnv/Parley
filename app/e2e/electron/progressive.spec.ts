// Revision 5 progressive answer delivery (architecture.md D6), fake provider, 0 real calls.
// The fake sends fixed-size chunks every `chunkMs`, so each block below is padded to
// exactly CHUNK characters and arrives at a known time. In-page samplers (every 50 ms)
// record what the answer card shows: lead visibility and position, scroll, block DOM
// identity, code-fence state and highlighting.
import { expect, test } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Harness, WORK } from './harness'

const CHUNK = 160
const FILE = join(WORK, 'report-progressive.json')
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
const LEAD = pad('LEADMARK Polymorphism lets one interface stand for many forms: a call runs the method of the object’s real type.')
const EXPL = Array.from({ length: 6 }, (_, i) => pad(`EXPL${i + 1} In C# you declare a virtual or abstract member on a base type and override it in derived types, so callers use the base type only.`))
const CODE = [
  pad('```csharp\nabstract class Shape { public abstract double Area(); } // CODEMARK', '\n'),
  pad('class Circle : Shape { public double R; public override double Area() => Math.PI * R * R; }', '\n'),
  pad('class Square : Shape { public double S; public override double Area() => S * S; }\n```', '\n'),
]
const LONG = HEADER + LEAD + EXPL.join('') + CODE.join('')

/** Install the samplers for the next answer. */
async function sample(h: Harness) {
  await h.page.evaluate(() => {
    const w = window as any
    clearInterval(w.__pdTimer)
    const S: any = (w.__pd = { leadAt: null, explAt: null, codeAt: null, leadOut: 0, scrollAfterLead: [], stray: 0, openSeen: 0, shikiWhileOpen: 0, maxRunsWhileOpen: 0, blocks: [], replaced: 0, moreBelow: 0, samples: 0 })
    w.__pdTimer = setInterval(() => {
      const body = document.querySelector('[aria-label="Answer text"]') as HTMLElement | null
      if (!body) return
      S.samples++
      const text = body.textContent ?? ''
      const now = Date.now()
      if (!S.leadAt && body.querySelector('.md-lead') && text.includes('LEADMARK')) S.leadAt = now
      if (!S.explAt && text.includes('EXPL1')) S.explAt = now
      if (!S.codeAt && text.includes('CODEMARK')) S.codeAt = now
      if (text.includes('```')) S.stray++
      const lead = body.querySelector('.md-lead') as HTMLElement | null
      const streaming = !!body.querySelector('.md.caret')
      if (lead && streaming) {
        const a = lead.getBoundingClientRect()
        const b = body.getBoundingClientRect()
        if (a.bottom <= b.top || a.top >= b.bottom) S.leadOut++
        S.scrollAfterLead.push(body.scrollTop)
      }
      const fig = body.querySelector('figure[data-streaming="true"]')
      if (fig) {
        S.openSeen++
        if (fig.querySelector('.shiki')) S.shikiWhileOpen++
        S.maxRunsWhileOpen = Math.max(S.maxRunsWhileOpen, Number(fig.getAttribute('data-highlight-runs') ?? 0))
      }
      if ([...document.querySelectorAll('button')].some((x) => x.textContent?.includes('More below'))) S.moreBelow++
      // finished blocks (all but the last) must keep their DOM node while the tail streams
      const blocks = [...body.querySelectorAll('.md-block')]
      if (streaming) {
        blocks.slice(0, -1).forEach((el, i) => {
          const prev = S.blocks[i]
          if (prev && prev.el !== el) S.replaced++
          if (!prev || prev.el !== el) S.blocks[i] = { el, html: el.innerHTML }
          else if (prev.html !== el.innerHTML) {
            S.replaced++
            prev.html = el.innerHTML
          }
        })
      }
    }, 50)
  })
}

const pd = (h: Harness) => h.page.evaluate(() => {
  const S = (window as any).__pd
  return { ...S, blocks: S.blocks.length, scrollMoves: new Set(S.scrollAfterLead).size - 1 }
})

test('PD-01/02/04/05/06/11: lead first and anchored, finished blocks stable, code highlighted once', async () => {
  const h = await new Harness('pd-main').launch()
  const r: Record<string, unknown> = {}
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    h.setScript({ default: { text: LONG, firstTokenMs: 300, chunkChars: CHUNK, chunkMs: 500 } })
    const s = await h.createSession({ autoGenerate: false })
    await h.goLive(s.id)
    await sample(h)
    const a = await h.gen(s.id, 'chat', { text: 'What is polymorphism, and how would you implement it in C#?' })
    const id = a.value?.answerId
    const end = await h.waitEnd(id, 30_000)
    // keep sampling a moment after done, for finalization
    const beforeDone = await pd(h)
    await h.page.waitForTimeout(400)
    // checked in the page: element identity doesn't survive serialization
    const { connected, total } = await h.page.evaluate(() => {
      const b = (window as any).__pd.blocks as Array<{ el: Element }>
      return { connected: b.filter((x) => x.el.isConnected).length, total: b.length }
    })
    const main = (await h.mainEvents()).filter((e) => e.id === id && e.n === 'answer:delta' && e.part === 'answer')
    const row = (await h.call('answers.get', { answerId: id })).value
    const fig = await h.page.locator('[aria-label="Answer text"] figure').first()
    const highlighted = (await fig.locator('.shiki').count()) > 0
    const runsAfter = Number((await fig.getAttribute('data-highlight-runs')) ?? -1)
    r.main = {
      end: end?.n,
      leadVisibleAfterFirstAnswerDeltaMs: beforeDone.leadAt && main[0] ? beforeDone.leadAt - main[0].t : null,
      leadBeforeSecondDelta: beforeDone.leadAt && main[1] ? beforeDone.leadAt <= main[1].t + 60 : null,
      leadOutSamples: beforeDone.leadOut,
      scrollMovesAfterLead: beforeDone.scrollMoves,
      moreBelowSamples: beforeDone.moreBelow,
      replacedFinishedBlocks: beforeDone.replaced,
      finishedBlocksTracked: beforeDone.blocks,
      blocksStillConnectedAfterDone: `${connected}/${total}`,
      strayBacktickSamples: beforeDone.stray,
      openFenceSamples: beforeDone.openSeen,
      shikiWhileOpen: beforeDone.shikiWhileOpen,
      maxHighlightRunsWhileOpen: beforeDone.maxRunsWhileOpen,
      highlightedAfterDone: highlighted,
      highlightRunsAfterDone: runsAfter,
      timing: row?.timing,
      samples: beforeDone.samples,
    }
    const m = r.main as any
    expect.soft(end?.n, 'done').toBe('answer:done')
    expect.soft(m.leadVisibleAfterFirstAnswerDeltaMs, 'PD-01 lead visible ≤ 100 ms after its chunk reaches main').toBeLessThanOrEqual(100)
    expect.soft(m.leadBeforeSecondDelta, 'PD-01 lead visible before the explanation chunk').toBe(true)
    expect.soft(m.leadOutSamples, 'PD-02 the lead stays inside the card while streaming').toBe(0)
    expect.soft(m.scrollMovesAfterLead, 'PD-02 scrollTop unchanged after the lead completes').toBe(0)
    expect.soft(m.moreBelowSamples, 'PD-02 "More below" shown while content is below').toBeGreaterThan(0)
    expect.soft(m.replacedFinishedBlocks, 'PD-04 0 replacements inside finished blocks').toBe(0)
    expect.soft(m.finishedBlocksTracked, 'PD-04 blocks were tracked').toBeGreaterThanOrEqual(6)
    expect.soft(m.blocksStillConnectedAfterDone, 'PD-06 no re-mount at done').toBe(`${total}/${total}`)
    expect.soft(m.strayBacktickSamples, 'PD-05 no stray backticks').toBe(0)
    expect.soft(m.openFenceSamples, 'PD-05 the open fence rendered as a code frame').toBeGreaterThan(0)
    expect.soft(m.shikiWhileOpen, 'PD-05 no highlighted HTML while the fence is open').toBe(0)
    expect.soft(m.maxHighlightRunsWhileOpen, 'PD-05 0 highlight runs while open').toBe(0)
    expect.soft(m.highlightedAfterDone, 'PD-05 highlighted once settled').toBe(true)
    expect.soft(m.highlightRunsAfterDone, 'PD-05 exactly one highlight run').toBe(1)
    expect.soft(typeof m.timing?.leadMs, 'PD-11 leadMs recorded').toBe('number')
    expect.soft(m.timing?.chunks, 'PD-11 chunks = 11').toBe(11)
    expect.soft(Math.abs((m.timing?.maxChunkGapMs ?? 0) - 500), 'PD-11 max gap ≈ 500 ms').toBeLessThanOrEqual(60)

    // PD-03: after the user scrolls, the card never moves on its own (slower chunks: time to scroll)
    h.setScript({ default: { text: LONG + CODE.join(''), firstTokenMs: 300, chunkChars: CHUNK, chunkMs: 900 } })
    await h.page.waitForTimeout(300)
    await sample(h)
    const b = await h.gen(s.id, 'chat', { text: 'Explain polymorphism again with C# code.' })
    // wait until the answer overflows the card, so there is something to scroll
    await h.page.waitForFunction(() => {
      const el = document.querySelector('[aria-label="Answer text"]') as HTMLElement | null
      return !!el && el.scrollHeight - el.clientHeight > 30 && !!el.querySelector('.md.caret')
    }, null, { timeout: 25_000 })
    const box = await h.page.getByLabel('Answer text').boundingBox()
    await h.page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await h.page.mouse.wheel(0, 40)
    await h.page.waitForTimeout(150)
    const afterWheel = await h.page.evaluate(() => (document.querySelector('[aria-label="Answer text"]') as HTMLElement).scrollTop)
    await h.page.waitForTimeout(1200)
    const later = await h.page.evaluate(() => (document.querySelector('[aria-label="Answer text"]') as HTMLElement).scrollTop)
    const more = h.page.getByRole('button', { name: 'More below' })
    const hadMore = await more.isVisible().catch(() => false)
    if (hadMore) await more.click()
    await h.page.waitForTimeout(1200)
    const atBottom = await h.page.evaluate(() => {
      const el = document.querySelector('[aria-label="Answer text"]') as HTMLElement
      return el.scrollHeight - el.scrollTop - el.clientHeight < 30
    })
    await h.waitEnd(b.value?.answerId, 30_000)
    r.userScroll = { afterWheel, later, hadMore, followsAfterMore: atBottom }
    expect.soft(later, 'PD-03 no automatic scroll after the user scrolled').toBe(afterWheel)
    expect.soft(hadMore, 'PD-03 "More below" offered').toBe(true)
    expect.soft(atBottom, 'PD-03 "More below" scrolls and follows').toBe(true)
    await h.call('sessions.end', { id: s.id, mode: 'leave' })
  } finally {
    save('main', r)
    await h.close()
  }
})

test('PD-08/09: interrupted keeps lead + partial code; Stop freezes the body; Retry is a new answer', async () => {
  const h = await new Harness('pd-fail').launch()
  const r: Record<string, unknown> = {}
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    const s = await h.createSession({ autoGenerate: false })
    await h.goLive(s.id)
    // PD-08: fail after header + lead + 6 explanations + 2 code chunks (fence still open)
    h.setScript({ default: { text: LONG, firstTokenMs: 200, chunkChars: CHUNK, chunkMs: 150, failAfterChunks: 10 } })
    await h.page.waitForTimeout(300)
    const a = await h.gen(s.id, 'chat', { text: 'What is polymorphism in C#?' })
    const e = await h.waitEnd(a.value?.answerId, 20_000)
    await h.page.waitForTimeout(500)
    const body = h.page.getByLabel('Answer text')
    const txt = (await body.textContent()) ?? ''
    const figs = await body.locator('figure').count()
    h.setScript({ default: { firstTokenMs: 100, chunkMs: 20 } })
    await h.page.waitForTimeout(300)
    const retry = await h.gen(s.id, 'chat', { text: 'What is polymorphism in C#?', retryOf: a.value?.answerId })
    await h.waitEnd(retry.value?.answerId)
    r.interrupted = { code: e?.p?.code, leadKept: txt.includes('LEADMARK'), codeKept: txt.includes('CODEMARK'), codeFrame: figs, stray: txt.includes('```'), seq: [a.value?.seq, retry.value?.seq], ids: retry.value?.answerId !== a.value?.answerId }
    expect.soft(e?.p?.code, 'PD-08 interrupted').toBe('interrupted')
    expect.soft(txt.includes('LEADMARK') && txt.includes('CODEMARK'), 'PD-08 lead and partial code kept').toBe(true)
    expect.soft(figs, 'PD-08 the open fence is shown as a closed code frame').toBeGreaterThan(0)
    expect.soft(txt.includes('```'), 'PD-08 no stray backticks').toBe(false)
    expect.soft((retry.value?.seq ?? 0) > (a.value?.seq ?? 0), 'PD-08 Retry is a new seq').toBe(true)

    // PD-09: Stop mid-code; the body doesn't change afterwards
    h.setScript({ default: { text: LONG, firstTokenMs: 200, chunkChars: CHUNK, chunkMs: 400 } })
    await h.page.waitForTimeout(300)
    const c = await h.gen(s.id, 'chat', { text: 'Show polymorphism in C# with code.' })
    await h.page.waitForFunction(() => (document.querySelector('[aria-label="Answer text"]')?.textContent ?? '').includes('CODEMARK'), null, { timeout: 15_000 })
    await h.call('answers.cancel', { answerId: c.value?.answerId })
    await h.page.waitForTimeout(150)
    const changes = await h.page.evaluate(async () => {
      const body = document.querySelector('[aria-label="Answer text"]')!
      let n = 0
      const obs = new MutationObserver((list) => {
        for (const m of list) if (m.type !== 'attributes') n++
      })
      obs.observe(body, { subtree: true, childList: true, characterData: true, attributes: true })
      await new Promise((res) => setTimeout(res, 500))
      obs.disconnect()
      return n
    })
    const stopped = await h.page.getByText('Stopped').first().isVisible().catch(() => false)
    r.stop = { stoppedShown: stopped, bodyChangesIn500ms: changes }
    expect.soft(stopped, 'PD-09 "Stopped" shown').toBe(true)
    expect.soft(changes, 'PD-09 0 body DOM changes after cancel').toBe(0)
    await h.call('sessions.end', { id: s.id, mode: 'leave' })
  } finally {
    save('fail', r)
    await h.close()
  }
})
