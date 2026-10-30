import { useEffect, useRef, useState } from 'react'
import {
  Bot,
  Briefcase,
  Check,
  FilePlus2,
  Languages,
  Link2,
  MessageSquareText,
  Phone,
  Plus,
  RotateCw,
  Settings2,
  Sparkles,
  Upload,
  WandSparkles,
  Zap,
  Cpu,
  Captions,
} from 'lucide-react'
import type { AnswerPrefs, CreateSessionInput, SessionType } from '@shared/types'
import { LIMITS } from '@shared/ipc'
import { prefsSummary } from '@shared/catalog'
import { api } from '@renderer/api'
import { AddDocumentFlow, UploadResumeModal } from '@renderer/components/ContextModals'
import { AnswerPrefsModal, InstructionsModal } from '@renderer/components/PrefsModals'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/components/ui/cn'
import { Callout, SkeletonLines, Tag } from '@renderer/components/ui/feedback'
import { Field, Segmented, SectionLabel, SettingRow, Switch, Textarea, TextInput } from '@renderer/components/ui/form'
import { MenuFooterButton, Select } from '@renderer/components/ui/select'
import { errorText } from '@renderer/lib/format'
import { useQuery, useSettings } from '@renderer/lib/hooks'
import { navigate } from '@renderer/lib/router'
import { Panel } from './OverlayApp'
import { WindowHeader } from './WindowControls'
import { CompanyField } from './CompanyField'

type Draft = Omit<CreateSessionInput, 'answerPrefs'> & { answerPrefs: AnswerPrefs | null }

const TYPE_OPTIONS: Array<{ value: SessionType; label: string; icon: React.ReactNode }> = [
  { value: 'interview', label: 'Interview', icon: <Briefcase size={14} strokeWidth={1.75} /> },
  { value: 'regular', label: 'Regular', icon: <Phone size={14} strokeWidth={1.75} /> },
  { value: 'mock', label: 'Mock', icon: <Bot size={14} strokeWidth={1.75} /> },
]

const CREATE_LABEL: Record<SessionType, string> = {
  interview: 'Create interview session',
  regular: 'Create call session',
  mock: 'Create mock interview',
}

/** S07 (details) and S08 (preferences). */
export function CreateSession({ draftId, initialStep, initialType }: { draftId: string | null; initialStep: 1 | 2; initialType: string | null }) {
  const settings = useSettings()
  const resumes = useQuery(() => api.resumes.list(), [], ['resumes'])
  const docs = useQuery(() => api.documents.list(), [], ['documents'])
  const models = useQuery(() => api.models.list(), [], ['keys'])
  const [step, setStep] = useState<1 | 2>(initialStep)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Partial<Record<keyof Draft | 'form', string>>>({})
  const [saving, setSaving] = useState(false)
  const [modal, setModal] = useState<null | 'prefs' | 'instructions' | 'upload' | 'doc'>(null)
  const mainRef = useRef<HTMLDivElement>(null)

  // Build the draft from Settings defaults, or load an existing draft (Back from S12).
  useEffect(() => {
    if (draft || !settings.data) return
    if (draftId) {
      api.sessions
        .get({ id: draftId })
        .then((s) => {
          if (s.status !== 'draft') {
            navigate('/overlay', { replace: true })
            return
          }
          setDraft({
            type: s.type,
            companyName: s.companyName,
            companyDomain: s.companyDomain,
            roleTitle: s.roleTitle,
            jobUrl: s.jobUrl,
            jobDescription: s.jobDescription,
            resumeId: s.resumeId,
            documentIds: s.documentIds,
            language: s.language,
            model: s.model,
            answerPrefs: s.answerPrefs,
            instructions: s.instructions,
            autoGenerate: s.autoGenerate,
            saveTranscript: s.saveTranscript,
          })
        })
        .catch((e) => setLoadError(errorText(e)))
      return
    }
    const s = settings.data
    setDraft({
      type: (['interview', 'regular', 'mock'].includes(initialType ?? '') ? initialType : 'interview') as SessionType,
      companyName: '',
      companyDomain: null,
      roleTitle: '',
      jobUrl: null,
      jobDescription: '',
      resumeId: null,
      documentIds: [],
      language: s.defaultLanguage,
      model: s.defaultModel,
      answerPrefs: null,
      instructions: '',
      autoGenerate: false,
      saveTranscript: true,
    })
  }, [settings.data, draftId, draft, initialType])

  // Pick the newest resume by default the first time the list arrives.
  const autoPicked = useRef(false)
  useEffect(() => {
    if (!draft || autoPicked.current || !resumes.data || draftId) return
    autoPicked.current = true
    if (!draft.resumeId && resumes.data[0]) setDraft({ ...draft, resumeId: resumes.data[0].id })
  }, [resumes.data, draft, draftId])

  // If the chosen model's key was removed, fall back to the first available model.
  useEffect(() => {
    if (!draft || !models.data?.length) return
    if (!models.data.some((m) => m.id === draft.model)) setDraft({ ...draft, model: models.data[0]!.id })
  }, [models.data, draft])

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 })
  }, [step])

  const set = (patch: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d))
    setErrors((e) => {
      const next = { ...e }
      for (const k of Object.keys(patch)) delete next[k as keyof Draft]
      delete next.form
      return next
    })
  }

  const validateStep1 = () => {
    if (!draft) return false
    const e: typeof errors = {}
    if (draft.jobDescription.length > LIMITS.jobDescription) e.jobDescription = `Keep it under ${LIMITS.jobDescription.toLocaleString()} characters.`
    if ((draft.companyName ?? '').length > LIMITS.company) e.companyName = 'That name is too long.'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const prefs = draft?.answerPrefs ?? settings.data?.defaultAnswerPrefs
  const noModels = models.data && models.data.length === 0

  const submit = async () => {
    if (!draft || !prefs) return
    if (noModels) {
      setErrors({ form: 'Add an API key first so a model can write the answers.' })
      return
    }
    setSaving(true)
    setErrors({})
    const input: CreateSessionInput = {
      ...draft,
      companyName: draft.companyName?.trim() || null,
      roleTitle: draft.roleTitle?.trim() || null,
      answerPrefs: prefs,
    }
    try {
      const s = draftId ? await api.sessions.update({ id: draftId, patch: input }) : await api.sessions.create(input)
      navigate(`/overlay/connect/${s.id}`, { replace: true })
    } catch (e) {
      setErrors({ form: errorText(e) })
      setSaving(false)
    }
  }

  const resumeOptions = (resumes.data ?? []).map((r) => ({
    value: r.id,
    label: r.title,
    hint: r.mdStatus === 'converting' ? 'Converting…' : r.mdStatus === 'failed' ? 'Needs a fix' : undefined,
  }))
  const docOptions = (docs.data ?? []).map((d) => ({ value: d.id, label: d.title }))
  const langOptions = api.models.languages().map((l) => ({
    value: l.code,
    label: l.label,
    // Hindi has no verified model yet (architecture.md §10): say so, not "Needs Deepgram".
    hint: l.stt.includes(settings.data?.sttProvider ?? 'local') ? undefined : l.code.startsWith('hi') ? 'Not verified yet' : 'Not available yet',
    disabled: !l.stt.includes(settings.data?.sttProvider ?? 'local'),
  }))
  const modelOptions = (models.data ?? []).map((m) => ({ value: m.id, label: m.label, hint: m.speed }))

  return (
    <Panel size="wizard">
      <WindowHeader />
      <div className="flex min-h-0 flex-1 border-t border-border">
        <aside className="flex w-(--tk-layout-overlay-wizard-rail-w) shrink-0 flex-col border-r border-border p-5 max-sm:hidden">
          <h1 className="text-lg font-medium">Create session</h1>
          <p className="mt-1 text-xs text-text-muted">Give the AI the context for this call. It answers from your resume and the job.</p>
          <ol aria-label="Steps" className="mt-6">
            <StepItem n={1} label="Details" state={step === 1 ? 'active' : 'done'} />
            <li aria-hidden className="ml-2.5 h-6 w-px bg-border" />
            <StepItem n={2} label="Preferences" state={step === 2 ? 'active' : 'upcoming'} />
          </ol>
        </aside>
        <form
          className="flex min-w-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            if (step === 1) {
              if (validateStep1()) setStep(2)
            } else void submit()
          }}
          noValidate
        >
          <div ref={mainRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto p-5">
            {loadError ? (
              <Callout tone="danger">{loadError}</Callout>
            ) : !draft || !prefs ? (
              <SkeletonLines lines={8} />
            ) : step === 1 ? (
              <div className="space-y-5">
                <h2 className="sr-only">Step 1 of 2: Details</h2>
                <div className="flex flex-col gap-1.5">
                  <span id="type-label" className="text-base font-medium">
                    Session type
                  </span>
                  <Segmented label="Session type" value={draft.type} onChange={(type) => set({ type })} options={TYPE_OPTIONS} />
                  {draft.type === 'mock' && <p className="text-xs text-text-subtle">An AI interviewer asks the questions, so you can practise with the same setup.</p>}
                </div>
                <JobLinkImport
                  onImported={(r, url) =>
                    set({
                      jobUrl: url,
                      companyName: draft.companyName || r.company || '',
                      roleTitle: draft.roleTitle || r.role || '',
                      jobDescription: r.description,
                    })
                  }
                  importedUrl={draft.jobUrl}
                />
                {/* side by side so the Context row stays above the fold, as in the reference */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Company" error={errors.companyName}>
                    {({ id, describedBy }) => <CompanyField id={id} describedBy={describedBy} name={draft.companyName ?? ''} domain={draft.companyDomain} onChange={(companyName, companyDomain) => set({ companyName, companyDomain })} />}
                  </Field>
                  <Field label={draft.type === 'regular' ? 'Topic' : 'Role'}>
                    {({ id, describedBy }) => (
                      <TextInput
                        id={id}
                        aria-describedby={describedBy}
                        value={draft.roleTitle ?? ''}
                        maxLength={LIMITS.title}
                        placeholder={draft.type === 'regular' ? 'What the call is about' : 'The job title'}
                        onChange={(e) => set({ roleTitle: e.target.value })}
                      />
                    )}
                  </Field>
                </div>
                <Field label={draft.type === 'regular' ? 'Notes for the AI' : 'Job description'} error={errors.jobDescription}>
                  {({ id, describedBy, invalid }) => (
                    <Textarea
                      id={id}
                      aria-describedby={describedBy}
                      invalid={invalid}
                      value={draft.jobDescription}
                      max={LIMITS.jobDescription}
                      placeholder={draft.type === 'regular' ? 'Agenda, people on the call, anything useful' : 'Paste the job post. The more detail, the better the answers.'}
                      onChange={(e) => set({ jobDescription: e.target.value })}
                      className="min-h-24"
                      rows={4}
                    />
                  )}
                </Field>
                <div className="space-y-3">
                  <SectionLabel>Context</SectionLabel>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Resume">
                      {({ id, describedBy }) => (
                        <Select
                          id={id}
                          describedBy={describedBy}
                          labelledBy={undefined}
                          ariaLabel="Resume"
                          value={draft.resumeId}
                          onChange={(resumeId) => set({ resumeId: resumeId || null })}
                          options={[...(draft.resumeId ? [{ value: '', label: 'No resume' }] : []), ...resumeOptions]}
                          placeholder={resumes.loading ? 'Loading…' : resumeOptions.length ? 'Pick a resume' : 'No resumes yet'}
                          emptyText="No resumes yet. Upload one below."
                          footer={
                            <>
                              <MenuFooterButton icon={<RotateCw size={14} />} onClick={() => void resumes.reload()}>
                                Refresh
                              </MenuFooterButton>
                              <MenuFooterButton icon={<Upload size={14} />} onClick={() => setModal('upload')}>
                                Upload
                              </MenuFooterButton>
                            </>
                          }
                        />
                      )}
                    </Field>
                    <Field label="Documents">
                      {({ id, describedBy }) => (
                        <Select
                          multiple
                          id={id}
                          describedBy={describedBy}
                          ariaLabel={`Documents, ${draft.documentIds.length} selected`}
                          value={draft.documentIds}
                          onChange={(documentIds) => set({ documentIds })}
                          options={docOptions}
                          placeholder={docs.loading ? 'Loading…' : docOptions.length ? 'None selected' : 'No documents yet'}
                          emptyText="No documents yet."
                          footer={
                            <>
                              <MenuFooterButton icon={<RotateCw size={14} />} onClick={() => void docs.reload()}>
                                Refresh
                              </MenuFooterButton>
                              <MenuFooterButton icon={<FilePlus2 size={14} />} onClick={() => setModal('doc')}>
                                Add
                              </MenuFooterButton>
                              <span className="flex-1" />
                              <MenuFooterButton disabled={!docOptions.length} onClick={() => set({ documentIds: docOptions.map((d) => d.value) })}>
                                Select all
                              </MenuFooterButton>
                              <MenuFooterButton disabled={!draft.documentIds.length} onClick={() => set({ documentIds: [] })}>
                                Clear
                              </MenuFooterButton>
                            </>
                          }
                        />
                      )}
                    </Field>
                  </div>
                  {!draft.resumeId && draft.type !== 'regular' && !resumes.loading && (
                    <Callout
                      action={
                        <Button size="sm" icon={<Upload size={14} />} onClick={() => setModal('upload')}>
                          Upload resume
                        </Button>
                      }
                    >
                      Without a resume, answers to "tell me about a time…" questions can only be general.
                    </Callout>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-5">
                <h2 className="sr-only">Step 2 of 2: Preferences</h2>
                <div className="space-y-2">
                  <SectionLabel>Session</SectionLabel>
                  <SettingRow
                    icon={<Languages size={16} />}
                    title="Language"
                    subtitle="What the call is spoken in"
                    control={({ labelledBy, describedBy }) => (
                      <div className="w-48">
                        <Select searchable size="sm" align="end" menuWidth="auto" labelledBy={labelledBy} describedBy={describedBy} value={draft.language} onChange={(language) => set({ language })} options={langOptions} />
                      </div>
                    )}
                  />
                  <SettingRow
                    icon={<Cpu size={16} />}
                    title="Model"
                    subtitle="Speed and quality of answers"
                    control={({ labelledBy, describedBy }) =>
                      noModels ? (
                        <Button size="sm" variant="secondary" external onClick={() => void api.window.openLibrary({ route: '/settings' })}>
                          Add an API key
                        </Button>
                      ) : (
                        <div className="w-48">
                          <Select size="sm" align="end" menuWidth="auto" labelledBy={labelledBy} describedBy={describedBy} value={draft.model} onChange={(model) => set({ model })} options={modelOptions} placeholder={models.loading ? 'Loading…' : 'Choose'} />
                        </div>
                      )
                    }
                  />
                  <SettingRow
                    icon={<MessageSquareText size={16} />}
                    title="Answer preferences"
                    subtitle={prefsSummary(prefs)}
                    control={() => (
                      <Button size="sm" variant="primary" icon={<Settings2 size={14} />} onClick={() => setModal('prefs')}>
                        Configure
                      </Button>
                    )}
                  />
                  <SettingRow
                    icon={<WandSparkles size={16} />}
                    title="AI instructions"
                    subtitle={draft.instructions ? `${draft.instructions.length.toLocaleString()} characters` : 'Extra guidance for every answer'}
                    control={() => (
                      <Button size="sm" variant="ghost" icon={draft.instructions ? undefined : <Plus size={14} />} onClick={() => setModal('instructions')}>
                        {draft.instructions ? 'Edit' : 'Add'}
                      </Button>
                    )}
                  />
                </div>
                <div className="space-y-2">
                  <SectionLabel>Extra</SectionLabel>
                  <SettingRow
                    icon={<Zap size={16} />}
                    title="Auto answer"
                    subtitle="Answer when a question is detected, without the hotkey"
                    control={({ describedBy }) => (
                      <span className="flex items-center gap-2">
                        <Tag>Beta</Tag>
                        <Switch checked={draft.autoGenerate} onCheckedChange={(autoGenerate) => set({ autoGenerate })} describedBy={describedBy} label="Auto answer" />
                      </span>
                    )}
                  />
                  <SettingRow
                    icon={<Captions size={16} />}
                    title="Save transcript"
                    subtitle="Keep the transcript and answers for review and notes"
                    control={({ describedBy }) => <Switch checked={draft.saveTranscript} onCheckedChange={(saveTranscript) => set({ saveTranscript })} describedBy={describedBy} label="Save transcript" />}
                  />
                  <p className="pl-7 text-xs text-text-subtle">
                    You're recording another person. Some places require everyone on the call to agree first. Everything is stored on this PC only; deleting the call removes it.
                  </p>
                </div>
                {errors.form && (
                  <Callout tone="danger" role="alert">
                    {errors.form}
                  </Callout>
                )}
              </div>
            )}
          </div>
          <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
            {step === 1 ? (
              <>
                <Button variant="ghost" onClick={() => navigate('/overlay')}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" className="min-w-30" disabled={!draft}>
                  Next
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={() => setStep(1)} disabled={saving}>
                  Back
                </Button>
                <Button type="submit" variant="primary" loading={saving} busyLabel="Starting…" disabled={!draft || noModels}>
                  {draft ? CREATE_LABEL[draft.type] : 'Create session'}
                </Button>
              </>
            )}
          </footer>
        </form>
      </div>
      {draft && prefs && (
        <>
          <AnswerPrefsModal open={modal === 'prefs'} onOpenChange={(v) => setModal(v ? 'prefs' : null)} value={prefs} onSave={(answerPrefs) => set({ answerPrefs })} />
          <InstructionsModal open={modal === 'instructions'} onOpenChange={(v) => setModal(v ? 'instructions' : null)} value={draft.instructions} onSave={(instructions) => set({ instructions })} />
        </>
      )}
      <UploadResumeModal
        open={modal === 'upload'}
        onOpenChange={(v) => setModal(v ? 'upload' : null)}
        onDone={(r) => {
          void resumes.reload()
          set({ resumeId: r.id })
        }}
      />
      <AddDocumentFlow
        open={modal === 'doc'}
        onOpenChange={(v) => setModal(v ? 'doc' : null)}
        onDone={(d) => {
          void docs.reload()
          setDraft((x) => (x ? { ...x, documentIds: [...new Set([...x.documentIds, d.id])] } : x))
        }}
      />
    </Panel>
  )
}

function StepItem({ n, label, state }: { n: number; label: string; state: 'upcoming' | 'active' | 'done' }) {
  return (
    <li aria-current={state === 'active' ? 'step' : undefined} className="flex items-center gap-2.5">
      <span
        className={cn(
          'flex size-5 items-center justify-center rounded-pill text-2xs font-semibold',
          state === 'upcoming' ? 'border border-border-input text-text-muted' : 'bg-accent text-on-accent',
        )}
      >
        {state === 'done' ? <Check size={12} strokeWidth={2.5} aria-label="Done" /> : n}
      </span>
      <span className={cn('text-sm', state === 'active' ? 'font-medium text-text' : 'text-text-muted')}>{label}</span>
    </li>
  )
}

function JobLinkImport({ onImported, importedUrl }: { onImported: (r: { company?: string; role?: string; description: string }, url: string) => void; importedUrl: string | null }) {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const run = async () => {
    setError(null)
    if (!/^https?:\/\/\S+\.\S+/.test(url.trim())) {
      setError('Paste a full link starting with https://')
      return
    }
    setBusy(true)
    try {
      const r = await api.jobs.import({ url: url.trim() })
      onImported(r, url.trim())
      setDone(new URL(url.trim()).hostname.replace(/^www\./, ''))
      setOpen(false)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <div className="space-y-1.5">
        <p className="text-xs text-text-muted">Have a link to the job post? Import the details from it.</p>
        <Button variant="secondary" className="w-full" icon={<Sparkles size={14} />} onClick={() => setOpen(true)}>
          {importedUrl || done ? 'Import from another link' : 'Paste a job link'}
        </Button>
        {(done || importedUrl) && (
          <p className="text-xs text-text-subtle" role="status">
            <Check size={12} className="mr-1 inline" aria-hidden />
            Imported from {done ?? new URL(importedUrl!).hostname}. Check the details below.
          </p>
        )}
      </div>
    )
  }
  return (
    <Field label="Job post link" error={error} hint="Public job pages only. Pages behind a login can't be read.">
      {({ id, describedBy, invalid }) => (
        <div className="flex gap-2">
          <TextInput
            ref={inputRef}
            id={id}
            className="flex-1"
            aria-describedby={describedBy}
            invalid={invalid}
            leading={<Link2 size={14} />}
            placeholder="https://"
            value={url}
            disabled={busy}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void run()
              }
              if (e.key === 'Escape') setOpen(false)
            }}
          />
          <Button variant="primary" loading={busy} busyLabel="Reading…" onClick={() => void run()}>
            Import
          </Button>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
        </div>
      )}
    </Field>
  )
}
