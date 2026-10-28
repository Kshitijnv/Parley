// Other recon flows on the real backend with the fake provider (zero Gemini calls):
// F02 resume import (+ the R5 call budget), documents, F03 Screenshot (local capture to
// the fake provider only), F05 prefs mid-call, Clear transcript, Leave / Rejoin (gate
// state rebuilt), F07 notes / transcript / Ask AI, persistence across a restart, crash
// mid-stream, and IPC validation boundaries.
import { expect, test } from '@playwright/test'
import { execSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { FILES, Harness, WORK } from './harness'

const NOTES = { company: 'Contoso', position: 'Backend Engineer', summary: 'Synthetic test call.', questions: [{ question: 'Process vs thread', responseNote: 'Covered.' }], nextSteps: ['Follow up.'] }
const PARSED = { contact: { name: 'Asha Verma', headline: null, email: null, phone: null, location: null }, summary: 'Engineer.', experience: [], skills: [{ category: 'Backend', items: ['C#'] }], projects: [] }

test('recon flows: resume, documents, screenshot, prefs, clear, rejoin, review, restart', async () => {
  const userData = join(WORK, `e2e-flows-${Date.now()}`)
  const report: Record<string, unknown> = {}
  let h = await new Harness('flows', { userData }).launch()
  let sessionId = ''
  let answeredId = ''
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    const calls = (purpose: string) => h.logLines().filter((l) => l.event === 'provider_request' && l.reason === purpose).length

    // ---------- F02: resume PDF ----------
    const pdf = join(FILES, 'asha-verma-resume.pdf')
    test.skip(!existsSync(pdf), 'needs .smoke/files/asha-verma-resume.pdf')
    h.setScript({ default: { firstTokenMs: 50, text: '# Asha Verma\n\n## Experience\n- Software Engineer, Lumen Freight' } })
    const imp = await h.call('resumes.importFile', { path: pdf, title: 'Asha Verma' })
    report.importOk = { mdMethod: imp.value?.mdMethod, convertCalls: calls('resume_convert'), parseCalls: calls('resume_parse') }
    expect.soft(imp.value?.mdMethod, 'F02-H1 PDF converted to Markdown').toBe('ai')
    expect.soft(calls('resume_convert'), 'F02-H1 1 conversion call').toBe(1)
    expect.soft(calls('resume_parse'), 'F02-H1 no automatic parse call').toBe(0)
    const dup = await h.call('resumes.importFile', { path: pdf, title: 'Asha again' })
    expect.soft(dup.value?.duplicateOf, 'F02-E1 duplicate PDF flagged (warn, by design)').toBe(imp.value?.id)
    const outside = await h.call('resumes.importFile', { path: join(WORK, '..', 'package.json'), title: 'nope' })
    expect.soft(outside.ok, 'F02-N1 file outside the allowed folder refused').toBe(false)
    const notPdf = await h.call('resumes.importFile', { path: join(FILES, 'notes.txt'), title: 'not a pdf' })
    expect.soft(notPdf.ok, 'F02-N2 a non-PDF refused').toBe(false)
    h.setScript({ default: { firstTokenMs: 50, output: PARSED } })
    const parse = await h.call('resumes.parse', { id: imp.value?.id })
    await h.page.waitForTimeout(500)
    const parsed = (await h.call('resumes.get', { id: imp.value?.id })).value
    report.parse = { ok: parse.ok, status: parsed?.parseStatus, calls: calls('resume_parse') }
    expect.soft(calls('resume_parse'), 'F02-H2 parse on demand: 1 call').toBe(1)
    expect.soft(parsed?.parseStatus, 'F02-H2 parsed fields ready').toBe('ready')
    const empty = await h.call('resumes.createFromText', { title: 'Empty', text: '' })
    expect.soft(empty.ok, 'F02-E2 empty pasted resume refused').toBe(false)
    const emoji = await h.call('resumes.createFromText', { title: 'Zoë 🚀 Müller', text: 'Ingénieure logicielle — C#, .NET 🚀, Kubernetes.' })
    expect.soft(emoji.ok, `F02-E3 accents and emoji accepted (${emoji.error})`).toBe(true)

    // ---------- documents ----------
    const doc = await h.call('documents.importFile', { path: join(FILES, 'notes.txt'), title: 'Notes' })
    expect.soft(doc.ok, `DOC-H1 TXT document imported (${doc.error})`).toBe(true)

    // ---------- live session with context ----------
    h.setScript({ default: { firstTokenMs: 150, chunkMs: 30 } })
    const s = await h.createSession({ autoGenerate: false, resumeId: imp.value?.id })
    sessionId = s.id
    await h.goLive(s.id)

    // F03: Screenshot (captured locally, sent to the fake provider only)
    const sh = await h.gen(s.id, 'screenshot')
    const sh2 = await h.gen(s.id, 'screenshot')
    const shEnd = await h.waitEnd(sh.value?.answerId)
    const shRow = (await h.call('answers.get', { answerId: sh.value?.answerId })).value
    report.screenshot = { outcome: sh.value?.outcome, second: sh2.value?.outcome, end: shEnd?.n, path: shRow?.screenshotPath, exists: shRow?.screenshotPath ? existsSync(join(userData, 'files', shRow.screenshotPath)) : false }
    expect.soft(sh.value?.outcome, 'F03-H1 screenshot request started').toBe('started')
    expect.soft(sh2.value?.outcome, 'F03-E1 second press within 1.5 s reused').toBe('reused')
    expect.soft(shEnd?.n, 'F03-H1 screenshot answer completes').toBe('answer:done')

    // F05: change prefs mid-call; the next answer uses them
    const newPrefs = { format: 'bullets', star: false, filler_words: false, length: 'short', tone: 'formal' }
    const up = await h.call('sessions.update', { id: s.id, patch: { answerPrefs: newPrefs } })
    expect.soft(up.ok, `F05-H1 prefs updated while live (${up.error})`).toBe(true)
    await h.feedSlot(['q03'], 6000)
    const a = await h.gen(s.id, 'answer')
    await h.waitEnd(a.value?.answerId)
    answeredId = a.value?.answerId
    const aRow = (await h.call('answers.get', { answerId: a.value?.answerId })).value
    expect.soft(aRow?.answerPrefs?.length, 'F05-H1 the next answer uses the new length').toBe('short')
    expect.soft(aRow?.answerPrefs?.format, 'F05-H1 ...and format').toBe('bullets')

    // Clear transcript: a following Answer has nothing new
    const cl = await h.call('transcript.clear', { sessionId: s.id })
    await h.page.waitForTimeout(2200)
    const afterClear = await h.gen(s.id, 'answer')
    report.clear = { ok: cl.ok, after: afterClear.value }
    expect.soft(cl.ok, 'CLR-H1 transcript cleared').toBe(true)
    expect.soft(afterClear.value?.outcome === 'started', 'CLR-H1 Answer after Clear makes no new request').toBe(false)

    // Leave -> Rejoin: dedupe state is rebuilt from the answers rows
    await h.call('sessions.end', { id: s.id, mode: 'leave' })
    const left = (await h.call('sessions.get', { id: s.id })).value
    expect.soft(left?.status, 'F01-E1 Leave for now keeps the session rejoinable').toBe('left')
    const rj = await h.call('sessions.rejoin', { id: s.id })
    expect.soft(rj.ok, `F01-E1 rejoin (${rj.error})`).toBe(true)
    await h.goLive(s.id).catch(() => {})
    // the gate is rebuilt from the answers rows: Answer with no new speech reuses the latest answer
    const r0 = h.requests(s.id).length
    const noNew = await h.gen(s.id, 'answer')
    report.rejoin = { status: (await h.call('sessions.get', { id: s.id })).value?.status, noNew: noNew.value, calls: h.requests(s.id).length - r0 }
    expect.soft(noNew.value?.outcome, 'F01-E2 after rejoin, Answer with nothing new is reused (gate rebuilt)').toBe('reused')
    expect.soft(h.requests(s.id).length - r0, 'F01-E2 0 calls').toBe(0)

    // crash mid-stream: kill the app while an answer streams
    h.setScript({ default: { firstTokenMs: 100, chunkMs: 400, chunkChars: 6 } })
    const cr = await h.gen(s.id, 'chat', { text: 'Explain consistent hashing' })
    await h.until((ev) => ev.some((e) => e.n === 'answer:delta' && e.p.answerId === cr.value?.answerId), 10_000, 50)
    const mainPid = h.app.process().pid
    h.app.process().kill('SIGKILL')
    // Under Playwright the killed main's child processes stay alive (its debugging connection
    // holds them) and keep the single-instance lock. Launched normally they exit within about
    // 1.2 s (checked by hand with a direct spawn + taskkill). Clean them up here.
    await new Promise((r) => setTimeout(r, 1000))
    execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='electron.exe'\\" | Where-Object { $_.ParentProcessId -eq ${mainPid} -or $_.CommandLine -like '*${basename(userData)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`)
    await new Promise((r) => setTimeout(r, 1500))

    // ---------- restart: persistence and crash recovery ----------
    h = await new Harness('flows2', { userData }).launch()
    await h.page.getByText(/Contoso/).first().waitFor({ timeout: 20_000 })
    const sess = (await h.call('sessions.get', { id: sessionId })).value
    const crRow = (await h.call('answers.get', { answerId: cr.value?.answerId })).value
    const kept = (await h.call('answers.get', { answerId: answeredId })).value
    const tr = (await h.call('transcript.get', { sessionId })).value
    report.restart = { status: sess?.status, crashed: { status: crRow?.status, endReason: crRow?.endReason, kept: crRow?.answerMd?.length }, keptAnswer: kept?.status, transcriptItems: Array.isArray(tr?.items) ? tr.items.length : tr ? Object.keys(tr) : null }
    expect.soft(['left', 'paused', 'live'].includes(sess?.status) || sess?.status !== 'ended', `P-01 a killed live call reopens rejoinable (${sess?.status})`).toBe(true)
    expect.soft(crRow?.status, 'P-02 the answer streaming at the crash is not left streaming').not.toBe('streaming')
    expect.soft(kept?.status, 'P-03 earlier answers persisted').toBe('done')

    // ---------- F07: end -> notes, transcript, Ask AI ----------
    h.setScript({ default: { firstTokenMs: 50, chunkMs: 20, output: NOTES } })
    await h.call('sessions.rejoin', { id: sessionId })
    await h.goLive(sessionId).catch(() => {})
    await h.call('sessions.end', { id: sessionId, mode: 'end' })
    let notes: any = null
    for (let i = 0; i < 30 && notes?.status !== 'ready' && notes?.status !== 'failed'; i++) {
      await h.page.waitForTimeout(500)
      notes = (await h.call('notes.get', { sessionId })).value
    }
    report.notes = { status: notes?.status, calls: h.logLines().filter((l) => l.event === 'provider_request' && l.reason === 'notes').length }
    expect.soft(notes?.status, 'F07-H1 notes generated after End').toBe('ready')
    const ask = await h.call('review.ask', { sessionId, message: 'What went well?' })
    await h.page.waitForTimeout(1500)
    const rl = (await h.call('review.list', { sessionId })).value
    report.review = { ok: ask.ok, err: ask.error, messages: Array.isArray(rl) ? rl.length : null }
    expect.soft(ask.ok, `F07-H2 Ask AI (${ask.error})`).toBe(true)

    // ---------- validation boundaries ----------
    const auto = await h.call('answers.generate', { sessionId, trigger: 'auto', clientRequestId: crypto.randomUUID() })
    const badId = await h.call('answers.generate', { sessionId, trigger: 'answer', clientRequestId: 'not-a-uuid' })
    const ended = await h.gen(sessionId, 'answer')
    const keys = (await h.call('keys.status')).value
    report.validation = { auto: auto.error, badId: badId.error, ended: ended.error, keys }
    expect.soft(auto.ok, 'SEC-01 a window cannot submit trigger auto').toBe(false)
    expect.soft(badId.ok, 'SEC-02 malformed clientRequestId refused (zod)').toBe(false)
    expect.soft(ended.ok, 'SEC-03 Answer on an ended session refused').toBe(false)
    expect.soft(JSON.stringify(keys ?? {}).includes('AIza'), 'SEC-04 keys:status never returns a key').toBe(false)
    expect.soft(h.realRequests().length, 'zero real provider calls').toBe(0)
    expect.soft(h.errors, 'no console errors').toEqual([])
  } finally {
    writeFileSync(join(WORK, 'report-flows.json'), JSON.stringify(report, null, 2))
    await h.close()
  }
})
