// Speech model registry (architecture.md revision 2 §10): manifests (files, sizes,
// sha256, licence), install state in the stt_models table, explicit downloads only
// (never while a session is live), and selection of the model for a session's language.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SttModelInfo } from '@shared/types'
import { all, get, run } from '../db/client'
import { now } from '../db/repo'
import { AppError } from '../errors'
import { log } from '../log'
import { downloadFiles, hashesOk, modelsRoot, sizesOk, type ModelFile } from './models'

export interface Manifest {
  id: string
  language: 'en' | 'hi' | null
  engine: 'streaming_transducer' | 'offline_ctc' | 'vad'
  label: string
  licence: string
  attribution: string
  /** Folder name under models/ (kept from earlier installs, so nothing moves). */
  dir: string
  base: string
  files: { encoder: ModelFile; decoder: ModelFile; joiner: ModelFile; tokens: ModelFile }
  /** Hindi stays false until the §10 checks pass on real Hindi audio. */
  selectable: boolean
  note?: string
}

export const MANIFESTS: Manifest[] = [
  {
    id: 'en-kroko-2025-08-06',
    language: 'en',
    engine: 'streaming_transducer',
    label: 'English (Kroko ASR community model)',
    licence: 'CC-BY-SA 4.0',
    attribution: 'Kroko ASR English community model by Banafo (kroko.ai), CC-BY-SA 4.0, packaged for sherpa-onnx by k2-fsa.',
    dir: 'sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06',
    base: 'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06/resolve/main/',
    files: {
      encoder: { name: 'encoder.onnx', size: 70092599, sha256: 'd4881c57449d581e0770fd53fa66c2fdc6cd167d92ece7c715e603defc96d9d4' },
      decoder: { name: 'decoder.onnx', size: 617488, sha256: '455ba38466fce8d5a57e7db68a323b684079ca4d9e1dd93a740d9b2429aae3b1' },
      joiner: { name: 'joiner.onnx', size: 336817, sha256: 'd406f616736350e2a7df3e39398b78eb2fc1a2ca6973a19d3853fa3227e25b52' },
      tokens: { name: 'tokens.txt', size: 6310, sha256: '396dbeb5f4858875690716084f54e90d339679d0ba3e6b5b584f3d7589254d2d' },
    },
    selectable: true,
  },
  {
    id: 'en-zipformer-2023-06-26',
    language: 'en',
    engine: 'streaming_transducer',
    label: 'English (k2-fsa Zipformer 2023, Apache-2.0)',
    licence: 'Apache-2.0',
    attribution: 'k2-fsa streaming Zipformer English (2023-06-26, int8), Apache-2.0.',
    dir: 'sherpa-onnx-streaming-zipformer-en-2023-06-26-int8',
    base: 'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/resolve/main/',
    files: {
      encoder: { name: 'encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx', size: 71083163, sha256: '563fde436d16cf7607cf408cd6b30909819d03162652ef389c2450ced3f45ac1' },
      decoder: { name: 'decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx', size: 1307236, sha256: '98da299f471e38bb4e1a8df579b8cc9122d6039576a77e357b3c60f17dd83b02' },
      joiner: { name: 'joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx', size: 259335, sha256: 'd944208d660d67c8d72cd2acaeac971fa5ceb8c80e76c1968148846fedd6e297' },
      tokens: { name: 'tokens.txt', size: 5048, sha256: '49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb' },
    },
    selectable: true,
  },
]

const fileList = (m: Manifest) => Object.values(m.files)
const totalBytes = (m: Manifest) => fileList(m).reduce((n, f) => n + f.size, 0)
export const manifest = (id: string) => MANIFESTS.find((m) => m.id === id)
export const modelDirOf = (m: Manifest) => join(modelsRoot(), m.dir)
const marker = (m: Manifest) => join(modelDirOf(m), 'verified.json')

interface Row {
  id: string
  status: SttModelInfo['status']
  files_verified_at: number | null
  recognition_verified_at: number | null
  error: string | null
}

const rowOf = (id: string) => get<Row>('select id, status, files_verified_at, recognition_verified_at, error from stt_models where id = ?', id)

function setRow(id: string, patch: Partial<{ status: string; bytes_done: number; files_verified_at: number | null; error: string | null }>) {
  const keys = Object.keys(patch)
  run(`update stt_models set ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? where id = ?`, ...(Object.values(patch) as Array<string | number | null>), now(), id)
}

/** App start: one row per manifest; adopt installs from before the registry; fast size check. */
export function initRegistry() {
  const t = now()
  for (const m of MANIFESTS) {
    run(`insert or ignore into stt_models (id, language, engine, status, bytes_total, created_at, updated_at) values (?, ?, ?, 'absent', ?, ?, ?)`, m.id, m.language, m.engine, totalBytes(m), t, t)
    const r = rowOf(m.id)!
    const dir = modelDirOf(m)
    const hasMarker = existsSync(marker(m))
    if (r.status === 'downloading') setRow(m.id, { status: 'failed', error: 'The download was interrupted when the app closed.' })
    if (hasMarker && sizesOk(dir, fileList(m))) {
      if (r.status !== 'installed') {
        let at = t
        try {
          at = Number((JSON.parse(readFileSync(marker(m), 'utf8')) as { verifiedAt?: number }).verifiedAt) || t
        } catch {
          // marker without a time
        }
        setRow(m.id, { status: 'installed', files_verified_at: at, error: null, bytes_done: totalBytes(m) })
        log('stt_model_adopted', { sttModelId: m.id })
      }
    } else if (r.status === 'installed') {
      setRow(m.id, existsSync(dir) ? { status: 'corrupt', error: 'Model files are missing or the wrong size. Reinstall it.' } : { status: 'absent', files_verified_at: null, error: null, bytes_done: 0 })
    }
  }
}

export function listModels(): SttModelInfo[] {
  return MANIFESTS.map((m) => {
    const r = rowOf(m.id)
    return {
      id: m.id,
      language: m.language,
      label: m.label,
      sizeMb: Math.round(totalBytes(m) / 1_000_000),
      licence: m.licence,
      attribution: m.attribution,
      status: r?.status ?? 'absent',
      selectable: m.selectable,
      note: m.note,
      filesVerifiedAt: r?.files_verified_at ?? null,
      recognitionVerifiedAt: r?.recognition_verified_at ?? null,
      error: r?.error ?? null,
    }
  })
}

const installed = (id: string) => rowOf(id)?.status === 'installed'

const ENV_PICK: Record<string, string> = { kroko: 'en-kroko-2025-08-06', 'zipformer-2023': 'en-zipformer-2023-06-26' }

/** The model a session in `language` (e.g. 'en-US') uses; null if none is installed. */
export function modelForLanguage(language: string): Manifest | null {
  const lang = language.toLowerCase().startsWith('hi') ? 'hi' : language.toLowerCase().startsWith('en') ? 'en' : null
  if (!lang) return null
  const preferred = lang === 'en' ? (ENV_PICK[process.env['PARLEY_STT_MODEL'] ?? ''] ?? 'en-kroko-2025-08-06') : null
  const pool = MANIFESTS.filter((m) => m.language === lang && m.selectable && installed(m.id))
  return pool.find((m) => m.id === preferred) ?? pool[0] ?? null
}

/** Whether any selectable model for the language exists in the registry (installed or not). */
export function languageSupported(language: string): boolean {
  const lang = language.toLowerCase().startsWith('hi') ? 'hi' : language.toLowerCase().startsWith('en') ? 'en' : null
  return !!lang && MANIFESTS.some((m) => m.language === lang && m.selectable)
}

export function filesOf(m: Manifest): Record<keyof Manifest['files'], string> {
  const dir = modelDirOf(m)
  return { encoder: join(dir, m.files.encoder.name), decoder: join(dir, m.files.decoder.name), joiner: join(dir, m.files.joiner.name), tokens: join(dir, m.files.tokens.name) }
}

// ---------- install, cancel, delete, verify ----------

const downloads = new Map<string, AbortController>()

export async function installModel(id: string, onProgress: (p: { modelId: string; stage: 'downloading' | 'verifying' | 'installed' | 'failed'; bytes: number; total: number; pct: number }) => void): Promise<{ ok: boolean; error?: string }> {
  const m = manifest(id)
  if (!m) throw new AppError('Unknown speech model.', 'not_found')
  if (installed(id)) {
    onProgress({ modelId: id, stage: 'installed', bytes: totalBytes(m), total: totalBytes(m), pct: 100 })
    return { ok: true }
  }
  if (downloads.has(id)) throw new AppError('This model is already downloading.', 'conflict')
  const ctrl = new AbortController()
  downloads.set(id, ctrl)
  setRow(id, { status: 'downloading', error: null, bytes_done: 0 })
  let last = -1
  try {
    await downloadFiles(modelDirOf(m), m.base, fileList(m), ctrl.signal, (done, total) => {
      const pct = Math.floor((done / total) * 100)
      if (pct !== last) {
        last = pct
        onProgress({ modelId: id, stage: 'downloading', bytes: done, total, pct })
        if (pct % 5 === 0) setRow(id, { bytes_done: done })
      }
    })
    onProgress({ modelId: id, stage: 'verifying', bytes: totalBytes(m), total: totalBytes(m), pct: 100 })
    const t = now()
    writeFileSync(marker(m), JSON.stringify({ id: m.dir, modelId: m.id, verifiedAt: t }))
    setRow(id, { status: 'installed', files_verified_at: t, bytes_done: totalBytes(m), error: null })
    onProgress({ modelId: id, stage: 'installed', bytes: totalBytes(m), total: totalBytes(m), pct: 100 })
    log('stt_model_installed', { sttModelId: id, bytes: totalBytes(m) })
    return { ok: true }
  } catch (e) {
    const msg = (e as Error).message
    const error = msg === 'cancelled' ? 'Download cancelled.' : /sha256/.test(msg) ? 'The downloaded file was damaged (checksum mismatch). Try again.' : 'Download interrupted. Check your connection and try again.'
    setRow(id, { status: msg === 'cancelled' ? 'absent' : 'failed', error: msg === 'cancelled' ? null : error })
    onProgress({ modelId: id, stage: 'failed', bytes: 0, total: totalBytes(m), pct: 0 })
    log('stt_model_install_failed', { sttModelId: id, reason: msg === 'cancelled' ? 'cancelled' : /sha256/.test(msg) ? 'checksum' : 'network' })
    return { ok: false, error }
  } finally {
    downloads.delete(id)
  }
}

export function cancelInstall(id: string) {
  downloads.get(id)?.abort()
}

export function deleteModel(id: string) {
  const m = manifest(id)
  if (!m) throw new AppError('Unknown speech model.', 'not_found')
  if (downloads.has(id)) throw new AppError('Cancel the download first.', 'conflict')
  rmSync(modelDirOf(m), { recursive: true, force: true })
  setRow(id, { status: 'absent', files_verified_at: null, bytes_done: 0, error: null })
}

export async function verifyModel(id: string): Promise<{ ok: boolean; error?: string }> {
  const m = manifest(id)
  if (!m) throw new AppError('Unknown speech model.', 'not_found')
  const ok = await hashesOk(modelDirOf(m), fileList(m))
  if (ok) {
    const t = now()
    writeFileSync(marker(m), JSON.stringify({ id: m.dir, modelId: m.id, verifiedAt: t }))
    setRow(id, { status: 'installed', files_verified_at: t, error: null })
    return { ok: true }
  }
  setRow(id, { status: 'corrupt', error: 'Files failed the checksum. Reinstall the model.' })
  return { ok: false, error: 'Files failed the checksum. Reinstall the model.' }
}

/** A load failure in the worker marks the model corrupt (English sessions aren't affected by Hindi). */
export function markCorrupt(id: string) {
  if (manifest(id)) setRow(id, { status: 'corrupt', error: 'The model failed to load. Verify or reinstall it.' })
}

export const installedModelIds = () => all<{ id: string }>(`select id from stt_models where status = 'installed'`).map((r) => r.id)
