import { useEffect, useRef, useState } from 'react'
import { AlignLeft, ArrowLeft, Check, ChevronRight, CircleHelp, Gauge, MessageSquare, Sparkles, Star } from 'lucide-react'
import type { AnswerPrefs, QuestionType } from '@shared/types'
import { FORMAT_LABEL, LENGTH_LABEL, TONE_LABEL, prefsSummary } from '@shared/catalog'
import { LIMITS } from '@shared/ipc'
import { api } from '@renderer/api'
import { Button } from './ui/button'
import { Callout, SpinnerLabel } from './ui/feedback'
import { RadioCards, Switch, Textarea } from './ui/form'
import { Markdown } from './ui/markdown'
import { Modal } from './ui/overlays'
import { Select } from './ui/select'
import { errorText } from '@renderer/lib/format'
import { useEvent } from '@renderer/lib/hooks'

const QTYPES: Array<{ value: QuestionType; label: string }> = [
  { value: 'behavioural', label: 'Behavioural' },
  { value: 'technical', label: 'Technical' },
  { value: 'coding', label: 'Coding' },
  { value: 'introduction', label: 'Introduction' },
]

const previewCache = new Map<string, string>()

/** S09: shape the answers, with an AI-written preview that follows every change. */
export function AnswerPrefsModal({
  open,
  onOpenChange,
  value,
  onSave,
  midCall,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  value: AnswerPrefs
  onSave: (p: AnswerPrefs) => Promise<void> | void
  midCall?: boolean
}) {
  const [prefs, setPrefs] = useState<AnswerPrefs>(value)
  const [pane, setPane] = useState<'overview' | 'format' | 'length' | 'tone'>('overview')
  const [qtype, setQtype] = useState<QuestionType>('behavioural')
  const [preview, setPreview] = useState('')
  const [regenerating, setRegenerating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [defaultSaved, setDefaultSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef<string | null>(null)

  useEffect(() => {
    if (open) {
      setPrefs(value)
      setPane('overview')
      setError(null)
      setDefaultSaved(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Debounced 800 ms and cached by (prefs, question type) so it doesn't burn the free tier.
  useEffect(() => {
    if (!open) return
    const key = JSON.stringify([prefs, qtype])
    const hit = previewCache.get(key)
    if (hit) {
      setPreview(hit)
      setRegenerating(false)
      return
    }
    setRegenerating(true)
    const t = setTimeout(async () => {
      try {
        const { previewId } = await api.prefs.preview({ prefs, questionType: qtype })
        pending.current = `${previewId}|${key}`
      } catch {
        setRegenerating(false)
      }
    }, 800)
    return () => clearTimeout(t)
  }, [prefs, qtype, open])

  useEvent('prefs:previewDelta', (d) => {
    if (!pending.current?.startsWith(d.previewId)) return
    if (d.text) setPreview(d.text)
    if (d.done) {
      const key = pending.current.slice(d.previewId.length + 1)
      if (d.text) previewCache.set(key, d.text)
      else setPreview((p) => p || '_Preview unavailable right now (no AI key, no connection or a provider error). Your choices still apply._')
      pending.current = null
      setRegenerating(false)
    }
  })

  const set = (patch: Partial<AnswerPrefs>) => setPrefs((p) => ({ ...p, ...patch }))

  return (
    <Modal open={open} onOpenChange={(v) => !saving && onOpenChange(v)} title="Answer preferences" size="two-pane">
      <div className="grid min-h-0 grid-cols-1 sm:h-(--tk-layout-modal-two-pane-h) sm:grid-cols-[44fr_56fr]">
        <section className="flex min-h-0 flex-col p-5" aria-label="Preferences">
          {pane === 'overview' ? (
            <>
              <h2 className="text-md font-semibold">Answer preferences</h2>
              <p className="mt-1 text-xs text-text-muted">
                {midCall ? 'Changes apply from the next answer in this call.' : 'Choose how answers are written. You can change this during a call too.'}
              </p>
              <div className="mt-4 flex flex-col gap-1">
                <PrefRow icon={<AlignLeft size={16} />} title="Format" value={prefsSummary(prefs)} onClick={() => setPane('format')} />
                <PrefRow icon={<Gauge size={16} />} title="Length" value={LENGTH_LABEL[prefs.length]} onClick={() => setPane('length')} />
                <PrefRow icon={<MessageSquare size={16} />} title="Tone" value={TONE_LABEL[prefs.tone]} onClick={() => setPane('tone')} />
              </div>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setPane('overview')} className="mb-3 inline-flex items-center gap-1.5 self-start rounded-sm text-sm text-text-muted hover:text-text">
                <ArrowLeft size={14} /> {pane === 'format' ? 'Format' : pane === 'length' ? 'Length' : 'Tone'}
              </button>
              <div className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                {pane === 'format' && (
                  <>
                    <RadioCards
                      label="Format"
                      value={prefs.format}
                      onChange={(format) => set({ format })}
                      options={[
                        { value: 'full_script', title: FORMAT_LABEL.full_script, description: 'Full sentences to read out as they are.' },
                        { value: 'script_bullets', title: FORMAT_LABEL.script_bullets, description: 'A spoken opening, then key points.' },
                        { value: 'bullets', title: FORMAT_LABEL.bullets, description: 'Short prompts. You do the talking.' },
                      ]}
                    />
                    <ToggleLine
                      icon={<Star size={16} />}
                      title="STAR for behavioural questions"
                      line="Situation, Task, Action, Result."
                      checked={prefs.star}
                      onChange={(star) => set({ star })}
                    />
                    <ToggleLine
                      icon={<Sparkles size={16} />}
                      title="Natural filler words"
                      line={'Adds a few "so" and "you know" so it sounds less read out.'}
                      checked={prefs.filler_words}
                      onChange={(filler_words) => set({ filler_words })}
                    />
                  </>
                )}
                {pane === 'length' && (
                  <RadioCards
                    label="Length"
                    value={prefs.length}
                    onChange={(length) => set({ length })}
                    options={[
                      { value: 'short', title: 'Short', description: 'Two or three points, about 20 seconds spoken.' },
                      { value: 'balanced', title: 'Balanced', description: 'Enough detail to show depth, about a minute.' },
                      { value: 'long', title: 'Long', description: 'Full detail with an extra example or edge case.' },
                    ]}
                  />
                )}
                {pane === 'tone' && (
                  <RadioCards
                    label="Tone"
                    value={prefs.tone}
                    onChange={(tone) => set({ tone })}
                    options={[
                      { value: 'simple', title: 'Simple', description: 'Plain, everyday words. Easy to say naturally.' },
                      { value: 'formal', title: 'Formal', description: 'Polished and precise, no contractions.' },
                    ]}
                  />
                )}
              </div>
            </>
          )}
          <div className="mt-auto flex items-center gap-2 pt-4">
            <Button
              variant="ghost"
              icon={defaultSaved ? <Check size={14} /> : undefined}
              onClick={async () => {
                try {
                  await api.settings.update({ defaultAnswerPrefs: prefs })
                  setDefaultSaved(true)
                } catch (e) {
                  setError(errorText(e))
                }
              }}
            >
              {defaultSaved ? 'Saved as default' : 'Set as default'}
            </Button>
            <span className="flex-1" />
            <Button
              variant="primary"
              loading={saving}
              busyLabel="Saving…"
              onClick={async () => {
                setSaving(true)
                setError(null)
                try {
                  await onSave(prefs)
                  onOpenChange(false)
                } catch (e) {
                  setError(errorText(e))
                } finally {
                  setSaving(false)
                }
              }}
            >
              Save
            </Button>
          </div>
          {error && (
            <p role="alert" className="mt-2 text-xs text-danger-text">
              {error}
            </p>
          )}
        </section>
        <section className="flex min-h-0 flex-col gap-3 border-t border-border bg-surface p-5 sm:rounded-r-lg sm:border-t-0 sm:border-l" aria-label="Answer preview">
          <div className="flex items-center gap-2 pr-8">
            <CircleHelp size={14} className="text-text-muted" aria-hidden />
            <span id="qtype-label" className="text-xs text-text-muted">
              Question type
            </span>
          </div>
          <Select labelledBy="qtype-label" value={qtype} onChange={(v) => setQtype(v as QuestionType)} options={QTYPES} />
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-text-muted" aria-hidden />
            <span className="text-xs text-text-muted">Preview</span>
            {regenerating && <SpinnerLabel label="Updating…" className="ml-auto text-xs" />}
          </div>
          <div className="scroll-thin min-h-40 flex-1 overflow-y-auto rounded-md border border-border bg-bg p-3" aria-live="polite" aria-busy={regenerating}>
            {preview ? (
              <Markdown text={preview} className={regenerating ? 'opacity-50 transition-opacity' : 'transition-opacity'} />
            ) : (
              <SpinnerLabel label="Writing a sample answer…" />
            )}
          </div>
        </section>
      </div>
    </Modal>
  )
}

function PrefRow({ icon, title, value, onClick }: { icon: React.ReactNode; title: string; value: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex min-h-12 items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-surface">
      <span className="text-text-muted" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-base font-medium">{title}</span>
        <span className="block truncate text-xs text-text-muted">{value}</span>
      </span>
      <ChevronRight size={16} className="text-text-muted" aria-hidden />
    </button>
  )
}

function ToggleLine({ icon, title, line, checked, onChange }: { icon: React.ReactNode; title: string; line: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = `t-${title.replace(/\W+/g, '-')}`
  return (
    <div className="flex items-center gap-3 px-1">
      <span className="text-text-muted" aria-hidden>
        {icon}
      </span>
      <label htmlFor={id} className="min-w-0 flex-1">
        <span className="block text-base font-medium">{title}</span>
        <span className="block text-xs text-text-muted">{line}</span>
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

/** S10: free-text context for every answer in the session. */
export function InstructionsModal({
  open,
  onOpenChange,
  value,
  onSave,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  value: string
  onSave: (v: string) => Promise<void> | void
}) {
  const [text, setText] = useState(value)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (open) {
      setText(value)
      setError(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const over = text.length > LIMITS.instructions
  const unchanged = text === value
  return (
    <Modal
      open={open}
      onOpenChange={(v) => !saving && onOpenChange(v)}
      title="AI instructions"
      description="Anything the AI should keep in mind: what to stress, what to avoid, facts that aren't in your resume."
      initialFocus={ref}
      footer={
        <>
          <Button variant="ghost" className="mr-auto" disabled={!text || saving} onClick={() => setText('')}>
            Clear
          </Button>
          <Button
            variant="primary"
            disabled={over || unchanged}
            loading={saving}
            busyLabel="Saving…"
            onClick={async () => {
              setSaving(true)
              try {
                await onSave(text)
                onOpenChange(false)
              } catch (e) {
                setError(errorText(e))
              } finally {
                setSaving(false)
              }
            }}
          >
            Save changes
          </Button>
        </>
      }
    >
      <label htmlFor="instructions" className="sr-only">
        Instructions
      </label>
      <Textarea
        ref={ref}
        id="instructions"
        value={text}
        max={LIMITS.instructions}
        onChange={(e) => setText(e.target.value)}
        className="h-70"
        placeholder={'For example:\nI moved from QA to development in 2023; mention it if asked about career changes.\nDon\'t claim experience with Kubernetes.'}
      />
      {over && (
        <p role="alert" className="mt-2 text-xs text-danger-text">
          That's over the {LIMITS.instructions.toLocaleString()} character limit. Trim it to save.
        </p>
      )}
      {error && (
        <Callout tone="danger" className="mt-3">
          {error}
        </Callout>
      )}
    </Modal>
  )
}
