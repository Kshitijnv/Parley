import { useEffect, useRef, useState } from 'react'
import { Tabs } from 'radix-ui'
import { Download, FileText, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import type { Resume } from '@shared/types'
import { api, isMock } from '@renderer/api'
import { Button } from '@renderer/components/ui/button'
import { Callout, SkeletonLines, SpinnerLabel, Tag } from '@renderer/components/ui/feedback'
import { TextInput, Textarea } from '@renderer/components/ui/form'
import { Markdown } from '@renderer/components/ui/markdown'
import { ConfirmDialog, toast } from '@renderer/components/ui/overlays'
import { bytes, dateTime, errorText } from '@renderer/lib/format'
import { useQuery } from '@renderer/lib/hooks'
import { navigate } from '@renderer/lib/router'
import { BackLink, PageHeader } from './LibraryApp'
import { resumeStatus } from './ResumesPage'

/** S18: what the AI reads, next to the original PDF. */
export function ResumeDetail({ id }: { id: string }) {
  const q = useQuery(() => api.resumes.get({ id }), [id], ['resumes'])
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState('')
  const [confirm, setConfirm] = useState<null | 'delete' | 'reconvert'>(null)
  const r = q.data

  useEffect(() => {
    if (r && !editing) setDraft(r.contentMd)
  }, [r, editing])

  if (q.error) {
    return (
      <div className="p-6">
        <Callout tone="danger" action={<Button size="sm" onClick={() => navigate('/library/resumes')}>Back to resumes</Button>}>
          {errorText(q.error)}
        </Callout>
      </div>
    )
  }
  if (!r) {
    return (
      <div className="p-6">
        <SkeletonLines lines={10} />
      </div>
    )
  }

  const st = resumeStatus(r)
  const saveTitle = async () => {
    const t = title.trim()
    setRenaming(false)
    if (!t || t === r.title) return
    try {
      await api.resumes.update({ id, title: t })
    } catch (e) {
      toast({ text: errorText(e), tone: 'error' })
    }
  }

  return (
    <>
      <PageHeader
        back={<BackLink to="/library/resumes" label="Resumes" />}
        title={
          renaming ? (
            <TextInput
              autoFocus
              aria-label="Resume title"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => void saveTitle()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveTitle()
                if (e.key === 'Escape') setRenaming(false)
              }}
            />
          ) : (
            <button
              type="button"
              className="group inline-flex max-w-full items-center gap-2 text-left"
              onClick={() => {
                setTitle(r.title)
                setRenaming(true)
              }}
              aria-label={`${r.title}. Rename`}
            >
              <span className="truncate">{r.title}</span>
              <Pencil size={14} className="shrink-0 text-text-muted opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden />
            </button>
          )
        }
        description={`${r.source === 'pdf' ? `PDF · ${bytes(r.fileSize)}` : 'Pasted text'} · updated ${dateTime(r.updatedAt)}`}
        actions={
          <>
            <Tag className={st.tone === 'warn' ? 'text-warning-text' : undefined}>{st.label}</Tag>
            {r.source === 'pdf' && (
              <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} disabled={r.mdStatus === 'converting'} onClick={() => setConfirm('reconvert')}>
                Reconvert
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => setConfirm('delete')}>
              Delete
            </Button>
          </>
        }
      />
      <div className="grid gap-6 p-6 lg:grid-cols-2">
        <section aria-label="Original file" className="flex min-h-96 flex-col overflow-hidden rounded-md border border-border">
          <div className="flex h-10 items-center justify-between border-b border-border px-3">
            <h2 className="text-sm font-medium">Original</h2>
            {r.fileUrl && (
              <a href={r.fileUrl} download={`${r.title}.pdf`} className="inline-flex items-center gap-1 rounded-sm text-xs text-text-muted hover:text-text">
                <Download size={14} aria-hidden /> Download
              </a>
            )}
          </div>
          {r.fileUrl ? (
            <iframe title={`${r.title} PDF`} src={r.fileUrl} className="min-h-160 w-full flex-1 bg-surface" />
          ) : r.source === 'pdf' ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
              <FileText size={24} className="text-text-subtle" aria-hidden />
              <p className="text-sm text-text-muted">The PDF file is missing from this PC. Delete this resume and upload it again to see it here.</p>
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
              <FileText size={24} className="text-text-subtle" aria-hidden />
              <p className="text-sm text-text-muted">This resume was pasted as text, so there's no file to show.</p>
            </div>
          )}
        </section>

        <Tabs.Root defaultValue="markdown" className="flex min-w-0 flex-col rounded-md border border-border">
          <Tabs.List aria-label="Resume views" className="flex h-10 items-center gap-1 border-b border-border px-2">
            <Tabs.Trigger value="markdown" className="h-7 rounded-sm px-2 text-sm text-text-muted data-[state=active]:bg-surface-2 data-[state=active]:font-medium data-[state=active]:text-text">
              What the AI reads
            </Tabs.Trigger>
            <Tabs.Trigger value="parsed" className="h-7 rounded-sm px-2 text-sm text-text-muted data-[state=active]:bg-surface-2 data-[state=active]:font-medium data-[state=active]:text-text">
              Parsed fields
            </Tabs.Trigger>
            <span className="flex-1" />
            {!editing && r.mdStatus === 'ready' && (
              <Button size="sm" variant="ghost" icon={<Pencil size={14} />} onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
          </Tabs.List>
          <Tabs.Content value="markdown" className="space-y-3 p-4 outline-none">
            {isMock && r.source === 'pdf' && (
              <Callout>Demo data: PDF conversion is simulated until the AI backend is connected, so this text is a sample, not your file.</Callout>
            )}
            {r.mdStatus === 'converting' || r.mdStatus === 'pending' ? (
              <div className="space-y-3">
                <SpinnerLabel label="Converting to Markdown…" />
                <SkeletonLines lines={10} />
              </div>
            ) : r.mdStatus === 'failed' ? (
              <Callout tone="danger" action={<Button size="sm" onClick={() => setConfirm('reconvert')}>Reconvert</Button>}>
                {r.mdError ?? 'Conversion failed.'}
              </Callout>
            ) : editing ? (
              <div className="space-y-3">
                <label htmlFor="md-edit" className="sr-only">
                  Resume Markdown
                </label>
                <Textarea id="md-edit" value={draft} onChange={(e) => setDraft(e.target.value)} max={60_000} className="h-[60vh] font-mono text-xs" />
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    disabled={saving}
                    onClick={() => {
                      setDraft(r.contentMd)
                      setEditing(false)
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    loading={saving}
                    busyLabel="Saving…"
                    disabled={draft === r.contentMd || draft.length > 60_000}
                    onClick={async () => {
                      setSaving(true)
                      try {
                        await api.resumes.update({ id, contentMd: draft })
                        setEditing(false)
                        toast({ text: 'Saved. New sessions use this version.' })
                      } catch (e) {
                        toast({ text: errorText(e), tone: 'error' })
                      } finally {
                        setSaving(false)
                      }
                    }}
                  >
                    Save
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {r.mdMethod === 'text_extract' && (
                  <Callout>Made with basic text extraction, so headings and columns may be out of order. Add a Gemini key in Settings and reconvert for better structure.</Callout>
                )}
                <Markdown text={r.contentMd} className="text-sm leading-5" />
              </>
            )}
          </Tabs.Content>
          <Tabs.Content value="parsed" className="p-4 outline-none">
            <ParsedView r={r} />
          </Tabs.Content>
        </Tabs.Root>
      </div>
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(v) => !v && setConfirm(null)}
        title="Delete this resume?"
        body={`"${r.title}" is removed from this PC. Past calls keep their transcripts but no longer link to it.`}
        confirmLabel="Delete resume"
        busyLabel="Deleting…"
        danger
        onConfirm={async () => {
          await api.resumes.delete({ id })
          navigate('/library/resumes', { replace: true })
        }}
      />
      <ConfirmDialog
        open={confirm === 'reconvert'}
        onOpenChange={(v) => !v && setConfirm(null)}
        title="Convert the PDF again?"
        body={r.mdMethod === 'manual' ? 'Your edits to the Markdown are replaced by a fresh conversion.' : 'The Markdown is rebuilt from the PDF.'}
        confirmLabel="Reconvert"
        busyLabel="Starting…"
        onConfirm={async () => {
          void api.resumes.reconvert({ id }).catch((e) => toast({ text: errorText(e), tone: 'error' }))
        }}
      />
    </>
  )
}

function ParsedView({ r }: { r: Resume }) {
  // Parsing is on demand (one model call): it starts the first time this tab opens.
  const asked = useRef(false)
  useEffect(() => {
    if (asked.current || r.parseStatus !== 'pending' || r.mdStatus !== 'ready') return
    asked.current = true
    void api.resumes.parse({ id: r.id }).catch((e) => toast({ text: errorText(e), tone: 'error' }))
  }, [r.id, r.parseStatus, r.mdStatus])
  if (r.parseStatus === 'pending' || r.parseStatus === 'parsing') {
    return (
      <div className="space-y-3">
        <SpinnerLabel label="Reading the fields…" />
        <SkeletonLines lines={6} />
      </div>
    )
  }
  if (r.parseStatus === 'failed' || !r.parsed) {
    return (
      <Callout
        tone={r.parseStatus === 'failed' ? 'danger' : 'info'}
        action={
          r.mdStatus === 'ready' ? (
            <Button size="sm" onClick={() => void api.resumes.parse({ id: r.id }).catch((e) => toast({ text: errorText(e), tone: 'error' }))}>
              Extract skills
            </Button>
          ) : null
        }
      >
        {r.parseError ?? 'The fields have not been read from this resume yet.'}
      </Callout>
    )
  }
  const p = r.parsed
  return (
    <div className="space-y-5 text-sm">
      <section>
        <h3 className="mb-1 text-xs font-medium tracking-wide text-text-subtle uppercase">Contact</h3>
        <p className="font-medium">{p.contact.name}</p>
        <p className="text-text-muted">{[p.contact.headline, p.contact.location, p.contact.email, p.contact.phone].filter(Boolean).join(' · ')}</p>
      </section>
      <section>
        <h3 className="mb-1 text-xs font-medium tracking-wide text-text-subtle uppercase">Summary</h3>
        <p>{p.summary}</p>
      </section>
      <section>
        <h3 className="mb-1 text-xs font-medium tracking-wide text-text-subtle uppercase">Experience</h3>
        <ul className="space-y-3">
          {p.experience.map((e, i) => (
            <li key={i}>
              <p className="font-medium">
                {e.role}, {e.company}
              </p>
              <p className="text-xs text-text-muted">{e.period}</p>
              <ul className="mt-1 list-disc pl-5 text-text-muted">
                {e.highlights.map((h, j) => (
                  <li key={j}>{h}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3 className="mb-2 text-xs font-medium tracking-wide text-text-subtle uppercase">Skills</h3>
        <div className="space-y-2">
          {Object.entries(p.skills).map(([cat, list]) => (
            <div key={cat}>
              <p className="mb-1 text-xs font-medium">{cat}</p>
              <div className="flex flex-wrap gap-1.5">
                {list.map((s) => (
                  <Tag key={s} size="md">
                    {s}
                  </Tag>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
      {p.projects.length > 0 && (
        <section>
          <h3 className="mb-1 text-xs font-medium tracking-wide text-text-subtle uppercase">Key projects</h3>
          <ul className="space-y-1">
            {p.projects.map((x, i) => (
              <li key={i}>
                <span className="font-medium">{x.name}:</span> <span className="text-text-muted">{x.description}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
