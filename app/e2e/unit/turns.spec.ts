// TurnDetector (architecture.md revision 2 §4) with a fake clock: settling, joining,
// classification, follow-ups and the open-turn cap. No model calls are possible here.
import { expect, test } from '@playwright/test'
import { DEFAULT_AUTO_POLICY } from '../../src/shared/catalog'
import { isQuestion, isShortQuestion, keySimilarity, questionKey, TurnDetector, type Candidate, type Clock } from '../../src/main/live/turns'

class FakeClock implements Clock {
  t = 0
  private timers: Array<{ at: number; fn: () => void; id: number }> = []
  private n = 0
  now = () => this.t
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.n
    this.timers.push({ at: this.t + ms, fn, id })
    return id
  }
  clearTimeout = (h: unknown) => {
    this.timers = this.timers.filter((x) => x.id !== h)
  }
  advance(ms: number) {
    const end = this.t + ms
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id)
      const next = this.timers[0]
      if (!next || next.at > end) break
      this.timers.shift()
      this.t = next.at
      next.fn()
    }
    this.t = end
  }
}

function setup(policy = DEFAULT_AUTO_POLICY) {
  const clock = new FakeClock()
  const out: Candidate[] = []
  const d = new TurnDetector('s1', () => policy, (c) => out.push(c), clock)
  let seq = 0
  /** Speech of `ms` on the lane, then the final arrives `lag` ms after the voice stops (Kroko: 1.5–2.5 s). */
  const speak = (text: string, ms = 1500, lag = 2000) => {
    d.onThemVoice(true)
    d.onThemPartial(text.split(' ')[0]!)
    clock.advance(ms)
    d.onThemVoice(false)
    clock.advance(lag)
    d.onThemPartial('')
    d.onThemFinal(seq++, text)
  }
  return { clock, out, d, speak }
}

test.describe('settling window', () => {
  test('TD-01 a question ending in "?" becomes a candidate 400 ms after the final, not before', () => {
    const { clock, out, speak } = setup()
    speak('Can you explain what dependency injection is?')
    clock.advance(399)
    expect(out).toHaveLength(0)
    clock.advance(1)
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('question')
  })

  test('TD-02 a question without "?" waits the full 1000 ms', () => {
    const { clock, out, speak } = setup()
    speak('Walk me through how you would design a URL shortener.')
    clock.advance(999)
    expect(out).toHaveLength(0)
    clock.advance(1)
    expect(out).toHaveLength(1)
  })

  test('TD-03 a non-empty partial pauses the window; it restarts when the partial clears', () => {
    const { clock, out, d, speak } = setup()
    speak('Can you tell me how you would scale it?')
    d.onThemPartial('and also')
    clock.advance(5000)
    expect(out).toHaveLength(0)
    d.onThemPartial('')
    clock.advance(399)
    expect(out).toHaveLength(0)
    clock.advance(1)
    expect(out).toHaveLength(1)
  })

  test('TD-04 speech energy pauses the window (partials lag the audio)', () => {
    const { clock, out, d, speak } = setup()
    speak('What is the difference between a process and a thread?')
    d.onThemVoice(true)
    clock.advance(3000)
    expect(out).toHaveLength(0)
    d.onThemVoice(false)
    clock.advance(400)
    expect(out).toHaveLength(1)
  })
})

test.describe('joining (§13 #2)', () => {
  test('TD-05 a question with a 1.2 s pause in the middle gives ONE candidate with both halves', () => {
    const { clock, out, d } = setup()
    // first half: 1.6 s of speech
    d.onThemVoice(true)
    clock.advance(1600)
    d.onThemVoice(false)
    // 1.2 s pause, then the second half starts; the first final arrives during it (lag 2 s)
    clock.advance(1200)
    d.onThemVoice(true)
    clock.advance(800)
    d.onThemFinal(0, 'So when you design a public REST API')
    // Kroko's partial for the second half shows up about 1 s after its audio starts
    clock.advance(200)
    d.onThemPartial('how do you')
    clock.advance(600)
    d.onThemVoice(false)
    clock.advance(2000)
    d.onThemPartial('')
    d.onThemFinal(1, 'how do you handle versioning?')
    clock.advance(5000)
    expect(out).toHaveLength(1)
    expect(out[0]!.text).toContain('REST API')
    expect(out[0]!.text).toContain('versioning')
    expect(out[0]!.lastSeq).toBe(1)
  })

  test('TD-06 two questions 4 s apart are two candidates', () => {
    const { clock, out, speak } = setup()
    speak('What is a closure?')
    clock.advance(4000)
    speak('What is a deadlock?')
    clock.advance(2000)
    expect(out.map((c) => c.text)).toEqual(['What is a closure?', 'What is a deadlock?'])
    expect(out[0]!.turnId).not.toBe(out[1]!.turnId)
  })

  test('TD-07 continuous speech with many finals makes one candidate at the end, not one per final', () => {
    const { clock, out, d } = setup()
    d.onThemVoice(true)
    const lines = ['So I want to hear about your background.', 'We use a lot of distributed systems here.', 'Lots of queues and caches.', 'And so my question is, how would you design a rate limiter?']
    lines.forEach((l, i) => {
      clock.advance(2000)
      d.onThemFinal(i, l)
    })
    clock.advance(1500)
    expect(out).toHaveLength(0)
    d.onThemVoice(false)
    clock.advance(1000)
    expect(out).toHaveLength(1)
    expect(out[0]!.text).toContain('rate limiter')
  })

  test('TD-08 a lane that stays noisy is evaluated 8 s after the last final (open-turn cap)', () => {
    const { clock, out, d } = setup()
    d.onThemVoice(true)
    clock.advance(1000)
    d.onThemFinal(0, 'How does garbage collection work in dot net?')
    clock.advance(7999)
    expect(out).toHaveLength(0)
    clock.advance(1)
    expect(out).toHaveLength(1)
  })

  test('TD-09 partials alone never produce a candidate', () => {
    const { clock, out, d } = setup()
    for (let i = 0; i < 50; i++) {
      d.onThemPartial(`what is the difference between ${i}`)
      clock.advance(150)
    }
    d.onThemPartial('')
    clock.advance(20_000)
    expect(out).toHaveLength(0)
  })
})

test.describe('classification', () => {
  for (const nq of ['Okay, great.', 'Thank you, that makes sense.', 'Right, interesting.', 'I worked at a logistics company for three years before I joined this team.', 'Our team mostly deploys to Azure and Kubernetes.']) {
    test(`TD-10 non-question makes no candidate: "${nq}"`, () => {
      const { clock, out, speak } = setup()
      speak(nq)
      clock.advance(10_000)
      expect(out).toHaveLength(0)
    })
  }

  test('TD-11 the user\'s own line repeated by "them" is rejected', () => {
    const { clock, out, d, speak } = setup()
    d.onYouFinal('What is the difference between a process and a thread?')
    speak('What is the difference between a process and a thread?')
    clock.advance(5000)
    expect(out).toHaveLength(0)
  })

  test('TD-12 follow-up: continuation + request within 20 s is a followup; a comment is not', () => {
    const { clock, out, d, speak } = setup()
    speak('What is a hash table?')
    clock.advance(1000)
    expect(out).toHaveLength(1)
    d.noteAnswered()
    clock.advance(4000)
    speak('And how would you explain collisions to a junior engineer')
    clock.advance(1500)
    expect(out).toHaveLength(2)
    expect(out[1]!.kind).toBe('followup')
    clock.advance(4000)
    speak('That is a really interesting way to put it.')
    clock.advance(3000)
    expect(out).toHaveLength(2)
  })

  test('TD-14 (BUG-001) a question joined after an unpunctuated statement is still detected', () => {
    // Real Kroko output from the e2e run: neither final carries punctuation.
    const { clock, out, d } = setup()
    d.onThemVoice(true)
    clock.advance(3500)
    d.onThemVoice(false)
    clock.advance(1200) // 1.2 s pause: the speech-gap rule joins the next utterance
    d.onThemVoice(true)
    clock.advance(400)
    d.onThemFinal(0, 'Our team mostly deploys to Azure and Kubernets')
    d.onThemPartial('how does')
    clock.advance(2600)
    d.onThemVoice(false)
    clock.advance(1500)
    d.onThemPartial('')
    d.onThemFinal(1, 'How does garbage collection work in tert')
    clock.advance(3000)
    expect(out).toHaveLength(1)
    expect(out[0]!.text).toContain('garbage collection')
    expect(out[0]!.questionKey).toContain('garbage')
  })

  test('TD-15 (BUG-003) a new question joined to a turn that already produced a candidate gets a new turnId', () => {
    // "What is a closure?" settles and is proposed; "What is a deadlock?" arrives 2 s later
    // (inside joinGapMs). The second question must not reuse the first one's turnId, or the
    // gate drops it as a duplicate of the answered turn.
    const { clock, out, d } = setup()
    d.onThemVoice(true)
    clock.advance(1300)
    d.onThemVoice(false)
    clock.advance(1600)
    d.onThemFinal(0, 'What is a closure?')
    clock.advance(400)
    expect(out).toHaveLength(1)
    d.onThemVoice(true)
    clock.advance(1300)
    d.onThemVoice(false)
    clock.advance(300)
    d.onThemFinal(1, 'What is a deadlock?')
    clock.advance(1000)
    expect(out).toHaveLength(2)
    expect(out[1]!.turnId).not.toBe(out[0]!.turnId)
    expect(out[1]!.text).toContain('deadlock')
    expect(out[1]!.lastSeq).toBe(1)
  })

  test('TD-16 words added to a turn that produced NO candidate keep the same turnId', () => {
    const { clock, out, d } = setup()
    d.onThemFinal(0, 'So we have a big monolith here.')
    clock.advance(1000)
    expect(out).toHaveLength(0)
    clock.advance(500)
    d.onThemFinal(1, 'How would you split it into services?')
    clock.advance(400)
    expect(out).toHaveLength(1)
    expect(out[0]!.text).toContain('monolith')
  })

  test('TD-17 (revision 4 A2, BUG-011) short questions by shape make a candidate; noise under minWords does not', () => {
    for (const q of ['What is polymorphism?', 'Define dependency injection.', 'What is recursion?', 'Why use caching?']) {
      const { clock, out, speak } = setup()
      speak(q)
      clock.advance(10_000)
      expect(out, q).toHaveLength(1)
    }
    for (const q of ['Really?', 'Is it?', 'Okay, great.', 'Makes sense?']) {
      const { clock, out, speak } = setup()
      speak(q)
      clock.advance(10_000)
      expect(out, q).toHaveLength(0)
    }
    const { clock, out, speak } = setup()
    speak('What is a closure exactly?')
    clock.advance(10_000)
    expect(out).toHaveLength(1)
  })

  test('TD-18 (revision 4 A4.1) a candidate carries the speech-end and final times', () => {
    const { clock, out, speak } = setup()
    speak('What is a closure exactly?', 1500, 2000)
    clock.advance(10_000)
    const c = out[0]!
    expect(c.voicedEndAt).toBe(1500)
    expect(c.finalAt).toBe(3500)
    expect(c.detectedAt - c.finalAt).toBe(DEFAULT_AUTO_POLICY.settleQuestionMarkMs)
  })

  test('TD-19 (revision 4 A2) the shape table', () => {
    const yes = ['What is polymorphism?', 'Why use caching?', 'Define dependency injection.', 'What is recursion?']
    const no = ['Really?', 'Is it?', 'Okay, great.', 'Makes sense?', 'What?']
    for (const q of yes) expect(isShortQuestion(q, 2), q).toBe(true)
    for (const q of no) expect(isShortQuestion(q, 2), q).toBe(false)
    // "And Kafka?" only as a follow-up (within the follow-up window)
    expect(isShortQuestion('And Kafka?', 2, false)).toBe(false)
    expect(isShortQuestion('And Kafka?', 2, true)).toBe(true)
    // a word that merely starts like a wh-word isn't one
    expect(isShortQuestion('Whatever works.', 2)).toBe(false)
  })

  test('TD-13 question keys: a verbatim repeat is similarity 1; distinct questions are below 0.7', () => {
    const a = questionKey('What is the difference between a process and a thread?')
    expect(keySimilarity(a, questionKey('what is the difference between a process and a thread'))).toBe(1)
    expect(keySimilarity(questionKey('What is a closure?'), questionKey('What is a deadlock?'))).toBeLessThan(0.7)
    expect(isQuestion('Tell me about a time when you had to resolve a conflict in your team.')).toBe(true)
  })
})
