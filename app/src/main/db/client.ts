import { copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { log } from '../log'
import { paths } from '../paths'
import m0000 from './migrations/0000_init.sql?raw'
import m0001 from './migrations/0001_live_since.sql?raw'
import m0002 from './migrations/0002_live_pipeline.sql?raw'
import m0003 from './migrations/0003_answer_routing.sql?raw'
import m0004 from './migrations/0004_cloud_stt.sql?raw'

// One SQLite file in %APPDATA%\<app>\data\app.db, opened only by the main process.
// node:sqlite ships with Electron's Node, so there is no native module to rebuild.

const MIGRATIONS = [m0000, m0001, m0002, m0003, m0004]

let db: DatabaseSync | null = null

export type Row = Record<string, SQLInputValue>

export function openDb(file = paths.db()): DatabaseSync {
  if (db) return db
  const isNew = !existsSync(file)
  let conn: DatabaseSync
  try {
    conn = new DatabaseSync(file)
    conn.exec('pragma foreign_keys = on; pragma journal_mode = wal; pragma synchronous = normal; pragma busy_timeout = 3000;')
    conn.prepare('pragma quick_check').get()
  } catch (e) {
    if (isNew) throw e
    // A corrupt file: keep it for inspection and start fresh rather than refusing to open.
    const aside = `${file}.corrupt-${Date.now()}`
    log('db_moved_aside', { errorName: (e as Error).name })
    copyFileSync(file, aside)
    for (const ext of ['', '-wal', '-shm']) rmSync(`${file}${ext}`, { force: true })
    conn = new DatabaseSync(file)
    conn.exec('pragma foreign_keys = on; pragma journal_mode = wal; pragma synchronous = normal; pragma busy_timeout = 3000;')
  }
  migrate(conn)
  db = conn
  return conn
}

function migrate(conn: DatabaseSync) {
  const current = Number((conn.prepare('pragma user_version').get() as { user_version: number }).user_version)
  if (current > MIGRATIONS.length) {
    throw new Error(`This database was written by a newer version of the app (schema ${current}). Update the app to open it.`)
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v]!.replace(/^﻿/, '')
    conn.exec('begin')
    try {
      conn.exec(sql)
      conn.exec(`pragma user_version = ${v + 1}`)
      conn.exec('commit')
    } catch (e) {
      conn.exec('rollback')
      throw new Error(`Database migration ${v} failed: ${(e as Error).message}`)
    }
  }
}

export function getDb(): DatabaseSync {
  return db ?? openDb()
}

export function closeDb() {
  db?.close()
  db = null
}

export function tx<T>(fn: () => T): T {
  const conn = getDb()
  conn.exec('begin immediate')
  try {
    const out = fn()
    conn.exec('commit')
    return out
  } catch (e) {
    conn.exec('rollback')
    throw e
  }
}

export const all = <T>(sql: string, ...params: SQLInputValue[]) => getDb().prepare(sql).all(...params) as T[]
export const get = <T>(sql: string, ...params: SQLInputValue[]) => getDb().prepare(sql).get(...params) as T | undefined
export const run = (sql: string, ...params: SQLInputValue[]) => getDb().prepare(sql).run(...params)

/** Daily VACUUM INTO backup, keeping the newest 7 (architecture.md "Jobs"). */
export function backup(): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const target = join(paths.backups(), `app-${day}.db`)
  rmSync(target, { force: true })
  getDb().prepare('vacuum into ?').run(target)
  const old = readdirSync(paths.backups())
    .filter((f) => /^app-\d{8}\.db$/.test(f))
    .sort()
    .reverse()
    .slice(7)
  for (const f of old) rmSync(join(paths.backups(), f), { force: true })
  return target
}
