// The mock "database": one JSON document in localStorage, shared by every window of
// the same origin. Each write re-reads first, so two windows don't clobber each other.
import type {
  Answer,
  DocumentFile,
  KeyStatus,
  Notes,
  Resume,
  ReviewMessage,
  Segment,
  Session,
  Settings,
} from '@shared/types'
import { emitLocal } from './bus'
import { emptyDb, seedDb } from './seed'

export type SessionRow = Omit<Session, 'resumeTitle'>
export type ResumeRowStored = Omit<Resume, 'fileUrl' | 'duplicateOf'>
export type DocumentStored = Omit<DocumentFile, 'fileUrl' | 'duplicateOf'>

export interface Db {
  version: 1
  settings: Settings
  keys: KeyStatus[]
  sttModelReady: boolean
  resumes: ResumeRowStored[]
  documents: DocumentStored[]
  sessions: SessionRow[]
  segments: Segment[]
  answers: Answer[]
  notes: Notes[]
  review: ReviewMessage[]
}

const KEY = 'parley:db:v1'

export function scenario(): string {
  try {
    const q = new URLSearchParams(location.search).get('mock')
    if (q) localStorage.setItem('parley:mock', q)
    return localStorage.getItem('parley:mock') ?? ''
  } catch {
    return ''
  }
}

export function hasScenario(name: string): boolean {
  return scenario().split(',').includes(name)
}

let cacheRaw: string | null = null
let cache: Db | null = null

function fresh(): Db {
  return hasScenario('empty') ? emptyDb() : seedDb()
}

export function load(): Db {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    // storage blocked: keep an in-memory db for this window
  }
  if (raw && raw === cacheRaw && cache) return cache
  if (!raw) {
    if (cache && cacheRaw === null) return cache
    const db = fresh()
    save(db)
    return db
  }
  try {
    const db = JSON.parse(raw) as Db
    if (db.version !== 1) throw new Error('old version')
    cacheRaw = raw
    cache = db
    return db
  } catch {
    const db = fresh()
    save(db)
    return db
  }
}

export function save(db: Db) {
  const raw = JSON.stringify(db)
  cache = db
  try {
    localStorage.setItem(KEY, raw)
    cacheRaw = raw
  } catch {
    cacheRaw = null
  }
}

export function mutate<T>(fn: (db: Db) => T): T {
  const db = structuredClone(load())
  const out = fn(db)
  save(db)
  return out
}

export function resetDb(kind: 'seed' | 'empty' = 'seed') {
  save(kind === 'seed' ? seedDb() : emptyDb())
}

// Another window wrote: tell this window's screens to refetch.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return
    emitLocal('data:changed', { area: 'sessions' })
    emitLocal('data:changed', { area: 'resumes' })
    emitLocal('data:changed', { area: 'documents' })
    emitLocal('data:changed', { area: 'settings' })
    emitLocal('data:changed', { area: 'keys' })
    emitLocal('data:changed', { area: 'notes' })
    emitLocal('data:changed', { area: 'transcript' })
  })
}

export const now = () => Date.now()
export const uuid = () => crypto.randomUUID()
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class ApiError extends Error {
  constructor(
    message: string,
    public code: string = 'bad_request',
    public field?: string,
  ) {
    super(message)
  }
}
