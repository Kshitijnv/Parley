// Scripted stand-in for the speech-to-text worker. Words arrive as partials a few
// hundred ms apart, then the line is finalised, like the real streaming model. Lines
// carry the filler and broken phrasing the real transcript has, so the answer
// engine's question rewrite has something to do.
import type { SessionType, Speaker, SttState } from '@shared/types'
import { emitLocal } from './bus'
import { hasScenario } from './store'

type Line = [Speaker, string, number] // speaker, text, pause after (ms)

const INTERVIEW: Line[] = [
  ['them', 'Hi. Thanks for joining today. Okay so. Could you start by telling me a bit about yourself?', 9000],
  ['you', 'Sure. Thanks for having me.', 2500],
  ['them', 'Great. So what do you know about. Delegates. In C sharp?', 9000],
  ['them', 'Okay. And how would you speed up a slow SQL query?', 9000],
  ['you', "I'd start with the execution plan.", 2500],
  ['them', 'Right. Tell me about a time you disagreed with a teammate on a technical choice.', 9000],
  ['them', 'And what is dependency injection. Why would you use it?', 9000],
  ['them', 'How do async and await work under the hood?', 9000],
  ['them', 'Last one. Why do you want to join us?', 9000],
  ['them', 'Great. Do you have any questions for us?', 12000],
]

const REGULAR: Line[] = [
  ['them', 'Morning. So. Can you walk us through how the migration to the new API will work?', 9000],
  ['you', 'Yes. We run both versions side by side for a month.', 3000],
  ['them', 'Okay. What happens to the old endpoints after that, and how do we stop clients breaking?', 9000],
  ['them', 'And is there a slow query problem on the reports page? It takes ages to load.', 9000],
  ['them', 'Fine. Can you send a summary after this call?', 12000],
]

const YOU_REPLIES = [
  'Let me think about that for a second.',
  'Sure, so in my last project we did exactly that.',
  'Good question. I would start by measuring first.',
]

export interface SttHooks {
  onFinal(speaker: Speaker, text: string, startMs: number, endMs: number): void
  onStatus(state: SttState, error?: string): void
}

export class MockStt {
  private timer: ReturnType<typeof setTimeout> | null = null
  private lineIdx = 0
  private partial: { speaker: Speaker; text: string } | null = null
  private t0 = performance.now()
  private queue: Line[] = []
  private running = false
  private failedOnce = false

  constructor(
    private sessionId: string,
    private type: SessionType,
    private hooks: SttHooks,
  ) {}

  start() {
    this.stop()
    this.running = true
    this.t0 = performance.now()
    this.hooks.onStatus('starting')
    this.timer = setTimeout(() => {
      this.hooks.onStatus('listening')
      this.next(1500)
    }, 900)
  }

  stop() {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.partial = null
  }

  currentPartial() {
    return this.partial
  }

  /** Mock interview: the AI interviewer's question is spoken, then a canned reply. */
  say(speaker: Speaker, text: string) {
    this.queue.push([speaker, text, 6000])
    if (speaker === 'them') this.queue.push(['you', YOU_REPLIES[Math.floor(Math.random() * YOU_REPLIES.length)], 4000])
    if (!this.partial) {
      if (this.timer) clearTimeout(this.timer)
      this.next(300)
    }
  }

  private script(): Line[] {
    return this.type === 'regular' ? REGULAR : this.type === 'mock' ? [] : INTERVIEW
  }

  private next(delay: number) {
    if (!this.running) return
    this.timer = setTimeout(() => {
      if (!this.running) return
      if (hasScenario('stt_error') && !this.failedOnce && this.lineIdx >= 1) {
        this.failedOnce = true
        this.partial = null
        this.hooks.onStatus('error', 'The speech model stopped responding.')
        this.running = false
        return
      }
      const line = this.queue.shift() ?? this.script()[this.lineIdx++]
      if (!line) return // script finished; keep listening silently
      this.speak(line)
    }, delay)
  }

  private speak([speaker, text, pause]: Line) {
    const words = text.split(' ')
    const start = performance.now() - this.t0
    let i = 0
    const tick = () => {
      if (!this.running) return
      i++
      this.partial = { speaker, text: words.slice(0, i).join(' ') }
      emitLocal('transcript:partial', { sessionId: this.sessionId, speaker, text: this.partial.text })
      if (i < words.length) {
        this.timer = setTimeout(tick, 170 + Math.random() * 120)
      } else {
        this.timer = setTimeout(() => {
          this.partial = null
          emitLocal('transcript:partial', { sessionId: this.sessionId, speaker, text: '' })
          this.hooks.onFinal(speaker, text, Math.round(start), Math.round(performance.now() - this.t0))
          this.next(pause)
        }, 450)
      }
    }
    tick()
  }
}

/** Simulated input level (0..1) per speaker, for the meters when real capture is off. */
export function simulatedLevel(partialSpeaker: Speaker | null, speaker: Speaker): number {
  return partialSpeaker === speaker ? 0.35 + Math.random() * 0.55 : Math.random() * 0.06
}
