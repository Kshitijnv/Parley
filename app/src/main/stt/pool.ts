// Cloud speech for the "them" lane (architecture.md revision 7 S2–S4): one Speechmatics
// session at a time, taken from the user's ordered keys. On an error it retries the same
// key or moves to the next one (S4.3), and gives the new session the audio from the
// last finished line onward (S4.4), so words spoken during a switch aren't lost and
// finished lines aren't repeated. Everything outside this file is injected, so the unit
// tests run it against a fake server without Electron.
import { AudioRing } from './ring'
import { classify, joinText, slowRetry, SmSession, type SmConfig, type SmOutcome } from './speechmatics'

const SR = 16000

export interface PoolKey {
  id: string
  slot: number
  key: string
}

export type KeyMark = 'ok' | 'rate_limited' | 'quota_exhausted' | 'auth_failed'

export interface PoolDeps {
  config: Omit<SmConfig, 'key'>
  /** Keys that may be used now, in the user's order. */
  usableKeys(): Promise<PoolKey[]>
  mark(id: string, state: KeyMark, errorType: string | null): void
  addUsage(id: string, ms: number): void
  /** A REST check of a key whose socket never opened: 'auth' means rejected. */
  testKey(key: string): Promise<'ok' | 'auth' | 'error'>
  log(event: string, fields: Record<string, unknown>): void
  timing?: Partial<PoolTiming>
}

export interface PoolTiming {
  /** A session that hasn't started by then counts as a failed connect. Vocabulary can make start slow. */
  connectTimeoutMs: number
  /** Backoff for reconnecting the same key; after the last one the pool moves on. */
  retryMs: number[]
  /** Minimum wait for errors the docs say to retry slowly. */
  slowRetryMs: number
  /** With no usable key left: wait, then start over (doubling to the max). */
  restartMs: number
  restartMaxMs: number
  /** More than this queued in the socket means the network can't keep up. */
  maxBufferedBytes: number
  usageFlushMs: number
}

const DEFAULT_TIMING: PoolTiming = {
  connectTimeoutMs: 15_000,
  retryMs: [250, 1000, 2000],
  slowRetryMs: 5000,
  restartMs: 10_000,
  restartMaxMs: 60_000,
  maxBufferedBytes: 1 << 20,
  usageFlushMs: 10_000,
}

export interface PoolEvents {
  /** The line so far: finished pieces plus the words still being recognised. */
  partial(text: string): void
  /** A finished line (end of utterance), with absolute sample positions. */
  final(text: string, startSample: number, endSample: number): void
  /** up: a session is streaming. slot: the key's 1-based place in the user's order. */
  state(up: boolean, slot?: number): void
  /** Every 5 s of streamed audio with words: lag between audio sent and recognised (ms). */
  stats(s: { partialLagMs?: number; partialEveryMs?: number; count: number; backlogMs: number }): void
}

const median = (xs: number[]) => (xs.length ? Math.round([...xs].sort((a, b) => a - b)[xs.length >> 1]!) : undefined)

export class CloudLane {
  readonly ring = new AudioRing(10 * SR)
  private t: PoolTiming
  private s: SmSession | null = null
  private cur: PoolKey | null = null
  private started = false
  private errType: string | null = null
  /** Absolute sample that the current session's time 0 is. */
  private base = 0
  private sent = 0
  /** End of the last finished line, absolute: a new session replays from here. */
  private committed = 0
  /** Output that ends before this sample belongs to lines the local engine already showed. */
  private adoptFrom = 0
  private acc = ''
  private accStart: number | null = null
  private tries = 0
  private restartWait: number
  private skip = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private fatal = false
  private downAt: number | null = null
  private openAt = 0
  private usage = 0
  private usageAt = performance.now()
  private st = { from: 0, lags: [] as number[], changes: [] as number[], backlog: 0 }

  constructor(
    private deps: PoolDeps,
    private ev: PoolEvents,
  ) {
    this.t = { ...DEFAULT_TIMING, ...deps.timing }
    this.restartWait = this.t.restartMs
  }

  get up() {
    return this.started
  }

  get slot() {
    return this.started ? this.cur?.slot : undefined
  }

  get keyId() {
    return this.started ? this.cur?.id : undefined
  }

  start() {
    void this.connectNext()
  }

  private later(fn: () => void, ms: number) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.stopped) fn()
    }, ms)
  }

  private async connectNext() {
    if (this.stopped || this.fatal) return
    const keys = (await this.deps.usableKeys()).filter((k) => !this.skip.has(k.id))
    if (this.stopped) return
    const k = keys[0]
    if (!k) {
      // Nothing left this round: start over later (rate limits clear, the network comes back).
      this.deps.log('stt_connect', { outcome: 'no_key', waitMs: this.restartWait })
      this.skip.clear()
      this.later(() => void this.connectNext(), this.restartWait)
      this.restartWait = Math.min(this.restartWait * 2, this.t.restartMaxMs)
      return
    }
    this.cur = k
    this.tries = 0
    this.open()
  }

  private open() {
    const k = this.cur!
    this.started = false
    this.errType = null
    this.openAt = performance.now()
    const s = new SmSession({ ...this.deps.config, key: k.key }, (e) => this.onEvent(s, e))
    this.s = s
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = setTimeout(() => this.fail(s, false), this.t.connectTimeoutMs)
  }

  private onEvent(s: SmSession, e: Parameters<ConstructorParameters<typeof SmSession>[1]>[0]) {
    if (s !== this.s || this.stopped) return
    switch (e.type) {
      case 'started': {
        if (this.connectTimer) clearTimeout(this.connectTimer)
        this.started = true
        this.tries = 0
        this.skip.clear()
        this.restartWait = this.t.restartMs
        // Replay from the end of the last finished line (at most what the ring holds).
        const { start, pcm } = this.ring.since(this.committed)
        this.base = start
        this.sent = 0
        this.acc = ''
        this.accStart = null
        for (let i = 0; i < pcm.length; i += 3200) this.send(pcm.subarray(i, i + 3200))
        this.deps.mark(this.cur!.id, 'ok', null)
        this.deps.log('stt_connect', { outcome: 'ok', keySlot: this.cur!.slot, vocabCount: this.deps.config.vocab.length, replayMs: Math.round((pcm.length / SR) * 1000), latencyMs: Math.round(performance.now() - this.openAt), switchMs: this.downAt === null ? undefined : Math.round(performance.now() - this.downAt) })
        this.downAt = null
        this.ev.state(true, this.cur!.slot)
        return
      }
      case 'partial': {
        if (this.abs(e.endS) < this.adoptFrom) return
        if (e.endS > 0) this.st.lags.push(Math.max(0, (this.sent / SR - e.endS) * 1000))
        this.st.changes.push(performance.now())
        this.ev.partial(joinText(this.acc, e.text))
        return
      }
      case 'final': {
        if (this.abs(e.endS) <= this.adoptFrom) return
        this.accStart ??= this.abs(e.startS)
        this.acc = joinText(this.acc, e.text)
        this.ev.partial(this.acc)
        return
      }
      case 'eou': {
        const end = this.abs(e.endS)
        if (this.acc) this.ev.final(this.acc, this.accStart ?? end, end)
        this.committed = Math.max(this.committed, end)
        this.acc = ''
        this.accStart = null
        return
      }
      case 'error':
        this.errType = e.errorType
        return
      case 'closed':
        void this.fail(s, e.opened, e.code)
        return
    }
  }

  private abs(sec: number) {
    return this.base + Math.round(sec * SR)
  }

  private send(pcm: Int16Array) {
    this.s!.sendAudio(pcm)
    this.sent += pcm.length
    this.usage += pcm.length
  }

  private async fail(s: SmSession, opened: boolean, code: number | null = null) {
    if (s !== this.s || this.stopped) return
    if (this.connectTimer) clearTimeout(this.connectTimer)
    s.close()
    this.s = null
    const wasUp = this.started
    this.started = false
    this.downAt ??= performance.now()
    this.flushUsage(true)
    // Words recognised since the last finished line are re-sent to the next session.
    this.acc = ''
    this.accStart = null
    if (wasUp) this.ev.state(false)
    const k = this.cur!
    let outcome: SmOutcome = classify(this.errType, code)
    // A handshake refusal has no error message: ask the key endpoint whether the key is the problem.
    if (outcome === 'retry_same' && !opened && !this.errType) {
      if ((await this.deps.testKey(k.key)) === 'auth') outcome = 'rotate_auth'
      if (this.stopped) return
    }
    this.deps.log('stt_error', { errorType: this.errType ?? undefined, status: code ?? undefined, outcome, keySlot: k.slot })
    switch (outcome) {
      case 'retry_same':
        if (this.tries < this.t.retryMs.length) {
          const wait = slowRetry(this.errType, code) ? Math.max(this.t.slowRetryMs, this.t.retryMs[this.tries]!) : this.t.retryMs[this.tries]!
          this.tries++
          this.later(() => this.open(), wait)
        } else {
          this.skip.add(k.id)
          void this.connectNext()
        }
        return
      case 'rotate_rate':
      case 'rotate_quota':
      case 'rotate_auth':
        this.deps.mark(k.id, outcome === 'rotate_rate' ? 'rate_limited' : outcome === 'rotate_quota' ? 'quota_exhausted' : 'auth_failed', this.errType)
        this.skip.add(k.id)
        void this.connectNext()
        return
      case 'fatal_config':
        // Every key would fail the same way: stay on local for this call.
        this.fatal = true
        return
    }
  }

  /** One frame of "them" audio (16 kHz Int16). Always buffered; streamed while a session is up. */
  push(pcm: Int16Array, at = performance.now()) {
    this.ring.write(pcm)
    if (!this.s || !this.started) return
    if (this.s.buffered > this.t.maxBufferedBytes) return void this.fail(this.s, true)
    this.send(pcm)
    this.st.backlog = Math.max(this.st.backlog, performance.now() - at)
    this.flushUsage(false)
    if (this.sent - this.st.from >= 5 * SR) {
      if (this.st.lags.length) {
        const c = this.st.changes
        this.ev.stats({ partialLagMs: median(this.st.lags), partialEveryMs: median(c.slice(1).map((t, i) => t - c[i]!)), count: this.st.lags.length, backlogMs: Math.round(this.st.backlog) })
      }
      this.st = { from: this.sent, lags: [], changes: [], backlog: 0 }
    }
  }

  /** The lane now shows cloud text: forget output for audio the local engine already covered. */
  adopt() {
    this.adoptFrom = this.ring.written
    this.committed = Math.max(this.committed, this.ring.written)
    this.acc = ''
    this.accStart = null
  }

  private flushUsage(force: boolean) {
    if (!this.cur || !this.usage) return
    if (!force && performance.now() - this.usageAt < this.t.usageFlushMs) return
    this.deps.addUsage(this.cur.id, Math.round((this.usage / SR) * 1000))
    this.usage = 0
    this.usageAt = performance.now()
  }

  /** End the call: ask for the last finals (up to 2 s), record usage, stop retrying. */
  async stop() {
    if (this.timer) clearTimeout(this.timer)
    if (this.connectTimer) clearTimeout(this.connectTimer)
    const s = this.s
    if (s && this.started) {
      await s.end(2000)
    }
    this.stopped = true
    s?.close()
    this.s = null
    this.flushUsage(true)
  }
}
