// Private mode (feature #39, architecture.md revision 3 P4). The only code that shows
// the overlay, bubble or snap window, or sets their window opacity.
//
// Electron's setContentProtection(true) already sets WDA_EXCLUDEFROMCAPTURE (0x11) on
// the top-level HWND, so there is no FFI here. The bug it doesn't cover: on Windows a
// protected window re-shown after hide() is captured as a solid black box while the
// affinity still reads 0x11 (P2). reveal() works around it: show at opacity 0, reset
// the affinity (off, on), fade in once DWM has composed.
import type { BrowserWindow } from 'electron'
import { release as osRelease } from 'node:os'
import type { PrivacyCapability } from '@shared/types'

const EXCLUDE_MIN_BUILD = 19041 // Windows 10 2004: first build with WDA_EXCLUDEFROMCAPTURE
export const REVEAL_MS = 100

/** What Private mode can do on this OS. Never changes the saved setting (P5). */
export function privacyCapability(platform: string = process.platform, release: string = osRelease()): PrivacyCapability {
  if (platform === 'win32') {
    const build = Number(release.split('.')[2])
    // An unreadable build is treated as current: Electron 45 needs Windows 10 anyway.
    if (Number.isFinite(build) && build > 0 && build < EXCLUDE_MIN_BUILD)
      return { mode: 'blackbox', reason: 'On this Windows version, other people see a black box instead of the window.' }
    return { mode: 'exclude', reason: null }
  }
  if (platform === 'darwin') return { mode: 'best_effort', reason: 'Hides the window from most screen capture. Not tested on this Mac.' }
  return { mode: 'unsupported', reason: 'This system has no way to keep a window out of screen capture.' }
}

export const capability = privacyCapability()
let privateOn = true

export function setPrivateFlag(on: boolean) {
  privateOn = on
}

interface Track {
  holds: Set<string>
  seq: number
  timer: NodeJS.Timeout | null
}
const tracks = new WeakMap<BrowserWindow, Track>()

function track(win: BrowserWindow): Track {
  let t = tracks.get(win)
  if (!t) {
    const nt: Track = { holds: new Set(), seq: 0, timer: null }
    tracks.set(win, nt)
    // A hide or close cancels a pending fade-in; the next reveal starts again from 0.
    win.on('hide', () => cancelReveal(win, nt))
    win.on('closed', () => {
      if (nt.timer) clearTimeout(nt.timer)
      nt.timer = null
    })
    t = nt
  }
  return t
}

function cancelReveal(win: BrowserWindow, t: Track) {
  t.seq++
  if (t.timer) clearTimeout(t.timer)
  t.timer = null
  release(win, 'reveal')
}

/** Window opacity is 0 while any reason holds it (reveal, screenshot). */
export function hold(win: BrowserWindow, reason: string) {
  if (win.isDestroyed()) return
  const t = track(win)
  t.holds.add(reason)
  win.setOpacity(0)
}

export function release(win: BrowserWindow, reason: string) {
  if (win.isDestroyed()) return
  const t = track(win)
  if (!t.holds.delete(reason)) return
  if (t.holds.size === 0) win.setOpacity(1)
}

/** Protection follows the setting, nothing else. Call at creation and on toggle. */
export function applyProtection(win: BrowserWindow) {
  if (win.isDestroyed()) return
  track(win)
  if (capability.mode === 'unsupported') return
  win.setContentProtection(privateOn)
}

export function reveal(win: BrowserWindow, activate: boolean) {
  if (win.isDestroyed()) return
  if (win.isVisible()) {
    if (activate) win.focus()
    return
  }
  if (!privateOn || capability.mode === 'unsupported') {
    activate ? win.show() : win.showInactive()
    return
  }
  const t = track(win)
  const seq = ++t.seq
  if (t.timer) clearTimeout(t.timer)
  hold(win, 'reveal')
  activate ? win.show() : win.showInactive()
  // Only while Private is on: with it off nothing here turns protection on.
  win.setContentProtection(false)
  win.setContentProtection(true)
  t.timer = setTimeout(() => {
    t.timer = null
    if (seq !== t.seq) return
    release(win, 'reveal')
  }, REVEAL_MS)
}
