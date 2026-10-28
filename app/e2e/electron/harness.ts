// Shared helpers for the Electron specs. The built app (npm run build) runs against a
// throwaway user-data folder, the scripted fake provider (PARLEY_FAKE_PROVIDER) and no
// real capture (PARLEY_TEST_NO_CAPTURE); env keys are ignored, so no Gemini call is
// possible unless a spec passes `real: true`. Provider calls are counted from the app's
// own structured log (`provider_request`, one line per attempt), not inferred from the UI.
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const APP_DIR = resolve(import.meta.dirname, '../..')
export const WORK = join(APP_DIR, '.smoke')
export const AUDIO = join(APP_DIR, 'e2e/fixtures/audio')
export const MODEL_DIR = join(WORK, 'stt-model')
export const FILES = join(WORK, 'files')
export const SENTINEL = 'ZQX-SENTINEL-4471'

export interface FakeStep {
  text?: string
  firstTokenMs?: number
  chunkMs?: number
  chunkChars?: number
  failAfterChunks?: number
  hang?: boolean
  output?: unknown
  error?: 'rate_limited' | 'quota_exhausted' | 'overloaded' | 'unclassified_429' | 'auth' | 'offline' | 'not_found' | 'auth_invalid_400' | 'forbidden_403' | 'region_403'
  retryAfterS?: number
}

export interface Ev {
  n: string
  p: any
  t: number
}

export class Harness {
  app!: ElectronApplication
  page!: Page
  stdout = ''
  errors: string[] = []
  readonly userData: string
  readonly script: string
  private scriptN = 0

  constructor(
    readonly name: string,
    private opts: { real?: boolean; userData?: string; extraEnv?: Record<string, string> } = {},
  ) {
    mkdirSync(WORK, { recursive: true })
    this.userData = opts.userData ?? join(WORK, `e2e-${name}-${Date.now()}`)
    this.script = join(WORK, `fake-${name}.json`)
  }

  setScript(s: { default?: FakeStep; steps?: FakeStep[]; models?: Record<string, { default?: FakeStep; steps?: FakeStep[] }> }) {
    // The fake provider reloads on mtime change; a counter keeps two writes in the same ms distinct.
    writeFileSync(this.script, JSON.stringify({ ...s, _n: ++this.scriptN }))
  }

  async launch() {
    if (!existsSync(this.script)) this.setScript({ default: { firstTokenMs: 300, chunkMs: 40 } })
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PARLEY_USER_DATA: this.userData,
      PARLEY_STT_MODEL_DIR: MODEL_DIR,
      PARLEY_TEST_NO_CAPTURE: '1',
      PARLEY_TEST_ALLOW_DIR: FILES,
      ...(this.opts.extraEnv ?? {}),
    }
    if (!this.opts.real) {
      env.PARLEY_FAKE_PROVIDER = this.script
      env.PARLEY_IGNORE_ENV_KEYS = '1'
    }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.PARLEY_MOCK
    this.app = await electron.launch({ args: [APP_DIR], env })
    this.app.process().stdout?.on('data', (d) => (this.stdout += d))
    this.app.process().stderr?.on('data', (d) => (this.stdout += d))
    this.page = await this.app.firstWindow()
    this.page.on('console', (m) => m.type() === 'error' && this.errors.push(m.text()))
    this.page.on('pageerror', (e) => this.errors.push(String(e)))
    await this.page.waitForLoadState('domcontentloaded')
    await this.tap()
    return this
  }

  /** Record events in the renderer (receipt time) and in main (send time). */
  async tap() {
    await this.page.evaluate(() => {
      const w = window as any
      w.__ev = []
      for (const n of ['stt:status', 'transcript:partial', 'transcript:final', 'answer:start', 'answer:delta', 'answer:done', 'answer:error', 'gate:status'])
        w.api.on(n, (p: unknown) => w.__ev.push({ n, p, t: Date.now() }))
      // First moment the visible answer body shows text beyond the question line, per answer.
      w.__vis = {}
      const obs = new MutationObserver(() => {
        const body = document.querySelector('[aria-label="Answer text"]')
        if (!body) return
        // body text minus the question line and the static "Answer:" label
        const q = body.querySelector('p')?.textContent ?? ''
        const len = (body.textContent ?? '').slice(q.length).replace(/^\s*Answer:/, '').trim().length
        const label = document.querySelector('[aria-label^="Answer "][aria-label*=" of "]')?.getAttribute('aria-label') ?? ''
        const shown = Number(/^Answer (\d+) of/.exec(label)?.[1] ?? 0) - 1
        // the panel is showing the answer with this seq (not the previous one)
        const cur = [...w.__ev].reverse().find((e: any) => e.n === 'answer:start' && e.p.seq === shown)?.p.answerId
        if (cur && len > 0 && !w.__vis[cur]) w.__vis[cur] = Date.now()
      })
      obs.observe(document.body, { subtree: true, childList: true, characterData: true })
    })
    await this.app.evaluate(({ BrowserWindow }) => {
      const g = globalThis as any
      g.__mainEv = []
      for (const w of BrowserWindow.getAllWindows()) {
        const wc = w.webContents as any
        if (wc.__tapped) continue
        wc.__tapped = true
        const orig = wc.send.bind(wc)
        wc.send = (ch: string, name: string, payload: any) => {
          if (ch === 'event' && /^answer:/.test(name) && w === BrowserWindow.getAllWindows()[0]) g.__mainEv.push({ n: name, id: payload?.answerId ?? payload?.id, part: payload?.part, offset: payload?.offset, t: Date.now() })
          return orig(ch, name, payload)
        }
      }
    })
  }

  mainEvents(): Promise<Array<{ n: string; id: string; part?: string; offset?: number; t: number }>> {
    return this.app.evaluate(() => (globalThis as any).__mainEv)
  }

  call<T = any>(path: string, input?: unknown): Promise<{ ok: boolean; value?: T; error?: string; code?: string }> {
    return this.page.evaluate(
      async ([path, input]) => {
        const [a, b] = (path as string).split('.')
        try {
          return { ok: true, value: await (window as any).api[a!][b!](input) }
        } catch (e: any) {
          return { ok: false, error: e.message, code: e.code }
        }
      },
      [path, input] as const,
    )
  }

  gen(sessionId: string, trigger: 'answer' | 'chat' | 'screenshot', extra: Record<string, unknown> = {}) {
    return this.call('answers.generate', { sessionId, trigger, clientRequestId: crypto.randomUUID(), ...extra })
  }

  events(): Promise<Ev[]> {
    return this.page.evaluate(() => (window as any).__ev)
  }

  async until<T>(fn: (ev: Ev[]) => T | null | undefined | false, ms = 15_000, step = 100): Promise<T | null> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const v = fn(await this.events())
      if (v) return v
      await this.page.waitForTimeout(step)
    }
    return null
  }

  async waitEnd(answerId: string | undefined, ms = 20_000) {
    if (!answerId) return null
    return this.until((ev) => ev.find((e) => (e.n === 'answer:done' && e.p.id === answerId) || (e.n === 'answer:error' && e.p.answerId === answerId)), ms)
  }

  logLines(): any[] {
    const dir = join(this.userData, 'logs')
    if (!existsSync(dir)) return []
    return readdirSync(dir).flatMap((f) =>
      readFileSync(join(dir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    )
  }

  logText(): string {
    const dir = join(this.userData, 'logs')
    if (!existsSync(dir)) return ''
    return readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n')
  }

  /** Live-answer provider attempts (background jobs carry a `reason`). */
  requests(sessionId?: string): any[] {
    return this.logLines().filter((l) => l.event === 'provider_request' && !l.reason && (!sessionId || l.sessionId === sessionId))
  }

  realRequests(): any[] {
    return this.logLines().filter((l) => l.event === 'provider_request' && l.provider !== 'fake')
  }

  // ---------- audio ----------

  static pcmOf(name: string): number[] {
    const b = readFileSync(join(AUDIO, `${name}.wav`))
    let i = 12
    while (i < b.length) {
      const id = b.toString('ascii', i, i + 4)
      const size = b.readUInt32LE(i + 4)
      if (id === 'data') return Array.from(new Int16Array(b.buffer.slice(b.byteOffset + i + 8, b.byteOffset + i + 8 + size)))
      i += 8 + size
    }
    throw new Error(`no data chunk in ${name}`)
  }

  /**
   * Real-time feed: 100 ms frames every 100 ms. Parts are clip names, silence in ms, or
   * { speaker } switches. Returns the wall time each clip's audio ended (speech end).
   */
  static trailingSilenceMs(name: string): number {
    const a = Harness.pcmOf(name)
    let k = a.length
    for (; k > 160; k -= 160) {
      let sum = 0
      for (let j = k - 160; j < k; j++) sum += a[j]! * a[j]!
      if (Math.sqrt(sum / 160) / 32768 > 0.0125) break
    }
    return Math.round(((a.length - k) / 16000) * 1000)
  }

  static durationMs(parts: Array<string | number>): number {
    return parts.reduce<number>((n, p) => n + (typeof p === 'number' ? p : (Harness.pcmOf(p).length / 16000) * 1000), 0)
  }

  /** Feed parts, then silence until `totalMs` has passed: real capture never stops sending frames. */
  async feedSlot(parts: Array<string | number>, totalMs: number) {
    const rest = Math.max(0, totalMs - Harness.durationMs(parts))
    return this.feed(rest ? [...parts, rest] : parts)
  }

  async feed(parts: Array<string | number>, speaker: 'them' | 'you' = 'them'): Promise<Record<string, number>> {
    // Clips go over as base64 Int16 PCM; silence is made in the page (no giant arrays).
    const plan = parts.map((p) => (typeof p === 'number' ? { silence: Math.round((p / 1000) * 16000) } : { name: p, b64: Buffer.from(new Int16Array(Harness.pcmOf(p)).buffer).toString('base64') }))
    const res: { t0: number; ends: Array<[string, number]> } = await this.page.evaluate(
      async ([plan, speaker]) => {
        const chunks: Int16Array[] = []
        const ends: Array<[string, number]> = []
        let total = 0
        for (const p of plan as Array<{ silence?: number; name?: string; b64?: string }>) {
          let a: Int16Array
          if (p.b64) {
            const bin = atob(p.b64)
            const u8 = new Uint8Array(bin.length)
            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
            a = new Int16Array(u8.buffer)
          } else a = new Int16Array(p.silence ?? 0)
          chunks.push(a)
          total += a.length
          if (p.name) ends.push([p.name, total])
        }
        const pcm = new Int16Array(total)
        let o = 0
        for (const c of chunks) {
          pcm.set(c, o)
          o += c.length
        }
        const t0 = Date.now()
        const s = performance.now()
        for (let i = 0, k = 0; i < pcm.length; i += 1600, k++) {
          const f = new Int16Array(1600)
          f.set(pcm.subarray(i, i + 1600))
          ;(window as any).api.audio.frame({ speaker, pcm: f.buffer })
          const wait = s + (k + 1) * 100 - performance.now()
          if (wait > 0) await new Promise((r) => setTimeout(r, wait))
        }
        return { t0, ends }
      },
      [plan, speaker] as const,
    )
    const out: Record<string, number> = {}
    // speech end = the last voiced 10 ms of the clip (clips carry ~0.9 s of trailing silence)
    for (const [name, end] of res.ends) out[name] = res.t0 + Math.round((end / 16000) * 1000) - Harness.trailingSilenceMs(name)
    return out
  }

  // ---------- sessions ----------

  async createSession(o: { autoGenerate: boolean; language?: string; resumeId?: string | null; instructions?: string; model?: string; saveTranscript?: boolean }) {
    const r = await this.call('sessions.create', {
      type: 'interview',
      companyName: 'Contoso',
      companyDomain: null,
      roleTitle: 'Backend Engineer',
      jobUrl: null,
      jobDescription: 'C# and distributed systems.',
      resumeId: o.resumeId ?? null,
      documentIds: [],
      language: o.language ?? 'en-US',
      model: o.model ?? 'google:gemini-flash-lite',
      instructions: o.instructions ?? '',
      autoGenerate: o.autoGenerate,
      saveTranscript: o.saveTranscript ?? true,
    })
    expect(r.ok, r.error).toBe(true)
    return r.value as { id: string }
  }

  async goLive(sessionId: string) {
    const prep = await this.call('stt.prepare', { sessionId })
    expect(prep.ok, prep.error).toBe(true)
    const st = await this.call('sessions.start', { id: sessionId })
    expect(st.ok, st.error).toBe(true)
    await this.page.evaluate((id) => (location.hash = `#/overlay/live/${id}`), sessionId)
    await this.page.getByRole('toolbar', { name: 'Call controls' }).waitFor({ timeout: 20_000 })
    return prep.value
  }

  async close() {
    await this.app?.close().catch(() => {})
  }
}
