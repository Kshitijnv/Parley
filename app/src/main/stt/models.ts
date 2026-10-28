// Download and verification mechanics for speech model files: streamed download to
// "<file>.part", sha256 while streaming, then rename. Files that are already present
// and verified are kept, so an interrupted install only re-fetches what's missing.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from '../paths'

export interface ModelFile {
  name: string
  size: number
  sha256: string
  /** Defaults to the manifest's base URL + name. */
  url?: string
}

export const modelsRoot = () => process.env['PARLEY_STT_MODEL_DIR'] || paths.models()

export function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(p)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

export function sizesOk(dir: string, files: ModelFile[]): boolean {
  return files.every((f) => {
    const p = join(dir, f.name)
    return existsSync(p) && statSync(p).size === f.size
  })
}

/** Full sha256 re-check of every file. */
export async function hashesOk(dir: string, files: ModelFile[]): Promise<boolean> {
  for (const f of files) {
    const p = join(dir, f.name)
    if (!existsSync(p) || statSync(p).size !== f.size || (await sha256File(p)) !== f.sha256) return false
  }
  return true
}

export async function downloadFiles(dir: string, base: string, files: ModelFile[], signal: AbortSignal, onBytes: (done: number, total: number) => void) {
  mkdirSync(dir, { recursive: true })
  const total = files.reduce((n, f) => n + f.size, 0)
  let done = 0
  for (const f of files) {
    const target = join(dir, f.name)
    if (existsSync(target) && statSync(target).size === f.size && (await sha256File(target)) === f.sha256) {
      done += f.size
      onBytes(done, total)
      continue
    }
    await fetchFile(f.url ?? base + f.name, `${target}.part`, f.sha256, signal, (n) => onBytes(done + n, total))
    renameSync(`${target}.part`, target)
    done += f.size
    onBytes(done, total)
  }
}

async function fetchFile(url: string, dest: string, sha: string, outer: AbortSignal, onBytes: (n: number) => void) {
  const ctrl = new AbortController()
  const abort = () => ctrl.abort()
  outer.addEventListener('abort', abort, { once: true })
  let stall = setTimeout(abort, 30_000)
  let res: Response
  try {
    res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' })
  } catch (e) {
    clearTimeout(stall)
    throw new Error(outer.aborted ? 'cancelled' : (e as Error).message)
  }
  if (!res.ok || !res.body) {
    clearTimeout(stall)
    throw new Error(`HTTP ${res.status}`)
  }
  const hash = createHash('sha256')
  const out = createWriteStream(dest)
  let n = 0
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      clearTimeout(stall)
      stall = setTimeout(abort, 30_000)
      hash.update(chunk)
      n += chunk.length
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
      onBytes(n)
    }
  } catch (e) {
    out.destroy()
    rmSync(dest, { force: true })
    throw new Error(outer.aborted ? 'cancelled' : ctrl.signal.aborted ? 'stalled for 30 s' : (e as Error).message)
  } finally {
    clearTimeout(stall)
    outer.removeEventListener('abort', abort)
  }
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
  if (hash.digest('hex') !== sha) {
    rmSync(dest, { force: true })
    throw new Error('sha256 mismatch')
  }
}
