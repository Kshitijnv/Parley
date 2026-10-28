import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Provider } from '@shared/types'

// Development configuration. `.env.local` (next to package.json) is read only when the
// app is not packaged, so a provider key in that file is a convenience for working on
// the app, never something an installer ships. Packaged builds use the keys the user
// saves in Settings (encrypted with safeStorage).

const appRoot = join(import.meta.dirname, '../..')

function loadDotEnv(file: string) {
  if (!existsSync(file)) return
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const k = line.slice(0, eq).trim()
    let v = line.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (process.env[k] === undefined) process.env[k] = v
  }
}

export const isDev = !app.isPackaged
if (isDev) loadDotEnv(join(appRoot, '.env.local'))

/** PARLEY_MOCK=1: the renderer keeps its built-in mock data layer (demo mode, clearly labelled). */
export const mockMode = process.env['PARLEY_MOCK'] === '1'

const ENV_KEYS: Partial<Record<Provider, string[]>> = {
  google: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  groq: ['GROQ_API_KEY'],
  deepgram: ['DEEPGRAM_API_KEY'],
  logodev: ['LOGODEV_API_KEY'],
}

/** A provider key from the environment, development builds only. */
export function envKey(provider: Provider): string | null {
  if (!isDev || process.env['PARLEY_IGNORE_ENV_KEYS'] === '1') return null
  for (const name of ENV_KEYS[provider] ?? []) {
    const v = process.env[name]?.trim()
    if (v) return v
  }
  return null
}

/** Overrides the user data folder (tests use a throwaway folder). */
export function userDataOverride(): string | null {
  return process.env['PARLEY_USER_DATA'] || null
}
