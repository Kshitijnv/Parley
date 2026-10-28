// Stored files (%APPDATA%\<app>\files\{resumes,documents,screenshots}), the app-file://
// protocol that serves them, and the file allow-list: main only reads a file the user
// picked in the native dialog or dragged onto a window, never an arbitrary path a
// renderer sends.
import { BrowserWindow, dialog, net, protocol } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PickedFile } from '@shared/types'
import { all } from './db/client'
import { isDev } from './env'
import { AppError } from './errors'
import { filePath, paths } from './paths'

const allowed = new Map<string, number>()
const TTL = 30 * 60_000

export function allowPath(p: string) {
  if (p) allowed.set(resolve(p), Date.now() + TTL)
}

function isAllowed(p: string) {
  const exp = allowed.get(resolve(p))
  if (exp && exp > Date.now()) return true
  // Automated tests can't use the native picker; development builds only.
  const testDir = isDev ? process.env['PARLEY_TEST_ALLOW_DIR'] : undefined
  if (!testDir) return false
  const rel = relative(resolve(testDir), resolve(p))
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

export async function pickFile(win: BrowserWindow | null, kind: 'resume' | 'document'): Promise<PickedFile | null> {
  const filters = kind === 'resume' ? [{ name: 'PDF', extensions: ['pdf'] }] : [{ name: 'PDF, text or Markdown', extensions: ['pdf', 'txt', 'md'] }]
  const opts = { properties: ['openFile' as const], filters }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  const p = r.filePaths[0]
  if (r.canceled || !p) return null
  allowPath(p)
  return { path: p, name: basename(p), size: statSync(p).size }
}

/** Read a picked file, enforcing the allow-list and the size cap. */
export function readPicked(p: string, maxBytes: number): { buf: Buffer; name: string; size: number } {
  if (!isAllowed(p)) throw new AppError('That file is no longer available. Pick it again.', 'not_found')
  if (!existsSync(p)) throw new AppError('That file was moved or deleted. Pick it again.', 'not_found')
  const size = statSync(p).size
  if (size === 0) throw new AppError('That file is empty.', 'validation', 'file')
  if (size > maxBytes) throw new AppError(`That file is over ${Math.round(maxBytes / 1024 / 1024)} MB. Export a smaller file and try again.`, 'validation', 'file')
  return { buf: readFileSync(p), name: basename(p), size }
}

export const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

export function store(rel: string, buf: Buffer) {
  const abs = filePath(rel)
  if (!abs) throw new AppError('Invalid file path.', 'validation')
  writeFileSync(abs, buf)
}

export function readStored(rel: string): Buffer | null {
  const abs = filePath(rel)
  return abs && existsSync(abs) ? readFileSync(abs) : null
}

export function removeStored(rel: string | null) {
  if (!rel) return
  const abs = filePath(rel)
  if (abs) rmSync(abs, { force: true })
}

/** Local PDF text (pdf.js via unpdf): the fallback when there's no AI key or no connection. */
export async function pdfText(buf: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(buf))
  const { text } = await extractText(pdf, { mergePages: true })
  return (Array.isArray(text) ? text.join('\n\n') : text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export const APP_FILE_SCHEME = { scheme: 'app-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }

export function registerFileProtocol() {
  protocol.handle('app-file', (req) => {
    const url = new URL(req.url)
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const abs = url.host === 'files' ? filePath(rel) : null
    if (!abs || !existsSync(abs)) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(abs).toString())
  })
}

/** Delete files no row points at (architecture.md "file cleanup" job). */
export function cleanupFiles(): number {
  const keep = new Set(
    all<{ p: string }>(
      `select file_path as p from resumes where file_path is not null
       union select file_path from documents where file_path is not null
       union select screenshot_path from answers where screenshot_path is not null`,
    ).map((r) => r.p.replace(/\\/g, '/')),
  )
  let removed = 0
  for (const dir of ['resumes', 'documents', 'screenshots']) {
    const abs = join(paths.files(), dir)
    if (!existsSync(abs)) continue
    for (const f of readdirSync(abs)) {
      const rel = `${dir}/${f}`
      if (keep.has(rel)) continue
      // Leave anything written in the last hour alone: it may belong to an import in progress.
      if (Date.now() - statSync(join(abs, f)).mtimeMs < 60 * 60_000) continue
      rmSync(join(abs, f), { force: true })
      removed++
    }
  }
  return removed
}
