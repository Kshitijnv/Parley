// Provider transport (architecture.md revision 6 M4). Every provider client shares one
// fetch so connections are reused between questions, and a live session warms the
// connection with a model-metadata request (no generation, so no generation quota).
//
// PARLEY_FETCH picks the transport for comparisons: 'net' (Electron's Chromium network
// stack: HTTP/2, a shared socket pool, the system proxy) or 'node' (Node's fetch).
import { net } from 'electron'
import type { Provider } from '@shared/types'
import { log } from '../log'
import { getKey } from '../secrets'
import { healthOf } from './health'

export type Transport = 'net' | 'node'

export const transport = (): Transport => (process.env['PARLEY_FETCH'] === 'node' ? 'node' : 'net')

/** The fetch given to every AI SDK provider client. */
export const providerFetch: typeof fetch = (input, init) => (transport() === 'net' ? net.fetch(input as string, init) : fetch(input, init))

/** A metadata request per provider: same host and auth as generation, no tokens used. */
function warmRequest(provider: Provider, key: string, model: string): { url: string; headers: Record<string, string> } | null {
  switch (provider) {
    case 'google':
      return { url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`, headers: { 'x-goog-api-key': key } }
    case 'groq':
      return { url: 'https://api.groq.com/openai/v1/models', headers: { authorization: `Bearer ${key}` } }
    case 'openai':
      return { url: 'https://api.openai.com/v1/models', headers: { authorization: `Bearer ${key}` } }
    case 'anthropic':
      return { url: 'https://api.anthropic.com/v1/models?limit=1', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }
    default:
      return null
  }
}

const lastWarm = new Map<Provider, number>()
const WARM_MIN_GAP_MS = 20_000

/**
 * Open (or keep open) the connection to a provider before the next question. Skipped
 * with no key, an unhealthy model, or a warm-up in the last 20 s. Never throws.
 */
export async function warmProvider(provider: Provider, catalogId: string, model: string, sessionId?: string): Promise<void> {
  const at = performance.now()
  if (at - (lastWarm.get(provider) ?? -Infinity) < WARM_MIN_GAP_MS) return
  if (healthOf(catalogId).state !== 'ok') return
  try {
    const key = await getKey(provider)
    const req = key ? warmRequest(provider, key, model) : null
    if (!req) return
    lastWarm.set(provider, at)
    const res = await providerFetch(req.url, { headers: req.headers, signal: AbortSignal.timeout(5000) })
    await res.arrayBuffer().catch(() => null)
    log('provider_warm', { sessionId, provider, model: catalogId, status: res.status, latencyMs: Math.round(performance.now() - at) })
  } catch (e) {
    log('provider_warm', { sessionId, provider, model: catalogId, errorName: (e as Error).name, latencyMs: Math.round(performance.now() - at) })
  }
}
