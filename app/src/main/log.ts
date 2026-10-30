// The one logger for main (architecture.md revision 2 §9). Only allow-listed fields
// are kept, and only as numbers, booleans or short identifier-like strings, so no
// transcript, prompt, resume, key, file name or provider message can be written.
import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const FIELDS = new Set([
  'event',
  'sessionId',
  'answerId',
  'turnId',
  'trigger',
  'outcome',
  'reason',
  'provider',
  'model',
  'status',
  'errorKind',
  'errorName',
  'errorCode',
  'quotaPeriod',
  'retryAfterMs',
  'attempt',
  'firstTokenMs',
  'latencyMs',
  'inputTokens',
  'outputTokens',
  'sttModelId',
  'language',
  'loadMs',
  'bytes',
  'stack',
  // revision 4 A5: candidate lifecycle, routing and per-stage timings (ids, enums, numbers)
  'candidateId',
  'into',
  'waitMs',
  'count',
  'authKind',
  'fallbackReason',
  'servedModel',
  'sttMs',
  'settleMs',
  'gateWaitMs',
  'queueWaitMs',
  'pressToAcceptMs',
  'buildMs',
  'ttftMs',
  'headerMs',
  'streamMs',
  // revision 5 D5
  'chunks',
  'maxChunkGapMs',
  'leadMs',
  // revision 6 T1 / M3: speech worker timing, prompt size, thinking setting
  'speaker',
  'endpoint',
  'rtf',
  'backlogMs',
  'partialLagMs',
  'partialEveryMs',
  'cachedTokens',
  'reasoningTokens',
  'thinking',
  // revision 7 S7: cloud speech (engine, key slot, the provider's error enum, sizes and timings)
  'sttEngine',
  'keySlot',
  'errorType',
  'vocabCount',
  'replayMs',
  'switchMs',
])

// Identifiers, enum values and model ids only: no spaces, at most 80 characters.
const SAFE = /^[\w.:\-/@]{0,80}$/

let file: string | null = null
function logFile(): string | null {
  if (file) return file
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    file = join(dir, `main-${new Date().toISOString().slice(0, 10)}.log`)
  } catch {
    file = null
  }
  return file
}

export type LogFields = Record<string, unknown>

export function log(event: string, fields: LogFields = {}) {
  const out: Record<string, string | number | boolean> = { t: Date.now(), event: SAFE.test(event) ? event : 'invalid_event' }
  for (const [k, v] of Object.entries(fields)) {
    if (!FIELDS.has(k) || v === undefined || v === null) continue
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    else if (typeof v === 'boolean') out[k] = v
    else if (typeof v === 'string' && k === 'stack') out[k] = safeStack(v)
    else if (typeof v === 'string' && SAFE.test(v)) out[k] = v
  }
  const line = JSON.stringify(out)
  console.log(line)
  const f = logFile()
  if (f) {
    try {
      appendFileSync(f, `${line}\n`)
    } catch {
      // logging must never break the app
    }
  }
}

/** Stack frames only: the message line (which can hold user or provider text) is dropped. */
export function safeStack(stack: string): string {
  return stack
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('at '))
    .slice(0, 4)
    .map((l) => l.replace(/\(.*[\\/](src|out|node_modules)[\\/]/, '($1/').replace(/[^\w.:\-/@ ()<>[\]]/g, ''))
    .join(' | ')
    .slice(0, 400)
}
