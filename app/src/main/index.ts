import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, protocol, screen, session } from 'electron'
import { schemas } from '@shared/ipc'
import { closeDb, openDb } from './db/client'
import { getSettings } from './db/repo'
import { isDev, mockMode, userDataOverride } from './env'
import { APP_FILE_SCHEME, registerFileProtocol } from './files'
import { setHotkeysActive } from './hotkeys'
import { registerIpc } from './ipc'
import { recoverOnStartup, runStartupJobs } from './jobs'
import { liveSessionId, stopLive } from './live'
import { ensureDirs } from './paths'
import { cancelSessionAnswers } from './ai/engine'
import './ai/gate'
import { run } from './db/client'
import {
  createOverlay,
  fit,
  getState,
  hideOverlay,
  moveBy,
  openLibrary,
  openOverlay,
  restoreOverlay,
  setBounds,
  setPrivate,
  snap,
  wins,
} from './windows'

// Windows, OS integration and the local data layer (SQLite, AI providers, speech-to-text).
// PARLEY_MOCK=1 keeps the renderer's built-in demo data layer instead.

const dataDir = userDataOverride()
if (dataDir) app.setPath('userData', dataDir)

if (!app.requestSingleInstanceLock()) app.quit()

protocol.registerSchemesAsPrivileged([APP_FILE_SCHEME])

function handle(channel: string, fn: (input: any) => unknown, schema?: { parse(v: unknown): unknown }) {
  ipcMain.handle(channel, (_e, input) => fn(schema ? schema.parse(input) : input))
}

handle('window:hide', () => {
  hideOverlay()
  return { ok: true }
})
handle('window:restore', () => {
  restoreOverlay()
  return { ok: true }
})
handle('window:moveBy', (i) => moveBy(i.dx, i.dy), schemas['window:moveBy'])
handle('window:snap', (i) => snap(i.phase), schemas['window:snap'])
handle('window:setBounds', (i) => setBounds(i), schemas['window:setBounds'])
handle('window:openLibrary', (i) => {
  openLibrary(i.route)
  return { ok: true }
}, schemas['window:openLibrary'])
handle('window:openOverlay', (i) => {
  openOverlay(String(i.route ?? '/'))
  return { ok: true }
})
handle('window:fit', (i) => fit(Number(i.width), Number(i.height)))
handle('window:setHotkeysActive', (i) => setHotkeysActive(Boolean(i.active), i.hotkeys ?? {}))
handle('window:close', () => app.quit())
handle('window:state', () => getState())
handle('window:setPrivate', (i) => setPrivate(Boolean(i.on)))
handle('window:cursorInOverlay', () => {
  const o = wins.overlay
  if (!o) return false
  const p = screen.getCursorScreenPoint()
  const b = o.getBounds()
  return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height
})

// Demo mode only: the renderer mock data layer tells the other windows that something
// changed. With the real data layer, main emits every event itself.
ipcMain.on('broadcast', (e, event: string, payload: unknown) => {
  if (!mockMode) return
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.webContents.id !== e.sender.id) w.webContents.send('event', event, payload)
  }
})

app.whenReady().then(() => {
  // Development only: the time-to-first-token bench (revision 6 M7) runs and quits.
  const bench = isDev ? process.env['PARLEY_BENCH'] : undefined
  if (bench) {
    ensureDirs()
    openDb()
    void import('./ai/bench')
      .then((b) => b.runBench(bench))
      .catch((e) => console.error('bench failed:', (e as Error).name))
      .finally(() => app.quit())
    return
  }
  // Development-only test switch: no mic and no loopback, so tests never record this PC.
  const testNoCapture = isDev && process.env['PARLEY_TEST_NO_CAPTURE'] === '1'
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    if (testNoCapture && permission === 'media') return cb(false)
    cb(permission === 'media' || permission === 'display-capture' || permission === 'clipboard-sanitized-write')
  })
  // Loopback capture of the call audio without the "pick a tab" step: answer
  // getDisplayMedia with the primary screen plus system audio. The renderer stops
  // the video track straight away.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] })
    // Automated tests feed the lanes directly; real capture would interleave its own frames.
    if (testNoCapture) return cb({ video: sources[0] })
    cb({ video: sources[0], audio: 'loopback' })
  })
  if (!mockMode) {
    ensureDirs()
    openDb()
    recoverOnStartup()
    registerFileProtocol()
    registerIpc()
    setPrivate(getSettings().privateMode)
  }
  createOverlay()
  if (!mockMode) setTimeout(runStartupJobs, 1500)
})

// Quitting during a call pauses it (status "left", rejoinable) with its transcript written.
let quitting = false
app.on('before-quit', (e) => {
  const id = liveSessionId()
  if (!id || quitting) return
  e.preventDefault()
  quitting = true
  cancelSessionAnswers(id, 'session_end')
  void stopLive(id)
    .then(() => {
      run(`update sessions set status = 'left', active_ms = active_ms + max(0, ? - coalesce(live_since, ?)), live_since = null, updated_at = ? where id = ?`, Date.now(), Date.now(), Date.now(), id)
    })
    .catch(() => {})
    .finally(() => app.quit())
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  if (!mockMode) closeDb()
})
app.on('window-all-closed', () => app.quit())
app.on('second-instance', () => {
  restoreOverlay()
})
