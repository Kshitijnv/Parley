import { safeStorage } from 'electron'
import type { KeyStatus, Provider } from '@shared/types'
import { all, get, run } from './db/client'
import { now } from './db/repo'
import { envKey } from './env'
import { AppError } from './errors'

// Provider API keys. Encrypted with safeStorage (Windows DPAPI: tied to this Windows
// user account) before they touch the database, decrypted only in main when a request
// is made, and never sent to a renderer. keys:status returns the last 4 characters only.

const PROVIDERS: Provider[] = ['google', 'openai', 'anthropic', 'groq', 'deepgram', 'logodev']
const cache = new Map<Provider, string>()

export async function setKey(provider: Provider, key: string): Promise<{ last4: string }> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new AppError('Windows could not provide encryption for this key, so it was not saved.', 'encryption_unavailable')
  }
  const ciphertext = await safeStorage.encryptStringAsync(key)
  const last4 = key.slice(-4)
  const t = now()
  run(
    `insert into secrets (provider, ciphertext, last4, verified_at, created_at, updated_at) values (?, ?, ?, null, ?, ?)
     on conflict (provider) do update set ciphertext = excluded.ciphertext, last4 = excluded.last4, verified_at = null, updated_at = excluded.updated_at`,
    provider,
    ciphertext,
    last4,
    t,
    t,
  )
  cache.set(provider, key)
  return { last4 }
}

export function deleteKey(provider: Provider) {
  run('delete from secrets where provider = ?', provider)
  cache.delete(provider)
}

export function markVerified(provider: Provider) {
  run('update secrets set verified_at = ?, updated_at = ? where provider = ?', now(), now(), provider)
}

/** The plain key, from Settings or (development builds only) the environment. */
export async function getKey(provider: Provider): Promise<string | null> {
  const hit = cache.get(provider)
  if (hit) return hit
  const row = get<{ ciphertext: Uint8Array }>('select ciphertext from secrets where provider = ?', provider)
  if (row) {
    try {
      const { result } = await safeStorage.decryptStringAsync(Buffer.from(row.ciphertext))
      cache.set(provider, result)
      return result
    } catch {
      // Encrypted under another Windows account or a reset profile: the key can't be recovered.
      return null
    }
  }
  return envKey(provider)
}

export function hasKey(provider: Provider): boolean {
  return cache.has(provider) || !!get('select 1 as x from secrets where provider = ?', provider) || !!envKey(provider)
}

export function keyStatus(): KeyStatus[] {
  const saved = all<{ provider: Provider; last4: string; verified_at: number | null }>('select provider, last4, verified_at from secrets')
  const out: KeyStatus[] = saved.map((r) => ({ provider: r.provider, last4: r.last4, verifiedAt: r.verified_at === null ? null : Number(r.verified_at), source: 'saved' }))
  for (const p of PROVIDERS) {
    if (out.some((k) => k.provider === p)) continue
    const k = envKey(p)
    if (k) out.push({ provider: p, last4: k.slice(-4), verifiedAt: null, source: 'env' })
  }
  return out
}

export function providersWithKeys(): Set<Provider> {
  return new Set(keyStatus().map((k) => k.provider))
}
