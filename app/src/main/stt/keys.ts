// Cloud speech keys (architecture.md revision 7 S4.1–S4.5): up to 5 Speechmatics keys,
// encrypted with safeStorage like `secrets`, tried in the user's order. Each has a state
// set by the pool, and Parley's own count of streamed audio per UTC month and in total.
// The plain key is decrypted only in main, only when a call or a test needs it.
import { safeStorage } from 'electron'
import type { SpeechKey, SpeechKeyState } from '@shared/types'
import { all, get, run, tx } from '../db/client'
import { now, uuid } from '../db/repo'
import { AppError } from '../errors'
import { providerFetch } from '../ai/transport'
import { isDev } from '../env'
import type { KeyMark, PoolKey } from './pool'
import { SM_KEY_TEST_URL, testSpeechmaticsKey } from './speechmatics'

export const MAX_SPEECH_KEYS = 5

/** The key-check endpoint; development builds may point it at the tests' fake server (S7). */
export const keyTestUrl = () => (isDev && process.env['PARLEY_SPEECHMATICS_TEST_URL']) || SM_KEY_TEST_URL
const HOUR = 3_600_000

const month = (t = now()) => new Date(t).toISOString().slice(0, 7)
/** Start of the next UTC month: when a used-up key is tried in a call again. */
const nextMonthStart = (t = now()) => {
  const d = new Date(t)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}

interface Row {
  id: string
  label: string
  last4: string
  position: number
  state: SpeechKeyState
  state_until: number | null
  last_error_type: string | null
  used_ms: number
  used_total_ms: number
  used_month: string
  budget_ms: number | null
  verified_at: number | null
  updated_at: number
  ciphertext: Uint8Array
}

const toKey = (r: Row): SpeechKey => ({
  id: r.id,
  label: r.label,
  last4: r.last4,
  position: Number(r.position),
  state: r.state,
  stateUntil: r.state_until === null ? null : Number(r.state_until),
  lastErrorType: r.last_error_type,
  // A count from an earlier month reads as 0 until the next write resets it.
  usedMs: r.used_month === month() ? Number(r.used_ms) : 0,
  usedTotalMs: Number(r.used_total_ms),
  budgetMs: r.budget_ms === null ? null : Number(r.budget_ms),
  verifiedAt: r.verified_at === null ? null : Number(r.verified_at),
})

const rows = () => all<Row>(`select * from speech_keys where provider = 'speechmatics' order by position, created_at`)
const row = (id: string) => get<Row>('select * from speech_keys where id = ?', id)

export const listSpeechKeys = (): SpeechKey[] => rows().map(toKey)

function requireRow(id: string): Row {
  const r = row(id)
  if (!r) throw new AppError('That key was removed.', 'not_found')
  return r
}

function renumber() {
  rows().forEach((r, i) => run('update speech_keys set position = ? where id = ?', i + 1, r.id))
}

export async function addSpeechKey(key: string, label: string, budgetHours: number | null): Promise<SpeechKey> {
  if (rows().length >= MAX_SPEECH_KEYS) throw new AppError(`Up to ${MAX_SPEECH_KEYS} keys. Remove one first.`, 'validation', 'key')
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new AppError('Windows could not provide encryption for this key, so it was not saved.', 'encryption_unavailable')
  const ciphertext = await safeStorage.encryptStringAsync(key)
  for (const r of rows()) {
    if (r.last4 !== key.slice(-4)) continue
    const same = await decrypt(r).catch(() => null)
    if (same === key) throw new AppError('This key is already saved.', 'validation', 'key')
  }
  const id = uuid()
  const t = now()
  run(
    `insert into speech_keys (id, label, ciphertext, last4, position, used_month, budget_ms, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    label,
    ciphertext,
    key.slice(-4),
    rows().length + 1,
    month(),
    budgetHours === null ? null : Math.round(budgetHours * HOUR),
    t,
    t,
  )
  return toKey(requireRow(id))
}

export function updateSpeechKey(id: string, patch: { label?: string; budgetHours?: number | null }): SpeechKey {
  requireRow(id)
  if (patch.label !== undefined) run('update speech_keys set label = ?, updated_at = ? where id = ?', patch.label, now(), id)
  if (patch.budgetHours !== undefined) run('update speech_keys set budget_ms = ?, updated_at = ? where id = ?', patch.budgetHours === null ? null : Math.round(patch.budgetHours * HOUR), now(), id)
  return toKey(requireRow(id))
}

export function moveSpeechKey(id: string, by: -1 | 1): SpeechKey[] {
  tx(() => {
    const list = rows()
    const i = list.findIndex((r) => r.id === id)
    if (i < 0) throw new AppError('That key was removed.', 'not_found')
    const j = i + by
    if (j < 0 || j >= list.length) return
    run('update speech_keys set position = ? where id = ?', j + 1, list[i]!.id)
    run('update speech_keys set position = ? where id = ?', i + 1, list[j]!.id)
  })
  return listSpeechKeys()
}

export function removeSpeechKey(id: string) {
  tx(() => {
    run('delete from speech_keys where id = ?', id)
    renumber()
  })
}

async function decrypt(r: Row): Promise<string> {
  const { result } = await safeStorage.decryptStringAsync(Buffer.from(r.ciphertext))
  return result
}

/** Test a saved key without audio; also "Try again" for a used-up or rate-limited key. */
export async function testSpeechKey(id: string): Promise<{ ok: boolean; error?: string }> {
  const r = requireRow(id)
  const key = await decrypt(r).catch(() => null)
  if (!key) return { ok: false, error: 'This key was saved under another Windows account and can’t be read. Remove it and add it again.' }
  const t = await testSpeechmaticsKey(key, providerFetch, keyTestUrl())
  if (t.result === 'ok') {
    run(`update speech_keys set state = 'ok', state_until = null, last_error_type = null, verified_at = ?, updated_at = ? where id = ?`, now(), now(), id)
    return { ok: true }
  }
  if (t.result === 'auth') {
    run(`update speech_keys set state = 'auth_failed', state_until = null, updated_at = ? where id = ?`, now(), id)
    return { ok: false, error: `Speechmatics rejected this key (${t.status}). Check it was copied in full.` }
  }
  return { ok: false, error: t.status ? `Speechmatics didn't answer the test (${t.status}). Try again in a minute.` : 'No connection to Speechmatics.' }
}

const RATE_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000]

/** The pool's verdict after a call error (S4.2/S4.3). */
export function markSpeechKey(id: string, state: KeyMark, errorType: string | null) {
  const r = row(id)
  if (!r) return
  let until: number | null = null
  if (state === 'quota_exhausted') until = nextMonthStart()
  if (state === 'rate_limited') {
    // Back off further each time in a row the key is rate limited: the last wait, doubled.
    const prev = r.state === 'rate_limited' && r.state_until !== null ? Number(r.state_until) - Number(r.updated_at) : 0
    until = now() + (RATE_BACKOFF_MS.find((ms) => ms > prev) ?? RATE_BACKOFF_MS.at(-1)!)
  }
  const verified = state === 'ok' ? now() : r.verified_at
  run('update speech_keys set state = ?, state_until = ?, last_error_type = ?, verified_at = ?, updated_at = ? where id = ?', state, until, errorType, verified, now(), id)
}

export function addSpeechUsage(id: string, ms: number) {
  const m = month()
  run(
    `update speech_keys set used_ms = case when used_month = ? then used_ms + ? else ? end, used_month = ?, used_total_ms = used_total_ms + ?, updated_at = ? where id = ?`,
    m,
    ms,
    ms,
    m,
    ms,
    now(),
    id,
  )
}

/** Budget left in ms, or null when the user set no budget. */
export const budgetLeft = (k: SpeechKey) => (k.budgetMs === null ? null : Math.max(0, k.budgetMs - k.usedTotalMs))

/**
 * Keys a call may use now, in order (S4.2): ok or unchecked; rate-limited and used-up keys
 * once their wait is over. With `minLeftMs`, a key whose budget has less left is skipped
 * at session start, so it runs out between calls rather than during one.
 */
export async function usableSpeechKeys(minLeftMs = 0): Promise<PoolKey[]> {
  const t = now()
  const out: PoolKey[] = []
  for (const r of rows()) {
    const k = toKey(r)
    if (k.state === 'auth_failed') continue
    if ((k.state === 'rate_limited' || k.state === 'quota_exhausted') && (k.stateUntil ?? 0) > t) continue
    const left = budgetLeft(k)
    if (left !== null && left < minLeftMs) continue
    const key = await decrypt(r).catch(() => null)
    if (key) out.push({ id: k.id, slot: k.position, key })
  }
  return out
}

export const speechKeyLabel = (id: string) => row(id)?.label || null
