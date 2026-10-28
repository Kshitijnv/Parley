// Entity and DTO types for the renderer <-> main contract (architecture.md "API").
// Field names follow replica/schema.sql in camelCase. Times are UTC epoch ms.

export type Theme = 'light' | 'dark' | 'system'
export type Provider = 'google' | 'openai' | 'anthropic' | 'groq' | 'deepgram' | 'logodev'
export type SessionType = 'interview' | 'regular' | 'mock'
export type SessionStatus = 'draft' | 'live' | 'left' | 'ended'
export type Speaker = 'you' | 'them'
export type AnswerTrigger = 'answer' | 'screenshot' | 'chat' | 'auto'
export type AnswerStatus = 'streaming' | 'done' | 'cancelled' | 'failed'
export type QuestionType = 'behavioural' | 'technical' | 'coding' | 'introduction'

export interface AnswerPrefs {
  format: 'full_script' | 'script_bullets' | 'bullets'
  star: boolean
  filler_words: boolean
  length: 'short' | 'balanced' | 'long'
  tone: 'simple' | 'formal'
}

export type HotkeyAction =
  | 'answer'
  | 'screenshot'
  | 'chat'
  | 'clear_transcript'
  | 'clear_answer'
  | 'history_prev'
  | 'history_next'
  | 'move_up'
  | 'move_down'
  | 'move_left'
  | 'move_right'

export type Hotkeys = Record<HotkeyAction, string>

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** architecture.md revision 2 §4–§5: question detection and automatic-request policy. */
export interface AutoPolicy {
  settleMs: number
  settleQuestionMarkMs: number
  joinGapMs: number
  minWords: number
  maxTurnChars: number
  followupWindowMs: number
  autoCooldownMs: number
  autoMaxPerMinute: number
  autoMaxPerSession: number
  dedupeWindowMs: number
  similarity: number
  manualMinIntervalMs: number
  staleCandidateMs: number
  /** Revision 4 A2: a question this short (words) still counts if its shape is a question. */
  shortQuestionMinWords: number
  /** Revision 4 A3: questions one queued request may combine. */
  maxMergedQuestions: number
}

/** Revision 4 A4.3: opt-in switch to another model before the first token. */
export interface AnswerRouting {
  /** null = off (the default). */
  fallbackModel: string | null
  fallbackAfterMs: number
  switchOn: { slowFirstToken: boolean; overloaded: boolean; rateLimited: boolean; auth: boolean; notFound: boolean }
  stickyAfterSlow: number
  stickyWindowMs: number
}

export type FallbackReason = 'slow_first_token' | 'overloaded' | 'rate_limited' | 'auth' | 'not_found'

/** Revision 4 A4.1: per-answer stage timings in ms (numbers only). */
export interface AnswerTiming {
  sttMs?: number
  settleMs?: number
  gateWaitMs?: number
  queueWaitMs?: number
  pressToAcceptMs?: number
  buildMs?: number
  /** Request → first token, one entry per attempt (null: that attempt had none). */
  ttftMs: Array<number | null>
  headerMs?: number
  streamMs?: number
  attempts: number
  /** Revision 5 D5: text deltas from the provider, the longest gap between them, first answer text → lead complete. */
  chunks?: number
  maxChunkGapMs?: number
  leadMs?: number
  /** Revision 6 M3: prompt size, cache hits and thinking tokens; M1: the thinking setting sent. */
  inputTokens?: number
  cachedTokens?: number
  reasoningTokens?: number
  thinking?: 'minimum' | 'default'
}

export interface Settings {
  autoPolicy: AutoPolicy
  answerRouting: AnswerRouting
  theme: Theme
  zoom: number
  privateMode: boolean
  overlayOpacity: number
  defaultLanguage: string
  defaultModel: string
  visionModel: string
  sttProvider: 'local' | 'deepgram'
  defaultAnswerPrefs: AnswerPrefs
  hotkeys: Hotkeys
  overlayBounds: Bounds | null
  lastBackupAt: number | null
  updatedAt: number
}

export interface KeyStatus {
  provider: Provider
  last4: string
  verifiedAt: number | null
  /** 'env': read from .env.local in a development build; it can't be removed in Settings. */
  source?: 'saved' | 'env'
}

export interface Model {
  id: string // "<provider>:<model id>"
  provider: Provider
  label: string
  vision: boolean
  speed: 'fastest' | 'fast' | 'balanced' | 'smartest'
}

export interface Language {
  code: string
  label: string
  /** STT providers that can transcribe it. The local model is English only. */
  stt: Array<'local' | 'deepgram'>
}

export interface Resume {
  id: string
  title: string
  source: 'pdf' | 'text'
  filePath: string | null
  fileSize: number | null
  fileUrl: string | null // app-file:// URL for the PDF preview
  contentHash: string
  contentMd: string
  mdStatus: 'pending' | 'converting' | 'ready' | 'failed'
  mdMethod: 'ai' | 'text_extract' | 'manual' | null
  mdError: string | null
  parseStatus: 'pending' | 'parsing' | 'ready' | 'failed' | 'skipped'
  parsed: ParsedResume | null
  parseError: string | null
  createdAt: number
  updatedAt: number
  duplicateOf?: string
}

export type ResumeRow = Pick<
  Resume,
  'id' | 'title' | 'source' | 'fileSize' | 'mdStatus' | 'mdMethod' | 'parseStatus' | 'createdAt' | 'updatedAt'
>

export interface ParsedResume {
  contact: { name: string; headline?: string; email?: string; phone?: string; location?: string }
  summary: string
  experience: Array<{ role: string; company: string; period: string; highlights: string[] }>
  skills: Record<string, string[]>
  projects: Array<{ name: string; description: string }>
}

export interface DocumentFile {
  id: string
  title: string
  source: 'pdf' | 'text' | 'markdown'
  filePath: string | null
  fileSize: number | null
  fileUrl: string | null
  contentHash: string
  rawText: string
  textStatus: 'pending' | 'ready' | 'empty' | 'failed'
  createdAt: number
  updatedAt: number
  duplicateOf?: string
}

export type DocumentRow = Pick<DocumentFile, 'id' | 'title' | 'source' | 'fileSize' | 'textStatus' | 'createdAt' | 'updatedAt'>

export interface Session {
  id: string
  type: SessionType
  companyName: string | null
  companyDomain: string | null
  roleTitle: string | null
  jobUrl: string | null
  jobDescription: string
  resumeId: string | null
  resumeTitle: string | null
  documentIds: string[]
  language: string
  model: string
  answerPrefs: AnswerPrefs
  instructions: string
  autoGenerate: boolean
  saveTranscript: boolean
  status: SessionStatus
  startedAt: number | null
  endedAt: number | null
  activeMs: number
  /** Wall-clock time the current live stretch began; null unless live. Kept in memory by main. */
  liveSince: number | null
  transcriptCursorAt: number | null
  createdAt: number
  updatedAt: number
}

export interface SessionCard {
  id: string
  type: SessionType
  companyName: string | null
  companyDomain: string | null
  roleTitle: string | null
  status: SessionStatus
  hasTranscript: boolean
  answerCount: number
  activeMs: number
  startedAt: number | null
  createdAt: number
}

export interface CreateSessionInput {
  type: SessionType
  companyName: string | null
  companyDomain: string | null
  roleTitle: string | null
  jobUrl: string | null
  jobDescription: string
  resumeId: string | null
  documentIds: string[]
  language: string
  model: string
  answerPrefs?: AnswerPrefs
  instructions: string
  autoGenerate: boolean
  saveTranscript: boolean
}

export interface Segment {
  id: string
  sessionId: string
  seq: number
  speaker: Speaker
  text: string
  startMs: number
  endMs: number
  spokenAt: number
}

export interface Answer {
  id: string
  sessionId: string
  seq: number
  trigger: AnswerTrigger
  status: AnswerStatus
  transcriptExcerpt: string
  userPrompt: string | null
  screenshotPath: string | null
  question: string | null
  answerMd: string
  model: string
  answerPrefs: AnswerPrefs
  error: string | null
  firstTokenMs: number | null
  latencyMs: number | null
  createdAt: number
  /** Revision 2 (migration 0002). Optional so the demo data layer can leave them out. */
  turnId?: string | null
  questionKey?: string | null
  attempts?: number
  endReason?: AnswerEndReason | null
  retryOf?: string | null
  /** Revision 4 (migration 0003): the model that wrote the text when a fallback served it. */
  servedModel?: string | null
  fallbackReason?: FallbackReason | null
  timing?: AnswerTiming | null
}

export type AnswerErrorCode =
  | 'no_key'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'overloaded'
  | 'auth'
  | 'interrupted'
  | 'timeout'
  | 'offline'
  | 'provider_error'
  | 'cancelled'

export type AnswerEndReason =
  | 'completed'
  | 'user_cancel'
  | 'superseded'
  | 'session_end'
  | 'timeout'
  | 'interrupted'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'overloaded'
  | 'offline'
  | 'auth'
  | 'provider_error'

export type GateReason =
  | 'not_live'
  | 'quota_exhausted'
  | 'cooling'
  | 'offline'
  | 'joined'
  | 'duplicate'
  | 'no_new_material'
  | 'auto_off'
  | 'rate_cap'
  | 'budget'
  | 'stale'
  | 'too_soon'
  | 'auth_failed'
  | 'merged'
  | 'replaced'
  | 'session_end'

/** answers:generate result. A suppressed request is a result, not an error. */
export interface GenerateResult {
  outcome: 'started' | 'joined' | 'reused' | 'suppressed'
  answerId?: string
  seq?: number
  reason?: GateReason
  /** Epoch ms when a cooling model may be called again. */
  retryAt?: number
  /** Short user-facing explanation for joined / reused / suppressed. */
  message?: string
}

export type ProviderState = 'ok' | 'cooling' | 'exhausted' | 'offline' | 'auth_failed'

export interface GateStatus {
  sessionId: string
  auto: 'on' | 'off' | 'cooldown' | 'queued' | 'paused_budget' | 'paused_quota' | 'paused_auth' | 'paused_offline'
  /** 'fallback' while the session's model is blocked and the fallback serves (revision 4 A1). */
  route?: 'primary' | 'fallback'
  provider: ProviderState
  retryAt?: number
  counts: { auto: number; manual: number; suppressed: number; merged: number; replaced: number; stale: number }
  /** `count`: questions in a merged request. */
  last?: { outcome: GenerateResult['outcome'] | 'merged' | 'replaced'; reason?: GateReason; at: number; count?: number }
  /** A request with no first token yet, after 3 s (revision 4 A4.1). `since`: epoch ms of the request. */
  waiting?: { answerId: string; model: string; since: number }
}

export interface SttModelInfo {
  id: string
  language: 'en' | 'hi' | null
  label: string
  sizeMb: number
  licence: string
  attribution: string
  status: 'absent' | 'downloading' | 'installed' | 'failed' | 'corrupt'
  /** Set only for models that can be picked for a session. */
  selectable: boolean
  /** Why a model isn't selectable yet (e.g. Hindi not verified). */
  note?: string
  filesVerifiedAt: number | null
  recognitionVerifiedAt: number | null
  error?: string | null
}

export interface SttStatus {
  state: SttState
  error?: string
  /** The model the worker actually loaded (revision 2 §10). */
  modelId?: string
  language?: string
  loadMs?: number
}

export interface Notes {
  sessionId: string
  status: 'pending' | 'generating' | 'ready' | 'failed'
  details: { company: string | null; position: string | null } | null
  summary: string | null
  questions: Array<{ question: string; responseNote: string }> | null
  nextSteps: string[] | null
  error: string | null
  generatedAt: number | null
}

export interface ReviewMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  status: 'streaming' | 'done' | 'failed'
  createdAt: number
}

export type TimelineItem =
  | { kind: 'segment'; at: number; segment: Segment }
  | { kind: 'answer'; at: number; answer: Answer }

export type SttState = 'starting' | 'listening' | 'reconnecting' | 'error' | 'stopped'

/** What Private mode can do on this OS (architecture.md revision 3 P4). */
export interface PrivacyCapability {
  mode: 'exclude' | 'blackbox' | 'best_effort' | 'unsupported'
  /** Shown next to the toggle; null when there's nothing to warn about. */
  reason: string | null
}

export interface WindowState {
  hidden: boolean
  snappedZone: number | null
  bounds: Bounds | null
  privateMode: boolean
  privacy: PrivacyCapability
}

export interface PickedFile {
  path: string
  name: string
  size: number
}

export interface CompanyHit {
  name: string
  domain: string
  logoUrl: string | null
}

export interface ImportProgress {
  id: string
  stage: 'copying' | 'converting' | 'ready' | 'failed'
  pct?: number
}
