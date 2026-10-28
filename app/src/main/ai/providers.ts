// Model catalog ids ("<provider>:<name>", src/shared/catalog.ts) -> an AnswerProvider
// and the provider's model id. Keys are read here, in main, and passed straight to the
// provider client; they never reach a renderer.
import { MODEL_CATALOG, modelLabel, providerOf, PROVIDERS } from '@shared/catalog'
import type { Provider } from '@shared/types'
import { AppError } from '../errors'
import { getKey, providersWithKeys } from '../secrets'
import { fakeProvider, fakeScriptPath } from './fake'
import type { AnswerProvider } from './provider'
import { sdkProvider } from './sdk'

/**
 * Catalog id -> provider model id. Gemini uses Google's "-latest" aliases, which move
 * to the newest stable model of each tier without an app update.
 */
const MODEL_IDS: Record<string, string> = {
  'google:gemini-flash-lite': 'gemini-flash-lite-latest',
  'google:gemini-flash': 'gemini-flash-latest',
  'google:gemini-pro': 'gemini-pro-latest',
  'openai:gpt-mini': 'gpt-5-mini',
  'openai:gpt': 'gpt-5.5',
  'anthropic:claude-haiku': 'claude-haiku-5-5',
  'anthropic:claude-sonnet': 'claude-sonnet-5-5',
  'groq:llama-instant': 'llama-3.1-8b-instant',
}

const LLM: Provider[] = ['google', 'openai', 'anthropic', 'groq']

function overrides(): Record<string, string> {
  try {
    return JSON.parse(process.env['PARLEY_MODEL_MAP'] ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

export function providerModelId(catalogId: string): string {
  return overrides()[catalogId] ?? MODEL_IDS[catalogId] ?? catalogId.slice(catalogId.indexOf(':') + 1)
}

export function providerLabel(p: Provider): string {
  return PROVIDERS.find((x) => x.id === p)?.label ?? p
}

export const isFake = () => !!fakeScriptPath()

export interface ResolvedModel {
  provider: AnswerProvider
  providerId: Provider
  catalogId: string
  /** The provider's own model id. */
  model: string
}

export function isVisionModel(catalogId: string): boolean {
  return MODEL_CATALOG.find((m) => m.id === catalogId)?.vision ?? false
}

export async function resolveModel(catalogId: string): Promise<ResolvedModel> {
  const providerId = providerOf(catalogId)
  if (!LLM.includes(providerId)) throw new AppError(`${modelLabel(catalogId)} is not a language model.`, 'validation')
  const model = providerModelId(catalogId)
  if (isFake()) return { provider: fakeProvider(), providerId, catalogId, model }
  const key = await getKey(providerId)
  if (!key) throw new AppError(`Add a ${providerLabel(providerId)} API key in Settings to use ${modelLabel(catalogId)}.`, 'no_key')
  return { provider: sdkProvider(providerId as Exclude<Provider, 'deepgram' | 'logodev'>, key, () => isVisionModel(catalogId)), providerId, catalogId, model }
}

/** Providers that can serve models now (all of them with the fake provider). */
export function modelProviders(): Set<Provider> {
  return isFake() ? new Set(LLM) : providersWithKeys()
}

/** The preferred model if its provider has a key, else the first catalog model that does. */
export function firstAvailableModel(withKeys: Set<Provider>, preferred?: string): string | null {
  if (preferred && withKeys.has(providerOf(preferred))) return preferred
  return MODEL_CATALOG.find((m) => withKeys.has(m.provider))?.id ?? null
}
