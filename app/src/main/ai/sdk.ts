// AnswerProvider over the Vercel AI SDK for Gemini, OpenAI, Anthropic and Groq.
// maxRetries is 0 everywhere: the app decides every attempt.
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, Output, streamText, type LanguageModel } from 'ai'
import type { ZodType } from 'zod'
import type { Provider } from '@shared/types'
import { classify } from './gemini'
import type { AnswerProvider, CompleteResult, ModelEvent, ModelRequest } from './provider'
import { providerFetch } from './transport'

type SdkProvider = Exclude<Provider, 'deepgram' | 'logodev'>

function factory(provider: SdkProvider, apiKey: string): (model: string) => LanguageModel {
  switch (provider) {
    case 'google':
      return createGoogleGenerativeAI({ apiKey, fetch: providerFetch })
    case 'openai':
      return createOpenAI({ apiKey, fetch: providerFetch })
    case 'anthropic':
      return createAnthropic({ apiKey, fetch: providerFetch })
    default:
      return createGroq({ apiKey, fetch: providerFetch })
  }
}

/** Options that keep first-token latency low (measured in backend.md). */
const FAST: Partial<Record<SdkProvider, Record<string, Record<string, unknown>>>> = {
  openai: { openai: { reasoningEffort: 'low' } },
}

export function sdkProvider(provider: SdkProvider, apiKey: string, vision: (model: string) => boolean): AnswerProvider {
  const make = factory(provider, apiKey)
  return {
    id: provider,
    supportsImages: vision,
    async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
      const res = streamText({
        model: make(req.model),
        instructions: req.system,
        messages: req.messages,
        abortSignal: signal,
        maxRetries: 0,
        maxOutputTokens: req.maxOutputTokens,
        temperature: req.temperature,
        providerOptions: FAST[provider] as never,
        // Gemini: the SDK maps 'none' to each model's lowest thinking setting
        // (thinkingLevel 'minimal' on Gemini 3 ids and aliases, thinkingBudget 0 on 2.5).
        ...(req.thinking === 'minimum' && provider === 'google' ? { reasoning: 'none' as const } : {}),
        // The SDK's default handler console.logs the error with the request body.
        onError: () => {},
      })
      let finish: ModelEvent | null = null
      try {
        for await (const part of res.fullStream) {
          if (part.type === 'text-delta') {
            if (part.text) yield { type: 'text', text: part.text }
          } else if (part.type === 'error') {
            throw part.error
          } else if (part.type === 'abort') {
            return
          } else if (part.type === 'finish') {
            const reason = part.finishReason === 'stop' ? 'stop' : part.finishReason === 'length' ? 'length' : 'other'
            const u = part.totalUsage
            finish = { type: 'finish', reason, usage: { input: u?.inputTokens ?? null, output: u?.outputTokens ?? null, cached: u?.inputTokenDetails?.cacheReadTokens ?? null, reasoning: u?.outputTokenDetails?.reasoningTokens ?? null } }
          }
        }
      } catch (e) {
        if (signal.aborted) return
        throw classify(e, provider)
      }
      yield finish ?? { type: 'finish', reason: 'other' }
    },
    async complete<T>(req: ModelRequest & { schema?: ZodType<T> }, signal: AbortSignal): Promise<CompleteResult<T>> {
      try {
        const res = await generateText({
          model: make(req.model),
          instructions: req.system,
          messages: req.messages,
          abortSignal: signal,
          maxRetries: 0,
          maxOutputTokens: req.maxOutputTokens,
          ...(req.schema ? { output: Output.object({ schema: req.schema }) } : {}),
        })
        return {
          text: res.text,
          output: req.schema ? ((res as unknown as { output: T }).output as T) : undefined,
          usage: { input: res.usage?.inputTokens ?? null, output: res.usage?.outputTokens ?? null },
        }
      } catch (e) {
        throw classify(e, provider)
      }
    },
  }
}
