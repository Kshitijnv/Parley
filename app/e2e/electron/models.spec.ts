// Speech model management (architecture.md revision 2 §10, §13 #11, #12): the English
// model actually loaded, reuse without download, missing / incomplete / corrupt files,
// downloads only from Settings and never while live, language fixed while live, and
// Hindi refused everywhere. No network download is made: the "missing" cases use empty
// or damaged copies, and only the refusal paths of stt:downloadModel are called.
import { expect, test } from '@playwright/test'
import { copyFileSync, mkdirSync, openSync, writeSync, closeSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Harness, MODEL_DIR, WORK } from './harness'

const KROKO = 'sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06'

function copyModel(to: string, damage?: 'truncate' | 'zero') {
  const src = join(MODEL_DIR, KROKO)
  const dst = join(to, KROKO)
  mkdirSync(dst, { recursive: true })
  for (const f of ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt', 'verified.json']) copyFileSync(join(src, f), join(dst, f))
  if (damage === 'truncate') writeFileSync(join(dst, 'joiner.onnx'), readFileSync(join(dst, 'joiner.onnx')).subarray(0, 1000))
  if (damage === 'zero') {
    // same size, garbage content: passes the start-up size check, fails to load
    const p = join(dst, 'joiner.onnx')
    const fd = openSync(p, 'r+')
    writeSync(fd, Buffer.alloc(statSync(p).size, 0), 0, statSync(p).size, 0)
    closeSync(fd)
  }
}

test('speech models: English status, reuse, refusals, Hindi disabled', async () => {
  const report: Record<string, unknown> = {}
  // ---------- installed English model, reused across a restart ----------
  const userData = join(WORK, `e2e-models-${Date.now()}`)
  let h = await new Harness('models', { userData }).launch()
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    const models = (await h.call('stt.models')).value as any[]
    const en = models.find((m) => m.id === 'en-kroko-2025-08-06')
    report.models = models.map((m) => ({ id: m.id, language: m.language, status: m.status, selectable: m.selectable }))
    expect.soft(en?.status, 'D-01 English model installed (adopted)').toBe('installed')
    expect.soft(models.some((m) => m.language === 'hi' && m.selectable), 'D-01/#12 no selectable Hindi model').toBe(false)
    expect.soft(h.logLines().some((l) => l.event === 'stt_model_adopted'), 'D-01 adopted from the marker').toBe(true)

    // #12: Hindi refused at create and update
    const base = { type: 'interview', companyName: 'X', companyDomain: null, roleTitle: null, jobUrl: null, jobDescription: '', resumeId: null, documentIds: [], model: 'google:gemini-flash-lite', instructions: '', autoGenerate: false, saveTranscript: true }
    const hi = await h.call('sessions.create', { ...base, language: 'hi' })
    const hiIN = await h.call('sessions.create', { ...base, language: 'hi-IN' })
    report.hindiCreate = { hi: hi.error, hiIN: hiIN.error }
    expect.soft(hi.ok, '#12 a Hindi session is refused').toBe(false)
    expect.soft(hiIN.ok, '#12 hi-IN is refused too').toBe(false)
    const fr = await h.call('sessions.create', { ...base, language: 'fr-FR' })
    expect.soft(fr.ok, 'D-02 other non-English languages are refused').toBe(false)
    const s = await h.createSession({ autoGenerate: false })
    const toHi = await h.call('sessions.update', { id: s.id, patch: { language: 'hi' } })
    expect.soft(toHi.ok, '#12 switching a draft session to Hindi is refused').toBe(false)

    // #11: prepare loads the model and reports it; status comes from the worker
    const prep = await h.goLive(s.id)
    const status = (await h.call('stt.status')).value
    report.stt = { prep, status }
    expect.soft(prep.modelId, '#11 prepare reports modelId').toBe('en-kroko-2025-08-06')
    expect.soft(status?.language, '#11 stt:status language from the worker').toBe('en')
    expect.soft(status?.modelId, '#11 stt:status modelId from the worker').toBe('en-kroko-2025-08-06')
    const chip = await h.page.getByRole('status').filter({ hasText: /./ }).first().getAttribute('aria-label')
    report.chip = chip
    expect.soft(chip ?? '', '#11 the live bar status chip names the loaded model').toMatch(/en · en-kroko-2025-08-06/)

    // while live: downloads, deletes and language changes refused
    const dl = await h.call('stt.downloadModel', { modelId: 'en-zipformer-2023-06-26' })
    const del = await h.call('stt.deleteModel', { modelId: 'en-kroko-2025-08-06' })
    const lang = await h.call('sessions.update', { id: s.id, patch: { language: 'en-GB' } })
    const langHi = await h.call('sessions.update', { id: s.id, patch: { language: 'hi' } })
    report.liveRefusals = { dl: dl.error, del: del.error, lang: lang.error, langHi: langHi.error }
    expect.soft(dl.ok, '#12/D-03 download refused while live').toBe(false)
    expect.soft(del.ok, 'D-03 delete refused while live / loaded').toBe(false)
    expect.soft(lang.ok, '#12 language change refused while live').toBe(false)
    expect.soft(langHi.ok, '#12 switching to Hindi refused while live').toBe(false)
    expect.soft(h.logLines().some((l) => /download/.test(l.event) && !/refused/.test(l.event)), 'D-03 no download started').toBe(false)

    // the transcript works with the loaded model (English recognition on synthetic speech)
    await h.feedSlot(['q03'], 6000)
    const fin = (await h.events()).filter((e) => e.n === 'transcript:final').map((e) => e.p.text)
    report.recognised = fin
    expect.soft(fin.join(' '), 'D-04 English recognised').toMatch(/difference between a process and a thread/i)
    await h.call('sessions.end', { id: s.id, mode: 'leave' })
    await h.close()

    // restart on the same data: reused, no re-adoption, no download
    h = await new Harness('models2', { userData }).launch()
    await h.page.getByText(/Contoso|calls?/i).first().waitFor({ timeout: 20_000 })
    const again = ((await h.call('stt.models')).value as any[]).find((m) => m.id === 'en-kroko-2025-08-06')
    const adoptions = h.logLines().filter((l) => l.event === 'stt_model_adopted').length
    report.restart = { status: again?.status, adoptions }
    expect.soft(again?.status, 'D-05 still installed after restart').toBe('installed')
    expect.soft(adoptions, 'D-05 adopted once only (no re-download, no re-adoption)').toBe(1)
    // rejoin keeps language fixed and loads the same model
    const rj = await h.call('sessions.rejoin', { id: s.id })
    report.rejoin = rj.ok ? 'ok' : rj.error
    await h.close()
  } finally {
    await h.close()
  }

  // ---------- no model installed: start refused with a clear message, no download ----------
  const emptyDir = join(WORK, `models-empty-${Date.now()}`)
  mkdirSync(emptyDir, { recursive: true })
  h = await new Harness('nomodel', { extraEnv: { PARLEY_STT_MODEL_DIR: emptyDir } }).launch()
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    await expect.soft(h.page.getByText(/speech model/i).first(), 'D-06 first-run setup callout on S03').toBeVisible()
    const s = await h.createSession({ autoGenerate: false })
    const prep = await h.call('stt.prepare', { sessionId: s.id })
    const start = await h.call('sessions.start', { id: s.id })
    report.missing = { prep: prep.error ?? prep.value, start: start.error }
    expect.soft(prep.ok && prep.value?.state === 'listening', 'D-06 prepare does not load a missing model').toBe(false)
    expect.soft(start.ok, 'D-06 start refused without a model').toBe(false)
    expect.soft(start.error ?? '', 'D-06 message points to Settings').toMatch(/install|Settings/i)
    // S12 offers "Install" through Settings, never a download in place
    await h.page.evaluate((id) => (location.hash = `#/overlay/connect/${id}`), s.id)
    await h.page.waitForTimeout(1500)
    const s12 = await h.page.locator('body').innerText()
    report.s12 = s12.slice(0, 400)
    expect.soft(/install/i.test(s12), 'D-06 S12 shows an install prompt').toBe(true)
    expect.soft(h.logLines().some((l) => /download/.test(l.event)), 'D-06 no download was started').toBe(false)
  } finally {
    await h.close()
  }

  // ---------- incomplete files (wrong size): not installed ----------
  const truncDir = join(WORK, `models-trunc-${Date.now()}`)
  copyModel(truncDir, 'truncate')
  h = await new Harness('trunc', { extraEnv: { PARLEY_STT_MODEL_DIR: truncDir } }).launch()
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    const m = ((await h.call('stt.models')).value as any[]).find((x) => x.id === 'en-kroko-2025-08-06')
    const s = await h.createSession({ autoGenerate: false })
    const start = await h.call('sessions.start', { id: s.id })
    report.truncated = { status: m?.status, start: start.error }
    expect.soft(m?.status, 'D-07 incomplete model is not reported installed').not.toBe('installed')
    expect.soft(start.ok, 'D-07 start refused').toBe(false)
  } finally {
    await h.close()
  }

  // ---------- corrupt files (right size, bad content): load fails, marked corrupt, verify flags it ----------
  const zeroDir = join(WORK, `models-zero-${Date.now()}`)
  copyModel(zeroDir, 'zero')
  h = await new Harness('corrupt', { extraEnv: { PARLEY_STT_MODEL_DIR: zeroDir } }).launch()
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    const s = await h.createSession({ autoGenerate: false })
    const prep = await h.call('stt.prepare', { sessionId: s.id })
    const start = await h.call('sessions.start', { id: s.id })
    const m = ((await h.call('stt.models')).value as any[]).find((x) => x.id === 'en-kroko-2025-08-06')
    const verify = await h.call('stt.verifyFiles', { modelId: 'en-kroko-2025-08-06' })
    const m2 = ((await h.call('stt.models')).value as any[]).find((x) => x.id === 'en-kroko-2025-08-06')
    report.corrupt = { prep: prep.value?.state ?? prep.error, prepErr: prep.value?.error, start: start.error, status: m?.status, verify: verify.ok ? verify.value : verify.error, after: m2?.status }
    expect.soft(start.ok, 'D-08 start refused with a corrupt model').toBe(false)
    expect.soft(m?.status, 'D-08 marked corrupt after the load failure').toBe('corrupt')
    expect.soft(verify.ok || !/in use/i.test(verify.error ?? ''), `D-08 (BUG-004) Verify files is not refused after a failed load (${verify.error})`).toBe(true)
    expect.soft(m2?.status, 'D-08 Verify files keeps it corrupt').not.toBe('installed')
    expect.soft(h.errors, 'no console errors').toEqual([])
  } finally {
    await h.close()
    writeFileSync(join(WORK, 'report-models.json'), JSON.stringify(report, null, 2))
  }
})
