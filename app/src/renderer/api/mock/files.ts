// Stand-in for %APPDATA%\<app>\files: blobs in IndexedDB keyed by relative path.
const DB = 'parley-files'
const STORE = 'files'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export const fileStore = {
  put: (path: string, blob: Blob) => tx('readwrite', (s) => s.put(blob, path)),
  get: (path: string) => tx<Blob | undefined>('readonly', (s) => s.get(path)),
  delete: (path: string) => tx('readwrite', (s) => s.delete(path)),
}

const urlCache = new Map<string, string>()
export async function fileUrl(path: string | null): Promise<string | null> {
  if (!path) return null
  const hit = urlCache.get(path)
  if (hit) return hit
  const blob = await fileStore.get(path).catch(() => undefined)
  if (!blob) return null
  const url = URL.createObjectURL(blob)
  urlCache.set(path, url)
  return url
}

// Files the user picked or dropped, waiting for importFile. The real preload
// returns a filesystem path; the mock returns a token that maps to the File.
const picked = new Map<string, File>()

export function registerPicked(file: File): string {
  const token = `picked://${crypto.randomUUID()}/${file.name}`
  picked.set(token, file)
  return token
}

export function takePicked(token: string): File | undefined {
  return picked.get(token)
}

export function pickWithInput(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.style.display = 'none'
    let settled = false
    input.addEventListener('change', () => {
      settled = true
      resolve(input.files?.[0] ?? null)
      input.remove()
    })
    input.addEventListener('cancel', () => {
      if (!settled) resolve(null)
      input.remove()
    })
    document.body.appendChild(input)
    input.click()
  })
}

export async function sha256(data: ArrayBuffer | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
