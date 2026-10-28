import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, Eraser } from 'lucide-react'
import type { Speaker, SttState } from '@shared/types'
import { cn } from '@renderer/components/ui/cn'
import { LevelMeter, Spinner } from '@renderer/components/ui/feedback'
import { IconButton } from '@renderer/components/ui/button'
import { GlassChip } from './GlassChip'

export interface Line {
  id: string
  speaker: Speaker
  text: string
}

/** S13 live transcript strip: newest words on the right, partial words in italics. */
export function TranscriptStrip({
  lines,
  partial,
  stt,
  level,
  expanded,
  onToggle,
  onClear,
  clearAccel,
}: {
  lines: Line[]
  partial: { speaker: Speaker; text: string } | null
  stt: { state: SttState; error?: string }
  level: number
  expanded: boolean
  onToggle: () => void
  onClear: () => void
  clearAccel: string
}) {
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    if (expanded) el.scrollTop = el.scrollHeight
    else el.scrollLeft = el.scrollWidth
  }, [lines, partial, expanded])

  const empty = lines.length === 0 && !partial?.text
  const status =
    stt.state === 'starting' ? (
      <span className="inline-flex items-center gap-1.5 text-glass-text-muted">
        <Spinner glass /> Starting the speech model…
      </span>
    ) : stt.state === 'reconnecting' ? (
      <span className="inline-flex items-center gap-1.5 text-glass-text-muted">
        <Spinner glass /> Reconnecting…
      </span>
    ) : stt.state === 'error' ? (
      <span className="text-glass-highlight">Transcription stopped: {stt.error ?? 'unknown error'}</span>
    ) : empty ? (
      <span className="text-glass-text-muted">Listening…</span>
    ) : null

  return (
    <section aria-label="Live transcript" className={cn('glass flex rounded-lg px-1.5', expanded ? 'h-40 items-start py-1.5' : 'h-(--tk-size-strip-h) items-center')}>
      <span className="flex h-6 w-6 shrink-0 items-center justify-center" aria-hidden>
        <LevelMeter level={level} live={stt.state === 'listening'} />
      </span>
      <div
        ref={scroller}
        role="log"
        aria-live="off"
        tabIndex={expanded ? 0 : -1}
        className={cn(
          'min-w-0 flex-1 text-sm',
          expanded ? 'scroll-thin h-full space-y-1 overflow-y-auto px-1' : 'fade-left overflow-hidden px-1 whitespace-nowrap',
        )}
      >
        {status && !expanded ? (
          status
        ) : expanded ? (
          <>
            {status}
            {lines.slice(-8).map((l) => (
              <p key={l.id} className="text-glass-text">
                <span className="mr-1.5 text-2xs font-medium text-glass-text-muted uppercase">{l.speaker === 'you' ? 'You' : 'Them'}</span>
                {l.text}
              </p>
            ))}
            {partial?.text && (
              <p className="text-glass-text-muted italic">
                <span className="mr-1.5 text-2xs font-medium uppercase not-italic">{partial.speaker === 'you' ? 'You' : 'Them'}</span>
                {partial.text}
              </p>
            )}
          </>
        ) : (
          <span className="inline-flex items-center justify-end gap-1.5">
            {lines.slice(-6).map((l, i, arr) => (
              <span key={l.id} className="inline-flex items-center gap-1.5">
                {i > 0 && arr[i - 1]!.speaker !== l.speaker && <span aria-hidden className="size-1 rounded-pill bg-glass-text-muted" />}
                <span className={l.speaker === 'you' ? 'text-glass-text-muted' : 'text-glass-text'}>{l.text}</span>
              </span>
            ))}
            {partial?.text && <span className="text-glass-text-muted italic">{partial.text}</span>}
          </span>
        )}
      </div>
      <div className={cn('flex shrink-0 items-center gap-1', expanded && 'self-start')}>
        <GlassChip label="Clear" icon={<Eraser size={14} />} accel={clearAccel} onClick={onClear} disabled={lines.length === 0} />
        <IconButton label={expanded ? 'Collapse transcript' : 'Expand transcript'} tone="glass" onClick={onToggle} aria-expanded={expanded}>
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </IconButton>
      </div>
    </section>
  )
}
