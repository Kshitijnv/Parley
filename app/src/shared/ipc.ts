// Channel names and zod input schemas: the single source of truth for every call
// between a window and main (architecture.md "IPC contract"). The mock data layer
// validates with these same schemas, so a bad input fails the same way in both.
import { z } from 'zod'

export const LIMITS = {
  fileBytes: 10 * 1024 * 1024,
  jobDescription: 50_000,
  instructions: 20_000,
  title: 200,
  company: 200,
} as const

const id = z.string().min(1)
const provider = z.enum(['google', 'openai', 'anthropic', 'groq', 'deepgram', 'logodev'])

export const answerPrefsSchema = z.object({
  format: z.enum(['full_script', 'script_bullets', 'bullets']),
  star: z.boolean(),
  filler_words: z.boolean(),
  length: z.enum(['short', 'balanced', 'long']),
  tone: z.enum(['simple', 'formal']),
})

const boundsSchema = z.object({ x: z.number(), y: z.number(), width: z.number().min(1), height: z.number().min(1) })

const int = (min: number, max: number) => z.number().int().min(min).max(max)
export const autoPolicySchema = z.object({
  settleMs: int(300, 4000),
  settleQuestionMarkMs: int(100, 4000),
  joinGapMs: int(500, 10000),
  minWords: int(1, 20),
  maxTurnChars: int(200, 5000),
  followupWindowMs: int(0, 120000),
  autoCooldownMs: int(1000, 120000),
  autoMaxPerMinute: int(1, 30),
  autoMaxPerSession: int(1, 1000),
  dedupeWindowMs: int(0, 600000),
  similarity: z.number().min(0.3).max(1),
  manualMinIntervalMs: int(0, 10000),
  staleCandidateMs: int(2000, 120000),
  shortQuestionMinWords: int(1, 20),
  maxMergedQuestions: int(1, 5),
})

export const answerRoutingSchema = z.object({
  fallbackModel: z.string().includes(':').nullable(),
  fallbackAfterMs: int(3000, 20000),
  switchOn: z.object({ slowFirstToken: z.boolean(), overloaded: z.boolean(), rateLimited: z.boolean(), auth: z.boolean(), notFound: z.boolean() }).partial(),
  stickyAfterSlow: int(1, 10),
  stickyWindowMs: int(10000, 600000),
})

export const cloudSttSchema = z.object({
  enabled: z.boolean(),
  consentedAt: z.number().int().nullable(),
  maxDelayS: z.number().min(0.7).max(4),
  eouSilenceS: z.number().min(0.2).max(2),
  vocab: z.boolean(),
  minLeftMin: int(0, 600),
})

const modelId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/)

export const settingsPatchSchema = z
  .object({
    theme: z.enum(['light', 'dark', 'system']),
    zoom: z.number().min(0.5).max(2),
    privateMode: z.boolean(),
    overlayOpacity: z.number().min(0.78).max(1),
    defaultLanguage: z.string().min(2),
    defaultModel: z.string().includes(':'),
    visionModel: z.string().includes(':'),
    sttProvider: z.enum(['local', 'deepgram']),
    defaultAnswerPrefs: answerPrefsSchema,
    hotkeys: z.record(z.string(), z.string()),
    overlayBounds: boundsSchema.nullable(),
    autoPolicy: autoPolicySchema.partial(),
    answerRouting: answerRoutingSchema.partial(),
    cloudStt: cloudSttSchema.partial(),
  })
  .partial()

export const createSessionSchema = z.object({
  type: z.enum(['interview', 'regular', 'mock']),
  companyName: z.string().trim().max(LIMITS.company).nullable(),
  companyDomain: z.string().nullable(),
  roleTitle: z.string().trim().max(LIMITS.title).nullable(),
  jobUrl: z.string().url().nullable(),
  jobDescription: z.string().max(LIMITS.jobDescription),
  resumeId: z.string().nullable(),
  documentIds: z.array(id),
  language: z.string().min(2),
  model: z.string().includes(':'),
  answerPrefs: answerPrefsSchema.optional(),
  instructions: z.string().max(LIMITS.instructions),
  autoGenerate: z.boolean(),
  saveTranscript: z.boolean(),
})

export const schemas = {
  'settings:update': settingsPatchSchema,
  'keys:set': z.object({ provider, key: z.string().trim().min(8, 'That key looks too short.') }),
  'keys:test': z.object({ provider }),
  'keys:delete': z.object({ provider }),
  // revision 7 S4/S6: cloud speech keys (Speechmatics), up to 5, tried in order
  'speechKeys:add': z.object({
    key: z.string().trim().min(16, 'That key looks too short.').max(200).regex(/^\S+$/, 'Paste the key without spaces.'),
    label: z.string().trim().max(40),
    budgetHours: z.number().min(0.1).max(10_000).nullable(),
  }),
  'speechKeys:update': z.object({ id, label: z.string().trim().max(40).optional(), budgetHours: z.number().min(0.1).max(10_000).nullable().optional() }),
  'speechKeys:test': z.object({ id }),
  'speechKeys:move': z.object({ id, by: z.union([z.literal(-1), z.literal(1)]) }),
  'speechKeys:remove': z.object({ id }),
  'sessions:list': z.object({ q: z.string().optional(), sort: z.enum(['newest', 'oldest']).optional() }),
  'sessions:get': z.object({ id }),
  'sessions:create': createSessionSchema,
  'sessions:update': z.object({ id, patch: createSessionSchema.partial() }),
  'sessions:delete': z.object({ id }),
  'sessions:start': z.object({ id, micDeviceId: z.string().optional() }),
  'sessions:end': z.object({ id, mode: z.enum(['leave', 'end']) }),
  'sessions:rejoin': z.object({ id }),
  'audio:frame': z.object({ speaker: z.enum(['you', 'them']), pcm: z.instanceof(ArrayBuffer) }),
  'answers:generate': z
    .object({
      sessionId: id,
      // 'auto' only comes from main's TurnDetector; a window can't submit it.
      trigger: z.enum(['answer', 'screenshot', 'chat']),
      text: z.string().trim().min(1).max(4000).optional(),
      force: z.boolean().optional(),
      clientRequestId: z.string().uuid(),
      /** Retry of a failed or interrupted answer: forces a new request linked by retry_of. */
      retryOf: id.optional(),
      /** Revision 4 A4.3: the user chose "Answer with <fallback>" (e.g. after a daily quota). */
      useFallback: z.boolean().optional(),
    })
    .refine((v) => v.trigger !== 'chat' || !!v.text, { message: 'Type a question first.', path: ['text'] }),
  'answers:cancel': z.object({ answerId: id }),
  'answers:list': z.object({ sessionId: id }),
  'answers:get': z.object({ answerId: id }),
  'gate:status': z.object({ sessionId: id }),
  'stt:downloadModel': z.object({ modelId }),
  'stt:cancelDownload': z.object({ modelId }),
  'stt:deleteModel': z.object({ modelId }),
  'stt:verifyFiles': z.object({ modelId }),
  'stt:prepare': z.object({ sessionId: id }),
  'transcript:clear': z.object({ sessionId: id }),
  'transcript:get': z.object({ sessionId: id }),
  'transcript:export': z.object({ sessionId: id, format: z.enum(['md', 'txt']) }),
  'transcript:delete': z.object({ sessionId: id }),
  'resumes:importFile': z.object({ path: z.string().min(1), title: z.string().trim().min(1, 'Give it a title.').max(LIMITS.title) }),
  'resumes:reconvert': z.object({ id }),
  'resumes:createFromText': z.object({
    title: z.string().trim().min(1, 'Give it a title.').max(LIMITS.title),
    text: z.string().trim().min(40, 'Paste the full resume: at least a few lines.').max(60_000),
  }),
  'resumes:get': z.object({ id }),
  'resumes:update': z.object({
    id,
    title: z.string().trim().min(1).max(LIMITS.title).optional(),
    contentMd: z.string().max(60_000).optional(),
  }),
  'resumes:delete': z.object({ id }),
  'resumes:parse': z.object({ id }),
  'documents:get': z.object({ id }),
  'documents:importFile': z.object({ path: z.string().min(1), title: z.string().trim().min(1, 'Give it a title.').max(LIMITS.title) }),
  'documents:createFromText': z.object({
    title: z.string().trim().min(1, 'Give it a title.').max(LIMITS.title),
    text: z.string().trim().min(1, 'Add some text.').max(60_000),
  }),
  'documents:update': z.object({ id, title: z.string().trim().min(1).max(LIMITS.title).optional(), rawText: z.string().max(60_000).optional() }),
  'documents:delete': z.object({ id }),
  'prefs:preview': z.object({ prefs: answerPrefsSchema, questionType: z.enum(['behavioural', 'technical', 'coding', 'introduction']) }),
  'notes:get': z.object({ sessionId: id }),
  'notes:generate': z.object({ sessionId: id }),
  'notes:clear': z.object({ sessionId: id }),
  'review:list': z.object({ sessionId: id }),
  'review:ask': z.object({ sessionId: id, message: z.string().trim().min(1).max(4000) }),
  'jobs:import': z.object({ url: z.string().trim().url('Paste a full link starting with https://') }),
  'companies:search': z.object({ q: z.string() }),
  'mock:nextQuestion': z.object({ sessionId: id }),
  'window:moveBy': z.object({ dx: z.number(), dy: z.number() }),
  'window:snap': z.object({ phase: z.enum(['start', 'end']) }),
  'window:setBounds': boundsSchema,
  'window:openLibrary': z.object({ route: z.string() }),
} as const

export type Channel = keyof typeof schemas

export const EVENTS = [
  'stt:downloadProgress',
  'stt:status',
  'transcript:partial',
  'transcript:final',
  'answer:start',
  'answer:delta',
  'answer:route',
  'answer:done',
  'answer:error',
  'resumes:progress',
  'documents:progress',
  'prefs:previewDelta',
  'notes:status',
  'review:delta',
  'hotkey:fired',
  'window:state',
  'data:changed',
  'gate:status',
] as const
