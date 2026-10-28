import { useState } from 'react'
import { Download, ShieldCheck, Trash2, X } from 'lucide-react'
import type { SttModelInfo } from '@shared/types'
import { api } from '@renderer/api'
import { Button } from '@renderer/components/ui/button'
import { Callout, Progress, SkeletonLines, Tag } from '@renderer/components/ui/feedback'
import { ConfirmDialog, toast } from '@renderer/components/ui/overlays'
import { dateTime, errorText } from '@renderer/lib/format'
import { useEvent, useQuery } from '@renderer/lib/hooks'

const STATUS: Record<SttModelInfo['status'], string> = {
  absent: 'Not installed',
  downloading: 'Downloading',
  installed: 'Installed',
  failed: 'Install failed',
  corrupt: 'Damaged: reinstall',
}

/** Settings › Speech models (architecture.md revision 2 §10): explicit installs only, never during a call. */
export function SpeechModels() {
  const models = useQuery(() => api.stt.models(), [], ['settings'])
  const [progress, setProgress] = useState<Record<string, { pct: number; stage?: string }>>({})
  useEvent('stt:downloadProgress', (p) => {
    if (p.modelId) setProgress((x) => ({ ...x, [p.modelId!]: { pct: p.pct, stage: p.stage } }))
  })

  if (models.loading && !models.data) return <SkeletonLines lines={3} />
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-border rounded-md border border-border">
        {(models.data ?? []).map((m) => (
          <ModelRow key={m.id} m={m} progress={progress[m.id]} reload={() => void models.reload()} />
        ))}
        <li className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-base font-medium">
              Hindi <Tag>Not available yet</Tag>
            </p>
            <p className="text-xs text-text-muted">No Hindi model has passed the recognition check on real Hindi audio yet, so Hindi calls can't be started.</p>
          </div>
        </li>
      </ul>
      <p className="text-xs text-text-subtle">Models are downloaded from Hugging Face, checked against their published checksums and kept on this PC. Transcription runs offline.</p>
    </div>
  )
}

function ModelRow({ m, progress, reload }: { m: SttModelInfo; progress?: { pct: number; stage?: string }; reload: () => void }) {
  const [busy, setBusy] = useState<null | 'install' | 'verify' | 'delete'>(null)
  const [confirm, setConfirm] = useState(false)
  const downloading = m.status === 'downloading' || busy === 'install'
  const run = async (kind: 'install' | 'verify' | 'delete', fn: () => Promise<{ ok: boolean; error?: string } | { ok: true }>) => {
    setBusy(kind)
    try {
      const r = (await fn()) as { ok: boolean; error?: string }
      if (!r.ok && r.error) toast({ text: r.error, tone: 'error' })
      else if (kind === 'verify') toast({ text: 'Files verified.' })
    } catch (e) {
      toast({ text: errorText(e), tone: 'error' })
    } finally {
      setBusy(null)
      reload()
    }
  }
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-base font-medium">
            {m.label}
            <Tag>{STATUS[m.status]}</Tag>
          </p>
          <p className="text-xs text-text-muted">
            {m.sizeMb} MB · {m.licence}
            {m.filesVerifiedAt ? ` · files checked ${dateTime(m.filesVerifiedAt)}` : ''}
          </p>
          <p className="text-xs text-text-subtle">{m.attribution}</p>
        </div>
        {m.status === 'installed' ? (
          <>
            <Button size="sm" variant="ghost" icon={<ShieldCheck size={14} />} loading={busy === 'verify'} busyLabel="Checking…" onClick={() => void run('verify', () => api.stt.verifyFiles({ modelId: m.id }))}>
              Verify files
            </Button>
            <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => setConfirm(true)} aria-label={`Remove ${m.label}`}>
              Remove
            </Button>
          </>
        ) : downloading ? (
          <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={() => void api.stt.cancelDownload({ modelId: m.id })}>
            Cancel
          </Button>
        ) : (
          <Button size="sm" variant="secondary" icon={<Download size={14} />} onClick={() => void run('install', () => api.stt.downloadModel({ modelId: m.id }))}>
            {m.status === 'corrupt' || m.status === 'failed' ? 'Reinstall' : 'Install'}
          </Button>
        )}
      </div>
      {downloading && (
        <div className="space-y-1" aria-live="polite">
          <p className="text-xs text-text-muted">{progress?.stage === 'verifying' ? 'Checking files…' : `Downloading… ${progress?.pct ?? 0}%`}</p>
          <Progress value={progress?.pct ?? 0} label={`${m.label} download`} />
        </div>
      )}
      {m.error && !downloading && <Callout tone="danger">{m.error}</Callout>}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Remove ${m.label}?`}
        body="Calls in this language can't start until you install it again."
        confirmLabel="Remove"
        busyLabel="Removing…"
        danger
        onConfirm={async () => {
          await run('delete', () => api.stt.deleteModel({ modelId: m.id }))
        }}
      />
    </li>
  )
}
