import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import type { Bounds, WindowState } from '@shared/types'
import { applyProtection, capability, reveal, setPrivateFlag } from './privacy'

const preload = join(import.meta.dirname, '../preload/index.cjs')

export const SHADOW_MARGIN = 8

const state: WindowState = { hidden: false, snappedZone: null, bounds: null, privateMode: true, privacy: capability }

export const wins: {
  overlay: BrowserWindow | null
  bubble: BrowserWindow | null
  snap: BrowserWindow | null
  library: BrowserWindow | null
} = { overlay: null, bubble: null, snap: null, library: null }

function load(win: BrowserWindow, hash: string) {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(`${devUrl}#${hash}`)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'), { hash })
}

function baseWebPrefs() {
  return { preload, sandbox: false, contextIsolation: true, nodeIntegration: false, plugins: true }
}

function externalLinks(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // A link in an answer must never load a web page into a window that has the preload.
  win.webContents.on('will-navigate', (e, url) => {
    const here = win.webContents.getURL().split('#')[0]
    if (url.split('#')[0] === here) return
    e.preventDefault()
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })
}

export function createOverlay(): BrowserWindow {
  const wa = screen.getPrimaryDisplay().workArea
  const width = 480 + SHADOW_MARGIN * 2
  const height = 650 + SHADOW_MARGIN * 2
  const win = new BrowserWindow({
    width,
    height,
    x: wa.x + wa.width - width - 40,
    y: wa.y + 60,
    frame: false,
    transparent: true,
    resizable: true,
    minWidth: 380,
    minHeight: 120,
    alwaysOnTop: true,
    skipTaskbar: false,
    hasShadow: false,
    show: false,
    title: 'Parley',
    webPreferences: baseWebPrefs(),
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true)
  applyProtection(win)
  win.once('ready-to-show', () => reveal(win, true))
  win.on('closed', () => {
    wins.overlay = null
  })
  externalLinks(win)
  load(win, '/overlay')
  wins.overlay = win
  return win
}

export function createBubble(): BrowserWindow {
  const size = 44 + 16
  const win = new BrowserWindow({
    width: size,
    height: size,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    focusable: true,
    webPreferences: baseWebPrefs(),
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  applyProtection(win)
  win.on('closed', () => {
    wins.bubble = null
  })
  load(win, '/bubble')
  wins.bubble = win
  return win
}

export function createSnap(): BrowserWindow {
  const wa = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({
    ...wa,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: baseWebPrefs(),
  })
  win.setIgnoreMouseEvents(true)
  win.setAlwaysOnTop(true, 'pop-up-menu')
  applyProtection(win)
  win.on('closed', () => {
    wins.snap = null
  })
  load(win, '/snap')
  wins.snap = win
  return win
}

export function openLibrary(route: string) {
  let win = wins.library
  if (!win || win.isDestroyed()) {
    win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 760,
      minHeight: 520,
      show: false,
      title: 'Parley Library',
      autoHideMenuBar: true,
      webPreferences: baseWebPrefs(),
    })
    win.once('ready-to-show', () => win?.show())
    win.on('closed', () => {
      wins.library = null
    })
    externalLinks(win)
    load(win, `/library${route.startsWith('/') ? route : `/${route}`}`)
    wins.library = win
  } else {
    win.webContents.send('nav', `/library${route.startsWith('/') ? route : `/${route}`}`)
    if (win.isMinimized()) win.restore()
    win.focus()
  }
}

export function openOverlay(route: string) {
  const win = wins.overlay ?? createOverlay()
  if (state.hidden) restoreOverlay()
  win.webContents.send('nav', `/overlay${route.startsWith('/') ? route : `/${route}`}`)
  reveal(win, true)
}

export function broadcastState() {
  for (const w of [wins.overlay, wins.bubble, wins.library]) {
    if (w && !w.isDestroyed()) w.webContents.send('event', 'window:state', { ...state })
  }
}

export function getState(): WindowState {
  const o = wins.overlay
  return { ...state, bounds: o && !o.isDestroyed() ? o.getBounds() : state.bounds }
}

export function hideOverlay() {
  const o = wins.overlay
  if (!o) return
  const b = o.getBounds()
  const bubble = wins.bubble ?? createBubble()
  const size = bubble.getBounds().width
  bubble.setBounds({ x: b.x + b.width - size - SHADOW_MARGIN, y: b.y + SHADOW_MARGIN, width: size, height: size })
  o.hide()
  reveal(bubble, false)
  state.hidden = true
  broadcastState()
}

export function restoreOverlay() {
  wins.bubble?.hide()
  if (wins.overlay) reveal(wins.overlay, true)
  state.hidden = false
  broadcastState()
}

export function setPrivate(on: boolean) {
  state.privateMode = on
  setPrivateFlag(on)
  // Hidden windows take the value now too; their next reveal resets it if on.
  for (const w of [wins.overlay, wins.bubble, wins.snap]) if (w && !w.isDestroyed()) applyProtection(w)
  broadcastState()
}

function clampToWorkArea(b: Bounds): Bounds {
  const wa = screen.getDisplayMatching(b).workArea
  const x = Math.min(Math.max(b.x, wa.x - SHADOW_MARGIN), wa.x + wa.width - b.width + SHADOW_MARGIN)
  const y = Math.min(Math.max(b.y, wa.y - SHADOW_MARGIN), wa.y + wa.height - b.height + SHADOW_MARGIN)
  return { ...b, x: Math.round(x), y: Math.round(y) }
}

export function moveBy(dx: number, dy: number): Bounds | null {
  const o = wins.overlay
  if (!o) return null
  const next = clampToWorkArea({ ...o.getBounds(), x: o.getBounds().x + dx, y: o.getBounds().y + dy })
  o.setBounds(next)
  state.snappedZone = null
  return next
}

export function setBounds(b: Bounds): Bounds | null {
  const o = wins.overlay
  if (!o) return null
  const next = clampToWorkArea(b)
  o.setBounds(next)
  return next
}

export function fit(width: number, height: number) {
  const o = wins.overlay
  if (!o) return
  const cur = o.getBounds()
  // the renderer measures CSS px; at a zoom other than 100% the window needs zoom × that in DIP
  const z = o.webContents.getZoomFactor()
  const w = Math.round((width + SHADOW_MARGIN * 2) * z)
  const h = Math.round((height + SHADOW_MARGIN * 2) * z)
  if (cur.width === w && cur.height === h) return
  o.setBounds(clampToWorkArea({ x: cur.x + Math.round((cur.width - w) / 2), y: cur.y, width: w, height: h }))
}

// Snap grid (S05): 3 columns x 2 rows across the work area of the overlay's display.
let snapTimer: NodeJS.Timeout | null = null
let hoverZone: number | null = null

function zoneAt(pt: { x: number; y: number }, wa: Electron.Rectangle): number {
  const col = Math.min(2, Math.max(0, Math.floor(((pt.x - wa.x) / wa.width) * 3)))
  const row = Math.min(1, Math.max(0, Math.floor(((pt.y - wa.y) / wa.height) * 2)))
  return row * 3 + col
}

export function snap(phase: 'start' | 'end'): Bounds | null {
  const o = wins.overlay
  if (!o) return null
  const wa = screen.getDisplayMatching(o.getBounds()).workArea
  const grid = wins.snap ?? createSnap()
  if (phase === 'start') {
    grid.setBounds(wa)
    reveal(grid, false)
    if (snapTimer) clearInterval(snapTimer)
    snapTimer = setInterval(() => {
      const z = zoneAt(screen.getCursorScreenPoint(), wa)
      if (z !== hoverZone) {
        hoverZone = z
        grid.webContents.send('event', 'snap:hover', { zone: z })
      }
    }, 50)
    return null
  }
  if (snapTimer) clearInterval(snapTimer)
  snapTimer = null
  grid.hide()
  const zone = hoverZone ?? zoneAt(screen.getCursorScreenPoint(), wa)
  hoverZone = null
  const cur = o.getBounds()
  const col = zone % 3
  const row = Math.floor(zone / 3)
  const x = col === 0 ? wa.x : col === 1 ? wa.x + wa.width / 2 - cur.width / 2 : wa.x + wa.width - cur.width
  const y = row === 0 ? wa.y : wa.y + wa.height - cur.height
  const next = clampToWorkArea({ ...cur, x: Math.round(x), y: Math.round(y) })
  o.setBounds(next)
  state.snappedZone = zone
  broadcastState()
  return next
}
