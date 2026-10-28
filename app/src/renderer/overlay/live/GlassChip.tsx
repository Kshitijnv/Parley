import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { ariaKeys, keyGlyphs } from '@renderer/lib/format'
import { cn } from '@renderer/components/ui/cn'
import { Kbd, Spinner } from '@renderer/components/ui/feedback'

export interface GlassChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  accel?: string
  icon?: ReactNode
  busy?: boolean
  flash?: boolean
  compact?: boolean
  /** Keep the label but drop the key hint (the live bar sets this when it runs out of room). */
  hideKeys?: boolean
  tone?: 'default' | 'danger'
}

/** Hotkey chip on the live layer: label + key glyphs; the shortcut is in the accessible name. */
export const GlassChip = forwardRef<HTMLButtonElement, GlassChipProps>(function GlassChip(
  { label, accel, icon, busy, flash, compact, hideKeys, tone = 'default', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={accel ? `${label}, ${ariaKeys(accel)}` : label}
      aria-keyshortcuts={accel ? ariaKeys(accel) : undefined}
      className={cn(
        'on-glass glass-chip inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-glass-border pr-1 pl-2 text-sm font-semibold transition-[filter,transform] duration-(--tk-motion-fast) hover:brightness-125 active:scale-[0.98]',
        flash && 'scale-[0.96] brightness-150',
        tone === 'danger' && 'border-glass-danger bg-glass-danger! pr-2.5 text-glass-on-danger',
        (!accel || hideKeys) && 'pr-2.5',
        className,
      )}
      {...rest}
    >
      {icon && <span className={cn(compact ? '' : '@max-[640px]:inline hidden')} aria-hidden>{icon}</span>}
      <span className={cn(compact && 'sr-only', !compact && '@max-[640px]:sr-only')}>{label}</span>
      {busy && <Spinner glass />}
      {accel && !hideKeys && <Kbd keys={keyGlyphs(accel)} className={cn(compact && 'hidden', '@max-[640px]:hidden')} />}
    </button>
  )
})
