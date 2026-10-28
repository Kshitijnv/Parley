import { useState } from 'react'
import { FileText, FileUser, MoreVertical, Plus, Trash2 } from 'lucide-react'
import type { ResumeRow } from '@shared/types'
import { api } from '@renderer/api'
import { AddResumeFlow } from '@renderer/components/ContextModals'
import { Button, IconButton } from '@renderer/components/ui/button'
import { Callout, EmptyState, Skeleton, Tag } from '@renderer/components/ui/feedback'
import { ConfirmDialog, Menu, MenuContent, MenuItem, MenuTrigger } from '@renderer/components/ui/overlays'
import { bytes, dayLabel, errorText } from '@renderer/lib/format'
import { useQuery } from '@renderer/lib/hooks'
import { navigate } from '@renderer/lib/router'
import { PageHeader } from './LibraryApp'

export function resumeStatus(r: Pick<ResumeRow, 'mdStatus' | 'mdMethod'>): { label: string; tone: 'muted' | 'warn' | 'busy' } {
  if (r.mdStatus === 'converting' || r.mdStatus === 'pending') return { label: 'Converting…', tone: 'busy' }
  if (r.mdStatus === 'failed') return { label: 'Needs attention', tone: 'warn' }
  if (r.mdMethod === 'text_extract') return { label: 'Basic text only', tone: 'warn' }
  if (r.mdMethod === 'manual') return { label: 'Edited by you', tone: 'muted' }
  return { label: 'Ready', tone: 'muted' }
}

/** S16: the resumes the AI can read. */
export function ResumesPage() {
  const list = useQuery(() => api.resumes.list(), [], ['resumes'])
  const [adding, setAdding] = useState(false)
  const [del, setDel] = useState<ResumeRow | null>(null)
  const rows = list.data ?? []
  return (
    <>
      <PageHeader
        title="Resumes"
        description="The AI answers experience questions from these. Pick one when you create a session."
        actions={
          <Button variant="accent" icon={<Plus size={16} />} onClick={() => setAdding(true)}>
            Add resume
          </Button>
        }
      />
      <div className="mx-auto max-w-(--tk-layout-library-content-max) p-6">
        {list.loading && !list.data ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading resumes">
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
            icon={<FileUser size={24} />}
            title="No resumes yet"
            line="Upload a PDF and the AI will use it in answers."
            action={
              <Button variant="secondary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
                Add resume
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border" aria-label="Resumes">
            {rows.map((r) => {
              const st = resumeStatus(r)
              return (
                <li key={r.id} className="relative flex items-center gap-3 px-4 py-3 hover:bg-surface">
                  <FileText size={20} strokeWidth={1.5} className="shrink-0 text-text-muted" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <button type="button" onClick={() => navigate(`/library/resumes/${r.id}`)} className="block max-w-full truncate text-left text-base font-medium after:absolute after:inset-0">
                      {r.title}
                    </button>
                    <p className="text-xs text-text-muted">
                      {r.source === 'pdf' ? `PDF · ${bytes(r.fileSize)}` : 'Text'} · added {dayLabel(r.createdAt)}
                    </p>
                  </div>
                  <Tag className={st.tone === 'warn' ? 'text-warning-text' : undefined}>{st.label}</Tag>
                  <Menu>
                    <MenuTrigger asChild>
                      <IconButton label={`More actions for ${r.title}`} className="relative z-10">
                        <MoreVertical size={16} />
                      </IconButton>
                    </MenuTrigger>
                    <MenuContent>
                      <MenuItem icon={<FileText size={16} />} onSelect={() => navigate(`/library/resumes/${r.id}`)}>
                        Open
                      </MenuItem>
                      <MenuItem danger icon={<Trash2 size={16} />} onSelect={() => setDel(r)}>
                        Delete
                      </MenuItem>
                    </MenuContent>
                  </Menu>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <AddResumeFlow open={adding} onOpenChange={setAdding} onDone={(r) => navigate(`/library/resumes/${r.id}`)} />
      <ConfirmDialog
        open={!!del}
        onOpenChange={(v) => !v && setDel(null)}
        title="Delete this resume?"
        body={`"${del?.title ?? ''}" is removed from this PC. Past calls keep their transcripts but no longer link to it.`}
        confirmLabel="Delete resume"
        busyLabel="Deleting…"
        danger
        onConfirm={async () => {
          if (del) await api.resumes.delete({ id: del.id })
        }}
      />
    </>
  )
}
