import type { ApiEventName, ApiEvents } from '@shared/api'

type Listener = (payload: any) => void

const listeners = new Map<string, Set<Listener>>()
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('parley-events') : null

channel?.addEventListener('message', (e: MessageEvent<{ event: string; payload: unknown }>) => {
  dispatch(e.data.event, e.data.payload)
})

function dispatch(event: string, payload: unknown) {
  listeners.get(event)?.forEach((cb) => {
    try {
      cb(payload)
    } catch (err) {
      console.error(err)
    }
  })
}

/** Emit to this window only (streams, STT events: the overlay owns them). */
export function emitLocal<E extends ApiEventName>(event: E, payload: ApiEvents[E]) {
  dispatch(event, payload)
}

/** Emit to this window and every other window of the app. */
export function emitAll<E extends ApiEventName>(event: E, payload: ApiEvents[E]) {
  dispatch(event, payload)
  channel?.postMessage({ event, payload })
}

/** Events pushed by Electron main (hotkey:fired, window:state, snap:hover). */
export function emitRaw(event: string, payload: unknown) {
  dispatch(event, payload)
}

export function on(event: string, cb: Listener): () => void {
  let set = listeners.get(event)
  if (!set) listeners.set(event, (set = new Set()))
  set.add(cb)
  return () => set.delete(cb)
}
