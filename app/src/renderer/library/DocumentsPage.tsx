import { useEffect, useState } from 'react'
import { FileText, Files, MoreVertical, Pencil, Plus, Trash2 } from 'lucide-react'
import type { DocumentRow } from '@shared/types'
import { api } from '@renderer/api'
import { AddDocumentFlow } from '@renderer/components/ContextModals'
import { Button, IconButton } from '@renderer/components/ui/button'
import { Callout, EmptyState, Skeleton, SkeletonLines, Tag } from '@renderer/components/ui/feedback'
import { Field, TextInput, Textarea } from '@renderer/components/ui/form'
import { ConfirmDialog, Menu, MenuContent, MenuItem, MenuTrigger, toast } from '@renderer/components/ui/overlays'
import { bytes, dateTime, dayLabel, errorText } from '@renderer/lib/format'
import { useQuery } from '@renderer/lib/hooks'
import { navigate } from '@renderer/lib/router'
import { BackLink, PageHeader } from './LibraryApp'

const SOURCE: Record<DocumentRow['source'], string> = { pdf: 'PDF', markdown: 'File', text: 'Note' }

/** S21: supporting documents used as extra context. */
export function DocumentsPage() {
  const list = useQuery(() => api.documents.list(), [], ['documents'])
  const [adding, setAdding] = useState(false)
  const [del, setDel] = useState<DocumentRow | null>(null)
  const rows = list.data ?? []
  return (
    <>
      <PageHeader
        title="Documents"
        description="Extra context for answers: project notes, a product brief, questions you want to ask."
        actions={
          <Button variant="accent" icon={<Plus size={16} />} onClick={() => setAdding(true)}>
            Add document
          </Button>
        }
      />
      <div className="mx-auto max-w-(--tk-layout-library-content-max) p-6">
        {list.loading && !list.data ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading documents">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : list.error ? (
          <Callout tone="danger" action={<Button size="sm" onClick={() => void list.reload()}>Try again</Button>}>
            {errorText(list.error)}
          </Callout>
        ) : rows.length === 0 ? (
          <EmptyState
            className="mt-16"
            icon={<Files size={24} />}
            title="No documents yet"
            line="Add notes or a brief for extra context."
            action={
              <Button variant="secondary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
                Add document
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border" aria-label="Documents">
            {rows.map((d) => (
              <li key={d.id} className="relative flex items-center gap-3 px-4 py-3 hover:bg-surface">
                <FileText size={20} strokeWidth={1.5} className="shrink-0 text-text-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <button type="button" onClick={() => navigate(`/library/documents/${d.id}`)} className="block max-w-full truncate text-left text-base font-medium after:absolute after:inset-0">
                    {d.title}
                  </button>
                  <p className="text-xs text-text-muted">
                    {SOURCE[d.source]}
                    {d.fileSize ? ` · ${bytes(d.fileSize)}` : ''} · added {dayLabel(d.createdAt)}
                  </p>
                </div>
                {d.textStatus === 'empty' && <Tag className="text-warning-text">No text found</Tag>}
                <Menu>
                  <MenuTrigger asChild>
                    <IconButton label={`More actions for ${d.title}`} className="relative z-10">
                      <MoreVertical size={16} />
                    </IconButton>
                  </MenuTrigger>
                  <MenuContent>
                    <MenuItem icon={<FileText size={16} />} onSelect={() => navigate(`/library/documents/${d.id}`)}>
                      Open
                    </MenuItem>
                    <MenuItem danger icon={<Trash2 size={16} />} onSelect={() => setDel(d)}>
                      Delete
                    </MenuItem>
                  </MenuContent>
                </Menu>
              </li>
            ))}
          </ul>
        )}
      </div>
      <AddDocumentFlow open={adding} onOpenChange={setAdding} onDone={(d) => navigate(`/library/documents/${d.id}`)} />
      <ConfirmDialog
        open={!!del}
        onOpenChange={(v) => !v && setDel(null)}
        title="Delete this document?"
        body={`"${del?.title ?? ''}" is removed from this PC and from any session that used it.`}
        confirmLabel="Delete document"
        busyLabel="Deleting…"
        danger
        onConfirm={async () => {
          if (del) await api.documents.delete({ id: del.id })
        }}
      />
    </>
  )
}

export function DocumentDetail({ id }: { id: string }) {
  const q = useQuery(() => api.documents.get({ id }), [id], ['documents'])
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const d = q.data
  useEffect(() => {
    if (d && !editing) {
      setTitle(d.title)
      setText(d.rawText)
    }
  }, [d, editing])

  if (q.error) {
    return (
      <div className="p-6">
        <Callout tone="danger" action={<Button size="sm" onClick={() => navigate('/library/documents')}>Back to documents</Button>}>
          {errorText(q.error)}
        </Callout>
      </div>
    )
  }
  if (!d) {
    return (
      <div className="p-6">
        <SkeletonLines lines={8} />
      </div>
    )
  }
  return (
    <>
      <PageHeader
        back={<BackLink to="/library/documents" label="Documents" />}
        title={d.title}
        description={`${SOURCE[d.source]}${d.fileSize ? ` · ${bytes(d.fileSize)}` : ''} · updated ${dateTime(d.updatedAt)}`}
        actions={
          <>
            {!editing && (
              <Button size="sm" variant="secondary" icon={<Pencil size={14} />} onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => setConfirm(true)}>
              Delete
            </Button>
          </>
        }
      />
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        {d.textStatus === 'empty' && !editing && <Callout tone="warning">No text was found in this file. Edit it to add the text by hand.</Callout>}
        {editing ? (
          <>
            <Field label="Title" error={!title.trim() ? 'Give it a title.' : null}>
              {({ id: fid, describedBy, invalid }) => <TextInput id={fid} aria-describedby={describedBy} invalid={invalid} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />}
            </Field>
            <Field label="Text the AI reads">
              {({ id: fid, describedBy }) => <Textarea id={fid} aria-describedby={describedBy} value={text} max={60_000} onChange={(e) => setText(e.target.value)} className="h-[55vh]" />}
            </Field>
            {error && <Callout tone="danger">{error}</Callout>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={saving} onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={saving}
                busyLabel="Saving…"
                disabled={!title.trim() || text.length > 60_000}
                onClick={async () => {
                  setSaving(true)
                  setError(null)
                  try {
                    await api.documents.update({ id, title, rawText: text })
                    setEditing(false)
                    toast({ text: 'Document saved.' })
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
          </>
        ) : (
          <pre className="rounded-md border border-border bg-surface p-4 font-sans text-sm whitespace-pre-wrap">{d.rawText || 'No text.'}</pre>
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete this document?"
        body={`"${d.title}" is removed from this PC and from any session that used it.`}
        confirmLabel="Delete document"
        busyLabel="Deleting…"
        danger
        onConfirm={async () => {
          await api.documents.delete({ id })
          navigate('/library/documents', { replace: true })
        }}
      />
    </>
  )
}
