import { useState } from 'react'
import { FileText, Upload, X } from 'lucide-react'
import type { PickedFile } from '@shared/types'
import { cn } from './ui/cn'
import { Progress } from './ui/feedback'
import { bytes } from '@renderer/lib/format'

export function DropZone({
  file,
  onPick,
  onDropFile,
  onRemove,
  stage,
  pct,
  rejected,
  accept,
  hint,
  label = 'Drop a PDF here or browse',
}: {
  file: PickedFile | null
  onPick: () => void
  onDropFile: (f: File) => void
  onRemove: () => void
  stage: string | null
  pct: number | null
  rejected: string | null
  accept: (f: File) => boolean
  hint: string
  label?: string
}) {
  const [over, setOver] = useState(false)
  const [shakeKey, setShakeKey] = useState(0)

  if (stage) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-3 rounded-lg border-[1.5px] border-dashed border-border-input bg-surface px-6">
        <p className="text-sm text-text" aria-live="polite">
          {stage}
        </p>
        <Progress value={pct} label={stage} className="max-w-64" />
      </div>
    )
  }

  if (file) {
    return (
      <div className="flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2.5">
        <FileText size={20} strokeWidth={1.5} className="shrink-0 text-text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{file.name}</p>
          <p className="text-xs text-text-muted">{bytes(file.size)}</p>
        </div>
        <button type="button" aria-label={`Remove ${file.name}`} onClick={onRemove} className="flex size-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text">
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>
    )
  }

  return (
    <div>
      <button
        key={shakeKey}
        type="button"
        onClick={onPick}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          const f = e.dataTransfer.files[0]
          if (!f) return
          if (!accept(f)) setShakeKey((k) => k + 1)
          onDropFile(f)
        }}
        className={cn(
          'flex h-40 w-full flex-col items-center justify-center gap-1.5 rounded-lg border-[1.5px] border-dashed bg-surface transition-colors duration-(--tk-motion-fast)',
          over ? 'border-solid border-accent bg-surface-2' : 'border-border-input hover:bg-surface-2',
          rejected && shakeKey > 0 && 'anim-shake',
        )}
      >
        <Upload size={20} strokeWidth={1.5} className="mb-1 text-text-muted" aria-hidden />
        <span className="text-sm text-text">{label}</span>
        <span className="text-xs text-text-subtle">{hint}</span>
      </button>
      {rejected && (
        <p role="alert" className="mt-2 text-xs text-danger-text">
          {rejected}
        </p>
      )}
    </div>
  )
}
