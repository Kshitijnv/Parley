// Private mode (feature #39) capture smoke on the real desktop: a solid backdrop window
// sits behind the overlay, and a separate PowerShell process grabs the screen with GDI.
// Each check classifies the overlay's area as absent (backdrop shows), black or
// visible. It covers GDI only; the 60 fps stream, the snap grid and real call apps are
// /replica-test's P6 suite. Needs an interactive Windows desktop.
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Harness, WORK } from './harness'

const BACKDROP = [30, 200, 120] // a colour the overlay never uses
const TOL = 14
const SHOTS = join(WORK, 'private-capture')
type Verdict = 'absent' | 'black' | 'visible'

test.skip(process.platform !== 'win32', 'GDI capture check is Windows-only')

async function winInfo(h: Harness, hash: string) {
  return h.app.evaluate(({ BrowserWindow, screen }, hash) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes(`#${hash}`))
    if (!w) return null
    const b = w.getBounds()
    const buf = w.getNativeWindowHandle()
    const hwnd = buf.length >= 8 ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0))
    return { b, hwnd, visible: w.isVisible(), opacity: w.getOpacity(), scale: screen.getDisplayMatching(b).scaleFactor }
  }, hash)
}

async function backdrop(h: Harness) {
  const o = (await winInfo(h, '/overlay'))!
  await h.app.evaluate(({ BrowserWindow }, [b, rgb]) => {
    const g = globalThis as any
    g.__backdrop?.destroy()
    const w = new BrowserWindow({ x: b.x - 40, y: b.y - 40, width: b.width + 80, height: b.height + 80, frame: false, focusable: false, skipTaskbar: true, show: false, backgroundColor: `rgb(${rgb.join(',')})` })
    w.setAlwaysOnTop(true, 'floating') // under the overlay's screen-saver level, over everything else
    void w.loadURL('data:text/html,<body style="margin:0"></body>')
    w.showInactive()
    g.__backdrop = w
  }, [o.b, BACKDROP] as const)
  await h.page.waitForTimeout(500)
}

/** 5 × 5 points inside the window's middle 70%, captured by GDI from another process. */
function capture(info: NonNullable<Awaited<ReturnType<typeof winInfo>>>, label: string, hwnds: string[]) {
  const s = info.scale
  const x = Math.round(info.b.x * s)
  const y = Math.round(info.b.y * s)
  const w = Math.round(info.b.width * s)
  const hh = Math.round(info.b.height * s)
  const pts: number[][] = []
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) pts.push([Math.round(w * (0.15 + 0.175 * i)), Math.round(hh * (0.15 + 0.175 * j))])
  mkdirSync(SHOTS, { recursive: true })
  const req = join(SHOTS, `${label}.json`)
  writeFileSync(req, JSON.stringify({ x, y, w, h: hh, pts, hwnds, png: join(SHOTS, `${label}.png`) }))
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(import.meta.dirname, 'gdi-sample.ps1'), req], { encoding: 'utf8' })
  const r = JSON.parse(out.trim()) as { pts: number[][]; affinity: string[] | string }
  const near = (c: number[], t: number[]) => c.every((v, k) => Math.abs(v - t[k]!) <= TOL)
  const back = r.pts.filter((c) => near(c, BACKDROP)).length
  const black = r.pts.filter((c) => c.every((v) => v < 10)).length
  const verdict: Verdict = back === pts.length ? 'absent' : black >= pts.length * 0.8 ? 'black' : 'visible'
  return { verdict, back, black, affinity: ([] as string[]).concat(r.affinity ?? []), sample: r.pts.slice(0, 3) }
}

async function check(h: Harness, hash: string, label: string, log: Record<string, unknown>) {
  await h.page.waitForTimeout(400) // past the 100 ms reveal fade and a few compositions
  const info = (await winInfo(h, hash))!
  expect(info.visible, `${hash} visible for ${label}`).toBe(true)
  const r = capture(info, label, [info.hwnd])
  log[label] = { ...r, opacity: info.opacity }
  return r.verdict
}

const results: Record<string, unknown> = {}
test.afterAll(() => writeFileSync(join(SHOTS, 'report.json'), JSON.stringify(results, null, 2)))

test('Private on: overlay and bubble absent at start and after hide/restore; off restores capture; on again hides', async () => {
  const h = await new Harness('private-on').launch()
  const log: Record<string, unknown> = {}
  results.on = log
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    expect((await h.call('settings.get')).value.privateMode).toBe(true)
    await backdrop(h)
    expect(await check(h, '/overlay', 'on-start', log)).toBe('absent')
    for (let i = 1; i <= 3; i++) {
      await h.call('window.hide')
      expect(await check(h, '/bubble', `on-bubble-${i}`, log)).toBe('absent')
      await h.call('window.restore')
      // the bug this fixes: black here from the first restore (architecture.md P2)
      expect(await check(h, '/overlay', `on-restore-${i}`, log)).toBe('absent')
    }
    await h.call('settings.update', { privateMode: false })
    expect(await check(h, '/overlay', 'toggled-off', log)).toBe('visible')
    await h.call('settings.update', { privateMode: true })
    expect(await check(h, '/overlay', 'toggled-on', log)).toBe('absent')
    // the setting must survive the restart in the next step
    await h.call('settings.update', { privateMode: false })
  } finally {
    await h.close()
  }
  // Restart with private_mode = 0 from SQLite: capturable, and hide/restore never turns protection on.
  const h2 = await new Harness('private-off', { userData: h.userData }).launch()
  const log2: Record<string, unknown> = {}
  results.offAfterRestart = log2
  try {
    await h2.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    expect((await h2.call('settings.get')).value.privateMode).toBe(false)
    expect((await h2.call('window.state')).value.privateMode).toBe(false)
    await backdrop(h2)
    expect(await check(h2, '/overlay', 'off-start', log2)).toBe('visible')
    for (let i = 1; i <= 2; i++) {
      await h2.call('window.hide')
      expect(await check(h2, '/bubble', `off-bubble-${i}`, log2)).toBe('visible')
      await h2.call('window.restore')
      expect(await check(h2, '/overlay', `off-restore-${i}`, log2)).toBe('visible')
    }
    // and back on, persisted, across a restart: absent from the first shown frame
    await h2.call('settings.update', { privateMode: true })
  } finally {
    await h2.close()
  }
  const h3 = await new Harness('private-on-again', { userData: h.userData }).launch()
  const log3: Record<string, unknown> = {}
  results.onAfterRestart = log3
  try {
    await h3.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    await backdrop(h3)
    expect(await check(h3, '/overlay', 'on-again-start', log3)).toBe('absent')
  } finally {
    await h3.close()
  }
})
