import { useState, type ReactNode } from 'react'
import { Check, ExternalLink, KeyRound, RotateCcw, Trash2 } from 'lucide-react'
import type { HotkeyAction, Hotkeys, KeyStatus, Provider, Settings } from '@shared/types'
import { DEFAULT_HOTKEYS, PROVIDERS, modelLabel, prefsSummary, providerOf } from '@shared/catalog'

const providerName = (modelId: string) => PROVIDERS.find((p) => p.id === providerOf(modelId))?.label ?? providerOf(modelId)
import { api, isMock } from '@renderer/api'
import { resetDb } from '@renderer/api/mock/store'
import { AnswerPrefsModal } from '@renderer/components/PrefsModals'
import { Button } from '@renderer/components/ui/button'
import { Callout, SkeletonLines, Tag } from '@renderer/components/ui/feedback'
import { Switch, TextInput } from '@renderer/components/ui/form'
import { ConfirmDialog, toast } from '@renderer/components/ui/overlays'
import { Select } from '@renderer/components/ui/select'
import { dateTime, errorText, keyGlyphs } from '@renderer/lib/format'
import { usePrivacy, useQuery, useSettings } from '@renderer/lib/hooks'
import { PageHeader } from './LibraryApp'
import { CloudSpeech } from './CloudSpeech'
import { SpeechModels } from './SpeechModels'

export function SettingsPage() {
  const settings = useSettings()
  const privacy = usePrivacy()
  const keys = useQuery(() => api.keys.status(), [], ['keys'])
  const models = useQuery(() => api.models.list(), [], ['keys'])
  const [prefsOpen, setPrefsOpen] = useState(false)
  const s = settings.data
  const update = async (patch: Partial<Settings>) => {
    try {
      await api.settings.update(patch)
    } catch (e) {
      toast({ text: errorText(e), tone: 'error' })
    }
  }
  return (
    <>
      <PageHeader title="Settings" description="Keys, defaults for new sessions, the overlay and shortcuts. Everything is stored on this PC." />
      <div className="mx-auto max-w-3xl space-y-10 p-6">
        <Section title="API keys" description="Your own keys pay for the AI. They're encrypted on this PC and never shown again after you save them.">
          <Callout tone="warning">
            On Google's free tier, prompts may be used to improve Google's products, and your prompts include your resume and the other side's words. Turn on billing for the key, or use another provider, if that matters to you.
          </Callout>
          {keys.loading && !keys.data ? (
            <SkeletonLines lines={4} />
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {PROVIDERS.map((p) => (
                <KeyRow key={p.id} provider={p} status={keys.data?.find((k) => k.provider === p.id) ?? null} />
              ))}
            </ul>
          )}
        </Section>

        <Section title="Speech models" description="Transcription runs on this PC. Install a model once, here; downloads never start during a call.">
          <SpeechModels />
        </Section>

        <Section title="Cloud speech (Speechmatics)" description="Optional. Faster, punctuated text of the other side, with names and tech terms from your resume spelled right. Uses your own Speechmatics keys; local speech stays ready as the fallback.">
          {s ? <CloudSpeech settings={s} update={update} /> : <SkeletonLines lines={2} />}
        </Section>

        <Section title="New session defaults">
          {!s ? (
            <SkeletonLines lines={3} />
          ) : (
            <div className="space-y-3">
              <Row label="Answer model" hint="Used when you create a session. You can change it per session.">
                <div className="w-56">
                  <Select
                    ariaLabel="Answer model"
                    value={s.defaultModel}
                    onChange={(v) => void update({ defaultModel: v })}
                    options={(models.data ?? []).map((m) => ({ value: m.id, label: m.label }))}
                    placeholder={models.data?.length ? 'Choose' : 'Add a key first'}
                    disabled={!models.data?.length}
                  />
                </div>
              </Row>
              <Row label="Screenshot model" hint="Needs a model that can read images.">
                <div className="w-56">
                  <Select
                    ariaLabel="Screenshot model"
                    value={s.visionModel}
                    onChange={(v) => void update({ visionModel: v })}
                    options={(models.data ?? []).filter((m) => m.vision).map((m) => ({ value: m.id, label: m.label }))}
                    placeholder={models.data?.length ? 'Choose' : 'Add a key first'}
                    disabled={!models.data?.length}
                  />
                </div>
              </Row>
              <Row
                label="Fallback model"
                hint={
                  s.answerRouting.fallbackModel
                    ? `If the answer model hasn't started after ${s.answerRouting.fallbackAfterMs / 1000} s, or is busy, rate limited or rejects its key, ask ${modelLabel(s.answerRouting.fallbackModel)} instead. Uses your ${providerName(s.answerRouting.fallbackModel)} key; each switch is a separate paid request. A used-up daily quota never switches on its own.`
                    : 'Off. Pick a model from another provider to switch to when the answer model is slow to start. Each switch is a separate paid request.'
                }
              >
                <div className="flex gap-2">
                  <div className="w-56">
                    <Select
                      ariaLabel="Fallback model"
                      value={s.answerRouting.fallbackModel ?? 'off'}
                      onChange={(v) => void update({ answerRouting: { ...s.answerRouting, fallbackModel: v === 'off' ? null : v } })}
                      options={[{ value: 'off', label: 'Off' }, ...(models.data ?? []).map((m) => ({ value: m.id, label: m.label }))]}
                    />
                  </div>
                  <div className="w-28">
                    <Select
                      ariaLabel="Switch after"
                      value={String(s.answerRouting.fallbackAfterMs)}
                      onChange={(v) => void update({ answerRouting: { ...s.answerRouting, fallbackAfterMs: Number(v) } })}
                      options={[3000, 4000, 6000, 8000, 10000, 15000, 20000].map((ms) => ({ value: String(ms), label: `after ${ms / 1000} s` }))}
                      disabled={!s.answerRouting.fallbackModel}
                    />
                  </div>
                </div>
              </Row>
              <Row label="Language" hint="The language calls are usually in.">
                <div className="w-56">
                  <Select
                    searchable
                    ariaLabel="Default language"
                    value={s.defaultLanguage}
                    onChange={(v) => void update({ defaultLanguage: v })}
                    options={api.models.languages().map((l) => ({ value: l.code, label: l.label, disabled: !l.stt.includes(s.sttProvider), hint: l.stt.includes(s.sttProvider) ? undefined : 'Needs Deepgram' }))}
                  />
                </div>
              </Row>
              <Row label="Speech to text" hint="Local runs offline on this PC (English), with the Kroko ASR community model (CC-BY-SA, kroko.ai) on sherpa-onnx. It's always on: for your microphone, and as the fallback when cloud speech is on.">
                <div className="w-56">
                  <Select
                    ariaLabel="Speech to text"
                    value={s.sttProvider}
                    onChange={(v) => void update({ sttProvider: v as Settings['sttProvider'] })}
                    options={[{ value: 'local', label: 'Local (offline)' }]}
                  />
                </div>
              </Row>
              <Row label="Answer preferences" hint={prefsSummary(s.defaultAnswerPrefs)}>
                <Button size="sm" variant="secondary" onClick={() => setPrefsOpen(true)}>
                  Configure
                </Button>
              </Row>
            </div>
          )}
        </Section>

        <Section title="Overlay">
          {s && (
            <div className="space-y-3">
              <Row label="Private mode" hint={privacy?.reason ?? 'Keeps the overlay out of screen shares and recordings (Windows 10 2004 or later). A camera can still see it.'}>
                <Switch label="Private mode" checked={s.privateMode} disabled={privacy?.mode === 'unsupported'} onCheckedChange={(v) => void update({ privateMode: v })} />
              </Row>
              <Row label="Live layer opacity" hint="Lower is more see-through. Below 78% text gets hard to read over bright pages, so that's the minimum.">
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={78}
                    max={100}
                    step={1}
                    aria-label="Live layer opacity"
                    value={Math.round(s.overlayOpacity * 100)}
                    onChange={(e) => void update({ overlayOpacity: Number(e.target.value) / 100 })}
                    className="w-40 accent-(--tk-color-accent)"
                  />
                  <span className="w-10 text-right text-xs text-text-muted">{Math.round(s.overlayOpacity * 100)}%</span>
                </div>
              </Row>
              <Row label="Zoom" hint="Size of the overlay text and controls.">
                <div className="w-40">
                  <Select
                    ariaLabel="Zoom"
                    value={String(s.zoom)}
                    onChange={(v) => void update({ zoom: Number(v) })}
                    options={[0.8, 0.9, 1, 1.1, 1.25, 1.5].map((z) => ({ value: String(z), label: `${Math.round(z * 100)}%` }))}
                  />
                </div>
              </Row>
            </div>
          )}
        </Section>

        <Section title="Shortcuts" description="These work in every app while a call is live, and nowhere else. Click a shortcut, then press the new keys.">
          {s && <HotkeyEditor hotkeys={{ ...DEFAULT_HOTKEYS, ...s.hotkeys }} onChange={(hotkeys) => void update({ hotkeys })} />}
        </Section>

        <Section title="Data">
          <p className="text-sm text-text-muted">
            Calls, resumes and documents are stored on this PC. Deleting a call removes its transcript, answers and notes.
            {s?.lastBackupAt ? ` Last backup: ${dateTime(s.lastBackupAt)}.` : ''}
          </p>
          {isMock && <DemoDataControls />}
        </Section>
      </div>
      {s && (
        <AnswerPrefsModal
          open={prefsOpen}
          onOpenChange={setPrefsOpen}
          value={s.defaultAnswerPrefs}
          onSave={async (p) => {
            await api.settings.update({ defaultAnswerPrefs: p })
          }}
        />
      )}
    </>
  )
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="space-y-3" aria-labelledby={`sec-${title}`}>
      <div>
        <h2 id={`sec-${title}`} className="text-md font-semibold">
          {title}
        </h2>
        {description && <p className="mt-1 text-xs text-text-muted">{description}</p>}
      </div>
      {children}
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-base font-medium">{label}</p>
        {hint && <p className="text-xs text-text-muted">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

function KeyRow({ provider, status }: { provider: (typeof PROVIDERS)[number]; status: KeyStatus | null }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'delete'>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [confirm, setConfirm] = useState(false)
  const id = `key-${provider.id}`

  const save = async () => {
    setBusy('save')
    setResult(null)
    try {
      await api.keys.set({ provider: provider.id as Provider, key: value })
      setValue('')
      setEditing(false)
      setBusy('test')
      const r = await api.keys.test({ provider: provider.id as Provider })
      setResult(r.ok ? { ok: true, text: 'Saved and working.' } : { ok: false, text: r.error ?? 'The key did not work.' })
    } catch (e) {
      setResult({ ok: false, text: errorText(e) })
    } finally {
      setBusy(null)
    }
  }
  const test = async () => {
    setBusy('test')
    setResult(null)
    const r = await api.keys.test({ provider: provider.id as Provider }).catch((e) => ({ ok: false, error: errorText(e) }))
    setResult(r.ok ? { ok: true, text: 'Working.' } : { ok: false, text: r.error ?? 'The key did not work.' })
    setBusy(null)
  }

  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <KeyRound size={16} className="text-text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-base font-medium">
            {provider.label}
            {provider.required && <Tag>Needed for answers</Tag>}
          </p>
          <p className="text-xs text-text-muted">{provider.purpose}</p>
          <p className="text-xs text-text-subtle">
            {status?.source === 'env'
              ? `Key ending ${status.last4} · from .env.local (development build only)`
              : status
                ? `Key ending ${status.last4}${status.verifiedAt ? ` · checked ${dateTime(status.verifiedAt)}` : ' · not checked yet'}`
                : 'No key'}
          </p>
        </div>
        {status?.source === 'env' && !editing && (
          <Button size="sm" variant="ghost" onClick={() => void test()} loading={busy === 'test'} busyLabel="Checking…">
            Check
          </Button>
        )}
        {status && status.source !== 'env' && !editing && (
          <>
            <Button size="sm" variant="ghost" onClick={() => void test()} loading={busy === 'test'} busyLabel="Checking…">
              Check
            </Button>
            <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => setConfirm(true)} aria-label={`Remove ${provider.label} key`}>
              Remove
            </Button>
          </>
        )}
        {!editing && (
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            {status ? 'Replace' : 'Add key'}
          </Button>
        )}
      </div>
      {editing && (
        <form
          className="flex flex-wrap items-center gap-2 pl-7"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <label htmlFor={id} className="sr-only">
            {provider.label} API key
          </label>
          <TextInput id={id} type="password" autoComplete="off" autoFocus className="min-w-60 flex-1" placeholder="Paste the key" value={value} onChange={(e) => setValue(e.target.value)} />
          <Button type="submit" size="md" variant="primary" disabled={value.trim().length < 8} loading={busy === 'save' || busy === 'test'} busyLabel="Saving…">
            Save
          </Button>
          <Button size="md" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <a href={provider.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-text-muted underline">
            Get a key <ExternalLink size={12} aria-hidden />
          </a>
        </form>
      )}
      {result && (
        <p role="status" className={result.ok ? 'pl-7 text-xs text-success' : 'pl-7 text-xs text-danger-text'}>
          {result.ok && <Check size={12} className="mr-1 inline" aria-hidden />}
          {result.text}
        </p>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Remove the ${provider.label} key?`}
        body="Sessions that use its models stop answering until you add a key again."
        confirmLabel="Remove key"
        busyLabel="Removing…"
        danger
        onConfirm={async () => {
          await api.keys.delete({ provider: provider.id as Provider })
          setResult(null)
        }}
      />
    </li>
  )
}

const HOTKEY_LABEL: Record<HotkeyAction, string> = {
  answer: 'Answer',
  screenshot: 'Answer from screen',
  chat: 'Type a question',
  clear_transcript: 'Clear transcript',
  clear_answer: 'Clear answer',
  history_prev: 'Previous answer',
  history_next: 'Next answer',
  move_up: 'Move up',
  move_down: 'Move down',
  move_left: 'Move left',
  move_right: 'Move right',
}

function accelFromEvent(e: React.KeyboardEvent): string | null {
  const key = e.key
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return null
  const map: Record<string, string> = { ' ': 'Space', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Enter: 'Enter', Backspace: 'Backspace' }
  const k = map[key] ?? (key.length === 1 ? key.toUpperCase() : key)
  const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean)
  if (!mods.length) return null
  return [...mods, k].join('+')
}

function HotkeyEditor({ hotkeys, onChange }: { hotkeys: Hotkeys; onChange: (h: Hotkeys) => void }) {
  const [recording, setRecording] = useState<HotkeyAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-border rounded-md border border-border">
        {(Object.keys(HOTKEY_LABEL) as HotkeyAction[]).map((action) => (
          <li key={action} className="flex items-center gap-3 px-4 py-2">
            <span className="flex-1 text-sm">{HOTKEY_LABEL[action]}</span>
            <button
              type="button"
              aria-label={`${HOTKEY_LABEL[action]}: ${hotkeys[action]}. Press to change`}
              onClick={() => {
                setRecording(action)
                setError(null)
              }}
              onBlur={() => setRecording((r) => (r === action ? null : r))}
              onKeyDown={(e) => {
                if (recording !== action) return
                if (e.key === 'Escape') {
                  setRecording(null)
                  return
                }
                if (e.key === 'Tab') return
                e.preventDefault()
                const accel = accelFromEvent(e)
                if (!accel) {
                  if (!['Control', 'Shift', 'Alt'].includes(e.key)) setError('Use at least one of Ctrl, Alt or Shift.')
                  return
                }
                const clash = (Object.keys(hotkeys) as HotkeyAction[]).find((a) => a !== action && hotkeys[a] === accel)
                if (clash) {
                  setError(`${keyGlyphs(accel).join(' ')} is already used for ${HOTKEY_LABEL[clash]}.`)
                  return
                }
                onChange({ ...hotkeys, [action]: accel })
                setRecording(null)
              }}
              className="min-w-36 rounded-md border border-border-input bg-surface px-2 py-1 text-right font-mono text-xs"
            >
              {recording === action ? 'Press keys…' : keyGlyphs(hotkeys[action]).join(' ')}
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      )}
      <Button size="sm" variant="ghost" icon={<RotateCcw size={14} />} onClick={() => onChange({ ...DEFAULT_HOTKEYS })}>
        Reset to defaults
      </Button>
    </div>
  )
}

function DemoDataControls() {
  const [confirm, setConfirm] = useState<null | 'seed' | 'empty'>(null)
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" onClick={() => setConfirm('seed')}>
        Reset demo data
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirm('empty')}>
        Clear all data
      </Button>
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(v) => !v && setConfirm(null)}
        title={confirm === 'seed' ? 'Reset to demo data?' : 'Clear all data?'}
        body="Every call, resume, document and setting in this demo is replaced."
        confirmLabel={confirm === 'seed' ? 'Reset' : 'Clear everything'}
        danger
        onConfirm={() => {
          resetDb(confirm ?? 'seed')
          location.reload()
        }}
      />
    </div>
  )
}
