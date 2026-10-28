// Launches the built Electron app (npm run build first), checks the overlay window
// renders S03 and that the library window opens, and prints console errors.
// Window behaviour only: it runs in demo mode (PARLEY_MOCK=1, the seeded mock data) in a
// throwaway data folder. scripts/backend-smoke.mjs covers the real data layer.
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const out = process.argv[2]
const env = { ...process.env, PARLEY_MOCK: '1', PARLEY_USER_DATA: mkdtempSync(join(tmpdir(), 'parley-electron-smoke-')) }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [resolve(import.meta.dirname, '..')], env })
const errors = []
const watch = (page) => {
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))
}
const overlay = await app.firstWindow()
watch(overlay)
await overlay.waitForLoadState('domcontentloaded')
await overlay.getByRole('heading', { name: 'Northwind Systems' }).waitFor({ timeout: 15000 })
const info = await app.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), onTop: w.isAlwaysOnTop(), bounds: w.getBounds(), visible: w.isVisible() })),
)
console.log('windows:', JSON.stringify(info))
if (out) await overlay.screenshot({ path: `${out}/electron-S03.png` })

const libPromise = app.waitForEvent('window')
await overlay.getByRole('button', { name: 'Open library' }).click()
const lib = await libPromise
watch(lib)
await lib.getByRole('heading', { name: 'Calls', exact: true }).waitFor({ timeout: 15000 })
console.log('library window opened:', await lib.title())
if (out) await lib.screenshot({ path: `${out}/electron-library.png` })

await overlay.getByRole('button', { name: 'Hide window' }).click()
await overlay.waitForTimeout(500)
const afterHide = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ url: w.webContents.getURL().split('#')[1], visible: w.isVisible() })))
console.log('after hide:', JSON.stringify(afterHide))

// Restore, go live on the paused call, and check hotkeys exist only while live.
await app.evaluate(({ BrowserWindow }) => {
  const o = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('#/overlay'))
  o?.show()
})
await overlay.getByRole('button', { name: 'Rejoin Fabrikam Labs' }).click()
await overlay.getByRole('button', { name: 'Rejoin' }).last().click().catch(() => {})
await overlay.getByRole('toolbar', { name: 'Call controls' }).waitFor({ timeout: 20000 })
await overlay.waitForTimeout(1500)
const liveKeys = await app.evaluate(({ globalShortcut }) => ['Control+Enter', 'Control+Shift+Enter', 'Control+Shift+Space'].map((k) => globalShortcut.isRegistered(k)))
console.log('hotkeys registered while live:', JSON.stringify(liveKeys))
if (out) await overlay.screenshot({ path: `${out}/electron-S13.png` })
await overlay.getByRole('button', { name: 'End call' }).click()
await overlay.getByRole('button', { name: 'Leave for now' }).click()
await overlay.getByRole('heading', { name: 'Fabrikam Labs' }).waitFor()
await overlay.waitForTimeout(300)
const afterKeys = await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Enter'))
console.log('Control+Enter registered after leaving:', afterKeys)

console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors')
await app.close()
