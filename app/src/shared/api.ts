// The Api every window calls. Today it is implemented by the mock data layer in
// src/renderer/api/mock; /replica-backend implements the same interface in preload
// (window.api) with ipcRenderer.invoke on the channel named in each comment.
import type {
  Answer,
  AnswerEndReason,
  AnswerErrorCode,
  FallbackReason,
  GateStatus,
  GenerateResult,
  SttModelInfo,
  SttStatus,
  AnswerPrefs,
  AnswerTrigger,
  Bounds,
  CompanyHit,
  CreateSessionInput,
  DocumentFile,
  DocumentRow,
  HotkeyAction,
  ImportProgress,
  KeyStatus,
  Language,
  Model,
  Notes,
  PickedFile,
  Provider,
  QuestionType,
  Resume,
  ResumeRow,
  ReviewMessage,
  Segment,
  Session,
  SessionCard,
  SpeechKey,
  Settings,
  Speaker,
  TimelineItem,
  WindowState,
} from './types'

export interface AnswerStartEvent {
  answerId: string
  sessionId: string
  seq: number
  trigger: AnswerTrigger
  turnId: string | null
  /** The detector's turn text or the typed question, shown until the model's question line arrives. */
  questionDraft: string | null
  model: string
  createdAt: number
}

export interface ApiEvents {
  'stt:downloadProgress': { pct: number; modelId?: string; stage?: 'downloading' | 'verifying' | 'installed' | 'failed'; bytes?: number; total?: number }
  'stt:status': SttStatus
  'transcript:partial': { sessionId: string; speaker: Speaker; text: string; utteranceId?: number; rev?: number }
  'transcript:final': Segment
  'answer:start': AnswerStartEvent
  /** `offset`: characters of this part already sent. The question part is always a full replacement at offset 0. */
  'answer:delta': { answerId: string; sessionId?: string; seq?: number; part: 'question' | 'answer'; offset?: number; text: string; attempt?: number }
  /** Revision 4 A4.3: the answer moved to the fallback model before its first token. */
  'answer:route': { answerId: string; sessionId: string; attempt: number; servedModel: string; reason: FallbackReason }
  'answer:done': Answer
  'answer:error': {
    answerId: string
    sessionId?: string
    code: AnswerErrorCode
    message: string
    endReason?: AnswerEndReason
    /** Text streamed before the error, kept on the row. */
    partial?: string
    /** Epoch ms. */
    retryAt?: number
    retryAfterS?: number
    /** Revision 4 A4.3: a usable fallback the user can choose with one press (never automatic for a daily quota). */
    fallbackModel?: string
  }
  'gate:status': GateStatus
  'resumes:progress': ImportProgress
  'documents:progress': ImportProgress
  'prefs:previewDelta': { previewId: string; text: string; done: boolean }
  'notes:status': { sessionId: string; status: Notes['status'] }
  'review:delta': { messageId: string; text: string; done: boolean }
  'hotkey:fired': { action: HotkeyAction }
  'window:state': WindowState
  /** Contract addition: lets other windows refresh lists after a write. */
  'data:changed': { area: 'sessions' | 'resumes' | 'documents' | 'settings' | 'keys' | 'speechKeys' | 'notes' | 'transcript' }
}

export type ApiEventName = keyof ApiEvents
export type Unsubscribe = () => void

export interface Api {
  settings: {
    get(): Promise<Settings> // settings:get
    update(patch: Partial<Omit<Settings, 'updatedAt' | 'lastBackupAt'>>): Promise<Settings> // settings:update
  }
  keys: {
    status(): Promise<KeyStatus[]> // keys:status
    set(input: { provider: Provider; key: string }): Promise<{ last4: string }> // keys:set
    test(input: { provider: Provider }): Promise<{ ok: boolean; error?: string }> // keys:test
    delete(input: { provider: Provider }): Promise<{ ok: true }> // keys:delete
  }
  /** Revision 7 S4/S6: cloud speech keys. The key is write-only: only the last 4 characters come back. */
  speechKeys: {
    list(): Promise<SpeechKey[]> // speechKeys:list
    add(input: { key: string; label: string; budgetHours: number | null }): Promise<{ key: SpeechKey; test: { ok: boolean; error?: string } }> // speechKeys:add
    update(input: { id: string; label?: string; budgetHours?: number | null }): Promise<SpeechKey> // speechKeys:update
    /** Also the "Try again" for a used-up or rate-limited key. */
    test(input: { id: string }): Promise<{ ok: boolean; error?: string }> // speechKeys:test
    move(input: { id: string; by: -1 | 1 }): Promise<SpeechKey[]> // speechKeys:move
    remove(input: { id: string }): Promise<{ ok: true }> // speechKeys:remove
  }
  models: {
    list(): Promise<Model[]> // models:list (only providers with keys)
    catalog(): Model[] // static catalog from ai/providers.ts, shared with the renderer
    languages(): Language[]
  }
  stt: {
    /** Whether the default English model is installed (kept for S03/S12). */
    modelStatus(): Promise<{ ready: boolean; sizeMb: number; modelId?: string }> // stt:modelStatus
    models(): Promise<SttModelInfo[]> // stt:models
    /** Refused while a session is live. */
    downloadModel(input: { modelId: string }): Promise<{ ok: boolean; error?: string }> // stt:downloadModel
    cancelDownload(input: { modelId: string }): Promise<{ ok: true }> // stt:cancelDownload
    deleteModel(input: { modelId: string }): Promise<{ ok: true }> // stt:deleteModel
    /** Contract addition: full sha256 re-check ("Verify files"). */
    verifyFiles(input: { modelId: string }): Promise<{ ok: boolean; error?: string }> // stt:verifyFiles
    /** S12: start the worker and load the session's model before Start. */
    prepare(input: { sessionId: string }): Promise<SttStatus> // stt:prepare
    /** Contract addition: the current transcription state, so a window that opens late doesn't miss stt:status. */
    status(): Promise<SttStatus> // stt:status
  }
  sessions: {
    list(input?: { q?: string; sort?: 'newest' | 'oldest' }): Promise<SessionCard[]> // sessions:list
    get(input: { id: string }): Promise<Session> // sessions:get
    create(input: CreateSessionInput): Promise<Session> // sessions:create
    update(input: { id: string; patch: Partial<CreateSessionInput> }): Promise<Session> // sessions:update
    delete(input: { id: string }): Promise<{ ok: true }> // sessions:delete
    start(input: { id: string; micDeviceId?: string }): Promise<Session> // sessions:start
    end(input: { id: string; mode: 'leave' | 'end' }): Promise<Session> // sessions:end
    rejoin(input: { id: string }): Promise<Session> // sessions:rejoin
  }
  audio: {
    frame(input: { speaker: Speaker; pcm: ArrayBuffer }): void // send audio:frame
  }
  answers: {
    /** Every live answer goes through main's RequestGate (revision 2 §5). */
    generate(input: { sessionId: string; trigger: AnswerTrigger; text?: string; force?: boolean; clientRequestId: string; retryOf?: string; useFallback?: boolean }): Promise<GenerateResult> // answers:generate
    cancel(input: { answerId: string }): Promise<{ ok: true }> // answers:cancel
    list(input: { sessionId: string }): Promise<Answer[]> // answers:list
    /** One answer; `liveText` is the text streamed so far while it's streaming (resync). */
    get(input: { answerId: string }): Promise<Answer & { liveText?: string }> // answers:get
    /** Contract addition: the gate's current state for the live bar chip. */
    gateStatus(input: { sessionId: string }): Promise<GateStatus | null> // gate:status
  }
  transcript: {
    clear(input: { sessionId: string }): Promise<{ cursorAt: number }> // transcript:clear
    get(input: { sessionId: string }): Promise<TimelineItem[]> // transcript:get
    export(input: { sessionId: string; format: 'md' | 'txt' }): Promise<{ path: string } | null> // transcript:export
    delete(input: { sessionId: string }): Promise<{ ok: true }> // transcript:delete
  }
  resumes: {
    list(): Promise<ResumeRow[]>
    pickFile(): Promise<PickedFile | null>
    /** Preload helper (webUtils.getPathForFile) for drag and drop. */
    pathForFile(file: File): string
    importFile(input: { path: string; title: string }): Promise<Resume>
    reconvert(input: { id: string }): Promise<Resume>
    createFromText(input: { title: string; text: string }): Promise<Resume>
    get(input: { id: string }): Promise<Resume>
    update(input: { id: string; title?: string; contentMd?: string }): Promise<Resume>
    delete(input: { id: string }): Promise<{ ok: true }>
    parse(input: { id: string }): Promise<Resume>
  }
  documents: {
    list(): Promise<DocumentRow[]>
    get(input: { id: string }): Promise<DocumentFile>
    pickFile(): Promise<PickedFile | null>
    pathForFile(file: File): string
    importFile(input: { path: string; title: string }): Promise<DocumentFile>
    createFromText(input: { title: string; text: string }): Promise<DocumentFile>
    update(input: { id: string; title?: string; rawText?: string }): Promise<DocumentFile>
    delete(input: { id: string }): Promise<{ ok: true }>
  }
  prefs: {
    preview(input: { prefs: AnswerPrefs; questionType: QuestionType }): Promise<{ previewId: string }> // prefs:preview
  }
  notes: {
    get(input: { sessionId: string }): Promise<Notes | null>
    generate(input: { sessionId: string }): Promise<Notes>
    clear(input: { sessionId: string }): Promise<{ ok: true }>
  }
  review: {
    list(input: { sessionId: string }): Promise<ReviewMessage[]>
    ask(input: { sessionId: string; message: string }): Promise<{ messageId: string }>
  }
  jobs: {
    import(input: { url: string }): Promise<{ company?: string; role?: string; description: string }>
  }
  companies: {
    search(input: { q: string }): Promise<CompanyHit[]>
  }
  mock: {
    nextQuestion(input: { sessionId: string }): Promise<Segment> // mock:nextQuestion (F08)
  }
  window: {
    hide(): Promise<{ ok: true }>
    restore(): Promise<{ ok: true }>
    moveBy(input: { dx: number; dy: number }): Promise<Bounds | null>
    snap(input: { phase: 'start' | 'end' }): Promise<Bounds | null>
    setBounds(input: Bounds): Promise<Bounds | null>
    openLibrary(input: { route: string }): Promise<{ ok: true }>
    /** Not in the original table: the library's "Create session" focuses the overlay. */
    openOverlay(input: { route: string }): Promise<{ ok: true }>
    /** Size the overlay window to the current screen's layout (list, wizard, live). */
    fit(input: { width: number; height: number }): Promise<void>
    setHotkeysActive(input: { active: boolean; hotkeys: Record<string, string> }): Promise<{ failed: string[] }>
    close(): Promise<void>
    state(): Promise<WindowState>
  }
  on<E extends ApiEventName>(event: E, cb: (payload: ApiEvents[E]) => void): Unsubscribe
}
