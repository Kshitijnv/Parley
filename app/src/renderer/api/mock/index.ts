// Mock implementation of the Api contract (src/shared/api.ts). Same inputs, outputs,
// validation and events as the IPC channels in architecture.md, backed by
// localStorage + IndexedDB, a scripted STT stream and a canned answer engine.
import { ZodError } from 'zod'
import type { Api, ApiEventName, ApiEvents } from '@shared/api'
import { DEFAULT_ANSWER_ROUTING, DEFAULT_AUTO_POLICY, DEFAULT_CLOUD_STT, MODEL_CATALOG, LANGUAGES, providerOf, modelLabel } from '@shared/catalog'
import { LIMITS, schemas, type Channel } from '@shared/ipc'
import type {
  Answer,
  AnswerErrorCode,
  AnswerTrigger,
  GenerateResult,
  DocumentFile,
  Notes,
  Resume,
  ReviewMessage,
  Segment,
  Session,
  SessionCard,
  SpeechKey,
  TimelineItem,
} from '@shared/types'
import { answerFor, chunks, convertedResumeMd, importJob, notesFor, previewFor, reviewAnswer, searchCompanies, type Ctx } from './ai'
import { emitAll, emitLocal, on } from './bus'
import { fileStore, fileUrl, pickWithInput, registerPicked, sha256, takePicked } from './files'
import { SAMPLE_PARSED, SAMPLE_RESUME_MD } from './seed'
import { MockStt } from './stt'
import { ApiError, hasScenario, load, mutate, now, sleep, uuid, type Db, type DocumentStored, type ResumeRowStored, type SessionRow } from './store'
import { windowApi } from '../window'

function validate<C extends Channel>(channel: C, input: unknown): any {
  try {
    return schemas[channel].parse(input)
  } catch (e) {
    if (e instanceof ZodError) {
      const issue = e.issues[0]
      throw new ApiError(issue?.message ?? 'Invalid input', 'validation', issue?.path.join('.'))
    }
    throw e
  }
}

const changed = (area: ApiEvents['data:changed']['area']) => emitAll('data:changed', { area })
const MOCK_MODEL_ID = 'en-kroko-2025-08-06'
const offline = () => hasScenario('offline') || (typeof navigator !== 'undefined' && navigator.onLine === false)

// ---------- shaping ----------

function sessionOut(row: SessionRow, db: Db): Session {
  const r = row.resumeId ? db.resumes.find((x) => x.id === row.resumeId) : null
  return { ...row, resumeTitle: r?.title ?? null }
}

function sessionCard(row: SessionRow, db: Db): SessionCard {
  return {
    id: row.id,
    type: row.type,
    companyName: row.companyName,
    companyDomain: row.companyDomain,
    roleTitle: row.roleTitle,
    status: row.status,
    hasTranscript: db.segments.some((s) => s.sessionId === row.id),
    answerCount: db.answers.filter((a) => a.sessionId === row.id && a.status !== 'failed').length,
    activeMs: row.activeMs + (row.liveSince ? now() - row.liveSince : 0),
    startedAt: row.startedAt,
    createdAt: row.createdAt,
  }
}

async function resumeOut(row: ResumeRowStored, duplicateOf?: string): Promise<Resume> {
  return { ...row, fileUrl: await fileUrl(row.filePath), ...(duplicateOf ? { duplicateOf } : {}) }
}

async function docOut(row: DocumentStored, duplicateOf?: string): Promise<DocumentFile> {
  return { ...row, fileUrl: await fileUrl(row.filePath), ...(duplicateOf ? { duplicateOf } : {}) }
}

function getSessionRow(db: Db, id: string): SessionRow {
  const s = db.sessions.find((x) => x.id === id)
  if (!s) throw new ApiError('That session no longer exists.', 'not_found')
  return s
}

function ctxFor(db: Db, s: SessionRow | null): Ctx {
  const r = s?.resumeId ? db.resumes.find((x) => x.id === s.resumeId) : s ? null : db.resumes[0]
  return { resume: r?.parsed ?? null, company: s?.companyName ?? null, role: s?.roleTitle ?? null }
}

// ---------- live engine (runs in the overlay window) ----------

interface Final {
  speaker: Segment['speaker']
  text: string
  at: number
}

const live: {
  sessionId: string | null
  stt: MockStt | null
  finals: Final[]
  pending: Segment[]
  flush: ReturnType<typeof setInterval> | null
  autoLast: number
} = { sessionId: null, stt: null, finals: [], pending: [], flush: null, autoLast: 0 }

const streams = new Map<string, { sessionId: string; cancel: () => void; text: string }>()

function flushSegments() {
  if (!live.pending.length) return
  const batch = live.pending.splice(0)
  mutate((db) => {
    db.segments.push(...batch)
  })
  changed('transcript')
}

function startEngine(row: SessionRow) {
  stopEngine(false)
  live.sessionId = row.id
  live.finals = []
  const db = load()
  let seq = db.segments.filter((s) => s.sessionId === row.id).length
  live.stt = new MockStt(row.id, row.type, {
    onStatus: (state, error) => emitLocal('stt:status', { state, error }),
    onFinal: (speaker, text, startMs, endMs) => {
      const seg: Segment = { id: uuid(), sessionId: row.id, seq: seq++, speaker, text, startMs, endMs, spokenAt: now() }
      live.finals.push({ speaker, text, at: seg.spokenAt })
      const s = load().sessions.find((x) => x.id === row.id)
      if (s?.saveTranscript) live.pending.push(seg)
      emitLocal('transcript:final', seg)
      if (s?.autoGenerate && speaker === 'them' && /\?\s*$/.test(text) && now() - live.autoLast > 10_000) {
        live.autoLast = now()
        void generateAnswer({ sessionId: row.id, trigger: 'auto' }).catch(() => {})
      }
    },
  })
  live.stt.start()
  live.flush = setInterval(flushSegments, 2000)
}

function stopEngine(emit = true) {
  live.stt?.stop()
  live.stt = null
  if (live.flush) clearInterval(live.flush)
  live.flush = null
  flushSegments()
  live.sessionId = null
  if (emit) emitLocal('stt:status', { state: 'stopped' })
}

function cancelStreams(sessionId: string) {
  for (const [, s] of streams) if (s.sessionId === sessionId) s.cancel()
}

function excerptFor(sessionId: string, row: SessionRow, db: Db): string {
  const lastAnswerAt = Math.max(0, ...db.answers.filter((a) => a.sessionId === sessionId && a.status !== 'failed').map((a) => a.createdAt))
  const cursor = row.transcriptCursorAt ?? 0
  const since = Math.max(lastAnswerAt, cursor, now() - 120_000)
  const pool = live.sessionId === sessionId ? live.finals : db.segments.filter((s) => s.sessionId === sessionId).map((s) => ({ speaker: s.speaker, text: s.text, at: s.spokenAt }))
  let lines = pool.filter((f) => f.at > since)
  if (!lines.length) lines = pool.filter((f) => f.at > Math.max(cursor, now() - 120_000)).slice(-2)
  const partial = live.sessionId === sessionId ? live.stt?.currentPartial() : null
  const text = lines.map((l) => `${l.speaker === 'you' ? 'You' : 'Them'}: ${l.text}`)
  if (partial?.text) text.push(`${partial.speaker === 'you' ? 'You' : 'Them'}: ${partial.text}`)
  return text.join('\n')
}

function failAnswer(id: string, code: AnswerErrorCode, message: string, retryAfterS?: number) {
  const sessionId = load().answers.find((x) => x.id === id)?.sessionId
  mutate((db) => {
    const a = db.answers.find((x) => x.id === id)
    if (a) {
      a.status = code === 'cancelled' ? 'cancelled' : 'failed'
      a.error = code === 'cancelled' ? null : message
    }
  })
  emitLocal('answer:error', { answerId: id, sessionId, code, message, retryAfterS, retryAt: retryAfterS ? Date.now() + retryAfterS * 1000 : undefined })
}

/** Demo answer engine (the real policy lives in main's RequestGate). 'auto' is internal only. */
async function generateAnswer(v: { sessionId: string; trigger: AnswerTrigger; text?: string }): Promise<GenerateResult> {
  const db = load()
  const s = getSessionRow(db, v.sessionId)
  if (s.status !== 'live') throw new ApiError('Answers work while the call is live.', 'conflict')
  cancelStreams(s.id)
  const model = v.trigger === 'screenshot' ? db.settings.visionModel : s.model
  const prefs = s.answerPrefs
  const excerpt = v.trigger === 'chat' ? v.text! : excerptFor(s.id, s, db)
  const seq = db.answers.filter((a) => a.sessionId === s.id).length
  const id = uuid()
  const row: Answer = {
    id,
    sessionId: s.id,
    seq,
    trigger: v.trigger,
    status: 'streaming',
    transcriptExcerpt: v.trigger === 'chat' ? '' : excerpt,
    userPrompt: v.trigger === 'chat' ? v.text! : null,
    screenshotPath: v.trigger === 'screenshot' ? `screenshots/${id}.png` : null,
    question: null,
    answerMd: '',
    model,
    answerPrefs: prefs,
    error: null,
    firstTokenMs: null,
    latencyMs: null,
    createdAt: now(),
  }
  mutate((d) => {
    d.answers.push(row)
  })
  emitLocal('answer:start', { answerId: id, sessionId: s.id, seq, trigger: v.trigger, turnId: null, questionDraft: v.trigger === 'chat' ? v.text! : null, model, createdAt: row.createdAt })

  let cancelled = false
  const entry = {
    sessionId: s.id,
    text: '',
    cancel: () => {
      cancelled = true
      streams.delete(id)
      failAnswer(id, 'cancelled', 'Stopped')
    },
  }
  streams.set(id, entry)

  const t0 = performance.now()
  void (async () => {
    await sleep(30)
    const fail = (code: AnswerErrorCode, msg: string, retry?: number) => {
      streams.delete(id)
      if (!cancelled) failAnswer(id, code, msg, retry)
    }
    if (!db.keys.some((k) => k.provider === providerOf(model))) {
      return fail('no_key', `Add a ${providerOf(model)} API key in Settings to use ${modelLabel(model)}.`)
    }
    if (!excerpt.trim() && v.trigger !== 'screenshot') {
      return fail('provider_error', 'Nothing new to answer yet. Wait for a question, or press Chat to type one.')
    }
    if (offline()) return fail('offline', 'No connection. The transcript keeps running; answers need the internet.')
    await sleep(hasScenario('slow') ? 5500 : 650 + Math.random() * 400)
    if (cancelled) return
    if (hasScenario('rate_limit')) return fail('rate_limited', `${modelLabel(model)} is rate limited.`, 12)
    if (hasScenario('provider_error')) return fail('provider_error', 'The model returned an error (500). Try again.')
    if (hasScenario('timeout')) {
      await sleep(8000)
      return fail('timeout', 'No reply after 10 seconds.')
    }
    const { question, md } = answerFor(
      v.trigger === 'screenshot' ? 'coding question on my screen' : excerpt,
      prefs,
      ctxFor(db, s),
      v.trigger === 'screenshot' ? 'twosum' : undefined,
    )
    const firstTokenMs = Math.round(performance.now() - t0)
    emitLocal('answer:delta', { answerId: id, sessionId: s.id, seq, part: 'question', offset: 0, text: question })
    for (const c of chunks(md)) {
      if (cancelled) return
      await sleep(40)
      emitLocal('answer:delta', { answerId: id, sessionId: s.id, seq, part: 'answer', offset: entry.text.length, text: c })
      entry.text += c
    }
    if (cancelled) return
    streams.delete(id)
    const done = mutate((d) => {
      const a = d.answers.find((x) => x.id === id)!
      Object.assign(a, { status: 'done', question, answerMd: md, firstTokenMs, latencyMs: Math.round(performance.now() - t0) })
      return a
    })
    emitLocal('answer:done', done)
    changed('transcript')
  })()
  return { outcome: 'started', answerId: id, seq }
}

// ---------- notes job ----------

async function runNotes(sessionId: string) {
  const setStatus = (status: Notes['status'], patch: Partial<Notes> = {}) => {
    mutate((db) => {
      let n = db.notes.find((x) => x.sessionId === sessionId)
      if (!n) {
        n = { sessionId, status, details: null, summary: null, questions: null, nextSteps: null, error: null, generatedAt: null }
        db.notes.push(n)
      }
      Object.assign(n, { status }, patch)
    })
    emitAll('notes:status', { sessionId, status })
    changed('notes')
  }
  setStatus('pending')
  await sleep(1200)
  setStatus('generating')
  await sleep(hasScenario('slow') ? 9000 : 3500)
  if (hasScenario('notes_fail') || offline()) {
    setStatus('failed', { error: offline() ? 'No connection. Notes will be written when you are back online.' : 'The model returned an empty response.' })
    return
  }
  const db = load()
  const s = db.sessions.find((x) => x.id === sessionId)
  if (!s) return
  const qs = db.answers.filter((a) => a.sessionId === sessionId && a.status === 'done' && a.question).map((a) => a.question!)
  const theirs = db.segments.filter((x) => x.sessionId === sessionId && x.speaker === 'them').length
  const n = notesFor(qs, s.companyName, s.roleTitle, theirs)
  setStatus('ready', { ...n, error: null, generatedAt: now() })
}

// ---------- resume conversion jobs ----------

async function runResumeConvert(id: string) {
  emitAll('resumes:progress', { id, stage: 'converting' })
  mutate((db) => {
    const r = db.resumes.find((x) => x.id === id)
    if (r) Object.assign(r, { mdStatus: 'converting', mdError: null, updatedAt: now() })
  })
  changed('resumes')
  await sleep(hasScenario('slow') ? 8000 : 2200)
  const fail = hasScenario('convert_fail')
  const hasKey = load().keys.some((k) => k.provider === 'google')
  mutate((db) => {
    const r = db.resumes.find((x) => x.id === id)
    if (!r) return
    if (fail) {
      Object.assign(r, { mdStatus: 'failed', mdError: 'No text found in this PDF. It may be a scanned image: add a Gemini key and reconvert, or paste the text instead.' })
    } else {
      Object.assign(r, {
        mdStatus: 'ready',
        mdMethod: hasKey && !offline() ? 'ai' : 'text_extract',
        contentMd: convertedResumeMd(r.title, SAMPLE_RESUME_MD),
        mdError: null,
        parseStatus: 'parsing',
        updatedAt: now(),
      })
    }
  })
  emitAll('resumes:progress', { id, stage: fail ? 'failed' : 'ready' })
  changed('resumes')
  if (!fail) void runResumeParse(id)
}

async function runResumeParse(id: string) {
  mutate((db) => {
    const r = db.resumes.find((x) => x.id === id)
    if (r) r.parseStatus = 'parsing'
  })
  changed('resumes')
  await sleep(1600)
  mutate((db) => {
    const r = db.resumes.find((x) => x.id === id)
    if (!r) return
    const name = r.contentMd.match(/^# (.+)$/m)?.[1] ?? SAMPLE_PARSED.contact.name
    r.parsed = { ...SAMPLE_PARSED, contact: { ...SAMPLE_PARSED.contact, name } }
    r.parseStatus = 'ready'
    r.parseError = null
  })
  changed('resumes')
}

const picked = (accept: string) => async () => {
  const f = await pickWithInput(accept)
  if (!f) return null
  return { path: registerPicked(f), name: f.name, size: f.size }
}

// ---------- the Api ----------

let speechKeys: SpeechKey[] = []

export const api: Api = {
  settings: {
    async get() {
      const s = load().settings
      return { ...s, autoPolicy: { ...DEFAULT_AUTO_POLICY, ...(s.autoPolicy ?? {}) }, answerRouting: { ...DEFAULT_ANSWER_ROUTING, ...(s.answerRouting ?? {}) }, cloudStt: { ...DEFAULT_CLOUD_STT, ...(s.cloudStt ?? {}) } }
    },
    async update(patch) {
      const p = validate('settings:update', patch)
      const out = mutate((db) => {
        const autoPolicy = { ...DEFAULT_AUTO_POLICY, ...(db.settings.autoPolicy ?? {}), ...(p.autoPolicy ?? {}) }
        const cur = { ...DEFAULT_ANSWER_ROUTING, ...(db.settings.answerRouting ?? {}) }
        const answerRouting = { ...cur, ...(p.answerRouting ?? {}), switchOn: { ...cur.switchOn, ...(p.answerRouting?.switchOn ?? {}) } }
        const c = { ...DEFAULT_CLOUD_STT, ...(db.settings.cloudStt ?? {}), ...(p.cloudStt ?? {}) }
        if (p.cloudStt?.consentedAt) c.consentedAt = now()
        if (c.enabled && c.consentedAt === null) throw new ApiError('Accept the cloud speech notice first.', 'validation', 'cloudStt')
        db.settings = { ...db.settings, ...p, autoPolicy, answerRouting, cloudStt: c, updatedAt: now() }
        return db.settings
      })
      if (p.privateMode !== undefined) void windowApi.setPrivate(p.privateMode)
      changed('settings')
      return out
    },
  },

  keys: {
    async status() {
      return load().keys
    },
    async set(input) {
      const { provider, key } = validate('keys:set', input)
      const last4 = key.slice(-4)
      mutate((db) => {
        db.keys = db.keys.filter((k) => k.provider !== provider)
        db.keys.push({ provider, last4, verifiedAt: null })
      })
      changed('keys')
      return { last4 }
    },
    async test(input) {
      const { provider } = validate('keys:test', input)
      await sleep(900)
      const k = load().keys.find((x) => x.provider === provider)
      if (!k) return { ok: false, error: 'No key saved for this provider.' }
      if (offline()) return { ok: false, error: 'No connection.' }
      if (hasScenario('bad_key')) return { ok: false, error: 'The provider rejected this key (401). Check it was copied in full.' }
      mutate((db) => {
        const x = db.keys.find((y) => y.provider === provider)
        if (x) x.verifiedAt = now()
      })
      changed('keys')
      return { ok: true }
    },
    async delete(input) {
      const { provider } = validate('keys:delete', input)
      mutate((db) => {
        db.keys = db.keys.filter((k) => k.provider !== provider)
      })
      changed('keys')
      return { ok: true }
    },
  },

  // Cloud speech keys live in memory only in the browser preview: nothing to protect, nothing to call.
  speechKeys: {
    async list() {
      return speechKeys
    },
    async add(input) {
      const { key, label, budgetHours } = validate('speechKeys:add', input)
      if (speechKeys.length >= 5) throw new ApiError('Up to 5 keys. Remove one first.', 'validation', 'key')
      await sleep(600)
      const bad = hasScenario('bad_key')
      const k: SpeechKey = { id: uuid(), label, last4: key.slice(-4), position: speechKeys.length + 1, state: bad ? 'auth_failed' : 'ok', stateUntil: null, lastErrorType: null, usedMs: 0, usedTotalMs: 0, budgetMs: budgetHours === null ? null : Math.round(budgetHours * 3_600_000), verifiedAt: bad ? null : now() }
      speechKeys = [...speechKeys, k]
      changed('speechKeys')
      return { key: k, test: bad ? { ok: false, error: 'Speechmatics rejected this key (401). Check it was copied in full.' } : { ok: true } }
    },
    async update(input) {
      const { id, label, budgetHours } = validate('speechKeys:update', input)
      speechKeys = speechKeys.map((k) => (k.id === id ? { ...k, label: label ?? k.label, budgetMs: budgetHours === undefined ? k.budgetMs : budgetHours === null ? null : Math.round(budgetHours * 3_600_000) } : k))
      changed('speechKeys')
      return speechKeys.find((k) => k.id === id)!
    },
    async test(input) {
      const { id } = validate('speechKeys:test', input)
      await sleep(600)
      speechKeys = speechKeys.map((k) => (k.id === id ? { ...k, state: 'ok', stateUntil: null, verifiedAt: now() } : k))
      changed('speechKeys')
      return { ok: true }
    },
    async move(input) {
      const { id, by } = validate('speechKeys:move', input)
      const i = speechKeys.findIndex((k) => k.id === id)
      const j = i + by
      if (i >= 0 && j >= 0 && j < speechKeys.length) {
        const next = [...speechKeys]
        ;[next[i], next[j]] = [next[j]!, next[i]!]
        speechKeys = next.map((k, n) => ({ ...k, position: n + 1 }))
      }
      changed('speechKeys')
      return speechKeys
    },
    async remove(input) {
      const { id } = validate('speechKeys:remove', input)
      speechKeys = speechKeys.filter((k) => k.id !== id).map((k, n) => ({ ...k, position: n + 1 }))
      changed('speechKeys')
      return { ok: true }
    },
  },

  models: {
    async list() {
      const keys = new Set(load().keys.map((k) => k.provider))
      return MODEL_CATALOG.filter((m) => keys.has(m.provider))
    },
    catalog: () => MODEL_CATALOG,
    languages: () => LANGUAGES,
  },

  stt: {
    async modelStatus() {
      return { ready: load().sttModelReady, sizeMb: 71, modelId: MOCK_MODEL_ID }
    },
    async models() {
      const ready = load().sttModelReady
      return [
        {
          id: MOCK_MODEL_ID,
          language: 'en' as const,
          label: 'English (demo data: no real model)',
          sizeMb: 71,
          licence: 'CC-BY-SA 4.0',
          attribution: 'Demo data. The real app downloads the Kroko ASR English community model.',
          status: ready ? ('installed' as const) : ('absent' as const),
          selectable: true,
          filesVerifiedAt: ready ? now() : null,
          recognitionVerifiedAt: null,
        },
      ]
    },
    async downloadModel(input) {
      const { modelId } = validate('stt:downloadModel', input)
      if (live.sessionId) throw new ApiError('End the call before installing speech models.', 'conflict')
      for (let pct = 0; pct <= 100; pct += 4) {
        emitLocal('stt:downloadProgress', { pct, modelId, stage: 'downloading' })
        if (pct === 60 && hasScenario('stt_download_fail')) {
          emitLocal('stt:downloadProgress', { pct: 0, modelId, stage: 'failed' })
          return { ok: false, error: 'Download interrupted. Check your connection and try again.' }
        }
        await sleep(110)
      }
      mutate((db) => {
        db.sttModelReady = true
      })
      emitLocal('stt:downloadProgress', { pct: 100, modelId, stage: 'installed' })
      changed('settings')
      return { ok: true }
    },
    async cancelDownload() {
      return { ok: true }
    },
    async deleteModel() {
      if (live.sessionId) throw new ApiError('End the call before removing speech models.', 'conflict')
      mutate((db) => {
        db.sttModelReady = false
      })
      changed('settings')
      return { ok: true }
    },
    async verifyFiles() {
      return { ok: load().sttModelReady }
    },
    async prepare(input) {
      validate('stt:prepare', input)
      if (!load().sttModelReady) throw new ApiError('Install the English speech model first (Settings › Speech models).', 'stt_model_missing')
      return { state: 'listening' as const, modelId: MOCK_MODEL_ID, language: 'en', loadMs: 0 }
    },
    async status() {
      return live.sessionId ? { state: 'listening' as const, modelId: MOCK_MODEL_ID, language: 'en' } : { state: 'stopped' as const }
    },
  },

  sessions: {
    async list(input = {}) {
      const { q, sort } = validate('sessions:list', input)
      const db = load()
      const needle = q?.trim().toLowerCase()
      let rows = db.sessions.filter((s) => s.status !== 'draft')
      if (needle) {
        rows = rows.filter((s) =>
          [s.companyName, s.roleTitle, s.jobDescription].some((f) => f?.toLowerCase().includes(needle)),
        )
      }
      rows.sort((a, b) => ((b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt)) * (sort === 'oldest' ? -1 : 1))
      return rows.map((r) => sessionCard(r, db))
    },
    async get(input) {
      const { id } = validate('sessions:get', input)
      const db = load()
      return sessionOut(getSessionRow(db, id), db)
    },
    async create(input) {
      const v = validate('sessions:create', input)
      const db0 = load()
      if (v.resumeId && !db0.resumes.some((r) => r.id === v.resumeId)) throw new ApiError('That resume was deleted. Pick another one.', 'validation', 'resumeId')
      const t = now()
      const row: SessionRow = {
        id: uuid(),
        type: v.type,
        companyName: v.companyName || null,
        companyDomain: v.companyDomain,
        roleTitle: v.roleTitle || null,
        jobUrl: v.jobUrl,
        jobDescription: v.jobDescription,
        resumeId: v.resumeId,
        documentIds: v.documentIds.filter((d: string) => db0.documents.some((x) => x.id === d)),
        language: v.language,
        model: v.model,
        answerPrefs: v.answerPrefs ?? db0.settings.defaultAnswerPrefs,
        instructions: v.instructions,
        autoGenerate: v.autoGenerate,
        saveTranscript: v.saveTranscript,
        status: 'draft',
        startedAt: null,
        endedAt: null,
        activeMs: 0,
        liveSince: null,
        transcriptCursorAt: null,
        createdAt: t,
        updatedAt: t,
      }
      await sleep(hasScenario('slow') ? 2500 : 600)
      const db = mutate((d) => {
        d.sessions.unshift(row)
        return d
      })
      changed('sessions')
      return sessionOut(row, db)
    },
    async update(input) {
      const { id, patch } = validate('sessions:update', input)
      const db = mutate((d) => {
        const s = getSessionRow(d, id)
        if (s.status === 'ended' && Object.keys(patch).some((k) => k !== 'answerPrefs')) {
          throw new ApiError('This call has ended and can no longer be edited.', 'conflict')
        }
        Object.assign(s, patch, { updatedAt: now() })
        return d
      })
      changed('sessions')
      return sessionOut(getSessionRow(db, id), db)
    },
    async delete(input) {
      const { id } = validate('sessions:delete', input)
      if (live.sessionId === id) throw new ApiError('End the call before deleting it.', 'conflict')
      mutate((db) => {
        db.sessions = db.sessions.filter((s) => s.id !== id)
        db.segments = db.segments.filter((s) => s.sessionId !== id)
        db.answers = db.answers.filter((s) => s.sessionId !== id)
        db.notes = db.notes.filter((s) => s.sessionId !== id)
        db.review = db.review.filter((s) => s.sessionId !== id)
      })
      changed('sessions')
      return { ok: true }
    },
    async start(input) {
      const { id } = validate('sessions:start', input)
      const db0 = load()
      const row0 = getSessionRow(db0, id)
      if (!db0.sttModelReady) throw new ApiError('Download the speech model first.', 'stt_not_ready')
      if (row0.status === 'ended') throw new ApiError('This call has ended. Create a new session to start another.', 'conflict')
      const other = db0.sessions.find((s) => s.status === 'live' && s.id !== id)
      if (other) throw new ApiError(`Another call (${other.companyName ?? 'untitled'}) is still live. End it first.`, 'conflict')
      const db = mutate((d) => {
        const s = getSessionRow(d, id)
        const t = now()
        if (s.status !== 'live') {
          s.status = 'live'
          s.startedAt ??= t
          s.liveSince = t
        }
        s.updatedAt = t
        return d
      })
      const row = getSessionRow(db, id)
      startEngine(row)
      changed('sessions')
      return sessionOut(row, db)
    },
    async end(input) {
      const { id, mode } = validate('sessions:end', input)
      cancelStreams(id)
      if (live.sessionId === id) stopEngine()
      let queueNotes = false
      const db = mutate((d) => {
        const s = getSessionRow(d, id)
        const t = now()
        if (s.status === 'live' && s.liveSince) s.activeMs += t - s.liveSince
        s.liveSince = null
        if (mode === 'end') {
          s.status = 'ended'
          s.endedAt = t
          queueNotes = s.saveTranscript && d.segments.some((x) => x.sessionId === id)
        } else if (s.status !== 'ended') {
          s.status = 'left'
        }
        s.updatedAt = t
        return d
      })
      changed('sessions')
      if (queueNotes) void runNotes(id)
      return sessionOut(getSessionRow(db, id), db)
    },
    async rejoin(input) {
      const { id } = validate('sessions:rejoin', input)
      const s = getSessionRow(load(), id)
      if (s.status !== 'left' && s.status !== 'live') throw new ApiError('Only a paused call can be rejoined.', 'conflict')
      return api.sessions.start({ id })
    },
  },

  audio: {
    frame() {
      // The mock STT is scripted; captured frames are dropped here. The real
      // implementation forwards them to the STT worker.
    },
  },

  answers: {
    async generate(input) {
      const v = validate('answers:generate', input)
      return generateAnswer(v)
    },
    async get(input) {
      const { answerId } = validate('answers:get', input)
      const a = load().answers.find((x) => x.id === answerId)
      if (!a) throw new ApiError('That answer no longer exists.', 'not_found')
      return { ...a, liveText: streams.get(answerId)?.text }
    },
    async gateStatus() {
      return null
    },
    async cancel(input) {
      const { answerId } = validate('answers:cancel', input)
      streams.get(answerId)?.cancel()
      return { ok: true }
    },
    async list(input) {
      const { sessionId } = validate('answers:list', input)
      return load()
        .answers.filter((a) => a.sessionId === sessionId)
        .sort((a, b) => a.seq - b.seq)
    },
  },

  transcript: {
    async clear(input) {
      const { sessionId } = validate('transcript:clear', input)
      const cursorAt = now()
      mutate((db) => {
        getSessionRow(db, sessionId).transcriptCursorAt = cursorAt
      })
      if (live.sessionId === sessionId) live.finals = []
      return { cursorAt }
    },
    async get(input) {
      const { sessionId } = validate('transcript:get', input)
      const db = load()
      getSessionRow(db, sessionId)
      const items: TimelineItem[] = [
        ...db.segments.filter((s) => s.sessionId === sessionId).map((segment) => ({ kind: 'segment' as const, at: segment.spokenAt, segment })),
        ...db.answers
          .filter((a) => a.sessionId === sessionId && (a.status === 'done' || (a.status === 'cancelled' && a.answerMd)))
          .map((answer) => ({ kind: 'answer' as const, at: answer.createdAt, answer })),
      ]
      return items.sort((a, b) => a.at - b.at)
    },
    async export(input) {
      const { sessionId, format } = validate('transcript:export', input)
      const db = load()
      const s = getSessionRow(db, sessionId)
      const items = await api.transcript.get({ sessionId })
      const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const title = `${s.companyName ?? 'Call'}${s.roleTitle ? ` – ${s.roleTitle}` : ''}`
      const lines =
        format === 'md'
          ? [`# ${title}`, '', `${new Date(s.startedAt ?? s.createdAt).toLocaleString()}`, '']
          : [title, new Date(s.startedAt ?? s.createdAt).toLocaleString(), '']
      for (const it of items) {
        if (it.kind === 'segment') {
          const who = it.segment.speaker === 'you' ? 'You' : 'Them'
          lines.push(format === 'md' ? `**${who}** · ${time(it.at)}  \n${it.segment.text}` : `[${time(it.at)}] ${who}: ${it.segment.text}`, '')
        } else {
          lines.push(format === 'md' ? `> **Question:** ${it.answer.question ?? ''}\n>\n${it.answer.answerMd.split('\n').map((l) => `> ${l}`).join('\n')}` : `Question: ${it.answer.question ?? ''}\nAnswer:\n${it.answer.answerMd}`, '')
        }
      }
      const name = `${title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'transcript'}.${format}`
      const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = name
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 5000)
      return { path: name }
    },
    async delete(input) {
      const { sessionId } = validate('transcript:delete', input)
      if (live.sessionId === sessionId) throw new ApiError('End the call before clearing its transcript.', 'conflict')
      mutate((db) => {
        db.segments = db.segments.filter((s) => s.sessionId !== sessionId)
        db.answers = db.answers.filter((s) => s.sessionId !== sessionId)
      })
      changed('transcript')
      changed('sessions')
      return { ok: true }
    },
  },

  resumes: {
    async list() {
      return load()
        .resumes.slice()
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(({ id, title, source, fileSize, mdStatus, mdMethod, parseStatus, createdAt, updatedAt }) => ({
          id,
          title,
          source,
          fileSize,
          mdStatus,
          mdMethod,
          parseStatus,
          createdAt,
          updatedAt,
        }))
    },
    pickFile: picked('application/pdf,.pdf'),
    pathForFile: (file) => registerPicked(file),
    async importFile(input) {
      const { path, title } = validate('resumes:importFile', input)
      const file = takePicked(path)
      if (!file) throw new ApiError('That file is no longer available. Pick it again.', 'not_found')
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') throw new ApiError('Only PDF files can be uploaded as a resume.', 'validation', 'file')
      if (file.size === 0) throw new ApiError('That file is empty.', 'validation', 'file')
      if (file.size > LIMITS.fileBytes) throw new ApiError('That file is over 10 MB. Export a smaller PDF and try again.', 'validation', 'file')
      const buf = await file.arrayBuffer()
      const hash = await sha256(buf)
      const dupe = load().resumes.find((r) => r.contentHash === hash)
      if (dupe) return resumeOut(dupe, dupe.id)
      const id = uuid()
      for (let pct = 0; pct <= 100; pct += 20) {
        emitAll('resumes:progress', { id, stage: 'copying', pct })
        await sleep(90)
      }
      const filePath = `resumes/${id}.pdf`
      await fileStore.put(filePath, new Blob([buf], { type: 'application/pdf' }))
      const t = now()
      const row: ResumeRowStored = {
        id,
        title,
        source: 'pdf',
        filePath,
        fileSize: file.size,
        contentHash: hash,
        contentMd: '',
        mdStatus: 'converting',
        mdMethod: null,
        mdError: null,
        parseStatus: 'pending',
        parsed: null,
        parseError: null,
        createdAt: t,
        updatedAt: t,
      }
      mutate((db) => {
        db.resumes.push(row)
      })
      changed('resumes')
      await runResumeConvert(id)
      return resumeOut(load().resumes.find((r) => r.id === id)!)
    },
    async reconvert(input) {
      const { id } = validate('resumes:reconvert', input)
      const r = load().resumes.find((x) => x.id === id)
      if (!r) throw new ApiError('That resume no longer exists.', 'not_found')
      if (r.source !== 'pdf') throw new ApiError('Only uploaded PDFs can be reconverted.', 'conflict')
      await runResumeConvert(id)
      return resumeOut(load().resumes.find((x) => x.id === id)!)
    },
    async createFromText(input) {
      const { title, text } = validate('resumes:createFromText', input)
      const hash = await sha256(text)
      const dupe = load().resumes.find((r) => r.contentHash === hash)
      if (dupe) return resumeOut(dupe, dupe.id)
      const t = now()
      const row: ResumeRowStored = {
        id: uuid(),
        title,
        source: 'text',
        filePath: null,
        fileSize: null,
        contentHash: hash,
        contentMd: text,
        mdStatus: 'ready',
        mdMethod: 'manual',
        mdError: null,
        parseStatus: 'pending',
        parsed: null,
        parseError: null,
        createdAt: t,
        updatedAt: t,
      }
      mutate((db) => {
        db.resumes.push(row)
      })
      changed('resumes')
      void runResumeParse(row.id)
      return resumeOut(row)
    },
    async get(input) {
      const { id } = validate('resumes:get', input)
      const r = load().resumes.find((x) => x.id === id)
      if (!r) throw new ApiError('That resume no longer exists.', 'not_found')
      return resumeOut(r)
    },
    async update(input) {
      const { id, title, contentMd } = validate('resumes:update', input)
      const out = mutate((db) => {
        const r = db.resumes.find((x) => x.id === id)
        if (!r) throw new ApiError('That resume no longer exists.', 'not_found')
        if (title !== undefined) r.title = title
        if (contentMd !== undefined && contentMd !== r.contentMd) {
          r.contentMd = contentMd
          r.mdMethod = 'manual'
          r.mdStatus = 'ready'
          r.mdError = null
        }
        r.updatedAt = now()
        return r
      })
      changed('resumes')
      return resumeOut(out)
    },
    async delete(input) {
      const { id } = validate('resumes:delete', input)
      const r = load().resumes.find((x) => x.id === id)
      mutate((db) => {
        db.resumes = db.resumes.filter((x) => x.id !== id)
        for (const s of db.sessions) if (s.resumeId === id) s.resumeId = null
      })
      if (r?.filePath) await fileStore.delete(r.filePath).catch(() => {})
      changed('resumes')
      return { ok: true }
    },
    async parse(input) {
      const { id } = validate('resumes:parse', input)
      await runResumeParse(id)
      return resumeOut(load().resumes.find((x) => x.id === id)!)
    },
  },

  documents: {
    async list() {
      return load()
        .documents.slice()
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(({ id, title, source, fileSize, textStatus, createdAt, updatedAt }) => ({ id, title, source, fileSize, textStatus, createdAt, updatedAt }))
    },
    async get(input) {
      const { id } = validate('documents:get', input)
      const d = load().documents.find((x) => x.id === id)
      if (!d) throw new ApiError('That document no longer exists.', 'not_found')
      return docOut(d)
    },
    pickFile: picked('application/pdf,.pdf,.txt,.md,text/plain,text/markdown'),
    pathForFile: (file) => registerPicked(file),
    async importFile(input) {
      const { path, title } = validate('documents:importFile', input)
      const file = takePicked(path)
      if (!file) throw new ApiError('That file is no longer available. Pick it again.', 'not_found')
      const ext = file.name.split('.').pop()?.toLowerCase()
      if (!['pdf', 'txt', 'md'].includes(ext ?? '')) throw new ApiError('Use a PDF, TXT or MD file.', 'validation', 'file')
      if (file.size > LIMITS.fileBytes) throw new ApiError('That file is over 10 MB.', 'validation', 'file')
      const buf = await file.arrayBuffer()
      const hash = await sha256(buf)
      const dupe = load().documents.find((d) => d.contentHash === hash)
      if (dupe) return docOut(dupe, dupe.id)
      const id = uuid()
      emitAll('documents:progress', { id, stage: 'copying', pct: 50 })
      const filePath = `documents/${id}.${ext}`
      await fileStore.put(filePath, new Blob([buf], { type: file.type || 'application/octet-stream' }))
      emitAll('documents:progress', { id, stage: 'converting' })
      await sleep(ext === 'pdf' ? 1200 : 300)
      const text = ext === 'pdf' ? `${title}\n\n(Text extracted from the PDF appears here once the real extractor is wired in.)` : new TextDecoder().decode(buf)
      const t = now()
      const row: DocumentStored = {
        id,
        title,
        // schema.sql: source 'text' means typed, with no file, so an uploaded .txt is stored as markdown
        source: ext === 'pdf' ? 'pdf' : 'markdown',
        filePath,
        fileSize: file.size,
        contentHash: hash,
        rawText: text,
        textStatus: text.trim() ? 'ready' : 'empty',
        createdAt: t,
        updatedAt: t,
      }
      mutate((db) => {
        db.documents.push(row)
      })
      emitAll('documents:progress', { id, stage: 'ready' })
      changed('documents')
      return docOut(row)
    },
    async createFromText(input) {
      const { title, text } = validate('documents:createFromText', input)
      const t = now()
      const row: DocumentStored = {
        id: uuid(),
        title,
        source: 'text',
        filePath: null,
        fileSize: null,
        contentHash: await sha256(text),
        rawText: text,
        textStatus: 'ready',
        createdAt: t,
        updatedAt: t,
      }
      mutate((db) => {
        db.documents.push(row)
      })
      changed('documents')
      return docOut(row)
    },
    async update(input) {
      const { id, title, rawText } = validate('documents:update', input)
      const out = mutate((db) => {
        const d = db.documents.find((x) => x.id === id)
        if (!d) throw new ApiError('That document no longer exists.', 'not_found')
        if (title !== undefined) d.title = title
        if (rawText !== undefined) {
          d.rawText = rawText
          d.textStatus = rawText.trim() ? 'ready' : 'empty'
        }
        d.updatedAt = now()
        return d
      })
      changed('documents')
      return docOut(out)
    },
    async delete(input) {
      const { id } = validate('documents:delete', input)
      const d = load().documents.find((x) => x.id === id)
      mutate((db) => {
        db.documents = db.documents.filter((x) => x.id !== id)
        for (const s of db.sessions) s.documentIds = s.documentIds.filter((x) => x !== id)
      })
      if (d?.filePath) await fileStore.delete(d.filePath).catch(() => {})
      changed('documents')
      return { ok: true }
    },
  },

  prefs: {
    async preview(input) {
      const { prefs, questionType } = validate('prefs:preview', input)
      const previewId = uuid()
      const db = load()
      void (async () => {
        await sleep(hasScenario('slow') ? 3000 : 500)
        if (offline()) {
          emitLocal('prefs:previewDelta', { previewId, text: '', done: true })
          return
        }
        const { question, md } = previewFor(questionType, prefs, ctxFor(db, null))
        let acc = `**Question:** ${question}\n\n`
        emitLocal('prefs:previewDelta', { previewId, text: acc, done: false })
        for (const c of chunks(md)) {
          await sleep(25)
          acc += c
          emitLocal('prefs:previewDelta', { previewId, text: acc, done: false })
        }
        emitLocal('prefs:previewDelta', { previewId, text: acc, done: true })
      })()
      return { previewId }
    },
  },

  notes: {
    async get(input) {
      const { sessionId } = validate('notes:get', input)
      return load().notes.find((n) => n.sessionId === sessionId) ?? null
    },
    async generate(input) {
      const { sessionId } = validate('notes:generate', input)
      const db = load()
      const s = getSessionRow(db, sessionId)
      if (!db.segments.some((x) => x.sessionId === sessionId)) {
        throw new ApiError(s.saveTranscript ? 'There is no transcript to write notes from yet.' : 'Save transcript was off for this call, so there is nothing to summarise.', 'conflict')
      }
      void runNotes(sessionId)
      await sleep(20)
      return load().notes.find((n) => n.sessionId === sessionId)!
    },
    async clear(input) {
      const { sessionId } = validate('notes:clear', input)
      mutate((db) => {
        db.notes = db.notes.filter((n) => n.sessionId !== sessionId)
      })
      changed('notes')
      return { ok: true }
    },
  },

  review: {
    async list(input) {
      const { sessionId } = validate('review:list', input)
      return load()
        .review.filter((m) => m.sessionId === sessionId)
        .sort((a, b) => a.createdAt - b.createdAt)
    },
    async ask(input) {
      const { sessionId, message } = validate('review:ask', input)
      const db = load()
      getSessionRow(db, sessionId)
      const t = now()
      const user: ReviewMessage = { id: uuid(), sessionId, role: 'user', content: message, status: 'done', createdAt: t }
      const reply: ReviewMessage = { id: uuid(), sessionId, role: 'assistant', content: '', status: 'streaming', createdAt: t + 1 }
      mutate((d) => {
        d.review.push(user, reply)
      })
      void (async () => {
        await sleep(700)
        if (offline()) {
          mutate((d) => {
            const m = d.review.find((x) => x.id === reply.id)!
            Object.assign(m, { status: 'failed', content: 'No connection. Try again when you are back online.' })
          })
          emitLocal('review:delta', { messageId: reply.id, text: '', done: true })
          return
        }
        const text = reviewAnswer(
          message,
          db.segments.filter((s) => s.sessionId === sessionId).map((s) => s.text),
          db.answers.filter((a) => a.sessionId === sessionId && a.question).map((a) => a.question!),
        )
        let acc = ''
        for (const c of chunks(text)) {
          await sleep(35)
          acc += c
          emitLocal('review:delta', { messageId: reply.id, text: acc, done: false })
        }
        mutate((d) => {
          const m = d.review.find((x) => x.id === reply.id)!
          Object.assign(m, { status: 'done', content: acc })
        })
        emitLocal('review:delta', { messageId: reply.id, text: acc, done: true })
      })()
      return { messageId: reply.id }
    },
  },

  jobs: {
    async import(input) {
      const { url } = validate('jobs:import', input)
      await sleep(hasScenario('slow') ? 6000 : 1600)
      if (offline()) throw new ApiError('No connection. Paste the job description instead.', 'offline')
      if (/expired|404|closed/i.test(url) || hasScenario('job_fail')) {
        throw new ApiError("We couldn't find a job post on that page. It may be closed or need a login. Paste the description instead.", 'unreadable')
      }
      return importJob(url)
    },
  },

  companies: {
    async search(input) {
      const { q } = validate('companies:search', input)
      await sleep(200)
      return searchCompanies(q)
    },
  },

  mock: {
    async nextQuestion(input) {
      const { sessionId } = validate('mock:nextQuestion', input)
      const db = load()
      const s = getSessionRow(db, sessionId)
      if (s.status !== 'live' || live.sessionId !== sessionId || !live.stt) throw new ApiError('Start the mock interview first.', 'conflict')
      const asked = new Set(live.finals.filter((f) => f.speaker === 'them').map((f) => f.text))
      const bank = [
        `Thanks for joining. To start, can you tell me about yourself${s.roleTitle ? ` and why the ${s.roleTitle} role` : ''}?`,
        'Tell me about a time you disagreed with a teammate on a technical choice. What happened?',
        'How would you speed up a slow SQL query in production?',
        'What is dependency injection, and why would you use it?',
        'Explain how async and await work in C#.',
        'What is your biggest weakness, and what are you doing about it?',
        'Why do you want to join us?',
        'Here is a coding question: given an array and a target, find two numbers that add up to the target.',
      ]
      const q = bank.find((b) => !asked.has(b)) ?? 'That is all from me. Do you have any questions for us?'
      live.stt.say('them', q)
      const seg: Segment = { id: uuid(), sessionId, seq: -1, speaker: 'them', text: q, startMs: 0, endMs: 0, spokenAt: now() }
      return seg
    },
  },

  window: windowApi.api,

  on<E extends ApiEventName>(event: E, cb: (payload: ApiEvents[E]) => void) {
    return on(event, cb)
  },
}

/** Crash recovery job (architecture.md "Jobs"): run once when the overlay starts. */
export function recoverOnStartup() {
  const pendingNotes: string[] = []
  mutate((db) => {
    const t = now()
    for (const s of db.sessions) {
      if (s.status === 'live') {
        if (s.liveSince) s.activeMs += Math.min(t - s.liveSince, 4 * 60 * 60_000)
        s.status = 'left'
        s.liveSince = null
      }
    }
    for (const a of db.answers) if (a.status === 'streaming') a.status = 'cancelled'
    for (const n of db.notes) {
      if (n.status === 'generating' || n.status === 'pending') pendingNotes.push(n.sessionId)
    }
  })
  for (const id of pendingNotes) void runNotes(id)
}
