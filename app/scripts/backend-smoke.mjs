// Basic backend smoke check (not the full /replica-test suite). Launches the built app
// (npm run build first) against a throwaway data folder and drives the real preload
// API: SQLite, key handling, speech model download, local STT fed with speech audio,
// real model calls (needs GEMINI_API_KEY in the environment or .env.local), cancel and
// duplicate guards, notes, persistence across a restart and crash recovery.
//
//   node scripts/backend-smoke.mjs <work dir> [them.wav] [you.wav]
//
// The work dir keeps the downloaded speech model between runs (stt-model/).
import { _electron as electron, chromium } from 'playwright'
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const work = resolve(process.argv[2] ?? '.smoke')
const themWav = process.argv[3]
const youWav = process.argv[4]
const appDir = resolve(import.meta.dirname, '..')
const userData = join(work, `userdata-${Date.now()}`)
const filesDir = join(work, 'files')
mkdirSync(filesDir, { recursive: true })

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
const skip = (name, why) => console.log(`SKIP  ${name}  (${why})`)

// A fictional resume as a real PDF, printed by the system Edge.
const pdfPath = join(filesDir, 'asha-verma-resume.pdf')
if (!existsSync(pdfPath)) {
  const b = await chromium.launch({ channel: 'msedge' })
  const p = await b.newPage()
  await p.setContent(`<h1>Asha Verma</h1><p>Backend engineer · Pune, India · asha.verma@example.com</p>
  <h2>Summary</h2><p>Backend engineer with 4 years of experience building .NET APIs.</p>
  <h2>Experience</h2><h3>Software Engineer, Lumen Freight (2022 – present)</h3><ul><li>Built a shipment tracking API in ASP.NET Core serving 2 million requests a day.</li><li>Cut report load time from 9 s to 1.2 s with covering indexes in SQL Server.</li></ul>
  <h3>Junior Developer, Orbit Retail (2020 – 2022)</h3><ul><li>Maintained an inventory service in C# and Entity Framework Core.</li></ul>
  <h2>Skills</h2><p>C#, ASP.NET Core, Entity Framework Core, SQL Server, Azure, Docker, React</p>`)
  await p.pdf({ path: pdfPath, format: 'A4' })
  await b.close()
}
writeFileSync(join(filesDir, 'notes.txt'), 'Team uses Azure Service Bus for messaging and xUnit for tests.')

const env = { ...process.env, PARLEY_USER_DATA: userData, PARLEY_STT_MODEL_DIR: join(work, 'stt-model'), PARLEY_TEST_ALLOW_DIR: filesDir }
delete env.ELECTRON_RUN_AS_NODE
const args = [appDir, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
if (youWav) args.push(`--use-file-for-fake-audio-capture=${resolve(youWav)}%noloop`)

const errors = []
async function launch() {
  const app = await electron.launch({ args, env })
  const page = await app.firstWindow()
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => {
    window.__ev = []
    for (const n of ['stt:status', 'transcript:final', 'transcript:partial', 'answer:delta', 'answer:done', 'answer:error', 'notes:status', 'review:delta', 'prefs:previewDelta', 'stt:downloadProgress', 'resumes:progress']) {
      window.api.on(n, (p) => window.__ev.push({ n, p, t: Date.now() }))
    }
  })
  return { app, page }
}

const call = (page, path, input) =>
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

const until = async (page, fn, arg, ms, step = 250) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await page.evaluate(fn, arg)
    if (v) return v
    await page.waitForTimeout(step)
  }
  return null
}

function wavPcm(file) {
  const b = readFileSync(file)
  let i = 12
  while (i < b.length) {
    const id = b.toString('ascii', i, i + 4)
    const size = b.readUInt32LE(i + 4)
    if (id === 'data') return Array.from(new Int16Array(b.buffer.slice(b.byteOffset + i + 8, b.byteOffset + i + 8 + size)))
    i += 8 + size
  }
  throw new Error('no data chunk')
}

// ---------------- first launch ----------------
let { app, page } = await launch()
await page.getByText('No calls yet').waitFor({ timeout: 20000 })
check('fresh database shows the S03 empty state', true)
check('real data layer exposed (window.api)', await page.evaluate(() => typeof window.api === 'object' && typeof window.api.sessions.list === 'function'))

// security and validation
const nativeData = await page.evaluate(() => window.native.invoke('sessions:list').then(() => 'allowed', (e) => e.message))
check('window.native cannot reach data channels', nativeData.startsWith('Unknown channel'), nativeData)
const outside = await call(page, 'resumes.importFile', { path: 'C:\\Windows\\win.ini', title: 'x' })
check('importFile refuses a path the user did not pick', !outside.ok && /no longer available/.test(outside.error), outside.error)
const badZoom = await call(page, 'settings.update', { zoom: 5 })
check('settings:update validates input (zod) with a clean message', !badZoom.ok && !/invoking remote method/.test(badZoom.error), badZoom.error)
const deepgram = await call(page, 'settings.update', { sttProvider: 'deepgram' })
check('Deepgram STT is refused (not built)', !deepgram.ok, deepgram.error)
await call(page, 'settings.update', { privateMode: false, defaultLanguage: 'en-GB' })

// keys and models
const keys = await call(page, 'keys.status')
const g = keys.value?.find((k) => k.provider === 'google')
check('Gemini key visible as last 4 only (env, dev build)', !!g && g.last4.length === 4 && !('key' in g), g ? `source=${g.source}` : 'no google key in env')
const kt = await call(page, 'keys.test', { provider: 'google' })
check('keys:test makes a real Gemini request', kt.ok && kt.value.ok, kt.value?.error ?? kt.error)
const models = await call(page, 'models.list')
check('models:list filtered to keyed providers', models.ok && models.value.some((m) => m.id === 'google:gemini-flash-lite'), models.value?.map((m) => m.id).join(','))

// speech model
const st0 = await call(page, 'stt.modelStatus')
const t0 = Date.now()
const dl = await call(page, 'stt.downloadModel', { modelId: 'en-kroko-2025-08-06' })
const pcts = await page.evaluate(() => window.__ev.filter((e) => e.n === 'stt:downloadProgress').length)
const st1 = await call(page, 'stt.modelStatus')
check('speech model download + sha256 verify', dl.ok && dl.value.ok && st1.value.ready, `was ready=${st0.value?.ready}, ${Math.round((Date.now() - t0) / 1000)} s, ${pcts} progress events, ${st1.value?.sizeMb} MB`)

// resumes
const pdf = await call(page, 'resumes.importFile', { path: pdfPath, title: 'Asha Verma CV' })
check('resume PDF -> Markdown with Gemini', pdf.ok && pdf.value.mdStatus === 'ready' && pdf.value.mdMethod === 'ai' && /Lumen Freight/.test(pdf.value.contentMd), pdf.ok ? `${pdf.value.mdMethod}, ${pdf.value.contentMd.length} chars` : pdf.error)
const dup = await call(page, 'resumes.importFile', { path: pdfPath, title: 'again' })
check('re-importing the same PDF is flagged as a duplicate', dup.ok && dup.value.duplicateOf === pdf.value?.id)
// The protocol is used by the S18 iframe and download link; fetch it through main's net module.
const viaMain = (u) => app.evaluate(({ net }, u) => net.fetch(u).then((r) => `${r.status} ${r.headers.get('content-type')}`, (e) => String(e.message)), u)
const served = pdf.ok ? await viaMain(pdf.value.fileUrl) : 'n/a'
check('app-file:// serves the stored PDF', /^200 application\/pdf/.test(served), served)
const escape = await viaMain('app-file://files/..%2Fdata%2Fapp.db')
const escape2 = await viaMain('app-file://other/C:/Windows/win.ini')
check('app-file:// refuses paths outside the files folder', /^404/.test(escape) && /^404/.test(escape2), `${escape} / ${escape2}`)
if (pdf.ok) await call(page, 'resumes.parse', { id: pdf.value.id })
const parsed = pdf.ok ? await until(page, async (id) => { const r = await window.api.resumes.get({ id }); return r.parseStatus === 'ready' || r.parseStatus === 'failed' ? r : null }, pdf.value.id, 90000, 1000) : null
check('resume structured parse (S18)', parsed?.parseStatus === 'ready' && parsed.parsed?.experience?.length >= 1, parsed ? `${parsed.parseStatus} ${parsed.parseError ?? ''} skills=${Object.keys(parsed.parsed?.skills ?? {}).join('/')}` : 'timed out')

// documents
const doc = await call(page, 'documents.importFile', { path: join(filesDir, 'notes.txt'), title: 'Team notes' })
check('document import (txt)', doc.ok && doc.value.textStatus === 'ready', doc.error)

// session + live call
const created = await call(page, 'sessions.create', {
  type: 'interview', companyName: 'Contoso', companyDomain: null, roleTitle: 'Backend Engineer', jobUrl: null,
  jobDescription: 'We build .NET microservices on Azure. You will design APIs and work with SQL Server.',
  resumeId: pdf.value?.id ?? null, documentIds: doc.ok ? [doc.value.id] : [], language: 'en-US', model: 'google:gemini-flash-lite',
  instructions: 'Keep answers practical.', autoGenerate: false, saveTranscript: true,
})
check('sessions:create', created.ok && created.value.status === 'draft', created.error)
const sid = created.value.id
const nonEnglish = await call(page, 'sessions.update', { id: sid, patch: { language: 'hi' } })
check('non-English language refused with the local model', !nonEnglish.ok, nonEnglish.error)
const started = await call(page, 'sessions.start', { id: sid })
check('sessions:start -> live', started.ok && started.value.status === 'live', started.error)
const listening = await until(page, async () => (await window.api.stt.status()).state === 'listening', null, 20000)
check('STT worker ready (utilityProcess + sherpa-onnx)', !!listening)

// 1) "them" lane fed directly over audio:frame before any capture runs (Chromium's fake
//    device flag also feeds the fake file into loopback capture, which would mix lanes).
let themText = null
if (themWav) {
  const pcm = wavPcm(themWav)
  await page.evaluate(async (pcm) => {
    const frame = 1600
    for (let i = 0; i < pcm.length + 16000 * 3.5; i += frame) {
      const f = new Int16Array(frame)
      if (i < pcm.length) f.set(pcm.slice(i, i + frame))
      window.api.audio.frame({ speaker: 'them', pcm: f.buffer })
      await new Promise((r) => setTimeout(r, 25))
    }
  }, pcm)
  // 3.5 s of silence follow the speech; the model ends the line within it.
  themText = await until(page, () => window.__ev.filter((e) => e.n === 'transcript:final' && e.p.speaker === 'them').map((e) => e.p.text).join(' / ') || null, null, 20000)
  if (process.env.SMOKE_STT_ONLY) {
    console.log(await page.evaluate(() => window.__ev.filter((e) => e.n.startsWith('transcript')).map((e) => `${e.t % 100000} ${e.n} ${e.p.speaker}: ${e.p.text}`).join('\n')))
    await app.close()
    process.exit(0)
  }
}
if (themWav) check('"them" audio -> transcript:final (IPC -> main -> worker)', !!themText && /dependency injection/i.test(themText), themText ?? 'no final')
else skip('"them" audio -> transcript:final', 'pass a speech WAV (16 kHz mono) asking about dependency injection as the 2nd argument')

// 2) Open the live view: the renderer starts real capture (fake mic file via getUserMedia,
//    loopback via getDisplayMedia) through the AudioWorklet.
const beforeCapture = await page.evaluate(() => window.__ev.length)
await page.evaluate((id) => { location.hash = `#/overlay/live/${id}` }, sid)
await page.getByRole('toolbar', { name: 'Call controls' }).waitFor({ timeout: 15000 })
const captured = youWav
  ? await until(page, (from) => window.__ev.slice(from).filter((e) => e.n === 'transcript:final' && /current job|happy to explain/i.test(e.p.text)).map((e) => `${e.p.speaker}: ${e.p.text}`).join(' | ') || null, beforeCapture, 30000)
  : null
if (youWav) check('captured audio (worklet -> 16 kHz frames) -> transcript:final', !!captured, captured ?? 'no final from the capture path')
else skip('captured audio -> transcript:final', 'pass a speech WAV mentioning "current job" as the 3rd argument')
const answerChip = await page.getByRole('button', { name: /^Answer/ }).isEnabled()
check('live view: Answer enabled once STT is listening', answerChip)

// answers
const gen = await call(page, 'answers.generate', { clientRequestId: crypto.randomUUID(), sessionId: sid, trigger: 'answer' })
const dupGen = await call(page, 'answers.generate', { clientRequestId: crypto.randomUUID(), sessionId: sid, trigger: 'answer' })
check('a second press within 300 ms returns the same answer', gen.ok && dupGen.ok && gen.value.answerId === dupGen.value.answerId)
const done = gen.ok ? await until(page, (id) => window.__ev.find((e) => (e.n === 'answer:done' && e.p.id === id) || (e.n === 'answer:error' && e.p.answerId === id))?.p, gen.value.answerId, 60000) : null
if (themWav) {
  check('Answer: streamed Gemini reply with rewritten question', !!done?.answerMd && !!done?.question, done?.answerMd ? `Q: ${done.question} | first token ${done.firstTokenMs} ms | ${done.answerMd.length} chars` : JSON.stringify(done))
  if (done?.answerMd) console.log('      ', done.answerMd.slice(0, 300).replace(/\n/g, ' '))
  const deltas = gen.ok ? await page.evaluate((id) => window.__ev.filter((e) => e.n === 'answer:delta' && e.p.answerId === id).length, gen.value.answerId) : 0
  check('answer arrived as batched deltas', deltas > 1, `${deltas} deltas`)
} else {
  check('Answer with an empty transcript explains there is nothing to answer', /Nothing new to answer/.test(done?.message ?? ''), done?.message)
}

const first = await call(page, 'answers.generate', { clientRequestId: crypto.randomUUID(), sessionId: sid, trigger: 'chat', text: 'Explain the CAP theorem in depth with examples.' })
await until(page, (id) => window.__ev.some((e) => e.n === 'answer:delta' && e.p.answerId === id), first.value?.answerId, 20000, 100)
const second = await call(page, 'answers.generate', { clientRequestId: crypto.randomUUID(), sessionId: sid, trigger: 'chat', text: 'What is a covering index?' })
const firstEnd = await until(page, (id) => window.__ev.find((e) => e.n === 'answer:error' && e.p.answerId === id)?.p, first.value?.answerId, 10000)
check('a new request cancels the one in flight', firstEnd?.code === 'cancelled', JSON.stringify(firstEnd))
const secondDone = await until(page, (id) => window.__ev.find((e) => (e.n === 'answer:done' && e.p.id === id) || (e.n === 'answer:error' && e.p.answerId === id))?.p, second.value?.answerId, 60000)
check('chat answer completes after the cancel', !!secondDone?.answerMd, secondDone?.question ?? JSON.stringify(secondDone))
const lateDeltas = await page.evaluate((a) => {
  const stopAt = window.__ev.find((e) => e.n === 'answer:error' && e.p.answerId === a)?.t ?? Infinity
  return window.__ev.filter((e) => e.n === 'answer:delta' && e.p.answerId === a && e.t > stopAt).length
}, first.value?.answerId)
check('no deltas from the cancelled answer after it was cancelled', lateDeltas === 0, `${lateDeltas} late deltas`)

const stop = await call(page, 'answers.generate', { clientRequestId: crypto.randomUUID(), sessionId: sid, trigger: 'chat', text: 'Write a long essay about distributed systems.' })
await until(page, (id) => window.__ev.some((e) => e.n === 'answer:delta' && e.p.answerId === id), stop.value?.answerId, 20000, 100)
await call(page, 'answers.cancel', { answerId: stop.value?.answerId })
const stopped = (await call(page, 'answers.list', { sessionId: sid })).value?.find((a) => a.id === stop.value?.answerId)
check('answers:cancel stops and keeps the partial text', stopped?.status === 'cancelled', `${stopped?.status}, ${stopped?.answerMd?.length ?? 0} chars kept`)

const prev = await call(page, 'prefs.preview', { prefs: { format: 'bullets', star: false, filler_words: false, length: 'short', tone: 'formal' }, questionType: 'technical' })
const prevDone = await until(page, (id) => window.__ev.find((e) => e.n === 'prefs:previewDelta' && e.p.previewId === id && e.p.done)?.p.text, prev.value?.previewId, 60000)
check('S09 preview streams a real sample answer', !!prevDone, prevDone ? prevDone.slice(0, 80).replace(/\n/g, ' ') : 'empty')

const job = await call(page, 'jobs.import', { url: 'https://example.com/' })
check('job import: a non-job page gives a clear error', !job.ok, job.error)

// end -> notes
const ended = await call(page, 'sessions.end', { id: sid, mode: 'end' })
check('sessions:end -> ended with active time', ended.ok && ended.value.status === 'ended' && ended.value.activeMs > 0, `${ended.value?.activeMs} ms`)
if (themWav) {
  const notes = await until(page, async (id) => { const n = await window.api.notes.get({ sessionId: id }); return n && (n.status === 'ready' || n.status === 'failed') ? n : null }, sid, 120000, 1000)
  check('AI notes generated after the call (S20)', notes?.status === 'ready', notes ? `${notes.status}: ${notes.summary?.slice(0, 100) ?? notes.error}` : 'timed out')
} else {
  const ng = await call(page, 'notes.generate', { sessionId: sid })
  check('notes for a call without a transcript are refused clearly', !ng.ok && /no transcript/.test(ng.error), ng.error)
}
const tl = await call(page, 'transcript.get', { sessionId: sid })
check('transcript saved (segments + answers)', tl.ok && (!themWav || tl.value.some((i) => i.kind === 'segment')) && tl.value.some((i) => i.kind === 'answer'), `${tl.value?.length} items`)
const ask = await call(page, 'review.ask', { sessionId: sid, message: 'What question did they ask me first?' })
const askDone = await until(page, (id) => window.__ev.find((e) => e.n === 'review:delta' && e.p.messageId === id && e.p.done)?.p.text, ask.value?.messageId, 60000)
check('Ask AI about the call (S23)', !!askDone, askDone?.slice(0, 100).replace(/\n/g, ' '))

// a second call left live, then the process is killed
const s2 = await call(page, 'sessions.create', { type: 'regular', companyName: 'Fabrikam', companyDomain: null, roleTitle: null, jobUrl: null, jobDescription: '', resumeId: null, documentIds: [], language: 'en-US', model: 'google:gemini-flash-lite', instructions: '', autoGenerate: true, saveTranscript: true })
await call(page, 'sessions.start', { id: s2.value.id })
await until(page, async () => (await window.api.stt.status()).state === 'listening', null, 20000)
if (themWav) {
  // Auto-generate: a question from "them" starts an answer without a key press.
  const pcm = wavPcm(themWav)
  const from = await page.evaluate(() => window.__ev.length)
  await page.evaluate(async (pcm) => {
    for (let i = 0; i < pcm.length + 16000 * 3.5; i += 1600) {
      const f = new Int16Array(1600)
      if (i < pcm.length) f.set(pcm.slice(i, i + 1600))
      window.api.audio.frame({ speaker: 'them', pcm: f.buffer })
      await new Promise((r) => setTimeout(r, 25))
    }
  }, pcm)
  const auto = await until(page, (from) => window.__ev.slice(from).find((e) => e.n === 'answer:done' && e.p.trigger === 'auto')?.p, from, 45000)
  check('auto-generate answers a detected question', !!auto?.answerMd, auto ? `Q: ${auto.question}` : 'no auto answer')
}
// Simulate a crash: kill Electron's main process and all its children. (Playwright's
// process handle doesn't reach the real main process on Windows.)
const mainPid = await app.evaluate(() => process.pid)
execSync(`taskkill /PID ${mainPid} /T /F`, { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 2000))

// ---------------- second launch: persistence + crash recovery ----------------
;({ app, page } = await launch())
await page.waitForTimeout(1500)
const list = await call(page, 'sessions.list', {})
const a = list.value?.find((s) => s.id === sid)
const b2 = list.value?.find((s) => s.id === s2.value.id)
check('ended call persisted across restart', a?.status === 'ended' && (!themWav || a.hasTranscript) && a.answerCount >= 2, a ? `answers=${a.answerCount}` : 'missing')
check('crash recovery: live call reopened as paused (left)', b2?.status === 'left', b2?.status)
const s = await call(page, 'settings.get')
check('settings persisted', s.value?.privateMode === false && s.value?.defaultLanguage === 'en-GB')
const res = await call(page, 'resumes.list')
check('resumes persisted', res.value?.length === 1, `${res.value?.length}`)
check('daily backup written', existsSync(join(userData, 'backups')) && readdirSync(join(userData, 'backups')).some((f) => f.endsWith('.db')))
await app.close()

console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors')
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
