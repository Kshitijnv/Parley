// IPC handlers for the data layer (architecture.md "API"). Every channel checks the
// sender is one of this app's own top-level pages, validates its input with the zod
// schema from src/shared/ipc.ts, and answers { ok, value } or { ok: false, error } so
// the renderer gets the user-facing message instead of Electron's wrapped error text.
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LANGUAGES, MODEL_CATALOG } from '@shared/catalog'
import { searchCompanies } from '@shared/companies'
import { LIMITS, schemas, type Channel } from '@shared/ipc'
import type { CompanyHit, DocumentFile, Resume, Session, TimelineItem } from '@shared/types'
import { all, get, run, tx } from './db/client'
import {
  answersFor,
  documentOut,
  documentRows,
  findDocument,
  findResume,
  getAnswer,
  getSettings,
  notesFor,
  now,
  patchSettings,
  requireResume,
  requireSession,
  resumeOut,
  resumeRows,
  reviewFor,
  segmentsFor,
  sessionCards,
  sessionOut,
  uuid,
} from './db/repo'
import { changed, emit } from './events'
import { AppError, toWire } from './errors'
import { allowPath, pdfText, pickFile, readPicked, removeStored, sha256, store } from './files'
import { cancelAnswer, cancelSessionAnswers, liveTextOf } from './ai/engine'
import { closeGate, gateStatus, openGate, submitManual } from './ai/gate'
import { askReview, convertResume, importJob, nextInterviewQuestion, parseResume, preview, queueNotes } from './ai/content'
import { clearAuth } from './ai/health'
import { testKey } from './ai/keytest'
import { modelProviders } from './ai/providers'
import { clearLive, feedAudio, injectThem, liveLines, liveSessionId, loadedModelIds, prepareStt, startLive, stopLive, sttStatus } from './live'
import { deleteKey, getKey, keyStatus, markVerified, setKey } from './secrets'
import { cancelInstall, deleteModel, installModel, languageSupported, listModels, manifest, modelForLanguage, verifyModel } from './stt/registry'
import { setPrivate } from './windows'

const rendererUrl = () => process.env['ELECTRON_RENDERER_URL'] ?? pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href

function trusted(e: { senderFrame: Electron.WebFrameMain | null }): boolean {
  const f = e.senderFrame
  if (!f || f.parent) return false
  const base = rendererUrl().split('#')[0]!.split('?')[0]!
  return f.url.split('#')[0]!.split('?')[0] === base || f.url.startsWith(base)
}

type Handler = (input: any, e: IpcMainInvokeEvent) => unknown

function handle(channel: string, fn: Handler) {
  const schema = (schemas as Record<string, { parse(v: unknown): unknown }>)[channel as Channel]
  ipcMain.handle(channel, async (e, input) => {
    if (!trusted(e)) return { ok: false, error: { message: 'Not allowed.', code: 'forbidden' } }
    try {
      const value = await fn(schema ? schema.parse(input ?? {}) : input, e)
      return { ok: true, value }
    } catch (err) {
      return { ok: false, error: toWire(err) }
    }
  })
}

const winOf = (e: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender)
/** A language can be picked when the catalog lists it for local STT and a selectable model exists. */
const localLanguage = (code: string) => (LANGUAGES.find((l) => l.code === code)?.stt.includes('local') ?? false) && languageSupported(code)
const anyLive = () => !!get(`select 1 as x from sessions where status = 'live'`) || !!liveSessionId()

// ---------- session helpers ----------

function setSessionDocuments(sessionId: string, ids: string[]) {
  run('delete from session_documents where session_id = ?', sessionId)
  const t = now()
  for (const d of ids) if (findDocument(d)) run('insert or ignore into session_documents (session_id, document_id, created_at) values (?, ?, ?)', sessionId, d, t)
}

const SESSION_COLUMNS: Record<string, [string, (v: any) => string | number | null]> = {
  type: ['type', String],
  companyName: ['company_name', (v) => (v ? String(v) : null)],
  companyDomain: ['company_domain', (v) => (v ? String(v) : null)],
  roleTitle: ['role_title', (v) => (v ? String(v) : null)],
  jobUrl: ['job_url', (v) => (v ? String(v) : null)],
  jobDescription: ['job_description', String],
  resumeId: ['resume_id', (v) => (v ? String(v) : null)],
  language: ['language', String],
  model: ['model', String],
  answerPrefs: ['answer_prefs', (v) => JSON.stringify(v)],
  instructions: ['instructions', String],
  autoGenerate: ['auto_generate', (v) => (v ? 1 : 0)],
  saveTranscript: ['save_transcript', (v) => (v ? 1 : 0)],
}

function checkModel(id: string) {
  if (!MODEL_CATALOG.some((m) => m.id === id) && !process.env['PARLEY_MODEL_MAP']?.includes(id)) throw new AppError('Pick a model from the list.', 'validation', 'model')
}

async function startSession(id: string): Promise<Session> {
  const s = requireSession(id)
  if (s.status === 'ended') throw new AppError('This call has ended. Create a new session to start another.', 'conflict')
  if (!localLanguage(s.language)) throw new AppError('This language isn\'t available for transcription yet. Change the language in step 2.', 'validation', 'language')
  // The session's model must be installed: no download here and no silent fallback (§10).
  if (!modelForLanguage(s.language)) throw new AppError('Install the English speech model first (Settings › Speech models).', 'stt_model_missing', 'language')
  const other = get<{ id: string; company_name: string | null }>(`select id, company_name from sessions where status = 'live' and id <> ?`, id)
  if (other) throw new AppError(`Another call (${other.company_name ?? 'untitled'}) is still live. End it first.`, 'conflict')
  const t = now()
  const wasLive = s.status === 'live' && liveSessionId() === id
  if (s.status !== 'live') run(`update sessions set status = 'live', started_at = coalesce(started_at, ?), live_since = ?, updated_at = ? where id = ?`, t, t, t, id)
  try {
    // Waits for the worker's ready{modelId, language}: answers can't start before transcription.
    await startLive(id)
  } catch (e) {
    if (s.status !== 'live') run(`update sessions set status = ?, live_since = null, updated_at = ? where id = ?`, s.status, now(), id)
    changed('sessions')
    throw e
  }
  if (!wasLive) openGate(id)
  changed('sessions')
  return sessionOut(requireSession(id))
}

async function endSession(id: string, mode: 'leave' | 'end'): Promise<Session> {
  const s = requireSession(id)
  cancelSessionAnswers(id, 'session_end')
  closeGate(id)
  await stopLive(id)
  const t = now()
  const add = s.status === 'live' && s.liveSince ? Math.max(0, t - s.liveSince) : 0
  if (mode === 'end') {
    run(`update sessions set status = 'ended', ended_at = ?, active_ms = active_ms + ?, live_since = null, updated_at = ? where id = ?`, t, add, t, id)
  } else if (s.status !== 'ended') {
    run(`update sessions set status = 'left', active_ms = active_ms + ?, live_since = null, updated_at = ? where id = ?`, add, t, id)
  }
  changed('sessions')
  if (mode === 'end' && s.saveTranscript && get('select 1 as x from transcript_segments where session_id = ? limit 1', id)) queueNotes(id)
  return sessionOut(requireSession(id))
}

// ---------- export ----------

function exportText(sessionId: string, format: 'md' | 'txt'): { name: string; text: string } {
  const s = requireSession(sessionId)
  const items = timeline(sessionId)
  const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const title = `${s.companyName ?? 'Call'}${s.roleTitle ? ` – ${s.roleTitle}` : ''}`
  const when = new Date(s.startedAt ?? s.createdAt).toLocaleString()
  const lines = format === 'md' ? [`# ${title}`, '', when, ''] : [title, when, '']
  for (const it of items) {
    if (it.kind === 'segment') {
      const who = it.segment.speaker === 'you' ? 'You' : 'Them'
      lines.push(format === 'md' ? `**${who}** · ${time(it.at)}  \n${it.segment.text}` : `[${time(it.at)}] ${who}: ${it.segment.text}`, '')
    } else {
      lines.push(
        format === 'md'
          ? `> **Question:** ${it.answer.question ?? ''}\n>\n${it.answer.answerMd.split('\n').map((l) => `> ${l}`).join('\n')}`
          : `Question: ${it.answer.question ?? ''}\nAnswer:\n${it.answer.answerMd}`,
        '',
      )
    }
  }
  const name = `${title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'transcript'}.${format}`
  return { name, text: lines.join('\n') }
}

function timeline(sessionId: string): TimelineItem[] {
  const items: TimelineItem[] = [
    ...segmentsFor(sessionId).map((segment) => ({ kind: 'segment' as const, at: segment.spokenAt, segment })),
    ...answersFor(sessionId)
      .filter((a) => a.status === 'done' || (a.status === 'cancelled' && a.answerMd))
      .map((answer) => ({ kind: 'answer' as const, at: answer.createdAt, answer })),
  ]
  return items.sort((a, b) => a.at - b.at)
}

// ---------- logos ----------

const logoCache = new Map<string, string | null>()

async function withLogos(hits: CompanyHit[]): Promise<CompanyHit[]> {
  const key = await getKey('logodev')
  if (!key) return hits
  return Promise.all(
    hits.map(async (h) => {
      if (!logoCache.has(h.domain)) {
        try {
          const ctrl = new AbortController()
          const t = setTimeout(() => ctrl.abort(), 3000)
          const res = await fetch(`https://img.logo.dev/${encodeURIComponent(h.domain)}?token=${encodeURIComponent(key)}&size=64&format=png`, { signal: ctrl.signal })
          clearTimeout(t)
          const type = res.headers.get('content-type') ?? ''
          logoCache.set(h.domain, res.ok && type.startsWith('image/') ? `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}` : null)
        } catch {
          return h
        }
      }
      return { ...h, logoUrl: logoCache.get(h.domain) ?? null }
    }),
  )
}

// ---------- registration ----------

export function registerIpc() {
  // Automatic answers: live.ts -> TurnDetector -> RequestGate (ai/gate.ts) owns all policy.

  ipcMain.on('audio:frame', (e, speaker: unknown, pcm: unknown) => {
    if (trusted(e)) feedAudio(speaker, pcm)
  })
  ipcMain.on('files:allow', (e, p: unknown) => {
    if (trusted(e) && typeof p === 'string') allowPath(p)
  })

  // settings and keys
  handle('settings:get', () => getSettings())
  handle('settings:update', (p) => {
    if (p.sttProvider === 'deepgram') throw new AppError('Deepgram streaming is not built yet, so transcription stays on the local English model.', 'not_supported', 'sttProvider')
    if (p.defaultModel) checkModel(p.defaultModel)
    if (p.visionModel) checkModel(p.visionModel)
    if (p.answerRouting) {
      // Revision 4 A4.3: a partial update keeps the rest; the fallback stays off unless chosen.
      if (p.answerRouting.fallbackModel) checkModel(p.answerRouting.fallbackModel)
      const cur = getSettings().answerRouting
      p = { ...p, answerRouting: { ...cur, ...p.answerRouting, switchOn: { ...cur.switchOn, ...(p.answerRouting.switchOn ?? {}) } } }
    }
    const out = patchSettings(p)
    if (p.privateMode !== undefined) setPrivate(p.privateMode)
    changed('settings')
    return out
  })
  handle('keys:status', () => keyStatus())
  handle('keys:set', async ({ provider, key }) => {
    const out = await setKey(provider, key)
    clearAuth(provider)
    changed('keys')
    return out
  })
  handle('keys:test', async ({ provider }) => {
    const r = await testKey(provider)
    if (r.ok && keyStatus().find((k) => k.provider === provider)?.source === 'saved') markVerified(provider)
    changed('keys')
    return r
  })
  handle('keys:delete', ({ provider }) => {
    deleteKey(provider)
    clearAuth(provider)
    changed('keys')
    return { ok: true }
  })
  handle('models:list', () => {
    const keys = modelProviders()
    return MODEL_CATALOG.filter((m) => keys.has(m.provider))
  })

  // speech models: explicit installs from Settings, never while a call is live (§10)
  handle('stt:modelStatus', () => {
    const m = modelForLanguage('en')
    const info = listModels().find((x) => x.id === (m?.id ?? 'en-kroko-2025-08-06'))
    return { ready: !!m, sizeMb: info?.sizeMb ?? 71, modelId: m?.id }
  })
  handle('stt:models', () => listModels())
  handle('stt:downloadModel', ({ modelId }) => {
    if (anyLive()) throw new AppError('End the call before installing speech models.', 'conflict')
    if (!manifest(modelId)) throw new AppError('Unknown speech model.', 'not_found')
    const out = installModel(modelId, (p) => emit('stt:downloadProgress', p))
    changed('settings')
    return out.finally(() => changed('settings'))
  })
  handle('stt:cancelDownload', ({ modelId }) => {
    cancelInstall(modelId)
    return { ok: true }
  })
  handle('stt:deleteModel', ({ modelId }) => {
    if (anyLive()) throw new AppError('End the call before removing speech models.', 'conflict')
    if (loadedModelIds().includes(modelId)) throw new AppError('This model is loaded. Leave the Connect screen first.', 'conflict')
    deleteModel(modelId)
    changed('settings')
    return { ok: true }
  })
  handle('stt:verifyFiles', async ({ modelId }) => {
    if (loadedModelIds().includes(modelId)) throw new AppError('This model is in use.', 'conflict')
    const r = await verifyModel(modelId)
    changed('settings')
    return r
  })
  handle('stt:prepare', ({ sessionId }) => prepareStt(sessionId))
  handle('stt:status', () => sttStatus())

  // sessions
  handle('sessions:list', ({ q, sort }) => sessionCards(q, sort))
  handle('sessions:get', ({ id }) => sessionOut(requireSession(id)))
  handle('sessions:create', (v) => {
    if (v.resumeId && !findResume(v.resumeId)) throw new AppError('That resume was deleted. Pick another one.', 'validation', 'resumeId')
    if (!localLanguage(v.language)) throw new AppError('Only English is available with the local speech model.', 'validation', 'language')
    checkModel(v.model)
    const id = uuid()
    const t = now()
    tx(() => {
      run(
        `insert into sessions (id, type, company_name, company_domain, role_title, job_url, job_description, resume_id, language, model, answer_prefs, instructions, auto_generate, save_transcript, status, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
        id,
        v.type,
        v.companyName || null,
        v.companyDomain || null,
        v.roleTitle || null,
        v.jobUrl,
        v.jobDescription,
        v.resumeId,
        v.language,
        v.model,
        JSON.stringify(v.answerPrefs ?? getSettings().defaultAnswerPrefs),
        v.instructions,
        v.autoGenerate ? 1 : 0,
        v.saveTranscript ? 1 : 0,
        t,
        t,
      )
      setSessionDocuments(id, v.documentIds)
    })
    changed('sessions')
    return sessionOut(requireSession(id))
  })
  handle('sessions:update', ({ id, patch }) => {
    const s = requireSession(id)
    const keys = Object.keys(patch).filter((k) => patch[k] !== undefined)
    if (s.status === 'ended' && keys.some((k) => k !== 'answerPrefs')) throw new AppError('This call has ended and can no longer be edited.', 'conflict')
    if (patch.resumeId && !findResume(patch.resumeId)) throw new AppError('That resume was deleted. Pick another one.', 'validation', 'resumeId')
    if (patch.model) checkModel(patch.model)
    // The model is fixed while live: Leave, change the language, then Rejoin (§10).
    if (patch.language && patch.language !== s.language && s.status === 'live') throw new AppError('Leave the call to change its language, then rejoin.', 'conflict', 'language')
    if (patch.language && !localLanguage(patch.language)) throw new AppError('This language isn\'t available for transcription yet.', 'validation', 'language')
    tx(() => {
      const sets: string[] = []
      const vals: Array<string | number | null> = []
      for (const k of keys) {
        const col = SESSION_COLUMNS[k]
        if (!col) continue
        sets.push(`${col[0]} = ?`)
        vals.push(col[1](patch[k]))
      }
      if (sets.length) run(`update sessions set ${sets.join(', ')}, updated_at = ? where id = ?`, ...vals, now(), id)
      if (patch.documentIds) setSessionDocuments(id, patch.documentIds)
    })
    changed('sessions')
    return sessionOut(requireSession(id))
  })
  handle('sessions:delete', ({ id }) => {
    requireSession(id)
    if (liveSessionId() === id) throw new AppError('End the call before deleting it.', 'conflict')
    const shots = all<{ p: string }>('select screenshot_path as p from answers where session_id = ? and screenshot_path is not null', id)
    run('delete from sessions where id = ?', id)
    for (const s of shots) removeStored(s.p)
    changed('sessions')
    return { ok: true }
  })
  handle('sessions:start', ({ id }) => startSession(id))
  handle('sessions:end', ({ id, mode }) => endSession(id, mode))
  handle('sessions:rejoin', ({ id }) => {
    const s = requireSession(id)
    if (s.status !== 'left' && s.status !== 'live') throw new AppError('Only a paused call can be rejoined.', 'conflict')
    return startSession(id)
  })

  // answers and transcript
  // Every window request goes through the gate; 'auto' only comes from the TurnDetector.
  handle('answers:generate', (v) => submitManual(v))
  handle('answers:cancel', ({ answerId }) => {
    cancelAnswer(answerId, 'user_cancel')
    return { ok: true }
  })
  handle('answers:list', ({ sessionId }) => answersFor(sessionId))
  handle('answers:get', ({ answerId }) => {
    const a = getAnswer(answerId)
    if (!a) throw new AppError('That answer no longer exists.', 'not_found')
    return { ...a, liveText: a.status === 'streaming' ? liveTextOf(answerId) : undefined }
  })
  handle('gate:status', ({ sessionId }) => gateStatus(sessionId))
  handle('transcript:clear', ({ sessionId }) => {
    requireSession(sessionId)
    const cursorAt = now()
    run('update sessions set transcript_cursor_at = ?, updated_at = ? where id = ?', cursorAt, cursorAt, sessionId)
    clearLive(sessionId)
    return { cursorAt }
  })
  handle('transcript:get', ({ sessionId }) => {
    requireSession(sessionId)
    return timeline(sessionId)
  })
  handle('transcript:export', async ({ sessionId, format }, e) => {
    const { name, text } = exportText(sessionId, format)
    const opts = { defaultPath: name, filters: [format === 'md' ? { name: 'Markdown', extensions: ['md'] } : { name: 'Text', extensions: ['txt'] }] }
    const w = winOf(e)
    const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    writeFileSync(r.filePath, text, 'utf8')
    return { path: r.filePath }
  })
  handle('transcript:delete', ({ sessionId }) => {
    requireSession(sessionId)
    if (liveSessionId() === sessionId) throw new AppError('End the call before clearing its transcript.', 'conflict')
    const shots = all<{ p: string }>('select screenshot_path as p from answers where session_id = ? and screenshot_path is not null', sessionId)
    tx(() => {
      run('delete from transcript_segments where session_id = ?', sessionId)
      run('delete from answers where session_id = ?', sessionId)
    })
    for (const s of shots) removeStored(s.p)
    changed('transcript')
    changed('sessions')
    return { ok: true }
  })

  // resumes
  handle('resumes:list', () => resumeRows())
  handle('resumes:pickFile', (_i, e) => pickFile(winOf(e), 'resume'))
  handle('resumes:importFile', async ({ path, title }) => {
    const f = readPicked(path, LIMITS.fileBytes)
    if (!/\.pdf$/i.test(f.name) || f.buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new AppError('Only PDF files can be uploaded as a resume.', 'validation', 'file')
    const hash = sha256(f.buf)
    const dupe = get<{ id: string }>('select id from resumes where content_hash = ?', hash)
    if (dupe) return resumeOut(requireResume(dupe.id), dupe.id)
    const id = uuid()
    emit('resumes:progress', { id, stage: 'copying', pct: 0 })
    const rel = `resumes/${id}.pdf`
    store(rel, f.buf)
    emit('resumes:progress', { id, stage: 'copying', pct: 100 })
    const t = now()
    run(
      `insert into resumes (id, title, source, file_path, file_size, content_hash, content_md, md_status, parse_status, created_at, updated_at)
       values (?, ?, 'pdf', ?, ?, ?, '', 'converting', 'pending', ?, ?)`,
      id,
      title,
      rel,
      f.size,
      hash,
      t,
      t,
    )
    changed('resumes')
    await convertResume(id)
    return resumeOut(requireResume(id))
  })
  handle('resumes:reconvert', async ({ id }) => {
    const r = requireResume(id)
    if (r.source !== 'pdf') throw new AppError('Only uploaded PDFs can be reconverted.', 'conflict')
    await convertResume(id)
    return resumeOut(requireResume(id))
  })
  handle('resumes:createFromText', ({ title, text }) => {
    const hash = sha256(text)
    const dupe = get<{ id: string }>('select id from resumes where content_hash = ?', hash)
    if (dupe) return resumeOut(requireResume(dupe.id), dupe.id)
    const id = uuid()
    const t = now()
    run(
      `insert into resumes (id, title, source, content_hash, content_md, md_status, md_method, parse_status, created_at, updated_at)
       values (?, ?, 'text', ?, ?, 'ready', 'manual', 'pending', ?, ?)`,
      id,
      title,
      hash,
      text,
      t,
      t,
    )
    changed('resumes')
    return resumeOut(requireResume(id))
  })
  handle('resumes:get', ({ id }) => resumeOut(requireResume(id)))
  handle('resumes:update', ({ id, title, contentMd }) => {
    const r = requireResume(id)
    if (title !== undefined) run('update resumes set title = ?, updated_at = ? where id = ?', title, now(), id)
    if (contentMd !== undefined && contentMd !== r.contentMd) {
      run(`update resumes set content_md = ?, md_method = 'manual', md_status = 'ready', md_error = null, updated_at = ? where id = ?`, contentMd, now(), id)
    }
    changed('resumes')
    return resumeOut(requireResume(id)) satisfies Resume
  })
  handle('resumes:delete', ({ id }) => {
    const r = findResume(id)
    run('delete from resumes where id = ?', id)
    removeStored(r?.filePath ?? null)
    changed('resumes')
    changed('sessions')
    return { ok: true }
  })
  handle('resumes:parse', async ({ id }) => {
    requireResume(id)
    await parseResume(id)
    return resumeOut(requireResume(id))
  })

  // documents
  handle('documents:list', () => documentRows())
  handle('documents:get', ({ id }) => {
    const d = findDocument(id)
    if (!d) throw new AppError('That document no longer exists.', 'not_found')
    return documentOut(d)
  })
  handle('documents:pickFile', (_i, e) => pickFile(winOf(e), 'document'))
  handle('documents:importFile', async ({ path, title }) => {
    const f = readPicked(path, LIMITS.fileBytes)
    const ext = f.name.split('.').pop()?.toLowerCase() ?? ''
    if (!['pdf', 'txt', 'md'].includes(ext)) throw new AppError('Use a PDF, TXT or MD file.', 'validation', 'file')
    if (ext === 'pdf' && f.buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new AppError('That file is not a valid PDF.', 'validation', 'file')
    const hash = sha256(f.buf)
    const dupe = get<{ id: string }>('select id from documents where content_hash = ?', hash)
    if (dupe) return documentOut(findDocument(dupe.id)!, dupe.id)
    const id = uuid()
    emit('documents:progress', { id, stage: 'copying', pct: 50 })
    const rel = `documents/${id}.${ext}`
    store(rel, f.buf)
    emit('documents:progress', { id, stage: 'converting' })
    let text = ''
    let status: DocumentFile['textStatus'] = 'ready'
    try {
      text = ext === 'pdf' ? await pdfText(f.buf) : f.buf.toString('utf8').replace(/^﻿/, '')
      if (!text.trim()) status = 'empty'
    } catch {
      status = 'failed'
    }
    const t = now()
    run(
      `insert into documents (id, title, source, file_path, file_size, content_hash, raw_text, text_status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      title,
      ext === 'pdf' ? 'pdf' : 'markdown',
      rel,
      f.size,
      hash,
      text.slice(0, 200_000),
      status,
      t,
      t,
    )
    emit('documents:progress', { id, stage: status === 'failed' ? 'failed' : 'ready' })
    changed('documents')
    return documentOut(findDocument(id)!)
  })
  handle('documents:createFromText', ({ title, text }) => {
    const id = uuid()
    const t = now()
    run(`insert into documents (id, title, source, content_hash, raw_text, text_status, created_at, updated_at) values (?, ?, 'text', ?, ?, 'ready', ?, ?)`, id, title, sha256(text), text, t, t)
    changed('documents')
    return documentOut(findDocument(id)!)
  })
  handle('documents:update', ({ id, title, rawText }) => {
    if (!findDocument(id)) throw new AppError('That document no longer exists.', 'not_found')
    if (title !== undefined) run('update documents set title = ?, updated_at = ? where id = ?', title, now(), id)
    if (rawText !== undefined) run('update documents set raw_text = ?, text_status = ?, updated_at = ? where id = ?', rawText, rawText.trim() ? 'ready' : 'empty', now(), id)
    changed('documents')
    return documentOut(findDocument(id)!)
  })
  handle('documents:delete', ({ id }) => {
    const d = findDocument(id)
    run('delete from documents where id = ?', id)
    removeStored(d?.filePath ?? null)
    changed('documents')
    return { ok: true }
  })

  // prefs, notes, review, jobs, companies, mock interview
  handle('prefs:preview', ({ prefs, questionType }) => preview(prefs, questionType))
  handle('notes:get', ({ sessionId }) => notesFor(sessionId))
  handle('notes:generate', ({ sessionId }) => {
    const s = requireSession(sessionId)
    if (!get('select 1 as x from transcript_segments where session_id = ? limit 1', sessionId)) {
      throw new AppError(s.saveTranscript ? 'There is no transcript to write notes from yet.' : 'Save transcript was off for this call, so there is nothing to summarise.', 'conflict')
    }
    run('update session_notes set attempts = 0 where session_id = ?', sessionId)
    queueNotes(sessionId)
    return notesFor(sessionId)
  })
  handle('notes:clear', ({ sessionId }) => {
    run('delete from session_notes where session_id = ?', sessionId)
    changed('notes')
    return { ok: true }
  })
  handle('review:list', ({ sessionId }) => reviewFor(sessionId))
  handle('review:ask', ({ sessionId, message }) => askReview(sessionId, message))
  handle('jobs:import', ({ url }) => importJob(url))
  handle('companies:search', ({ q }) => withLogos(searchCompanies(q)))
  handle('mock:nextQuestion', async ({ sessionId }) => {
    const s = requireSession(sessionId)
    if (s.status !== 'live' || liveSessionId() !== sessionId) throw new AppError('Start the mock interview first.', 'conflict')
    const { lines } = liveLines(sessionId, 0)
    const asked = lines.filter((l) => l.speaker === 'them').map((l) => l.text)
    const lastAnswer = lines
      .filter((l) => l.speaker === 'you')
      .slice(-4)
      .map((l) => l.text)
      .join(' ')
    const q = await nextInterviewQuestion(sessionId, asked, lastAnswer)
    const seg = injectThem(sessionId, q)
    if (!seg) throw new AppError('The mock interview stopped. Rejoin it first.', 'conflict')
    return seg
  })
}
