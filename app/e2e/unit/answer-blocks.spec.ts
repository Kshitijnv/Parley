// Revision 5 (progressive answer delivery): the lead paragraph, block splitting and the
// answer-event reducer. Pure functions; no Electron, no provider.
import { expect, test } from '@playwright/test'
import { isOpenFence, leadEnd, LEAD_MAX_CHARS, splitBlocks } from '../../src/shared/answerBlocks'
import { reduce, type State } from '../../src/renderer/overlay/live/answerReduce'

test.describe('PD-10 leadEnd', () => {
  test('a paragraph then a blank line ends at the paragraph', () => {
    const md = 'Polymorphism lets one interface stand for many forms.\n\n- point'
    expect(leadEnd(md, false)).toBe('Polymorphism lets one interface stand for many forms.'.length)
  })
  test('a list straight after the lead ends it before the list', () => {
    const md = 'Caching keeps hot data close.\n- faster reads'
    expect(leadEnd(md, false)).toBe('Caching keeps hot data close.'.length)
  })
  test('still open while streaming: no blank line yet, or a lone newline', () => {
    expect(leadEnd('Polymorphism lets one interface', false)).toBeNull()
    expect(leadEnd('Polymorphism lets one interface.\n', false)).toBeNull()
    expect(leadEnd('Polymorphism lets one interface.\n-', false)).toBeNull() // "-" may still become prose
  })
  test('answers that open with a list, heading or fence have no lead', () => {
    for (const md of ['- first point\n- second', '## Heading\ntext', '```js\nx\n```', '1. step'])
      expect(leadEnd(md, false), md).toBe(0)
  })
  test(`over ${LEAD_MAX_CHARS} characters without a break is not a lead`, () => {
    expect(leadEnd('word '.repeat(90), false)).toBe(0)
    expect(leadEnd('word '.repeat(90), true)).toBe(0)
  })
  test('a single short paragraph, final: its whole length', () => {
    expect(leadEnd('A closure keeps its scope.', true)).toBe('A closure keeps its scope.'.length)
    expect(leadEnd('  A closure keeps its scope.  ', true)).toBe(2 + 'A closure keeps its scope.'.length)
  })
})

test.describe('block splitting', () => {
  test('blank lines split; fenced code keeps its blank lines', () => {
    const md = 'Lead.\n\nPoint one.\n\n```js\nconst a = 1\n\nconst b = 2\n```\n\nAfter.'
    expect(splitBlocks(md)).toEqual(['Lead.', 'Point one.', '```js\nconst a = 1\n\nconst b = 2\n```', 'After.'])
  })
  test('the lead is its own block even with a list right after it', () => {
    const md = 'Caching keeps hot data close.\n- faster reads\n- less load'
    expect(splitBlocks(md, leadEnd(md, false))).toEqual(['Caching keeps hot data close.', '- faster reads\n- less load'])
  })
  test('a streaming tail stays one open block', () => {
    const blocks = splitBlocks('Lead.\n\n```csharp\nclass A {')
    expect(blocks.at(-1)).toBe('```csharp\nclass A {')
    expect(isOpenFence(blocks.at(-1)!)).toBe(true)
    expect(isOpenFence('```csharp\nclass A {}\n```')).toBe(false)
    expect(isOpenFence('plain text')).toBe(false)
  })
  test('appending text never changes finished blocks', () => {
    const full = 'Lead line.\n\nSecond block.\n\n```js\nx()\n```\n\nTail block.'
    let prev: string[] = []
    for (let i = 1; i <= full.length; i++) {
      const b = splitBlocks(full.slice(0, i))
      // every block but the last of the previous split must be unchanged now
      for (let k = 0; k < prev.length - 1; k++) expect(b[k], `prefix ${i}, block ${k}`).toBe(prev[k])
      prev = b
    }
  })
})

test.describe('PD-07 reducer: append, gaps, attempts, finalize', () => {
  const start = (s: State = {}) =>
    reduce(s, { type: 'start', e: { answerId: 'a1', sessionId: 's', seq: 0, trigger: 'chat', turnId: null, questionDraft: 'Q', model: 'm', createdAt: 0 } })
  const delta = (s: State, offset: number, text: string, attempt = 1) => reduce(s, { type: 'delta', d: { answerId: 'a1', sessionId: 's', part: 'answer', offset, text, attempt } })

  test('in order, duplicate and overlapping deltas give the same text once', () => {
    let s = start()
    s = delta(s, 0, 'Hello ')
    s = delta(s, 6, 'world')
    s = delta(s, 6, 'world') // duplicate
    s = delta(s, 0, 'Hello wor') // overlap, nothing new
    s = delta(s, 9, 'ld!') // overlap, new tail "!"
    expect(s.a1!.md).toBe('Hello world!')
    expect(s.a1!.needsResync).toBeFalsy()
  })
  test('a gap marks the answer for one resync', () => {
    let s = start()
    s = delta(s, 0, 'Hi')
    s = delta(s, 10, 'later')
    expect(s.a1!.md).toBe('Hi')
    expect(s.a1!.needsResync).toBe(true)
  })
  test('a delta from an older attempt is dropped', () => {
    let s = start()
    s = delta(s, 0, 'from attempt 2 ', 2)
    s = delta(s, 15, 'stale', 1)
    expect(s.a1!.md).toBe('from attempt 2 ')
    expect(s.a1!.attempt).toBe(2)
  })
  test('deltas after done are ignored; done keeps the streamed string when it matches', () => {
    let s = start()
    s = delta(s, 0, 'Answer text.\n')
    const streamed = s.a1!.md
    const row = { id: 'a1', sessionId: 's', seq: 0, trigger: 'chat' as const, status: 'done' as const, transcriptExcerpt: '', userPrompt: 'Q', screenshotPath: null, question: 'Q?', answerMd: 'Answer text.', model: 'm', answerPrefs: {} as never, error: null, firstTokenMs: 1, latencyMs: 2, createdAt: 0 }
    s = reduce(s, { type: 'done', a: row })
    expect(s.a1!.status).toBe('done')
    expect(s.a1!.md).toBe(streamed) // same string: memoized blocks don't re-render
    s = delta(s, streamed.length, 'late')
    expect(s.a1!.md).toBe(streamed)
    // a different authoritative text replaces once
    let t = start()
    t = delta(t, 0, 'Partial')
    t = reduce(t, { type: 'done', a: { ...row, answerMd: 'Different final text.' } })
    expect(t.a1!.md).toBe('Different final text.')
  })
})
