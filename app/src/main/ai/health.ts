// ProviderHealth (architecture.md revision 2 §1, §6): per catalog model, shared by live
// answers and background work. Monotonic clock for every timer.
import { providerOf } from '@shared/catalog'
import type { Provider, ProviderState } from '@shared/types'
import type { ProviderError } from './provider'

interface H {
  exhausted: boolean
  coolUntil: number
  /** Why the model is cooling: picks the fallback switch rule (revision 4 A4.3). */
  coolReason: 'rate_limited' | 'overloaded'
  recent429: number[]
  lastExhaustedManualTry: number
}

const models = new Map<string, H>()
const authFailed = new Set<Provider>()
let offline = false
const listeners = new Set<() => void>()

const mono = () => performance.now()
export const toEpoch = (m: number) => Math.round(Date.now() + (m - mono()))

const FIVE_MIN = 5 * 60_000
const TEN_MIN = 10 * 60_000
const DEFAULT_COOL_MS = 30_000
const OVERLOAD_COOL_MS = 15_000

function h(id: string): H {
  let x = models.get(id)
  if (!x) models.set(id, (x = { exhausted: false, coolUntil: 0, coolReason: 'rate_limited', recent429: [], lastExhaustedManualTry: -Infinity }))
  return x
}

const changed = () => listeners.forEach((f) => f())

export function onHealthChange(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function healthOf(catalogId: string): { state: ProviderState; retryAtMono?: number; retryAt?: number; coolReason?: 'rate_limited' | 'overloaded' } {
  if (authFailed.has(providerOf(catalogId))) return { state: 'auth_failed' }
  const x = models.get(catalogId)
  if (x?.exhausted) return { state: 'exhausted' }
  if (x && x.coolUntil > mono()) return { state: 'cooling', retryAtMono: x.coolUntil, retryAt: toEpoch(x.coolUntil), coolReason: x.coolReason }
  if (offline) return { state: 'offline' }
  return { state: 'ok' }
}

export function reportSuccess(catalogId: string) {
  const x = h(catalogId)
  const was = x.exhausted || x.coolUntil > mono() || offline || x.recent429.length > 0
  x.exhausted = false
  x.coolUntil = 0
  x.recent429 = []
  offline = false
  if (was) changed()
}

export function reportError(catalogId: string, e: ProviderError) {
  const x = h(catalogId)
  const t = mono()
  switch (e.kind) {
    case 'rate_limited':
      x.recent429 = [...x.recent429.filter((at) => t - at < FIVE_MIN), t]
      // Three 429s in a row within 5 minutes count as an exhausted quota (§6).
      if (x.recent429.length >= 3) {
        x.exhausted = true
        x.lastExhaustedManualTry = t
      } else {
        x.coolUntil = t + (e.retryAfterMs ?? DEFAULT_COOL_MS)
        x.coolReason = 'rate_limited'
      }
      break
    case 'quota_exhausted':
      // The call that hit the quota counts as the manual try for the next 10 minutes.
      x.exhausted = true
      x.lastExhaustedManualTry = t
      break
    case 'overloaded':
      if (x.coolUntil <= t) x.coolReason = 'overloaded'
      x.coolUntil = Math.max(x.coolUntil, t + OVERLOAD_COOL_MS)
      break
    case 'offline':
      offline = true
      break
    case 'auth':
      authFailed.add(providerOf(catalogId))
      break
    default:
      return
  }
  changed()
}

/** A new or removed key clears the auth block for that provider. */
export function clearAuth(provider: Provider) {
  if (authFailed.delete(provider)) changed()
}

/** While exhausted, a manual try is allowed at most once every 10 minutes. */
export function takeExhaustedManualTry(catalogId: string): boolean {
  const x = h(catalogId)
  if (mono() - x.lastExhaustedManualTry < TEN_MIN) return false
  x.lastExhaustedManualTry = mono()
  return true
}

/** True when background work should wait instead of spending a call. */
export function blocked(catalogId: string): boolean {
  const s = healthOf(catalogId).state
  return s === 'cooling' || s === 'exhausted' || s === 'auth_failed'
}

// ---------- sticky fallback (revision 4 A4.3) ----------

const slowSwitches = new Map<string, number[]>()
const stickyUntil = new Map<string, number>()

/** A switch away from `catalogId` because it had no first token in time. */
export function noteSlowSwitch(catalogId: string, stickyAfter: number, windowMs: number) {
  const t = mono()
  const list = [...(slowSwitches.get(catalogId) ?? []).filter((at) => t - at < FIVE_MIN), t]
  slowSwitches.set(catalogId, list)
  if (list.length >= stickyAfter) {
    stickyUntil.set(catalogId, t + windowMs)
    slowSwitches.set(catalogId, [])
  }
}

/** True while new requests should skip `catalogId` and go straight to the fallback. */
export function stickyFallback(catalogId: string): boolean {
  const until = stickyUntil.get(catalogId)
  if (until === undefined) return false
  if (mono() < until) return true
  stickyUntil.delete(catalogId)
  return false
}
