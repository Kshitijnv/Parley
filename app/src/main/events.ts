import { BrowserWindow } from 'electron'
import type { ApiEventName, ApiEvents } from '@shared/api'

/** Push an event to every app window (the windows filter by session or id themselves). */
export function emit<E extends ApiEventName>(event: E, payload: ApiEvents[E]) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('event', event, payload)
  }
}

export const changed = (area: ApiEvents['data:changed']['area']) => emit('data:changed', { area })
