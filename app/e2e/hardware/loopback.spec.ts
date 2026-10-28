// Real system-audio (WASAPI loopback) capture, run on purpose only (npx playwright test
// --project=hardware). PARLEY_TEST_NO_CAPTURE is off, so the app captures what this PC plays.
// The microphone is denied in main, so nothing from the room is recorded. A synthetic clip
// (Windows voice, non-sensitive) is played through the default output with System.Media.SoundPlayer.
// Fake provider: 0 Gemini calls. This checks the capture path, not a real call app.
import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { AUDIO, Harness, WORK } from '../electron/harness'

const run = promisify(execFile)
const play = (clip: string) => run('powershell', ['-NoProfile', '-Command', `(New-Object System.Media.SoundPlayer '${join(AUDIO, `${clip}.wav`)}').PlaySync()`])

test('HW-01 loopback: speech played on this PC reaches the "them" lane and triggers an auto answer', async () => {
  const h = await new Harness('loopback', { extraEnv: { PARLEY_TEST_NO_CAPTURE: '' } }).launch()
  const report: Record<string, unknown> = {}
  try {
    await h.app.evaluate(({ session }) => {
      session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission !== 'media'))
      session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission !== 'media')
    })
    h.setScript({ default: { firstTokenMs: 200, chunkMs: 20 } })
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    const s = await h.createSession({ autoGenerate: true, saveTranscript: false })
    await h.goLive(s.id)
    await h.page.waitForTimeout(3000) // capture starts
    const t0 = Date.now()
    const bar0 = h.page.getByRole('toolbar', { name: 'Call controls' })
    const samples: string[] = []
    const sampler = setInterval(() => void bar0.getByRole('combobox').nth(1).getAttribute('aria-label').then((l) => samples.push(String(l).replace(/^Call audio, /, '').slice(0, 30))).catch(() => {}), 250)
    await play('q01')
    clearInterval(sampler)
    report.themLaneDuringPlay = [...new Set(samples)]
    await h.page.waitForTimeout(6000)
    await play('q06')
    const got = await h.until((ev) => ev.filter((e) => e.n === 'answer:start').length >= 1 && ev, 15_000)
    await h.page.waitForTimeout(4000)
    const ev = await h.events()
    const finals = ev.filter((e) => e.n === 'transcript:final' && e.t >= t0).map((e) => ({ speaker: e.p.speaker, text: e.p.text }))
    const starts = ev.filter((e) => e.n === 'answer:start').map((e) => ({ trigger: e.p.trigger, draft: e.p.questionDraft }))
    const bar = h.page.getByRole('toolbar', { name: 'Call controls' })
    report.devices = await bar.getByRole('combobox').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    report.finals = finals
    report.starts = starts
    report.requests = h.requests(s.id).length
    report.realRequests = h.realRequests().length
    expect.soft(finals.some((f) => f.speaker === 'them' && /dependency injection/i.test(f.text)), 'them lane heard q01').toBe(true)
    expect.soft(finals.some((f) => f.speaker === 'them' && /shortener/i.test(f.text)), 'them lane heard q06').toBe(true)
    expect.soft(finals.filter((f) => f.speaker === 'you').length, 'no mic lines (mic denied)').toBe(0)
    expect.soft(starts.filter((x) => x.trigger === 'auto').length, 'auto answers').toBeGreaterThanOrEqual(1)
    expect(h.realRequests().length, 'no real provider calls').toBe(0)
    void got
  } finally {
    writeFileSync(join(WORK, 'report-loopback.json'), JSON.stringify(report, null, 2))
    await h.close()
  }
})
