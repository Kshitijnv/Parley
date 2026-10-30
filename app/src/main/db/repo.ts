// Row <-> DTO mapping for the shared contract types (src/shared/types.ts). Every read
// and write of the database goes through the main process; these helpers keep the
// snake_case columns out of the handlers.
import { DEFAULT_ANSWER_ROUTING, DEFAULT_AUTO_POLICY, DEFAULT_CLOUD_STT, DEFAULT_HOTKEYS, DEFAULT_PREFS } from '@shared/catalog'
import type {
  Answer,
  AnswerEndReason,
  AnswerPrefs,
  AnswerRouting,
  AnswerTiming,
  AutoPolicy,
  CloudStt,
  DocumentFile,
  DocumentRow,
  Notes,
  ParsedResume,
  Resume,
  ResumeRow,
  ReviewMessage,
  Segment,
  Session,
  SessionCard,
  Settings,
} from '@shared/types'
import { AppError } from '../errors'
import { all, get, run } from './client'

const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string' || !v) return fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const bool = (v: unknown) => Number(v) === 1

export const now = () => Date.now()
export const uuid = () => crypto.randomUUID()

// ---------- settings ----------

export function ensureSettings() {
  const t = now()
  run('insert or ignore into settings (id, created_at, updated_at) values (1, ?, ?)', t, t)
}

function routingOf(v: unknown): AnswerRouting {
  const j = json<Partial<AnswerRouting>>(v, {})
  return { ...DEFAULT_ANSWER_ROUTING, ...j, switchOn: { ...DEFAULT_ANSWER_ROUTING.switchOn, ...(j.switchOn ?? {}) } }
}

export function getSettings(): Settings {
  ensureSettings()
  const r = get<Record<string, unknown>>('select * from settings where id = 1')!
  return {
    autoPolicy: { ...DEFAULT_AUTO_POLICY, ...json<Partial<AutoPolicy>>(r['auto_policy'], {}) },
    answerRouting: routingOf(r['answer_routing']),
    cloudStt: { ...DEFAULT_CLOUD_STT, ...json<Partial<CloudStt>>(r['cloud_stt'], {}) },
    theme: r['theme'] as Settings['theme'],
    zoom: Number(r['zoom']),
    privateMode: bool(r['private_mode']),
    overlayOpacity: Number(r['overlay_opacity']),
    defaultLanguage: String(r['default_language']),
    defaultModel: String(r['default_model']),
    visionModel: String(r['vision_model']),
    sttProvider: r['stt_provider'] as Settings['sttProvider'],
    defaultAnswerPrefs: { ...DEFAULT_PREFS, ...json<Partial<AnswerPrefs>>(r['default_answer_prefs'], {}) },
    hotkeys: { ...DEFAULT_HOTKEYS, ...json<Partial<Settings['hotkeys']>>(r['hotkeys'], {}) },
    overlayBounds: json(r['overlay_bounds'], null),
    lastBackupAt: num(r['last_backup_at']),
    updatedAt: Number(r['updated_at']),
  }
}

const SETTING_COLUMNS: Record<string, [string, (v: any) => string | number | null]> = {
  theme: ['theme', String],
  zoom: ['zoom', Number],
  privateMode: ['private_mode', (v) => (v ? 1 : 0)],
  overlayOpacity: ['overlay_opacity', Number],
  defaultLanguage: ['default_language', String],
  defaultModel: ['default_model', String],
  visionModel: ['vision_model', String],
  sttProvider: ['stt_provider', String],
  defaultAnswerPrefs: ['default_answer_prefs', (v) => JSON.stringify(v)],
  hotkeys: ['hotkeys', (v) => JSON.stringify(v)],
  overlayBounds: ['overlay_bounds', (v) => (v ? JSON.stringify(v) : null)],
  lastBackupAt: ['last_backup_at', (v) => (v === null ? null : Number(v))],
  autoPolicy: ['auto_policy', (v) => JSON.stringify(v)],
  answerRouting: ['answer_routing', (v) => JSON.stringify(v)],
  cloudStt: ['cloud_stt', (v) => JSON.stringify(v)],
}

export function patchSettings(patch: Partial<Omit<Settings, 'autoPolicy' | 'cloudStt'>> & { autoPolicy?: Partial<AutoPolicy>; cloudStt?: Partial<CloudStt> }): Settings {
  ensureSettings()
  // A partial policy merges into the stored one.
  if (patch.autoPolicy) patch = { ...patch, autoPolicy: { ...getSettings().autoPolicy, ...patch.autoPolicy } }
  if (patch.cloudStt) patch = { ...patch, cloudStt: { ...getSettings().cloudStt, ...patch.cloudStt } }
  const sets: string[] = []
  const vals: Array<string | number | null> = []
  for (const [k, v] of Object.entries(patch)) {
    const col = SETTING_COLUMNS[k]
    if (!col || v === undefined) continue
    sets.push(`${col[0]} = ?`)
    vals.push(col[1](v))
  }
  if (sets.length) run(`update settings set ${sets.join(', ')}, updated_at = ? where id = 1`, ...vals, now())
  return getSettings()
}

// ---------- sessions ----------

export type SessionDb = Omit<Session, 'resumeTitle' | 'documentIds'>

function sessionFromRow(r: Record<string, unknown>): SessionDb {
  return {
    id: String(r['id']),
    type: r['type'] as Session['type'],
    companyName: (r['company_name'] as string | null) ?? null,
    companyDomain: (r['company_domain'] as string | null) ?? null,
    roleTitle: (r['role_title'] as string | null) ?? null,
    jobUrl: (r['job_url'] as string | null) ?? null,
    jobDescription: String(r['job_description'] ?? ''),
    resumeId: (r['resume_id'] as string | null) ?? null,
    language: String(r['language']),
    model: String(r['model']),
    answerPrefs: { ...DEFAULT_PREFS, ...json<Partial<AnswerPrefs>>(r['answer_prefs'], {}) },
    instructions: String(r['instructions'] ?? ''),
    autoGenerate: bool(r['auto_generate']),
    saveTranscript: bool(r['save_transcript']),
    status: r['status'] as Session['status'],
    startedAt: num(r['started_at']),
    endedAt: num(r['ended_at']),
    activeMs: Number(r['active_ms'] ?? 0),
    liveSince: num(r['live_since']),
    transcriptCursorAt: num(r['transcript_cursor_at']),
    createdAt: Number(r['created_at']),
    updatedAt: Number(r['updated_at']),
  }
}

export function findSession(id: string): SessionDb | null {
  const r = get<Record<string, unknown>>('select * from sessions where id = ?', id)
  return r ? sessionFromRow(r) : null
}

export function requireSession(id: string): SessionDb {
  const s = findSession(id)
  if (!s) throw new AppError('That session no longer exists.', 'not_found')
  return s
}

export function sessionOut(s: SessionDb): Session {
  const resumeTitle = s.resumeId ? (get<{ title: string }>('select title from resumes where id = ?', s.resumeId)?.title ?? null) : null
  const documentIds = all<{ document_id: string }>('select document_id from session_documents where session_id = ? order by created_at', s.id).map((d) => d.document_id)
  return { ...s, resumeTitle, documentIds }
}

export function sessionCards(q: string | undefined, sort: 'newest' | 'oldest' | undefined): SessionCard[] {
  const needle = q?.trim().toLowerCase()
  const like = needle ? `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null
  const rows = all<Record<string, unknown>>(
    `select s.*,
       exists(select 1 from transcript_segments t where t.session_id = s.id) as has_transcript,
       (select count(*) from answers a where a.session_id = s.id and a.status <> 'failed') as answer_count
     from sessions s
     where s.status <> 'draft'
       ${like ? `and (lower(coalesce(s.company_name,'')) like ? escape '\\' or lower(coalesce(s.role_title,'')) like ? escape '\\' or lower(s.job_description) like ? escape '\\')` : ''}
     order by coalesce(s.started_at, s.created_at) ${sort === 'oldest' ? 'asc' : 'desc'}`,
    ...(like ? [like, like, like] : []),
  )
  const t = now()
  return rows.map((r) => {
    const s = sessionFromRow(r)
    return {
      id: s.id,
      type: s.type,
      companyName: s.companyName,
      companyDomain: s.companyDomain,
      roleTitle: s.roleTitle,
      status: s.status,
      hasTranscript: bool(r['has_transcript']),
      answerCount: Number(r['answer_count']),
      activeMs: s.activeMs + (s.status === 'live' && s.liveSince ? t - s.liveSince : 0),
      startedAt: s.startedAt,
      createdAt: s.createdAt,
    }
  })
}

// ---------- segments ----------

export function segmentFromRow(r: Record<string, unknown>): Segment {
  return {
    id: String(r['id']),
    sessionId: String(r['session_id']),
    seq: Number(r['seq']),
    speaker: r['speaker'] as Segment['speaker'],
    text: String(r['text']),
    startMs: Number(r['start_ms']),
    endMs: Number(r['end_ms']),
    spokenAt: Number(r['spoken_at']),
  }
}

export function segmentsFor(sessionId: string): Segment[] {
  return all<Record<string, unknown>>('select * from transcript_segments where session_id = ? order by seq', sessionId).map(segmentFromRow)
}

export function nextSegmentSeq(sessionId: string): number {
  return Number(get<{ n: number | null }>('select max(seq) as n from transcript_segments where session_id = ?', sessionId)?.n ?? -1) + 1
}

export function insertSegments(segs: Segment[]) {
  const t = now()
  const stmt = 'insert or ignore into transcript_segments (id, session_id, seq, speaker, text, start_ms, end_ms, spoken_at, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?)'
  for (const s of segs) run(stmt, s.id, s.sessionId, s.seq, s.speaker, s.text, s.startMs, Math.max(s.startMs, s.endMs), s.spokenAt, t, t)
}

// ---------- answers ----------

export function answerFromRow(r: Record<string, unknown>): Answer {
  return {
    id: String(r['id']),
    sessionId: String(r['session_id']),
    seq: Number(r['seq']),
    trigger: r['trigger'] as Answer['trigger'],
    status: r['status'] as Answer['status'],
    transcriptExcerpt: String(r['transcript_excerpt'] ?? ''),
    userPrompt: (r['user_prompt'] as string | null) ?? null,
    screenshotPath: (r['screenshot_path'] as string | null) ?? null,
    question: (r['question'] as string | null) ?? null,
    answerMd: String(r['answer_md'] ?? ''),
    model: String(r['model']),
    answerPrefs: { ...DEFAULT_PREFS, ...json<Partial<AnswerPrefs>>(r['answer_prefs'], {}) },
    error: (r['error'] as string | null) ?? null,
    firstTokenMs: num(r['first_token_ms']),
    latencyMs: num(r['latency_ms']),
    createdAt: Number(r['created_at']),
    turnId: (r['turn_id'] as string | null) ?? null,
    questionKey: (r['question_key'] as string | null) ?? null,
    attempts: Number(r['attempts'] ?? 1),
    endReason: (r['end_reason'] as AnswerEndReason | null) ?? null,
    retryOf: (r['retry_of'] as string | null) ?? null,
    servedModel: (r['served_model'] as string | null) ?? null,
    fallbackReason: (r['fallback_reason'] as Answer['fallbackReason']) ?? null,
    timing: json<AnswerTiming | null>(r['timing'], null),
  }
}

export function getAnswer(id: string): Answer | null {
  const r = get<Record<string, unknown>>('select * from answers where id = ?', id)
  return r ? answerFromRow(r) : null
}

export function answersFor(sessionId: string): Answer[] {
  return all<Record<string, unknown>>('select * from answers where session_id = ? order by seq', sessionId).map(answerFromRow)
}

// ---------- resumes ----------

export type ResumeDb = Omit<Resume, 'fileUrl' | 'duplicateOf'>

export function resumeFromRow(r: Record<string, unknown>): ResumeDb {
  return {
    id: String(r['id']),
    title: String(r['title']),
    source: r['source'] as Resume['source'],
    filePath: (r['file_path'] as string | null) ?? null,
    fileSize: num(r['file_size']),
    contentHash: String(r['content_hash']),
    contentMd: String(r['content_md'] ?? ''),
    mdStatus: r['md_status'] as Resume['mdStatus'],
    mdMethod: (r['md_method'] as Resume['mdMethod']) ?? null,
    mdError: (r['md_error'] as string | null) ?? null,
    parseStatus: r['parse_status'] as Resume['parseStatus'],
    parsed: json<ParsedResume | null>(r['parsed'], null),
    parseError: (r['parse_error'] as string | null) ?? null,
    createdAt: Number(r['created_at']),
    updatedAt: Number(r['updated_at']),
  }
}

export function findResume(id: string): ResumeDb | null {
  const r = get<Record<string, unknown>>('select * from resumes where id = ?', id)
  return r ? resumeFromRow(r) : null
}

export function requireResume(id: string): ResumeDb {
  const r = findResume(id)
  if (!r) throw new AppError('That resume no longer exists.', 'not_found')
  return r
}

export function resumeOut(r: ResumeDb, duplicateOf?: string): Resume {
  return { ...r, fileUrl: r.filePath ? `app-file://files/${r.filePath}` : null, ...(duplicateOf ? { duplicateOf } : {}) }
}

export function resumeRows(): ResumeRow[] {
  return all<Record<string, unknown>>('select id, title, source, file_size, md_status, md_method, parse_status, created_at, updated_at from resumes order by created_at desc').map((r) => ({
    id: String(r['id']),
    title: String(r['title']),
    source: r['source'] as Resume['source'],
    fileSize: num(r['file_size']),
    mdStatus: r['md_status'] as Resume['mdStatus'],
    mdMethod: (r['md_method'] as Resume['mdMethod']) ?? null,
    parseStatus: r['parse_status'] as Resume['parseStatus'],
    createdAt: Number(r['created_at']),
    updatedAt: Number(r['updated_at']),
  }))
}

// ---------- documents ----------

export type DocumentDb = Omit<DocumentFile, 'fileUrl' | 'duplicateOf'>

export function documentFromRow(r: Record<string, unknown>): DocumentDb {
  return {
    id: String(r['id']),
    title: String(r['title']),
    source: r['source'] as DocumentFile['source'],
    filePath: (r['file_path'] as string | null) ?? null,
    fileSize: num(r['file_size']),
    contentHash: String(r['content_hash']),
    rawText: String(r['raw_text'] ?? ''),
    textStatus: r['text_status'] as DocumentFile['textStatus'],
    createdAt: Number(r['created_at']),
    updatedAt: Number(r['updated_at']),
  }
}

export function findDocument(id: string): DocumentDb | null {
  const r = get<Record<string, unknown>>('select * from documents where id = ?', id)
  return r ? documentFromRow(r) : null
}

export function documentOut(d: DocumentDb, duplicateOf?: string): DocumentFile {
  return { ...d, fileUrl: d.filePath ? `app-file://files/${d.filePath}` : null, ...(duplicateOf ? { duplicateOf } : {}) }
}

export function documentRows(): DocumentRow[] {
  return all<Record<string, unknown>>('select id, title, source, file_size, text_status, created_at, updated_at from documents order by created_at desc').map((r) => ({
    id: String(r['id']),
    title: String(r['title']),
    source: r['source'] as DocumentFile['source'],
    fileSize: num(r['file_size']),
    textStatus: r['text_status'] as DocumentFile['textStatus'],
    createdAt: Number(r['created_at']),
    updatedAt: Number(r['updated_at']),
  }))
}

// ---------- notes / review ----------

export function notesFor(sessionId: string): Notes | null {
  const r = get<Record<string, unknown>>('select * from session_notes where session_id = ?', sessionId)
  if (!r) return null
  const questions = json<Array<{ question: string; response_note?: string; responseNote?: string }> | null>(r['questions'], null)
  return {
    sessionId,
    status: r['status'] as Notes['status'],
    details: json(r['details'], null),
    summary: (r['summary'] as string | null) ?? null,
    questions: questions ? questions.map((q) => ({ question: q.question, responseNote: q.responseNote ?? q.response_note ?? '' })) : null,
    nextSteps: json(r['next_steps'], null),
    error: (r['error'] as string | null) ?? null,
    generatedAt: num(r['generated_at']),
  }
}

export function reviewFor(sessionId: string): ReviewMessage[] {
  return all<Record<string, unknown>>('select * from review_messages where session_id = ? order by created_at', sessionId).map((r) => ({
    id: String(r['id']),
    sessionId,
    role: r['role'] as ReviewMessage['role'],
    content: String(r['content']),
    status: r['status'] as ReviewMessage['status'],
    createdAt: Number(r['created_at']),
  }))
}
