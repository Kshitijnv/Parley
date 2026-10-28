// Answer routing (architecture.md revision 4 A4.3): whether an opt-in fallback model can
// serve a live answer. The gate asks it before suppressing a blocked request; the engine
// asks it before switching. Off unless the user picked a fallback model.
import { DEFAULT_ANSWER_ROUTING, MODEL_CATALOG, providerOf } from '@shared/catalog'
import type { AnswerRouting, AnswerTrigger, FallbackReason } from '@shared/types'
import { getSettings } from '../db/repo'
import { healthOf } from './health'
import { isVisionModel, modelProviders } from './providers'

export function routing(): AnswerRouting {
  try {
    return getSettings().answerRouting
  } catch {
    return DEFAULT_ANSWER_ROUTING
  }
}

/** The fallback model if it is configured, different, keyed, healthy and fits the trigger. */
export function usableFallback(primary: string, trigger: AnswerTrigger): string | null {
  const fb = routing().fallbackModel
  if (!fb || fb === primary || !MODEL_CATALOG.some((m) => m.id === fb)) return null
  if (trigger === 'screenshot' && !isVisionModel(fb)) return null
  if (!modelProviders().has(providerOf(fb))) return null
  return healthOf(fb).state === 'ok' ? fb : null
}

/**
 * When the primary can't be called right now (key rejected, or cooling after a 429 or a
 * 503), the fallback serves instead of the request being refused, if the matching switch
 * rule is on. A daily quota never qualifies (A4.3): the user chooses it with one press.
 */
export function fallbackForBlocked(primary: string, trigger: AnswerTrigger): { model: string; reason: FallbackReason } | null {
  const h = healthOf(primary)
  const on = routing().switchOn
  const reason: FallbackReason | null =
    h.state === 'auth_failed' && on.auth ? 'auth' : h.state === 'cooling' ? (h.coolReason === 'overloaded' ? (on.overloaded ? 'overloaded' : null) : on.rateLimited ? 'rate_limited' : null) : null
  if (!reason) return null
  const model = usableFallback(primary, trigger)
  return model ? { model, reason } : null
}
