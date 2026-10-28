// The replaceable model seam (architecture.md revision 2 §7). Providers stream text and
// map their failures to ProviderError. They never retry: the RequestGate (live
// answers) and callModel() (background work) own every attempt.
import type { ModelMessage } from 'ai'
import type { Provider } from '@shared/types'

export interface ModelRequest {
  model: string
  /** Stable within a session so Gemini's implicit caching can apply. */
  system: string
  messages: ModelMessage[]
  maxOutputTokens: number
  temperature?: number
  /** Revision 6 M1: 'minimum' asks for the least thinking the model allows (live answers). */
  thinking?: 'minimum' | 'default'
}

export interface Usage {
  input: number | null
  output: number | null
  /** Revision 6 M3: input tokens served from the provider's prompt cache, and thinking tokens. */
  cached?: number | null
  reasoning?: number | null
}

export type ModelEvent =
  | { type: 'text'; text: string }
  | { type: 'finish'; reason: 'stop' | 'length' | 'other'; usage?: Usage }

export type ProviderErrorKind = 'rate_limited' | 'quota_exhausted' | 'overloaded' | 'auth' | 'bad_request' | 'not_found' | 'offline' | 'timeout' | 'unknown'

export class ProviderError extends Error {
  /** Revision 4 A1: for kind 'auth', whether the key is wrong or not allowed here. */
  authKind?: 'invalid_key' | 'forbidden'

  constructor(
    public kind: ProviderErrorKind,
    public status?: number,
    public retryAfterMs?: number,
    public quotaPeriod?: 'minute' | 'day' | 'unknown',
  ) {
    // The message is the kind only: provider bodies never travel past this point.
    super(kind)
    this.name = 'ProviderError'
  }
}

export interface CompleteResult<T> {
  text: string
  output?: T
  usage?: { input: number | null; output: number | null }
}

export interface AnswerProvider {
  readonly id: Provider | 'fake'
  supportsImages(model: string): boolean
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>
  /** Non-streaming call for background work; `schema` asks for structured output. */
  complete<T>(req: ModelRequest & { schema?: import('zod').ZodType<T> }, signal: AbortSignal): Promise<CompleteResult<T>>
}
