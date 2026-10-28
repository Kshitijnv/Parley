import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, Eraser, MessageSquare, Pencil, RotateCw, Square, Star } from 'lucide-react'
import { leadEnd } from '@shared/answerBlocks'
import type { AnswerErrorCode, AnswerTrigger, FallbackReason, Hotkeys } from '@shared/types'
import { modelLabel } from '@shared/catalog'
import { cn } from '@renderer/components/ui/cn'
import { LiveRegion, SpinnerLabel } from '@renderer/components/ui/feedback'
import { IconButton } from '@renderer/components/ui/button'
import { Markdown } from '@renderer/components/ui/markdown'
import { keyGlyphs, timeOfDay } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/hooks'
import { GlassChip } from './GlassChip'

export interface AnswerView {
  id: string
  seq: number
  trigger: AnswerTrigger
  userPrompt: string | null
  question: string | null
  md: string
  status: 'streaming' | 'done' | 'cancelled' | 'failed'
  code?: AnswerErrorCode
  error?: string | null
  retryAt?: number
  createdAt: number
  firstTokenMs?: number | null
  /** The detector's turn text, shown until the model's question line arrives. */
  draft?: string | null
  /** A delta arrived past the end of the text: the store re-fetches it. */
  needsResync?: boolean
  /** Revision 4 A4.3: the fallback model served this answer, and why. */
  servedModel?: string | null
  fallbackReason?: FallbackReason | null
  /** A fallback the user may choose with one press after a daily quota. */
  fallbackOffer?: string
  /** Revision 5 D4: the highest provider attempt seen on a delta. */
  attempt?: number
}

const ROUTE_WHY: Record<FallbackReason, string> = {
  slow_first_token: 'the first model was slow to start',
  overloaded: 'the first model was busy',
  rate_limited: 'the first model was rate limited',
  auth: 'the first key was rejected',
  not_found: 'the first model was unavailable',
}

const SIZE_KEY = 'parley:answer-size'
const MIN = { w: 360, h: 160 }

function loadSize(): { w: number; h: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(SIZE_KEY) ?? 'null')
    return v && typeof v.w === 'number' ? v : null
  } catch {
    return null
  }
}

/** S14: the answer card with history paging, streaming, errors and a resize corner. */
export function AnswerPanel({
  answers,
  index,
  cleared,
  hotkeys,
  onPrev,
  onNext,
  onClear,
  onStop,
  onRetry,
  onFallback,
  fallbackLabel,
  onAnswerWithFallback,
  onFollowUp,
}: {
  answers: AnswerView[]
  index: number
  cleared: boolean
  hotkeys: Hotkeys
  onPrev: () => void
  onNext: () => void
  onClear: () => void
  onStop: (id: string) => void
  onRetry: (a: AnswerView) => void
  onFallback: ((a: AnswerView) => void) | null
  fallbackLabel: string | null
  onAnswerWithFallback: (a: AnswerView) => void
  onFollowUp: (a: AnswerView) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [size, setSize] = useState(loadSize)
  const [copied, setCopied] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const now = useNow(500)
  const a = cleared ? undefined : answers[index]
  const streaming = a?.status === 'streaming'
  // Revision 5 D3: where the direct-answer paragraph ends (null while it's still arriving).
  const lead = useMemo(() => (a?.md ? leadEnd(a.md, !streaming) : null), [a?.md, streaming])

  // Revision 5 D4 anchoring: follow new text only until the lead is complete, so the
  // definition stays readable while the rest arrives. Once the user scrolls, the card never
  // moves on its own; "More below" scrolls down and follows from then on.
  const follow = useRef<'lead' | 'bottom' | 'off'>('lead')
  const [below, setBelow] = useState(false)
  const measure = () => {
    const el = body.current
    setBelow(!!el && el.scrollHeight - el.scrollTop - el.clientHeight > 24)
  }
  useEffect(() => {
    follow.current = 'lead'
    setBelow(false)
  }, [a?.id])
  useEffect(() => {
    const el = body.current
    if (!el || !streaming) return measure()
    if (follow.current === 'bottom' || (follow.current === 'lead' && lead === null)) el.scrollTop = el.scrollHeight
    measure()
  }, [a?.md, streaming, lead])
  const userScrolled = () => {
    follow.current = 'off'
  }

  const startResize = (e: React.PointerEvent) => {
    const panel = (e.currentTarget as HTMLElement).closest('section') as HTMLElement
    const r = panel.getBoundingClientRect()
    const sx = e.clientX
    const sy = e.clientY
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      const next = { w: Math.max(MIN.w, Math.round(r.width + ev.clientX - sx)), h: Math.max(MIN.h, Math.round(r.height + ev.clientY - sy)) }
      setSize(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setSize((s) => {
        try {
          if (s) localStorage.setItem(SIZE_KEY, JSON.stringify(s))
        } catch {
          // per-window preference only
        }
        return s
      })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const retryIn = a?.retryAt ? Math.max(0, Math.ceil((a.retryAt - now) / 1000)) : 0
  const hasAnswers = answers.length > 0

  return (
    <section
      aria-label="Answer"
      className={cn('glass relative flex w-(--tk-layout-answer-panel-w) min-w-0 flex-col rounded-lg', !a || collapsed ? 'h-auto' : 'h-(--tk-layout-answer-panel-h)')}
      style={a && !collapsed && size ? { width: size.w, height: size.h, maxWidth: '100%' } : { width: size?.w, maxWidth: '100%' }}
    >
      <header className="flex h-9 shrink-0 items-center gap-1.5 px-2">
        <GlassChip label="Previous" icon={<ChevronLeft size={14} />} accel={hotkeys.history_prev} onClick={onPrev} disabled={!hasAnswers || index <= 0 || cleared} />
        <GlassChip label="Next" icon={<ChevronRight size={14} />} accel={hotkeys.history_next} onClick={onNext} disabled={!hasAnswers || index >= answers.length - 1 || cleared} />
        {hasAnswers && !cleared && (
          <span className="text-xs text-glass-text-muted" aria-label={`Answer ${index + 1} of ${answers.length}`}>
            {index + 1} / {answers.length}
          </span>
        )}
        <span className="flex-1" />
        {streaming && <SpinnerLabel glass label="Generating…" className="text-xs" />}
        {streaming && a && <GlassChip label="Stop" icon={<Square size={12} />} onClick={() => onStop(a.id)} />}
        {a?.status === 'cancelled' && <span className="rounded-sm bg-glass-kbd px-1.5 text-2xs font-medium text-glass-on-kbd">Stopped</span>}
        <GlassChip label="Clear" icon={<Eraser size={14} />} accel={hotkeys.clear_answer} onClick={onClear} disabled={!a} />
        <IconButton label={collapsed ? 'Expand answer' : 'Collapse answer'} tone="glass" onClick={() => setCollapsed((v) => !v)} aria-expanded={!collapsed} disabled={!a}>
          {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </IconButton>
      </header>

      {!a ? (
        <p className="px-3.5 pb-3 text-sm text-glass-text-muted">
          Press {keyGlyphs(hotkeys.answer).join(' ')} to answer the latest question, or Chat to type one.
        </p>
      ) : (
        <>
          <div
            ref={body}
            onScroll={measure}
            onWheel={userScrolled}
            onTouchMove={userScrolled}
            onKeyDown={(e) => ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key) && userScrolled()}
            className={cn('scroll-thin min-h-0 flex-1 overflow-y-auto px-3.5 anim-fade', collapsed && 'pb-3')}
            key={a.id}
            tabIndex={0}
            aria-label="Answer text"
          >
            <p className="flex items-start gap-1.5 text-sm font-semibold text-glass-text">
              <MessageSquare size={14} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                <span className="mr-1">Question:</span>
                {a.question ?? (a.trigger === 'chat' && a.userPrompt ? a.userPrompt : a.trigger === 'screenshot' ? 'Reading your screen…' : a.draft ? a.draft : streaming ? 'Working out the question…' : 'Not answered')}
              </span>
            </p>
            {!collapsed && (
              <div className="mt-2.5 pb-3">
                {a.status === 'failed' ? (
                  <>
                    {a.md && <Markdown text={a.md} lead={lead} className="mb-2.5 text-sm leading-5 text-glass-text" />}
                    <ErrorBody a={a} retryIn={retryIn} onRetry={() => onRetry(a)} onFallback={onFallback && (() => onFallback(a))} fallbackLabel={fallbackLabel} onAnswerWithFallback={() => onAnswerWithFallback(a)} />
                  </>
                ) : (
                  <>
                    <p className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-glass-text">
                      <Star size={14} className="text-glass-highlight" fill="currentColor" aria-hidden />
                      Answer:
                    </p>
                    {a.md ? <Markdown text={a.md} streaming={streaming} lead={lead} className="text-sm leading-5 text-glass-text" /> : streaming ? <span className="caret text-glass-text-muted" /> : null}
                  </>
                )}
              </div>
            )}
          </div>
          {!collapsed && (
            <footer className="flex h-8 shrink-0 items-center gap-1 border-t border-glass-border/50 px-2 text-xs text-glass-text-muted">
              <span className="pl-1">{timeOfDay(a.createdAt)}</span>
              {a.firstTokenMs ? <span>· first words in {(a.firstTokenMs / 1000).toFixed(1)} s</span> : null}
              {a.servedModel ? <span>· answered by {modelLabel(a.servedModel)}{a.fallbackReason ? ` (${ROUTE_WHY[a.fallbackReason]})` : ''}</span> : null}
              <span className="flex-1" />
              {below && streaming && (
                <GlassChip
                  label="More below"
                  icon={<ArrowDown size={12} />}
                  onClick={() => {
                    follow.current = 'bottom'
                    const el = body.current
                    if (el) el.scrollTop = el.scrollHeight
                    measure()
                  }}
                />
              )}
              <IconButton
                label={copied ? 'Copied' : 'Copy answer'}
                tone="glass"
                disabled={!a.md}
                onClick={() => {
                  void navigator.clipboard?.writeText(`${a.question ?? ''}\n\n${a.md}`)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </IconButton>
              <IconButton label="Ask a follow-up" tone="glass" onClick={() => onFollowUp(a)}>
                <Pencil size={14} />
              </IconButton>
              <span
                role="separator"
                aria-label="Resize answer panel"
                onPointerDown={startResize}
                className="resize-handle ml-1 flex size-4 items-end justify-end text-glass-text-muted"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                  <path d="M9 1 1 9M9 5 5 9" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
                </svg>
              </span>
            </footer>
          )}
          {a.status === 'done' && <LiveRegion text={`Answer ready: ${a.question ?? ''}`} />}
        </>
      )}
    </section>
  )
}

function ErrorBody({ a, retryIn, onRetry, onFallback, fallbackLabel, onAnswerWithFallback }: { a: AnswerView; retryIn: number; onRetry: () => void; onFallback: (() => void) | null; fallbackLabel: string | null; onAnswerWithFallback: () => void }) {
  const msg = a.code === 'rate_limited' && retryIn > 0 ? `${a.error} Retry in ${retryIn} s.` : a.error
  return (
    <div role="alert" className="space-y-2">
      <p className="text-sm text-glass-highlight">{msg}</p>
      <div className="flex flex-wrap gap-1.5">
        {a.code !== 'no_key' && (
          <GlassChip label={a.code === 'rate_limited' && retryIn > 0 ? `Retry in ${retryIn} s` : 'Retry'} icon={<RotateCw size={12} />} onClick={onRetry} disabled={a.code === 'rate_limited' && retryIn > 0} />
        )}
        {a.fallbackOffer && <GlassChip label={`Answer with ${modelLabel(a.fallbackOffer)}`} onClick={onAnswerWithFallback} />}
        {(a.code === 'rate_limited' || a.code === 'quota_exhausted' || a.code === 'overloaded' || a.code === 'provider_error' || a.code === 'timeout') && onFallback && fallbackLabel && <GlassChip label={`Use ${fallbackLabel}`} onClick={onFallback} />}
      </div>
    </div>
  )
}
