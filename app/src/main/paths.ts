import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

const root = () => app.getPath('userData')

export const paths = {
  data: () => join(root(), 'data'),
  db: () => join(root(), 'data', 'app.db'),
  backups: () => join(root(), 'backups'),
  files: () => join(root(), 'files'),
  models: () => join(root(), 'models'),
}

export function ensureDirs() {
  for (const d of [paths.data(), paths.backups(), paths.models(), join(paths.files(), 'resumes'), join(paths.files(), 'documents'), join(paths.files(), 'screenshots')]) {
    mkdirSync(d, { recursive: true })
  }
}

/** Absolute path of a stored file, or null if the relative path escapes the files folder. */
export function filePath(rel: string): string | null {
  const base = paths.files()
  const abs = resolve(base, rel)
  const r = relative(base, abs)
  if (!r || r.startsWith('..') || isAbsolute(r)) return null
  return abs
}
