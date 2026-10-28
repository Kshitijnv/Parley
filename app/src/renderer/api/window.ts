// Window behaviour. In Electron it goes to main (real frameless, always-on-top
// windows). In the browser preview the overlay lives in a simulated desktop, and
// this module is that desktop's state.
import type { Api } from '@shared/api'
import type { Bounds, WindowState } from '@shared/types'
import { emitLocal } from './mock/bus'

export const isElectron = typeof window !== 'undefined' && !!window.native?.isElectron

export interface SimState extends WindowState {
  bounds: Bounds
  snapping: boolean
  hoverZone: number | null
  closed: boolean
  desktop: { width: number; height: number }
}

const subs = new Set<() => void>()
export const sim: SimState = {
  hidden: false,
  snappedZone: null,
  privateMode: true,
  privacy: { mode: 'exclude', reason: null },
  snapping: false,
  hoverZone: null,
  closed: false,
  desktop: { width: typeof window !== 'undefined' ? window.innerWidth : 1440, height: typeof window !== 'undefined' ? window.innerHeight : 900 },
  bounds: { x: 0, y: 24, width: 480, height: 650 },
}
if (typeof window !== 'undefined') sim.bounds.x = Math.max(16, window.innerWidth - 480 - 48)

export function simSubscribe(cb: () => void) {
  subs.add(cb)
  return () => {
    subs.delete(cb)
  }
}

function simChanged() {
  emitLocal('window:state', { hidden: sim.hidden, snappedZone: sim.snappedZone, bounds: sim.bounds, privateMode: sim.privateMode, privacy: sim.privacy })
  subs.forEach((cb) => cb())
}

function clamp(b: Bounds): Bounds {
  const { width, height } = sim.desktop
  return {
    ...b,
    x: Math.round(Math.min(Math.max(b.x, 0), Math.max(0, width - b.width))),
    y: Math.round(Math.min(Math.max(b.y, 0), Math.max(0, height - Math.min(b.height, height)))),
  }
}

export function simSetHover(zone: number | null) {
  if (sim.hoverZone === zone) return
  sim.hoverZone = zone
  simChanged()
}

export function simSetDesktop(width: number, height: number) {
  sim.desktop = { width, height }
  sim.bounds = clamp(sim.bounds)
  simChanged()
}

export function simReopen() {
  sim.closed = false
  sim.hidden = false
  simChanged()
}

const n = () => window.native!

const electronApi: Api['window'] = {
  hide: () => n().invoke('window:hide'),
  restore: () => n().invoke('window:restore'),
  moveBy: (i) => n().invoke('window:moveBy', i),
  snap: (i) => n().invoke('window:snap', i),
  setBounds: (i) => n().invoke('window:setBounds', i),
  openLibrary: (i) => n().invoke('window:openLibrary', i),
  openOverlay: (i) => n().invoke('window:openOverlay', i),
  fit: (i) => n().invoke('window:fit', i),
  setHotkeysActive: (i) => n().invoke('window:setHotkeysActive', i),
  close: () => n().invoke('window:close'),
  state: () => n().invoke('window:state'),
}

const browserApi: Api['window'] = {
  async hide() {
    sim.hidden = true
    simChanged()
    return { ok: true }
  },
  async restore() {
    sim.hidden = false
    simChanged()
    return { ok: true }
  },
  async moveBy({ dx, dy }) {
    sim.bounds = clamp({ ...sim.bounds, x: sim.bounds.x + dx, y: sim.bounds.y + dy })
    sim.snappedZone = null
    simChanged()
    return sim.bounds
  },
  async snap({ phase }) {
    if (phase === 'start') {
      sim.snapping = true
      simChanged()
      return null
    }
    sim.snapping = false
    const zone = sim.hoverZone
    sim.hoverZone = null
    if (zone !== null) {
      const { width, height } = sim.desktop
      const col = zone % 3
      const row = Math.floor(zone / 3)
      const x = col === 0 ? 0 : col === 1 ? width / 2 - sim.bounds.width / 2 : width - sim.bounds.width
      const y = row === 0 ? 0 : height - sim.bounds.height
      sim.bounds = clamp({ ...sim.bounds, x, y })
      sim.snappedZone = zone
    }
    simChanged()
    return sim.bounds
  },
  async setBounds(b) {
    sim.bounds = clamp(b)
    simChanged()
    return sim.bounds
  },
  async openLibrary({ route }) {
    window.open(`${location.pathname}${location.search}#/library${route.startsWith('/') ? route : `/${route}`}`, 'parley-library')
    return { ok: true }
  },
  async openOverlay({ route }) {
    window.open(`${location.pathname}${location.search}#/overlay${route.startsWith('/') ? route : `/${route}`}`, 'parley-overlay')
    return { ok: true }
  },
  async fit({ width, height }) {
    if (sim.bounds.width === Math.round(width) && sim.bounds.height === Math.round(height)) return
    const cx = sim.bounds.x + sim.bounds.width / 2
    sim.bounds = clamp({ x: cx - width / 2, y: sim.bounds.y, width: Math.round(width), height: Math.round(height) })
    simChanged()
  },
  async setHotkeysActive() {
    // The browser can't register global hotkeys; the live view listens for keydown instead.
    return { failed: [] }
  },
  async close() {
    sim.closed = true
    simChanged()
  },
  async state() {
    return { hidden: sim.hidden, snappedZone: sim.snappedZone, bounds: sim.bounds, privateMode: sim.privateMode, privacy: sim.privacy }
  },
}

export const windowApi = {
  api: isElectron ? electronApi : browserApi,
  async setPrivate(on: boolean) {
    if (isElectron) await n().invoke('window:setPrivate', { on })
    else {
      sim.privateMode = on
      simChanged()
    }
  },
  setZoom(factor: number) {
    if (isElectron) n().setZoom(factor)
  },
}
