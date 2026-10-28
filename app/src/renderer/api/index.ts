import type { Api } from '@shared/api'
import { emitRaw, on as onRaw } from './mock/bus'
import { api as mockApi } from './mock'
import { isElectron } from './window'

/** True while the data layer is the mock (no window.api from /replica-backend yet). */
export const isMock = typeof window === 'undefined' || !window.api

export const api: Api = (typeof window !== 'undefined' && window.api) || mockApi

// Events Electron main pushes to this window (hotkeys, window state, snap hover)
// join the same event bus the screens subscribe to.
if (isElectron) window.native!.on((event, payload) => emitRaw(event, payload))

export { isElectron, onRaw }
export { ApiError } from './mock/store'
