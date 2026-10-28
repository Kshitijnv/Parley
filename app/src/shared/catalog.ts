import type { AnswerPrefs, AnswerRouting, AutoPolicy, Hotkeys, Language, Model, Provider } from './types'

export const APP_NAME = 'Parley' // placeholder until /replica-brand

export const MODEL_CATALOG: Model[] = [
  { id: 'google:gemini-flash-lite', provider: 'google', label: 'Gemini Flash-Lite', vision: true, speed: 'fastest' },
  { id: 'google:gemini-flash', provider: 'google', label: 'Gemini Flash', vision: true, speed: 'fast' },
  { id: 'google:gemini-pro', provider: 'google', label: 'Gemini Pro', vision: true, speed: 'smartest' },
  { id: 'openai:gpt-mini', provider: 'openai', label: 'GPT mini', vision: true, speed: 'fast' },
  { id: 'openai:gpt', provider: 'openai', label: 'GPT', vision: true, speed: 'smartest' },
  { id: 'anthropic:claude-haiku', provider: 'anthropic', label: 'Claude Haiku', vision: true, speed: 'fast' },
  { id: 'anthropic:claude-sonnet', provider: 'anthropic', label: 'Claude Sonnet', vision: true, speed: 'balanced' },
  { id: 'groq:llama-instant', provider: 'groq', label: 'Llama Instant (Groq)', vision: false, speed: 'fastest' },
]

export const PROVIDERS: Array<{ id: Provider; label: string; purpose: string; required?: boolean; url: string }> = [
  { id: 'google', label: 'Google Gemini', purpose: 'Default model for answers, resume conversion and notes.', required: true, url: 'https://aistudio.google.com/apikey' },
  { id: 'groq', label: 'Groq', purpose: 'Fast backup model when Gemini is rate limited.', url: 'https://console.groq.com/keys' },
  { id: 'openai', label: 'OpenAI', purpose: 'Optional answer models.', url: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', label: 'Anthropic', purpose: 'Optional answer models.', url: 'https://console.anthropic.com/settings/keys' },
  { id: 'deepgram', label: 'Deepgram', purpose: 'Cloud speech-to-text for languages other than English.', url: 'https://console.deepgram.com/' },
  { id: 'logodev', label: 'logo.dev', purpose: 'Company logos in the company field.', url: 'https://www.logo.dev/' },
]

const L = (code: string, label: string, local = false): Language => ({
  code,
  label,
  stt: local ? ['local', 'deepgram'] : ['deepgram'],
})

export const LANGUAGES: Language[] = [
  L('en-US', 'English (US)', true),
  L('en-GB', 'English (UK)', true),
  L('en-IN', 'English (India)', true),
  L('en-US-medical', 'English, medical terms'),
  L('hi', 'Hindi'),
  L('es', 'Spanish'),
  L('fr', 'French'),
  L('de', 'German'),
  L('it', 'Italian'),
  L('pt-BR', 'Portuguese (Brazil)'),
  L('pt-PT', 'Portuguese (Portugal)'),
  L('nl', 'Dutch'),
  L('nl-medical', 'Dutch, medical terms'),
  L('da', 'Danish'),
  L('da-medical', 'Danish, medical terms'),
  L('sv', 'Swedish'),
  L('no', 'Norwegian'),
  L('fi', 'Finnish'),
  L('pl', 'Polish'),
  L('tr', 'Turkish'),
  L('ru', 'Russian'),
  L('uk', 'Ukrainian'),
  L('ja', 'Japanese'),
  L('ko', 'Korean'),
  L('zh', 'Chinese (Mandarin)'),
  L('id', 'Indonesian'),
  L('vi', 'Vietnamese'),
  L('ta', 'Tamil'),
]

/** architecture.md revision 2 §4–§5 defaults (also the migration 0002 column default). */
export const DEFAULT_AUTO_POLICY: AutoPolicy = {
  settleMs: 1000,
  settleQuestionMarkMs: 400,
  joinGapMs: 2500,
  minWords: 4,
  maxTurnChars: 1200,
  followupWindowMs: 20000,
  autoCooldownMs: 8000,
  autoMaxPerMinute: 4,
  autoMaxPerSession: 100,
  dedupeWindowMs: 120000,
  similarity: 0.7,
  manualMinIntervalMs: 1500,
  staleCandidateMs: 20000,
  shortQuestionMinWords: 2,
  maxMergedQuestions: 3,
}

/** Revision 4 A4.3 defaults (also the migration 0003 column default). Fallback off. */
export const DEFAULT_ANSWER_ROUTING: AnswerRouting = {
  fallbackModel: null,
  fallbackAfterMs: 6000,
  switchOn: { slowFirstToken: true, overloaded: true, rateLimited: true, auth: true, notFound: true },
  stickyAfterSlow: 2,
  stickyWindowMs: 120000,
}

export const DEFAULT_PREFS: AnswerPrefs = {
  format: 'script_bullets',
  star: true,
  filler_words: false,
  length: 'balanced',
  tone: 'simple',
}

export const DEFAULT_HOTKEYS: Hotkeys = {
  answer: 'Control+Enter',
  screenshot: 'Control+Shift+Enter',
  chat: 'Control+Shift+Space',
  clear_transcript: 'Control+Shift+Backspace',
  clear_answer: 'Control+Backspace',
  history_prev: 'Control+Left',
  history_next: 'Control+Right',
  move_up: 'Control+Shift+Up',
  move_down: 'Control+Shift+Down',
  move_left: 'Control+Shift+Left',
  move_right: 'Control+Shift+Right',
}

export const FORMAT_LABEL: Record<AnswerPrefs['format'], string> = {
  full_script: 'Full script',
  script_bullets: 'Script and bullets',
  bullets: 'Bullet points',
}
export const LENGTH_LABEL: Record<AnswerPrefs['length'], string> = { short: 'Short', balanced: 'Balanced', long: 'Long' }
export const TONE_LABEL: Record<AnswerPrefs['tone'], string> = { simple: 'Simple', formal: 'Formal' }

export function prefsSummary(p: AnswerPrefs): string {
  return [FORMAT_LABEL[p.format], p.star ? 'STAR' : null, p.filler_words ? 'filler words' : null].filter(Boolean).join(' · ')
}

export function providerOf(modelId: string): Provider {
  return modelId.split(':')[0] as Provider
}

export function modelLabel(modelId: string): string {
  return MODEL_CATALOG.find((m) => m.id === modelId)?.label ?? modelId
}
