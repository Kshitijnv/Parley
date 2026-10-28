// Scripted provider for development and tests (architecture.md revision 2 §7). Enabled
// only in development builds by PARLEY_FAKE_PROVIDER=<path to a JSON script>. It lets
// /replica-test drive every path (429 per minute or per day, 503, slow first token,
// interruptions) with zero Gemini calls. Its default reply is labelled as fake.
//
// Script: { "default"?: Step, "steps"?: Step[], "models"?: { [providerModelId]: { "default"?, "steps"? } } }.
// Each provider call takes the next step; when they run out, `default` is used. A
// `models` entry (keyed by the provider's own model id, e.g. "gpt-5-mini") gives that
// model its own steps, so a test can script a primary and a fallback separately. The
// file is re-read when it changes, and a changed file restarts at its first step.
//
// Step: { "text"?: string, "firstTokenMs"?: number, "chunkMs"?: number, "chunkChars"?: number,
//         "failAfterChunks"?: number, "hang"?: true, "output"?: object,
//         "error"?: "rate_limited" | "quota_exhausted" | "overloaded" | "unclassified_429" | "auth" | "offline" | "not_found"
//                   | "auth_invalid_400" | "forbidden_403" | "region_403"   (these three go through the real classifier),
//         "retryAfterS"?: number }
import { APICallError } from 'ai'
import { readFileSync, statSync } from 'node:fs'
import type { ZodType } from 'zod'
import { isDev } from '../env'
import type { AnswerProvider, CompleteResult, ModelEvent, ModelRequest } from './provider'
import { classify } from './gemini'
import { ProviderError } from './provider'

interface Step {
  text?: string
  firstTokenMs?: number
  chunkMs?: number
  chunkChars?: number
  failAfterChunks?: number
  hang?: boolean
  output?: unknown
  error?: 'rate_limited' | 'quota_exhausted' | 'overloaded' | 'unclassified_429' | 'auth' | 'offline' | 'not_found' | 'auth_invalid_400' | 'forbidden_403' | 'region_403'
  retryAfterS?: number
}

interface Script {
  default?: Step
  steps?: Step[]
  models?: Record<string, { default?: Step; steps?: Step[] }>
}

export const fakeScriptPath = (): string | null => (isDev && process.env['PARLEY_FAKE_PROVIDER']) || null

let loaded = { mtime: -1, script: {} as Script, next: new Map<string, number>() }

function nextStep(model?: string): Step {
  const p = fakeScriptPath()
  if (!p) return {}
  try {
    const m = statSync(p).mtimeMs
    if (m !== loaded.mtime) loaded = { mtime: m, script: JSON.parse(readFileSync(p, 'utf8')) as Script, next: new Map() }
  } catch {
    return {}
  }
  const own = model ? loaded.script.models?.[model] : undefined
  const k = own ? model! : ''
  const steps = own ? (own.steps ?? []) : (loaded.script.steps ?? [])
  const def = own ? (own.default ?? loaded.script.default ?? {}) : (loaded.script.default ?? {})
  const i = loaded.next.get(k) ?? 0
  loaded.next.set(k, i + 1)
  return steps[i] ?? def
}

/** The bodies real providers send, so the classifier itself is under test. */
function apiError(status: number, body: object): never {
  throw classify(new APICallError({ message: `HTTP ${status}`, url: 'https://fake.invalid', requestBodyValues: {}, statusCode: status, responseBody: JSON.stringify(body) }), 'google')
}

function lastUserText(req: ModelRequest): string {
  const m = [...req.messages].reverse().find((x) => x.role === 'user')
  const c = m?.content
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => ('text' in p ? p.text : '')).join(' ') : ''
  const them = text.split('\n').filter((l) => /^Them:/.test(l)).pop()
  return (them ?? text).replace(/^Them:\s*/, '').slice(0, 120)
}

function defaultText(req: ModelRequest): string {
  const q = lastUserText(req) || 'your question'
  return `QUESTION: ${q}\n---\n**[Fake provider: scripted test output, not a real AI answer.]** The direct answer comes first in one short sentence.\n\n- A supporting point.\n- Another supporting point.\n- A third point with \`code\`.`
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })

function raise(step: Step): never {
  const after = step.retryAfterS !== undefined ? step.retryAfterS * 1000 : undefined
  switch (step.error) {
    case 'rate_limited':
      throw new ProviderError('rate_limited', 429, after, 'minute')
    case 'quota_exhausted':
      throw new ProviderError('quota_exhausted', 429, after, 'day')
    case 'unclassified_429':
      throw new ProviderError('rate_limited', 429, after, 'unknown')
    case 'overloaded':
      throw new ProviderError('overloaded', 503)
    case 'auth':
      throw new ProviderError('auth', 401)
    case 'not_found':
      throw new ProviderError('not_found', 404)
    case 'auth_invalid_400':
      return apiError(400, { error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } })
    case 'forbidden_403':
      return apiError(403, { error: { code: 403, status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_SERVICE_BLOCKED' }] } })
    case 'region_403':
      return apiError(403, { error: { code: 403, status: 'FAILED_PRECONDITION', message: 'User location is not supported for the API use.' } })
    default:
      throw new ProviderError('offline')
  }
}

export function fakeProvider(): AnswerProvider {
  return {
    id: 'fake',
    supportsImages: () => true,
    async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
      const step = nextStep(req.model)
      await sleep(step.firstTokenMs ?? 150, signal)
      if (signal.aborted) return
      if (step.error) raise(step)
      if (step.hang) {
        await sleep(10 * 60_000, signal)
        return
      }
      const text = step.text ?? defaultText(req)
      const size = step.chunkChars ?? 24
      let chunks = 0
      for (let i = 0; i < text.length; i += size) {
        if (signal.aborted) return
        if (step.failAfterChunks !== undefined && chunks >= step.failAfterChunks) throw new ProviderError('overloaded', 503)
        yield { type: 'text', text: text.slice(i, i + size) }
        chunks++
        await sleep(step.chunkMs ?? 30, signal)
      }
      yield { type: 'finish', reason: 'stop', usage: { input: null, output: null } }
    },
    async complete<T>(req: ModelRequest & { schema?: ZodType<T> }, signal: AbortSignal): Promise<CompleteResult<T>> {
      const step = nextStep(req.model)
      await sleep(step.firstTokenMs ?? 100, signal)
      if (step.error) raise(step)
      if (req.schema) {
        const parsed = req.schema.safeParse(step.output)
        if (!parsed.success) throw new ProviderError('bad_request', 400)
        return { text: JSON.stringify(parsed.data), output: parsed.data }
      }
      return { text: step.text ?? '[Fake provider: scripted test output, not a real AI answer.]' }
    },
  }
}
