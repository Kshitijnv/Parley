import { globalShortcut } from 'electron'
import type { HotkeyAction } from '@shared/types'
import { getState, moveBy, restoreOverlay, wins } from './windows'

const MOVE_STEP = 24
const DEBOUNCE_MS = 300
const lastFired = new Map<string, number>()

// Registered only while a session is live: Ctrl+Enter and Ctrl+Backspace would
// otherwise stop working in every other app.
export function setHotkeysActive(active: boolean, hotkeys: Record<string, string>): { failed: string[] } {
  globalShortcut.unregisterAll()
  if (!active) return { failed: [] }
  const failed: string[] = []
  for (const [action, accel] of Object.entries(hotkeys)) {
    try {
      const ok = globalShortcut.register(accel, () => fire(action as HotkeyAction))
      if (!ok) failed.push(action)
    } catch {
      failed.push(action)
    }
  }
  return { failed }
}

function fire(action: HotkeyAction) {
  const now = Date.now()
  const repeatable = action.startsWith('move_') || action.startsWith('history_')
  if (!repeatable && now - (lastFired.get(action) ?? 0) < DEBOUNCE_MS) return
  lastFired.set(action, now)
  switch (action) {
    case 'move_up':
      moveBy(0, -MOVE_STEP)
      return
    case 'move_down':
      moveBy(0, MOVE_STEP)
      return
    case 'move_left':
      moveBy(-MOVE_STEP, 0)
      return
    case 'move_right':
      moveBy(MOVE_STEP, 0)
      return
    case 'chat':
      // Through restoreOverlay so the bubble goes away and Private mode's reveal runs.
      if (getState().hidden || !wins.overlay?.isVisible()) restoreOverlay()
      else wins.overlay.focus()
      break
  }
  wins.overlay?.webContents.send('event', 'hotkey:fired', { action })
}
