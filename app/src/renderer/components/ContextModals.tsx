import { useEffect, useRef, useState } from 'react'
import { ClipboardPaste, FileUp, ChevronRight } from 'lucide-react'
import type { DocumentFile, PickedFile, Resume } from '@shared/types'
import { LIMITS } from '@shared/ipc'
import { api } from '@renderer/api'
import { Button } from './ui/button'
import { Callout } from './ui/feedback'
import { Field, Textarea, TextInput } from './ui/form'
import { Modal } from './ui/overlays'
import { DropZone } from './DropZone'
import { errorText } from '@renderer/lib/format'
import { useEvent } from '@renderer/lib/hooks'

const isPdf = (f: File) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf'
const isDoc = (f: File) => /\.(pdf|txt|md)$/i.test(f.name)
const titleFrom = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, LIMITS.title)

function checkFile(f: File, kind: 'resume' | 'document'): string | null {
  if (kind === 'resume' && !isPdf(f)) return 'Only PDF files work here. Export your resume as a PDF, or paste the text instead.'
  if (kind === 'document' && !isDoc(f)) return 'Use a PDF, TXT or MD file.'
  if (f.size === 0) return 'That file is empty.'
  if (f.size > LIMITS.fileBytes) return 'That file is over 10 MB.'
  return null
}

/** S25: upload a resume PDF, with progress through copy and Markdown conversion. */
export function UploadResumeModal({
  open,
  onOpenChange,
  onBack,
  onDone,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onBack?: () => void
  onDone: (r: Resume) => void
}) {
  return <UploadModal kind="resume" open={open} onOpenChange={onOpenChange} onBack={onBack} onDone={(r) => onDone(r as Resume)} />
}

export function UploadModal({
  kind,
  open,
  onOpenChange,
  onBack,
  onDone,
}: {
  kind: 'resume' | 'document'
  open: boolean
  onOpenChange: (v: boolean) => void
  onBack?: () => void
  onDone: (r: Resume | DocumentFile) => void
}) {
  const [file, setFile] = useState<PickedFile | null>(null)
  const [title, setTitle] = useState('')
  const [rejected, setRejected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [pct, setPct] = useState<number | null>(null)
  const [dupe, setDupe] = useState<Resume | DocumentFile | null>(null)
  const ns = kind === 'resume' ? api.resumes : api.documents

  useEffect(() => {
    if (!open) return
    setFile(null)
    setTitle('')
    setRejected(null)
    setError(null)
    setStage(null)
    setPct(null)
    setDupe(null)
  }, [open])

  useEvent(kind === 'resume' ? 'resumes:progress' : 'documents:progress', (p) => {
    if (!stage) return
    if (p.stage === 'copying') {
      setStage('Copying…')
      setPct(p.pct ?? null)
    } else if (p.stage === 'converting') {
      setStage(kind === 'resume' ? 'Converting to Markdown…' : 'Reading text…')
      setPct(null)
    }
  })

  const accept = (f: File) => !checkFile(f, kind)
  const take = (f: File) => {
    const err = checkFile(f, kind)
    setRejected(err)
    if (err) return
    setFile({ path: ns.pathForFile(f), name: f.name, size: f.size })
    if (!title) setTitle(titleFrom(f.name))
  }

  const submit = async () => {
    if (!file) {
      setRejected(kind === 'resume' ? 'Choose a PDF first.' : 'Choose a file first.')
      return
    }
    setError(null)
    setStage('Copying…')
    setPct(0)
    try {
      const out = await ns.importFile({ path: file.path, title: title.trim() || titleFrom(file.name) })
      setStage(null)
      if (out.duplicateOf) {
        setDupe(out)
        return
      }
      onDone(out)
      onOpenChange(false)
    } catch (e) {
      setStage(null)
      setError(errorText(e))
    }
  }

  const busy = !!stage
  return (
    <Modal
      open={open}
      onOpenChange={(v) => !busy && onOpenChange(v)}
      title={kind === 'resume' ? 'Upload a resume' : 'Upload a document'}
      description={kind === 'resume' ? 'The AI reads it as Markdown. You can check and edit the result afterwards.' : 'Notes, a project brief or a company one-pager the AI should know about.'}
      footer={
        <>
          {onBack && (
            <Button variant="ghost" onClick={onBack} disabled={busy} className="mr-auto">
              Back
            </Button>
          )}
          <Button variant="primary" onClick={() => void submit()} loading={busy} busyLabel="Uploading…" disabled={!file && !busy}>
            {kind === 'resume' ? 'Upload resume' : 'Upload document'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <DropZone
          file={file}
          stage={stage}
          pct={pct}
          rejected={rejected}
          accept={accept}
          hint={kind === 'resume' ? 'PDF, up to 10 MB' : 'PDF, TXT or MD, up to 10 MB'}
          label={kind === 'resume' ? 'Drop a PDF here or browse' : 'Drop a file here or browse'}
          onPick={async () => {
            const f = await ns.pickFile()
            if (!f) return
            if (kind === 'resume' && !/\.pdf$/i.test(f.name)) {
              setRejected('Only PDF files work here.')
              return
            }
            if (f.size > LIMITS.fileBytes) {
              setRejected('That file is over 10 MB.')
              return
            }
            setRejected(null)
            setFile(f)
            if (!title) setTitle(titleFrom(f.name))
          }}
          onDropFile={take}
          onRemove={() => setFile(null)}
        />
        {file && !busy && (
          <Field label="Title" hint="Shown in the session setup list.">
            {({ id, describedBy }) => <TextInput id={id} aria-describedby={describedBy} value={title} maxLength={LIMITS.title} onChange={(e) => setTitle(e.target.value)} />}
          </Field>
        )}
        {error && (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        )}
        {dupe && (
          <Callout
            tone="warning"
            action={
              <Button
                size="sm"
                onClick={() => {
                  onDone(dupe)
                  onOpenChange(false)
                }}
              >
                Use it
              </Button>
            }
          >
            You already added this file as "{dupe.title}".
          </Callout>
        )}
      </div>
    </Modal>
  )
}

/** Typed or pasted text, for a resume (fallback for scans) or a document. */
export function PasteTextModal({
  kind,
  open,
  onOpenChange,
  onBack,
  onDone,
}: {
  kind: 'resume' | 'document'
  open: boolean
  onOpenChange: (v: boolean) => void
  onBack?: () => void
  onDone: (r: Resume | DocumentFile) => void
}) {
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [errors, setErrors] = useState<{ title?: string; text?: string; form?: string }>({})
  const [busy, setBusy] = useState(false)
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (open) {
      setTitle('')
      setText('')
      setErrors({})
    }
  }, [open])
  const submit = async () => {
    const e: typeof errors = {}
    if (!title.trim()) e.title = 'Give it a title.'
    if (kind === 'resume' && text.trim().length < 40) e.text = 'Paste the full resume: at least a few lines.'
    if (kind === 'document' && !text.trim()) e.text = 'Add some text.'
    setErrors(e)
    if (Object.keys(e).length) return
    setBusy(true)
    try {
      const out = kind === 'resume' ? await api.resumes.createFromText({ title, text }) : await api.documents.createFromText({ title, text })
      onDone(out)
      onOpenChange(false)
    } catch (err) {
      setErrors({ form: errorText(err) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={open}
      onOpenChange={(v) => !busy && onOpenChange(v)}
      title={kind === 'resume' ? 'Paste resume text' : 'Write or paste a document'}
      description={kind === 'resume' ? 'Plain text or Markdown both work. Keep every date, role and skill.' : 'The AI reads this as extra context in your sessions.'}
      size="md"
      initialFocus={first}
      footer={
        <>
          {onBack && (
            <Button variant="ghost" onClick={onBack} disabled={busy} className="mr-auto">
              Back
            </Button>
          )}
          <Button variant="primary" loading={busy} busyLabel="Saving…" onClick={() => void submit()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Title" error={errors.title}>
          {({ id, describedBy, invalid }) => (
            <TextInput ref={first} id={id} aria-describedby={describedBy} invalid={invalid} value={title} maxLength={LIMITS.title} onChange={(e) => setTitle(e.target.value)} />
          )}
        </Field>
        <Field label={kind === 'resume' ? 'Resume text' : 'Text'} error={errors.text}>
          {({ id, describedBy, invalid }) => (
            <Textarea id={id} aria-describedby={describedBy} invalid={invalid} value={text} max={60_000} onChange={(e) => setText(e.target.value)} className="h-64" />
          )}
        </Field>
        {errors.form && <Callout tone="danger">{errors.form}</Callout>}
      </div>
    </Modal>
  )
}

/** S17: choose how to add a resume. LinkedIn import and the resume builder are out of scope. */
export function AddResumeFlow({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone: (r: Resume) => void }) {
  const [step, setStep] = useState<'choose' | 'upload' | 'paste'>('choose')
  useEffect(() => {
    if (open) setStep('choose')
  }, [open])
  return (
    <>
      <Modal open={open && step === 'choose'} onOpenChange={onOpenChange} title="Add a resume" description="The AI uses it to answer in your voice, with your real roles and results.">
        <div className="flex flex-col gap-2">
          <ChoiceRow icon={<FileUp size={20} strokeWidth={1.5} />} title="Upload a PDF" line="Best for most resumes, including two-column layouts." onClick={() => setStep('upload')} />
          <ChoiceRow icon={<ClipboardPaste size={20} strokeWidth={1.5} />} title="Paste text" line="For a resume you have as text, or a PDF that won't convert." onClick={() => setStep('paste')} />
        </div>
      </Modal>
      <UploadResumeModal open={open && step === 'upload'} onOpenChange={onOpenChange} onBack={() => setStep('choose')} onDone={onDone} />
      <PasteTextModal kind="resume" open={open && step === 'paste'} onOpenChange={onOpenChange} onBack={() => setStep('choose')} onDone={(r) => onDone(r as Resume)} />
    </>
  )
}

export function AddDocumentFlow({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone: (d: DocumentFile) => void }) {
  const [step, setStep] = useState<'choose' | 'upload' | 'paste'>('choose')
  useEffect(() => {
    if (open) setStep('choose')
  }, [open])
  return (
    <>
      <Modal open={open && step === 'choose'} onOpenChange={onOpenChange} title="Add a document" description="Extra context for answers: project notes, a product brief, a list of questions to ask.">
        <div className="flex flex-col gap-2">
          <ChoiceRow icon={<FileUp size={20} strokeWidth={1.5} />} title="Upload a file" line="PDF, TXT or MD, up to 10 MB." onClick={() => setStep('upload')} />
          <ChoiceRow icon={<ClipboardPaste size={20} strokeWidth={1.5} />} title="Write or paste text" line="Quick notes you type here." onClick={() => setStep('paste')} />
        </div>
      </Modal>
      <UploadModal kind="document" open={open && step === 'upload'} onOpenChange={onOpenChange} onBack={() => setStep('choose')} onDone={(d) => onDone(d as DocumentFile)} />
      <PasteTextModal kind="document" open={open && step === 'paste'} onOpenChange={onOpenChange} onBack={() => setStep('choose')} onDone={(d) => onDone(d as DocumentFile)} />
    </>
  )
}

function ChoiceRow({ icon, title, line, onClick }: { icon: React.ReactNode; title: string; line: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-3 rounded-md border border-border px-3.5 py-3 text-left hover:bg-surface">
      <span className="text-text-muted" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-base font-medium">{title}</span>
        <span className="block text-xs text-text-muted">{line}</span>
      </span>
      <ChevronRight size={16} className="text-text-muted" aria-hidden />
    </button>
  )
}
