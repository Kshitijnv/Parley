import type { ReactNode } from 'react'
import { Info, TriangleAlert } from 'lucide-react'
import { cn } from './cn'

export function Spinner({ className, glass }: { className?: string; glass?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-3.5 shrink-0 rounded-pill border-2 border-current border-r-transparent anim-spin',
        glass ? 'text-glass-text' : 'text-accent',
        className,
      )}
    />
  )
}

export function SpinnerLabel({ label, glass, className }: { label: string; glass?: boolean; className?: string }) {
  return (
    <span role="status" className={cn('inline-flex items-center gap-1.5 text-sm', glass ? 'text-glass-text-muted' : 'text-text-muted', className)}>
      <Spinner glass={glass} />
      {label}
    </span>
  )
}

export function Progress({ value, label, className }: { value: number | null; label: string; className?: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value ?? undefined}
      className={cn('relative h-1 w-full overflow-hidden rounded-pill bg-surface-2', className)}
    >
      {value === null ? (
        <div className="absolute inset-y-0 w-[30%] rounded-pill bg-accent" style={{ animation: 'slide var(--tk-motion-slow) linear infinite', animationDuration: '1.2s' }} />
      ) : (
        <div className="h-full rounded-pill bg-accent transition-[width] duration-(--tk-motion-base)" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      )}
    </div>
  )
}

export function Callout({
  tone = 'info',
  children,
  icon,
  role,
  className,
  action,
}: {
  tone?: 'info' | 'warning' | 'danger'
  children: ReactNode
  icon?: ReactNode
  role?: 'note' | 'alert'
  className?: string
  action?: ReactNode
}) {
  return (
    <div
      role={role ?? (tone === 'info' ? 'note' : 'alert')}
      className={cn(
        'flex gap-3 rounded-md px-3.5 py-3 text-xs',
        tone === 'info' && 'bg-surface text-text-muted',
        tone === 'warning' && 'border border-warning-border bg-warning-bg text-warning-text',
        tone === 'danger' && 'border border-danger-text/40 bg-surface text-danger-text',
        className,
      )}
    >
      <span className={cn('mt-px shrink-0', tone === 'warning' ? 'text-warning-icon' : tone === 'danger' ? 'text-danger-text' : 'text-text-muted')}>
        {icon ?? (tone === 'info' ? <Info size={16} strokeWidth={1.75} /> : <TriangleAlert size={16} strokeWidth={1.75} />)}
      </span>
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  line,
  action,
  className,
}: {
  icon: ReactNode
  title: string
  line: string
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('mx-auto flex max-w-70 flex-col items-center gap-1.5 text-center', className)}>
      <span className="mb-2 text-text-subtle" aria-hidden>
        {icon}
      </span>
      <h2 className="text-md font-semibold text-text">{title}</h2>
      <p className="text-xs text-text-muted">{line}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('rounded-sm bg-surface-2 anim-skeleton', className)} />
}

export function SkeletonLines({ lines = 4, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-3', i === lines - 1 ? 'w-3/5' : i % 2 ? 'w-11/12' : 'w-full')} />
      ))}
    </div>
  )
}

export function Tag({ children, icon, className, size = 'sm' }: { children: ReactNode; icon?: ReactNode; className?: string; size?: 'sm' | 'md' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm bg-surface-2 px-1.5 text-text-muted',
        size === 'sm' ? 'h-5 text-2xs font-medium' : 'min-h-6 py-0.5 text-xs',
        className,
      )}
    >
      {icon}
      {children}
    </span>
  )
}

export function Kbd({ keys, className }: { keys: string[]; className?: string }) {
  return (
    // One cap per combo ("Ctrl ⇧ ↵"), as in the reference live bar; a cap per key overflowed the bar.
    <kbd aria-hidden className={cn('inline-flex items-center gap-[3px] rounded-xs bg-glass-kbd px-[5px] py-px font-mono text-2xs text-glass-on-kbd', className)}>
      {keys.map((k, i) => (
        <span key={i}>{k}</span>
      ))}
    </kbd>
  )
}

export function LevelMeter({ level, live }: { level: number; live: boolean }) {
  const bars = [0.35, 0.6, 1, 0.7, 0.45]
  return (
    <span aria-hidden className="flex h-3.5 items-center gap-0.5">
      {bars.map((b, i) => (
        <span
          key={i}
          className={cn('w-[3px] rounded-pill transition-[height] duration-(--tk-motion-fast)', live && level > 0.08 ? 'bg-glass-live' : 'bg-glass-text-muted')}
          style={{ height: `${Math.max(18, Math.min(100, level * b * 140))}%` }}
        />
      ))}
    </span>
  )
}

export function LiveRegion({ text }: { text: string }) {
  return (
    <span className="sr-only" aria-live="polite" role="status">
      {text}
    </span>
  )
}
