// TurnDetector (architecture.md revision 2 §4). Joins "them" finals into turns, waits
// for the settling window (paused while the speaker is mid-utterance), classifies the
// settled turn locally and proposes a Candidate. Pure logic: an injected clock and
// timer, no model calls, no rate state.
import type { AutoPolicy } from '@shared/types'

export interface Candidate {
  candidateId: string
  sessionId: string
  turnId: string
  kind: 'question' | 'followup'
  text: string
  /** Monotonic ms of the last "them" speech in the turn. */
  lastSpeechAt: number
  detectedAt: number
  questionKey: string
  tokens: string[]
  /** Highest segment seq in the turn. */
  lastSeq: number
  /** Monotonic ms the turn's last final arrived (revision 4 A4.1 timings). */
  finalAt: number
  /** Monotonic ms the lane's voice last went quiet before that final, if known. */
  voicedEndAt?: number
}

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
}

export const realClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

// ---------- question keys (§6) ----------

const STOP = new Set(
  'a an the and or but so to of in on at for with about from by is are was were be been being do does did can could would will should shall may might must you your yours i me my we our us it its this that these those there here what which who whom whose how why when where please tell me just um uh like okay ok right well yeah hmm actually basically really'.split(
    ' ',
  ),
)

export function keyTokens(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .slice(0, 16)
}

export const questionKey = (text: string) => keyTokens(text).join(' ')

export function keySimilarity(a: string, b: string): number {
  const A = new Set(a.split(' ').filter(Boolean))
  const B = new Set(b.split(' ').filter(Boolean))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const w of A) if (B.has(w)) inter++
  return inter / (A.size + B.size - inter)
}

// ---------- classification (§4 rule 4) ----------

const QUESTION_START =
  /^(what|why|how|when|where|which|who|whom|whose|can you|could you|would you|will you|do you|does|did you|is|are|was|were|have you|has|should|tell me|walk me|explain|describe|give me|talk me|share|define|compare|design|implement|write)\b/i
const REQUEST = /\b(tell me about|walk me through|explain|describe|give me an example|compare|design|implement|write|what is|what are|what's|how would you|how do you|why do you|can you|could you)\b/i
const HINDI = /(क्या|क्यों|कैसे|कौन|कब|कहाँ|कितना|कितने|बताइए|बताओ|बताएँ|समझाइए|समझाओ|एक्सप्लेन|डिफरेंस)/
const BACKCHANNEL = /^(okay|ok|right|great|got it|makes sense|thank you|thanks|sure|cool|nice|perfect|alright|all right|yes|yeah|no|hmm|interesting|really|हाँ|ठीक है|अच्छा)[\s.,!?]*$/i
const CONTINUATION = /^(and|what about|how about|why|so|but|और|तो)\b/i

const contentWords = (t: string) => t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length

export function lastSentences(text: string, n = 2): string {
  const parts = text.trim().split(/(?<=[.!?।])\s+/)
  return parts.slice(-n).join(' ')
}

// Revision 4 A2: a question shorter than minWords still counts by its shape.
const SHORT_START = /^(what|why|how|which|who|when|where|define|explain|describe|compare|name|list)\b/i

/**
 * A short question: at least `minWords` words, opens with a wh-word or a request verb
 * (or, as a follow-up within the follow-up window, ends with "?"), has a content token
 * and isn't a backchannel. "What is polymorphism?" and "Why use caching?" pass;
 * "Really?", "Is it?" and "Makes sense?" don't.
 */
export function isShortQuestion(text: string, minWords: number, followup = false): boolean {
  const t = text.trim()
  if (contentWords(t) < minWords || BACKCHANNEL.test(t) || keyTokens(t).length < 1) return false
  return SHORT_START.test(lastSentences(t, 1)) || (followup && /\?\s*$/.test(t))
}

export function isQuestion(text: string): boolean {
  const tail = lastSentences(text)
  const last = lastSentences(text, 1)
  return /\?\s*$/.test(tail) || QUESTION_START.test(last) || QUESTION_START.test(tail) || REQUEST.test(tail) || HINDI.test(tail)
}

// ---------- detector ----------

interface Turn {
  turnId: string
  finals: Array<{ seq: number; text: string }>
  lastFinalAt: number
  voicedEndAt?: number
  evaluated: boolean
  /** A candidate was proposed for this turn. */
  proposed: boolean
}

/** A turn left open by noisy audio is evaluated anyway this long after its last final. */
const MAX_OPEN_MS = 8000

export class TurnDetector {
  private turn: Turn | null = null
  private timer: unknown = null
  private capTimer: unknown = null
  /** "Still talking": a non-empty partial (§4 rule 3) or speech energy on the lane. */
  private partialTalking = false
  private voiceTalking = false
  private lastVoiceOffAt = -Infinity
  /** Silence before the utterance now being recognised: null until its voice starts. */
  private gapBeforeUtterance: number | null = null
  private lastYou = ''
  private lastAnsweredAt = -Infinity

  private get talking() {
    return this.partialTalking || this.voiceTalking
  }

  constructor(
    private sessionId: string,
    private policy: () => AutoPolicy,
    private onCandidate: (c: Candidate) => void,
    private clock: Clock = realClock,
  ) {}

  /** The open turn (manual requests attach to it). */
  current(): { turnId: string; text: string; lastSeq: number } | null {
    if (!this.turn) return null
    return { turnId: this.turn.turnId, text: this.text(this.turn), lastSeq: this.turn.finals.at(-1)?.seq ?? -1 }
  }

  noteAnswered() {
    this.lastAnsweredAt = this.clock.now()
  }

  onYouFinal(text: string) {
    this.lastYou = text
  }

  onThemPartial(text: string) {
    this.setTalking(() => (this.partialTalking = text.trim().length > 0))
  }

  /**
   * Speech energy on the "them" lane. The recogniser's partials lag the audio by about
   * a second, so without this a pause inside a question could end the settling window
   * before the second half's partial arrives.
   */
  onThemVoice(active: boolean) {
    if (active === this.voiceTalking) return
    const t = this.clock.now()
    if (active && this.gapBeforeUtterance === null) this.gapBeforeUtterance = t - this.lastVoiceOffAt
    if (!active) this.lastVoiceOffAt = t
    this.setTalking(() => (this.voiceTalking = active))
  }

  private setTalking(change: () => void) {
    const was = this.talking
    change()
    if (this.talking && !was) this.cancelTimer()
    else if (!this.talking && was && this.turn && !this.turn.evaluated) this.arm()
  }

  onThemFinal(seq: number, text: string) {
    const p = this.policy()
    const t = this.clock.now()
    this.partialTalking = false
    // Join when the finals are close, or when the speaker paused less than joinGapMs
    // before this utterance (finals arrive 1.5–2.5 s after speech, so the gap between
    // finals overstates the real pause).
    const speechJoin = this.gapBeforeUtterance !== null && this.gapBeforeUtterance <= p.joinGapMs
    const joinable = !!this.turn && (t - this.turn.lastFinalAt <= p.joinGapMs || (speechJoin && t - this.turn.lastFinalAt <= p.joinGapMs + 6000))
    const voicedEndAt = Number.isFinite(this.lastVoiceOffAt) && this.lastVoiceOffAt <= t ? this.lastVoiceOffAt : undefined
    // The next utterance's pause is measured from here; voice already active means no pause.
    this.gapBeforeUtterance = this.voiceTalking ? 0 : null
    if (joinable && this.turn) {
      this.turn.finals.push({ seq, text })
      this.turn.lastFinalAt = t
      this.turn.voicedEndAt = voicedEndAt
      // New words re-open the turn for evaluation. If it already proposed a candidate,
      // the new words are a new request (a follow-on question, or the rest of one that
      // fired early): give it a new turnId, or the gate drops it as the answered turn.
      this.turn.evaluated = false
      if (this.turn.proposed) {
        this.turn.turnId = crypto.randomUUID()
        this.turn.proposed = false
      }
    } else {
      if (this.turn && !this.turn.evaluated) this.evaluate()
      this.turn = { turnId: crypto.randomUUID(), finals: [{ seq, text }], lastFinalAt: t, voicedEndAt, evaluated: false, proposed: false }
    }
    // Cap: constant noise on the loopback must not keep a turn open forever. Only a new
    // final restarts it, never a change in the talking signal.
    if (this.capTimer !== null) this.clock.clearTimeout(this.capTimer)
    const turn = this.turn
    this.capTimer = this.clock.setTimeout(() => {
      this.capTimer = null
      if (this.turn === turn && !turn.evaluated) this.evaluate()
    }, MAX_OPEN_MS)
    this.arm()
  }

  /** F08: an injected interviewer question is a complete turn; no settling window. */
  onMockQuestion(seq: number, text: string) {
    this.cancelTimer()
    this.turn = { turnId: crypto.randomUUID(), finals: [{ seq, text }], lastFinalAt: this.clock.now(), evaluated: false, proposed: false }
    this.evaluate()
  }

  dispose() {
    this.cancelTimer()
    if (this.capTimer !== null) this.clock.clearTimeout(this.capTimer)
    this.capTimer = null
    this.turn = null
  }

  private text(t: Turn, boundaries = false): string {
    // The recogniser often ends a final without punctuation, so for classification each
    // final's end counts as a sentence end; otherwise a question joined after a statement
    // reads as one long sentence that starts like the statement.
    const s = t.finals.map((f) => (boundaries && !/[.!?।]\s*$/.test(f.text) ? `${f.text.trim()}.` : f.text)).join(' ')
    const max = this.policy().maxTurnChars
    return s.length > max ? s.slice(s.length - max) : s
  }

  private cancelTimer() {
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
  }

  private arm() {
    this.cancelTimer()
    if (!this.turn || this.talking) return
    const p = this.policy()
    const ms = /\?\s*$/.test(this.text(this.turn)) ? p.settleQuestionMarkMs : p.settleMs
    this.timer = this.clock.setTimeout(() => {
      this.timer = null
      if (!this.talking) {
        if (this.capTimer !== null) this.clock.clearTimeout(this.capTimer)
        this.capTimer = null
        this.evaluate()
      }
    }, ms)
  }

  private evaluate() {
    const turn = this.turn
    if (!turn || turn.evaluated) return
    turn.evaluated = true
    const p = this.policy()
    const text = this.text(turn).trim()
    const now = this.clock.now()
    const recent = now - this.lastAnsweredAt <= p.followupWindowMs
    if (contentWords(text) < p.minWords && !isShortQuestion(text, p.shortQuestionMinWords, recent)) return
    if (BACKCHANNEL.test(text)) return
    if (this.lastYou && questionKey(text) === questionKey(this.lastYou)) return
    const sentences = this.text(turn, true).trim()
    const question = isQuestion(sentences)
    let kind: Candidate['kind'] | null = null
    if (question) kind = recent ? 'followup' : 'question'
    else if (recent && CONTINUATION.test(text) && (REQUEST.test(text) || HINDI.test(text))) kind = 'followup'
    if (!kind) return
    const key = questionKey(lastSentences(sentences))
    turn.proposed = true
    this.onCandidate({
      candidateId: crypto.randomUUID(),
      sessionId: this.sessionId,
      turnId: turn.turnId,
      kind,
      text,
      lastSpeechAt: turn.lastFinalAt,
      detectedAt: now,
      questionKey: key,
      tokens: key.split(' ').filter(Boolean),
      lastSeq: turn.finals.at(-1)?.seq ?? -1,
      finalAt: turn.lastFinalAt,
      voicedEndAt: turn.voicedEndAt,
    })
  }
}
