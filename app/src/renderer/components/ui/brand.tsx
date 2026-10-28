import { APP_NAME } from '@shared/catalog'
import { cn } from './cn'

/** Placeholder mark until /replica-brand: a rounded square with three sound bars. */
export function AppMark({ size = 20, className, bars = 'fill-bg' }: { size?: number; className?: string; bars?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden className={cn('shrink-0', className)}>
      <rect width="20" height="20" rx="5" fill="currentColor" />
      <rect x="5" y="8" width="2" height="4" rx="1" className={bars} />
      <rect x="9" y="5" width="2" height="10" rx="1" className={bars} />
      <rect x="13" y="7" width="2" height="6" rx="1" className={bars} />
    </svg>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-base font-semibold text-text', className)}>
      <AppMark className="text-primary" />
      {APP_NAME}
    </span>
  )
}
