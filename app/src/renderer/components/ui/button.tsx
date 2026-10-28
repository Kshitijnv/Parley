import { forwardRef, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { cn } from './cn'
import { Spinner } from './feedback'

type Variant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger' | 'link'
type Size = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: ReactNode
  loading?: boolean
  busyLabel?: string
  external?: boolean
}

const variants: Record<Variant, string> = {
  primary: 'bg-primary text-on-primary hover:opacity-90',
  accent: 'bg-accent text-on-accent hover:opacity-90',
  secondary: 'border border-border bg-surface text-text hover:bg-surface-2',
  ghost: 'text-text hover:bg-surface-2',
  danger: 'bg-danger text-on-danger hover:brightness-[0.92]',
  link: 'px-0! h-auto! text-text underline-offset-2 hover:underline',
}

const sizes: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-9 px-3.5 text-sm font-medium gap-1.5',
  lg: 'h-10 px-4 text-sm font-semibold gap-1.5',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, loading, busyLabel, external, className, children, onClick, type = 'button', ...rest },
  ref,
) {
  const inner = useRef<HTMLButtonElement | null>(null)
  const [width, setWidth] = useState<number>()
  useLayoutEffect(() => {
    if (!loading && inner.current) setWidth(inner.current.offsetWidth)
  }, [loading, children])
  return (
    <button
      ref={(el) => {
        inner.current = el
        if (typeof ref === 'function') ref(el)
        else if (ref) ref.current = el
      }}
      type={type}
      aria-busy={loading || undefined}
      onClick={(e) => {
        if (loading) {
          e.preventDefault()
          return
        }
        onClick?.(e)
      }}
      style={loading && width ? { minWidth: width } : undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md transition-[background-color,opacity,filter,transform] duration-(--tk-motion-fast) active:translate-y-[0.5px] disabled:pointer-events-none',
        sizes[size],
        variants[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner className={variant === 'primary' || variant === 'accent' || variant === 'danger' ? 'text-current!' : undefined} /> : icon}
      {loading && busyLabel ? busyLabel : children}
      {external && !loading && <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden />}
      {loading && busyLabel && <span className="sr-only" aria-live="polite">{busyLabel}</span>}
    </button>
  )
})

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  tone?: 'neutral' | 'danger' | 'glass' | 'glass-danger'
  size?: 'sm' | 'md'
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, tone = 'neutral', size = 'sm', className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md transition-colors duration-(--tk-motion-fast)',
        size === 'sm' ? 'size-7' : 'size-9',
        tone === 'neutral' && 'text-text-muted hover:bg-surface-2 hover:text-text active:bg-border',
        tone === 'danger' && 'bg-danger text-on-danger hover:brightness-[0.92]',
        tone === 'glass' && 'on-glass text-glass-text-muted hover:bg-glass-kbd hover:text-glass-text',
        tone === 'glass-danger' && 'on-glass bg-glass-danger text-glass-on-danger hover:brightness-[0.92]',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
})
