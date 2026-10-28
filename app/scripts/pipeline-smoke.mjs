// Basic validation of the live pipeline revision 2 (architecture.md R1–R6), with the
// scripted fake provider: ZERO Gemini calls. Not the /replica-test acceptance suite.
// Audio is fed in real time, because the TurnDetector's settling window uses wall time.
//
//   npm run build
//   node scripts/pipeline-smoke.mjs <work dir> <audio dir>
//
// <work dir>/stt-model/ must already hold the installed English model (it's adopted, not
// downloaded). <audio dir> holds 16 kHz mono WAVs: q1a q1b nq q2 q3 q4 q5 q6 (see backend.md).
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const work = resolve(process.argv[2] ?? '.smoke')
const audio = resolve(process.argv[3] ?? join(work, 'audio'))
const appDir = resolve(import.meta.dirname, '..')
const userData = join(work, `pipeline-${Date.now()}`)
const script = join(work, 'fake-provider.json')
const SENTINEL = 'ZQX-SENTINEL-4471'
mkdirSync(work, { recursive: true })

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
const setScript = (s) => {
  writeFileSync(script, JSON.stringify(s))
}
setScript({ default: { firstTokenMs: 300, chunkMs: 40 } })

const env = { ...process.env, PARLEY_USER_DATA: userData, PARLEY_STT_MODEL_DIR: join(work, 'stt-model'), PARLEY_FAKE_PROVIDER: script, PARLEY_IGNORE_ENV_KEYS: '1', PARLEY_TEST_NO_CAPTURE: '1', PARLEY_TEST_ALLOW_DIR: join(work, 'files') }
delete env.ELECTRON_RUN_AS_NODE
delete env.PARLEY_MOCK
// No fake-media flags: they bypass the app's capture handlers. PARLEY_TEST_NO_CAPTURE keeps
// the real mic and loopback off, so only the injected frames reach the lanes.
const app = await electron.launch({ args: [appDir], env })
let stdout = ''
app.process().stdout?.on('data', (d) => (stdout += d))
app.process().stderr?.on('data', (d) => (stdout += d))
const page = await app.firstWindow()
const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(String(e)))
await page.waitForLoadState('domcontentloaded')
await page.evaluate(() => {
  window.__ev = []
  for (const n of ['stt:status', 'transcript:final', 'answer:start', 'answer:delta', 'answer:done', 'answer:error', 'gate:status']) window.api.on(n, (p) => window.__ev.push({ n, p, t: Date.now() }))
})

const call = (path, input) =>
  page.evaluate(
    async ([path, input]) => {
      const [a, b] = path.split('.')
      try {
        return { ok: true, value: await window.api[a][b](input) }
      } catch (e) {
        return { ok: false, error: e.message }
      }
    },
    [path, input],
  )
const until = async (fn, arg, ms, step = 200) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await page.evaluate(fn, arg)
    if (v) return v
    await page.waitForTimeout(step)
  }
  return null
}
const logLines = () => {
  const dir = join(userData, 'logs')
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean)).map((l) => JSON.parse(l))
}
const requests = () => logLines().filter((l) => l.event === 'provider_request' && !l.reason).length
const uuid = () => crypto.randomUUID()
const gen = (sessionId, trigger, extra = {}) => call('answers.generate', { sessionId, trigger, clientRequestId: uuid(), ...extra })

function pcmOf(name) {
  const b = readFileSync(join(audio, `${name}.wav`))
  let i = 12
  while (i < b.length) {
    const id = b.toString('ascii', i, i + 4)
    const size = b.readUInt32LE(i + 4)
    if (id === 'data') return Array.from(new Int16Array(b.buffer.slice(b.byteOffset + i + 8, b.byteOffset + i + 8 + size)))
    i += 8 + size
  }
  throw new Error(`no data chunk in ${name}`)
}
const silence = (ms) => new Array(Math.round((ms / 1000) * 16000)).fill(0)
/** Real-time feed on the "them" lane: 100 ms frames every 100 ms. */
async function feed(parts) {
  const pcm = parts.flatMap((p) => (typeof p === 'number' ? silence(p) : pcmOf(p)))
  await page.evaluate(async (pcm) => {
    const start = performance.now()
    for (let i = 0, k = 0; i < pcm.length; i += 1600, k++) {
      const f = new Int16Array(1600)
      f.set(pcm.slice(i, i + 1600))
      window.api.audio.frame({ speaker: 'them', pcm: f.buffer })
      const wait = start + (k + 1) * 100 - performance.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    }
  }, pcm)
}
const evCount = (n, pred = '') => page.evaluate(([n, pred]) => window.__ev.filter((e) => e.n === n && (!pred || new Function('e', `return ${pred}`)(e))).length, [n, pred])

// ---------- R6: model registry ----------
await page.getByText('No calls yet').waitFor({ timeout: 20000 })
const models = (await call('stt.models')).value ?? []
const en = models.find((m) => m.id === 'en-kroko-2025-08-06')
check('existing English install adopted from its marker (no download)', en?.status === 'installed' && !!en.filesVerifiedAt && logLines().some((l) => l.event === 'stt_model_adopted'), en?.status)
check('Hindi is not offered as a selectable model', !models.some((m) => m.language === 'hi' && m.selectable))
const hiCreate = await call('sessions.create', { type: 'interview', companyName: 'X', companyDomain: null, roleTitle: null, jobUrl: null, jobDescription: '', resumeId: null, documentIds: [], language: 'hi', model: 'google:gemini-flash-lite', instructions: '', autoGenerate: false, saveTranscript: true })
check('a Hindi session is refused', !hiCreate.ok, hiCreate.error)

// ---------- R5: background call budget (resume conversion) ----------
const pdfPath = join(work, 'files', 'asha-verma-resume.pdf')
const convCalls = () => logLines().filter((l) => l.event === 'provider_request' && l.reason === 'resume_convert').length
const parseCalls = () => logLines().filter((l) => l.event === 'provider_request' && l.reason === 'resume_parse').length
if (existsSync(pdfPath)) {
  setScript({ default: { firstTokenMs: 50 }, steps: [{ error: 'overloaded' }, { error: 'overloaded' }, { error: 'overloaded' }] })
  const n0 = convCalls()
  const imp = await call('resumes.importFile', { path: pdfPath, title: 'Budget test' })
  check('resume upload during an overload: at most 2 calls, then local text extraction', convCalls() - n0 === 2 && imp.value?.mdMethod === 'text_extract', `${convCalls() - n0} calls, ${imp.value?.mdMethod ?? imp.error}`)
  await page.waitForTimeout(15_500) // the overload cooled both models for 15 s
  setScript({ default: { firstTokenMs: 50, text: '# Asha Verma\n\n## Experience\n- Software Engineer, Lumen Freight' } })
  const n1 = convCalls()
  const p1 = parseCalls()
  const rc = await call('resumes.reconvert', { id: imp.value?.id })
  check('successful conversion: 1 call, and no automatic parse call', convCalls() - n1 === 1 && parseCalls() === p1 && rc.value?.mdMethod === 'ai', `${convCalls() - n1} calls, parse calls +${parseCalls() - p1}`)
} else {
  console.log(`SKIP  resume budget checks (no ${pdfPath}; run backend-smoke once to create it)`)
}
setScript({ default: { firstTokenMs: 300, chunkMs: 40 } })

// sentinel in a key, a resume, instructions and a typed question (§13 #10)
await call('keys.set', { provider: 'google', key: `AIzaFAKE-${SENTINEL}-key` })
const resume = await call('resumes.createFromText', { title: 'Sentinel CV', text: `Backend engineer ${SENTINEL}. Built APIs in C# and ASP.NET Core for five years at Lumen Freight.` })

const mk = (autoGenerate) =>
  call('sessions.create', { type: 'interview', companyName: 'Contoso', companyDomain: null, roleTitle: 'Engineer', jobUrl: null, jobDescription: 'C# APIs', resumeId: resume.value?.id ?? null, documentIds: [], language: 'en-US', model: 'google:gemini-flash-lite', instructions: `Be brief. ${SENTINEL}`, autoGenerate, saveTranscript: true })

// ---------- Session A: automatic answers ----------
const A = (await mk(true)).value
const prep = await call('stt.prepare', { sessionId: A.id })
check('stt:prepare loads the model before Start and reports it', prep.ok && prep.value.state === 'listening' && prep.value.modelId === 'en-kroko-2025-08-06' && prep.value.language === 'en', JSON.stringify(prep.value ?? prep.error))
const startA = await call('sessions.start', { id: A.id })
check('sessions:start (uses the prepared worker)', startA.ok && startA.value.status === 'live', startA.error)
const dl = await call('stt.downloadModel', { modelId: 'en-zipformer-2023-06-26' })
check('model downloads are refused while a call is live', !dl.ok, dl.error)
const lang = await call('sessions.update', { id: A.id, patch: { language: 'en-GB' } })
check('changing the language while live is refused', !lang.ok, lang.error)
await page.evaluate((id) => (location.hash = `#/overlay/live/${id}`), A.id)
await page.getByRole('toolbar', { name: 'Call controls' }).waitFor({ timeout: 15000 })

const r0 = requests()
// A question with a 1.2 s pause in the middle.
await feed(['q1a', 1200, 'q1b', 3500])
const autoStart = await until(() => window.__ev.find((e) => e.n === 'answer:start' && e.p.trigger === 'auto')?.p, null, 15000)
const autoDone = autoStart ? await until((id) => window.__ev.find((e) => e.n === 'answer:done' && e.p.id === id)?.p, autoStart.answerId, 15000) : null
check('auto answer for a question with a pause: exactly 1 provider request', requests() - r0 === 1, `${requests() - r0} requests`)
check('the detected turn (one candidate) contains both halves of the question', /garbage/i.test(autoStart?.questionDraft ?? '') && /NET|run/i.test(autoStart?.questionDraft ?? ''), autoStart?.questionDraft)
const shown = await page.getByText(/Fake provider/).first().isVisible().catch(() => false)
check('the automatic answer appears in the answer panel (finding 1)', shown)
const autoDeltas = autoStart ? await evCount('answer:delta', `e.p.answerId === '${autoStart.answerId}'`) : 0
check('automatic answer streamed as deltas with offsets', autoDeltas > 1 && (await page.evaluate((id) => window.__ev.filter((e) => e.n === 'answer:delta' && e.p.answerId === id && e.p.part === 'answer').every((e) => typeof e.p.offset === 'number'), autoStart?.answerId)), `${autoDeltas} deltas`)

const r1 = requests()
const press = await gen(A.id, 'answer')
check('Answer with no new speech is reused, not re-sent (finding 4)', press.ok && press.value.outcome === 'reused' && press.value.answerId === autoStart?.answerId && requests() === r1, JSON.stringify(press.value))
await feed(['nq', 3500])
await page.waitForTimeout(2500)
check('a non-question makes no request', requests() === r1, `${requests() - r1} requests`)

// cross-path join: Answer while the auto answer for the same question is in flight
setScript({ default: { firstTokenMs: 3000, chunkMs: 40 } })
const r2 = requests()
const before = await evCount('answer:start')
await feed(['q2', 3500])
const auto2 = await until((n) => window.__ev.filter((e) => e.n === 'answer:start').length > n && window.__ev.filter((e) => e.n === 'answer:start').at(-1).p, before, 15000)
if (!auto2) console.log('      finals:', JSON.stringify(await page.evaluate(() => window.__ev.filter((e) => e.n === 'transcript:final').map((e) => [e.t % 100000, e.p.speaker, e.p.text]))))
if (!auto2) console.log('      gate log:', JSON.stringify(logLines().filter((l) => /candidate|gate_decision/.test(l.event)).slice(-8)))
const joined = auto2 ? await gen(A.id, 'answer') : null
check('Answer during the auto answer for the same question joins it (0 extra requests)', joined?.value?.outcome === 'joined' && joined.value.answerId === auto2.answerId, JSON.stringify(joined?.value))
await until((id) => window.__ev.some((e) => e.n === 'answer:done' && e.p.id === id), auto2?.answerId, 15000)
check('...and the provider got exactly 1 request', requests() - r2 === 1, `${requests() - r2}`)
await call('sessions.end', { id: A.id, mode: 'end' })

// ---------- Session B: manual paths and retries ----------
setScript({ default: { firstTokenMs: 200, chunkMs: 40 } })
const B = (await mk(false)).value
await call('sessions.start', { id: B.id })
await page.evaluate((id) => (location.hash = `#/overlay/live/${id}`), B.id)
await page.getByRole('toolbar', { name: 'Call controls' }).waitFor({ timeout: 15000 })

async function manualAfter(clip, steps) {
  setScript({ default: { firstTokenMs: 200, chunkMs: 40 }, steps })
  await feed([clip, 3000])
  const r = requests()
  const t0 = Date.now()
  const res = await gen(B.id, 'answer')
  const id = res.value?.answerId
  const end = id ? await until((id) => window.__ev.find((e) => (e.n === 'answer:done' && e.p.id === id) || (e.n === 'answer:error' && e.p.answerId === id))?.p, id, 20000) : null
  return { res, id, end, calls: requests() - r, ms: Date.now() - t0 }
}

const m429 = await manualAfter('q3', [{ error: 'rate_limited', retryAfterS: 2 }])
const row429 = (await call('answers.get', { answerId: m429.id })).value
check('429 per minute (retryDelay 2 s): manual gets exactly one retry, then succeeds', m429.calls === 2 && row429?.status === 'done' && row429.attempts === 2 && m429.ms >= 2000, `${m429.calls} calls, ${m429.ms} ms, attempts=${row429?.attempts}`)

const m503 = await manualAfter('q5', [{ error: 'overloaded' }])
check('503: one retry after a short backoff, then succeeds', m503.calls === 2 && m503.end?.answerMd, `${m503.calls} calls`)

const mInt = await manualAfter('q6', [{ failAfterChunks: 10, chunkMs: 40 }])
const rowInt = (await call('answers.get', { answerId: mInt.id })).value
check('interrupted stream keeps the partial text, status interrupted, no automatic retry', mInt.end?.code === 'interrupted' && rowInt?.endReason === 'interrupted' && rowInt.answerMd.length > 0 && mInt.calls === 1, `code=${mInt.end?.code} endReason=${rowInt?.endReason} ${mInt.calls} calls, kept ${rowInt?.answerMd?.length} chars`)
setScript({ default: { firstTokenMs: 200, chunkMs: 40 } })
const retry = await gen(B.id, 'answer', { retryOf: mInt.id })
await until((id) => window.__ev.some((e) => e.n === 'answer:done' && e.p.id === id), retry.value?.answerId, 15000)
const rowRetry = (await call('answers.get', { answerId: retry.value?.answerId })).value
check('Retry creates a new answer linked by retry_of', retry.value?.outcome === 'started' && rowRetry?.retryOf === mInt.id, JSON.stringify(retry.value))

// supersede: a newer request cancels the one in flight, with no events after
setScript({ default: { firstTokenMs: 100, chunkMs: 150, chunkChars: 8 } })
const c1 = await gen(B.id, 'chat', { text: `Explain eventual consistency ${SENTINEL}` })
await until((id) => window.__ev.some((e) => e.n === 'answer:delta' && e.p.answerId === id), c1.value?.answerId, 10000, 50)
const c2 = await gen(B.id, 'chat', { text: 'What is a covering index?' })
const c1err = await until((id) => window.__ev.find((e) => e.n === 'answer:error' && e.p.answerId === id), c1.value?.answerId, 5000, 50)
await page.waitForTimeout(800)
const late = await page.evaluate(([id, t]) => window.__ev.filter((e) => e.n === 'answer:delta' && e.p.answerId === id && e.t > t).length, [c1.value?.answerId, c1err?.t ?? 0])
check('a newer request supersedes the one in flight; no deltas after cancel', c1err?.p.endReason === 'superseded' && late === 0, `endReason=${c1err?.p.endReason}, late=${late}`)
await until((id) => window.__ev.some((e) => e.n === 'answer:done' && e.p.id === id), c2.value?.answerId, 20000)
const current = await page.evaluate(() => document.querySelector('[aria-label^="Answer "][aria-label*=" of "]')?.getAttribute('aria-label'))
check('the newest answer stays current in the panel', !!current && /Answer (\d+) of \1$/.test(current), current)

// daily quota: no retry, then no call at all
const mDay = await manualAfter('q4', [{ error: 'quota_exhausted' }])
await feed(['q2', 3000])
const r3 = requests()
const again = await gen(B.id, 'answer')
const gate = (await call('answers.gateStatus', { sessionId: B.id })).value
check('daily quota: failed with no retry', mDay.calls === 1 && mDay.end?.code === 'quota_exhausted', `${mDay.calls} calls, ${mDay.end?.code}`)
check('daily quota: the next press makes no call and explains why', again.value?.outcome === 'suppressed' && again.value.reason === 'quota_exhausted' && requests() === r3 && gate?.provider === 'exhausted', JSON.stringify(again.value))
await call('sessions.end', { id: B.id, mode: 'leave' })

// ---------- R1: logs ----------
await page.waitForTimeout(500)
const logs = readdirSync(join(userData, 'logs')).map((f) => readFileSync(join(userData, 'logs', f), 'utf8')).join('\n')
check('sentinel (key, resume, instructions, typed question) appears 0 times in logs and stdout/stderr', !logs.includes(SENTINEL) && !stdout.includes(SENTINEL), `${(logs.match(new RegExp(SENTINEL, 'g')) ?? []).length} in logs`)
check('no transcript text in logs', !/garbage|runtime|rate limiter/i.test(logs))
const realCalls = logLines().filter((l) => l.event === 'provider_request' && l.provider !== 'fake').length
check('zero real provider calls in this run', realCalls === 0, `${realCalls}`)

await app.close()
console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors')
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
