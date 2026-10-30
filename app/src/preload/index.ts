import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron'
import type { Api, ApiEventName } from '@shared/api'
import { LANGUAGES, MODEL_CATALOG } from '@shared/catalog'

// window.native: the OS bridge for window behaviour (window:* channels only).
// window.api: the data layer, the same Api interface the renderer's mock implements,
// over ipcRenderer.invoke. With PARLEY_MOCK=1 window.api is left out and the renderer
// falls back to its built-in demo data.

const WINDOW_CHANNELS = new Set([
  'window:hide',
  'window:restore',
  'window:moveBy',
  'window:snap',
  'window:setBounds',
  'window:openLibrary',
  'window:openOverlay',
  'window:fit',
  'window:setHotkeysActive',
  'window:close',
  'window:state',
  'window:setPrivate',
  'window:cursorInOverlay',
])

const native = {
  isElectron: true as const,
  invoke: (channel: string, input?: unknown) => {
    if (!WINDOW_CHANNELS.has(channel)) return Promise.reject(new Error(`Unknown channel ${channel}`))
    return ipcRenderer.invoke(channel, input)
  },
  broadcast: (event: string, payload: unknown) => ipcRenderer.send('broadcast', event, payload),
  on: (cb: (event: string, payload: unknown) => void) => {
    const listener = (_e: unknown, event: string, payload: unknown) => cb(event, payload)
    ipcRenderer.on('event', listener)
    return () => {
      ipcRenderer.removeListener('event', listener)
    }
  },
  onNav: (cb: (route: string) => void) => {
    const listener = (_e: unknown, route: string) => cb(route)
    ipcRenderer.on('nav', listener)
    return () => {
      ipcRenderer.removeListener('nav', listener)
    }
  },
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  setZoom: (factor: number) => webFrame.setZoomFactor(factor),
}

contextBridge.exposeInMainWorld('native', native)

async function call<T>(channel: string, input?: unknown): Promise<T> {
  const r = (await ipcRenderer.invoke(channel, input)) as { ok: true; value: T } | { ok: false; error: { message: string; code: string; field?: string } }
  if (r.ok) return r.value
  const err = new Error(r.error.message)
  err.name = r.error.code
  throw err
}

const c =
  <I, O>(channel: string) =>
  (input?: I) =>
    call<O>(channel, input)

/** A dropped File's path, allow-listed in main so importFile may read it. */
function pathForFile(file: File): string {
  const p = webUtils.getPathForFile(file)
  if (p) ipcRenderer.send('files:allow', p)
  return p
}

const win = (channel: string) => (input?: unknown) => ipcRenderer.invoke(channel, input)

const api: Api = {
  settings: { get: c('settings:get'), update: c('settings:update') },
  keys: { status: c('keys:status'), set: c('keys:set'), test: c('keys:test'), delete: c('keys:delete') },
  speechKeys: { list: c('speechKeys:list'), add: c('speechKeys:add'), update: c('speechKeys:update'), test: c('speechKeys:test'), move: c('speechKeys:move'), remove: c('speechKeys:remove') },
  models: { list: c('models:list'), catalog: () => MODEL_CATALOG, languages: () => LANGUAGES },
  stt: {
    modelStatus: c('stt:modelStatus'),
    models: c('stt:models'),
    downloadModel: c('stt:downloadModel'),
    cancelDownload: c('stt:cancelDownload'),
    deleteModel: c('stt:deleteModel'),
    verifyFiles: c('stt:verifyFiles'),
    prepare: c('stt:prepare'),
    status: c('stt:status'),
  },
  sessions: {
    list: c('sessions:list'),
    get: c('sessions:get'),
    create: c('sessions:create'),
    update: c('sessions:update'),
    delete: c('sessions:delete'),
    start: c('sessions:start'),
    end: c('sessions:end'),
    rejoin: c('sessions:rejoin'),
  },
  audio: {
    frame: ({ speaker, pcm }) => ipcRenderer.send('audio:frame', speaker, pcm),
  },
  answers: { generate: c('answers:generate'), cancel: c('answers:cancel'), list: c('answers:list'), get: c('answers:get'), gateStatus: c('gate:status') },
  transcript: { clear: c('transcript:clear'), get: c('transcript:get'), export: c('transcript:export'), delete: c('transcript:delete') },
  resumes: {
    list: c('resumes:list'),
    pickFile: c('resumes:pickFile'),
    pathForFile,
    importFile: c('resumes:importFile'),
    reconvert: c('resumes:reconvert'),
    createFromText: c('resumes:createFromText'),
    get: c('resumes:get'),
    update: c('resumes:update'),
    delete: c('resumes:delete'),
    parse: c('resumes:parse'),
  },
  documents: {
    list: c('documents:list'),
    get: c('documents:get'),
    pickFile: c('documents:pickFile'),
    pathForFile,
    importFile: c('documents:importFile'),
    createFromText: c('documents:createFromText'),
    update: c('documents:update'),
    delete: c('documents:delete'),
  },
  prefs: { preview: c('prefs:preview') },
  notes: { get: c('notes:get'), generate: c('notes:generate'), clear: c('notes:clear') },
  review: { list: c('review:list'), ask: c('review:ask') },
  jobs: { import: c('jobs:import') },
  companies: { search: c('companies:search') },
  mock: { nextQuestion: c('mock:nextQuestion') },
  window: {
    hide: win('window:hide'),
    restore: win('window:restore'),
    moveBy: win('window:moveBy'),
    snap: win('window:snap'),
    setBounds: win('window:setBounds'),
    openLibrary: win('window:openLibrary'),
    openOverlay: win('window:openOverlay'),
    fit: win('window:fit'),
    setHotkeysActive: win('window:setHotkeysActive'),
    close: win('window:close'),
    state: win('window:state'),
  } as Api['window'],
  on(event: ApiEventName, cb: (payload: never) => void) {
    const listener = (_e: unknown, name: string, payload: unknown) => {
      if (name === event) cb(payload as never)
    }
    ipcRenderer.on('event', listener)
    return () => {
      ipcRenderer.removeListener('event', listener)
    }
  },
} as Api

if (process.env['PARLEY_MOCK'] !== '1') contextBridge.exposeInMainWorld('api', api)
