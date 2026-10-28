// keys:test: one tiny real request per provider (a model list where one exists, so it
// costs no tokens). Only the status code is reported back, never the key.
import type { Provider } from '@shared/types'
import { getKey } from '../secrets'
import { providerLabel } from './providers'

const CHECKS: Record<Provider, (key: string) => { url: string; headers: Record<string, string> }> = {
  google: (k) => ({ url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', headers: { 'x-goog-api-key': k } }),
  openai: (k) => ({ url: 'https://api.openai.com/v1/models', headers: { authorization: `Bearer ${k}` } }),
  anthropic: (k) => ({ url: 'https://api.anthropic.com/v1/models?limit=1', headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' } }),
  groq: (k) => ({ url: 'https://api.groq.com/openai/v1/models', headers: { authorization: `Bearer ${k}` } }),
  deepgram: (k) => ({ url: 'https://api.deepgram.com/v1/projects', headers: { authorization: `Token ${k}` } }),
  logodev: (k) => ({ url: `https://img.logo.dev/example.com?token=${encodeURIComponent(k)}&size=16`, headers: {} }),
}

export async function testKey(provider: Provider): Promise<{ ok: boolean; error?: string }> {
  const key = await getKey(provider)
  if (!key) return { ok: false, error: 'No key saved for this provider.' }
  const { url, headers } = CHECKS[provider](key)
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 12_000)
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal })
    if (res.ok) return { ok: true }
    if (res.status === 401 || res.status === 403 || res.status === 400) return { ok: false, error: `${providerLabel(provider)} rejected this key (${res.status}). Check it was copied in full.` }
    if (res.status === 429) return { ok: false, error: `${providerLabel(provider)} accepted the request but is rate limiting this key right now (429).` }
    return { ok: false, error: `${providerLabel(provider)} returned an error (${res.status}). Try again later.` }
  } catch {
    return { ok: false, error: ctrl.signal.aborted ? `${providerLabel(provider)} did not answer within 12 seconds.` : 'No connection.' }
  } finally {
    clearTimeout(t)
  }
}
