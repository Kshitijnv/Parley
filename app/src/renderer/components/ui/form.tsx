import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { RadioGroup, Switch as RSwitch } from 'radix-ui'
import { X } from 'lucide-react'
import { cn } from './cn'

export function Field({
  label,
  hint,
  error,
  children,
  id,
  className,
  labelAside,
}: {
  label: ReactNode
  hint?: ReactNode
  error?: string | null
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode
  id?: string
  className?: string
  labelAside?: ReactNode
}) {
  const auto = useId()
  const fid = id ?? auto
  const hintId = hint ? `${fid}-hint` : undefined
  const errId = error ? `${fid}-err` : undefined
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={fid} className="text-base font-medium text-text">
          {label}
        </label>
        {labelAside}
      </div>
      {children({ id: fid, describedBy: [hintId, errId].filter(Boolean).join(' ') || undefined, invalid: !!error })}
      {hint && !error && (
        <p id={hintId} className="text-xs text-text-subtle">
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} className="text-xs text-danger-text">
          {error}
        </p>
      )}
    </div>
  )
}

const inputBase =
  'w-full rounded-md border border-border-input bg-surface text-sm text-text placeholder:text-text-subtle transition-colors duration-(--tk-motion-fast) hover:border-text-muted focus-visible:border-focus focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-(--tk-opacity-disabled) aria-invalid:border-danger-text'

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean
  onClear?: () => void
  leading?: ReactNode
  trailing?: ReactNode
  inputSize?: 'sm' | 'md'
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { invalid, onClear, leading, trailing, className, inputSize = 'md', value, ...rest },
  ref,
) {
  return (
    <div className={cn('relative flex items-center', className)}>
      {leading && <span className="pointer-events-none absolute left-3 flex items-center text-text-muted">{leading}</span>}
      <input
        ref={ref}
        value={value}
        aria-invalid={invalid || undefined}
        className={cn(inputBase, inputSize === 'md' ? 'h-9' : 'h-7 text-xs', leading ? 'pl-9' : 'pl-3', onClear || trailing ? 'pr-9' : 'pr-3')}
        {...rest}
      />
      <span className="absolute right-2 flex items-center gap-1">
        {trailing}
        {onClear && value ? (
          <button type="button" aria-label="Clear" onClick={onClear} className="flex size-6 items-center justify-center rounded-sm text-text-muted hover:bg-surface-2 hover:text-text">
            <X size={14} strokeWidth={1.75} />
          </button>
        ) : null}
      </span>
    </div>
  )
})

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
  max?: number
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ invalid, max, className, value, ...rest }, ref) {
  const len = typeof value === 'string' ? value.length : 0
  const over = max !== undefined && len > max
  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={value}
        aria-invalid={invalid || over || undefined}
        className={cn(inputBase, 'scroll-thin block resize-none px-3 py-2.5 leading-5', max !== undefined && 'pb-6', className)}
        {...rest}
      />
      {max !== undefined && (
        <span className={cn('pointer-events-none absolute right-3 bottom-1.5 text-xs', over ? 'text-danger-text' : 'text-text-subtle')}>
          {len.toLocaleString()} / {max.toLocaleString()}
        </span>
      )}
    </div>
  )
})

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  id,
  label,
  describedBy,
  glass,
}: {
  checked: boolean
  onCheckedChange: (v: boolean) => void
  disabled?: boolean
  id?: string
  label?: string
  describedBy?: string
  glass?: boolean
}) {
  return (
    <RSwitch.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      aria-describedby={describedBy}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-pill border transition-colors duration-(--tk-motion-fast) disabled:opacity-(--tk-opacity-disabled)',
        glass
          ? 'border-glass-border data-[state=checked]:border-glass-accent data-[state=checked]:bg-glass-accent'
          : 'border-border-input bg-border-input data-[state=checked]:border-accent data-[state=checked]:bg-accent',
      )}
    >
      <RSwitch.Thumb
        className={cn(
          'block size-4 translate-x-px rounded-pill shadow-card transition-transform duration-(--tk-motion-fast) data-[state=checked]:translate-x-[17px]',
          glass ? 'bg-glass-text data-[state=checked]:bg-glass-bg' : 'bg-bg data-[state=checked]:bg-on-accent',
        )}
      />
    </RSwitch.Root>
  )
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T
  onChange: (v: T) => void
  options: Array<{ value: T; label: string; icon?: ReactNode; disabled?: boolean }>
  label: string
}) {
  return (
    <RadioGroup.Root
      aria-label={label}
      value={value}
      onValueChange={(v) => onChange(v as T)}
      orientation="horizontal"
      className="grid h-9 auto-cols-fr grid-flow-col rounded-md bg-surface-2 p-[3px]"
    >
      {options.map((o) => (
        <RadioGroup.Item
          key={o.value}
          value={o.value}
          disabled={o.disabled}
          className="flex items-center justify-center gap-1.5 rounded-sm text-sm text-text-muted transition-colors duration-(--tk-motion-fast) hover:text-text data-[state=checked]:bg-bg data-[state=checked]:font-medium data-[state=checked]:text-text data-[state=checked]:shadow-card"
        >
          {o.icon}
          {o.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  )
}

export function RadioCards<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T
  onChange: (v: T) => void
  options: Array<{ value: T; title: string; description: string }>
  label: string
}) {
  const base = useId()
  return (
    <RadioGroup.Root aria-label={label} value={value} onValueChange={(v) => onChange(v as T)} className="flex flex-col gap-2">
      {options.map((o) => (
        <RadioGroup.Item
          key={o.value}
          value={o.value}
          aria-describedby={`${base}-${o.value}`}
          className="group flex items-start gap-2.5 rounded-md border border-border bg-bg px-3.5 py-3 text-left transition-colors duration-(--tk-motion-fast) hover:bg-surface data-[state=checked]:border-accent data-[state=checked]:outline-[0.5px] data-[state=checked]:outline-accent"
        >
          <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-pill border border-border-input group-data-[state=checked]:border-accent">
            <RadioGroup.Indicator className="size-2 rounded-pill bg-accent" />
          </span>
          <span className="flex flex-col gap-0.5">
            <span className="text-base font-medium text-text">{o.title}</span>
            <span id={`${base}-${o.value}`} className="text-xs text-text-muted">
              {o.description}
            </span>
          </span>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  )
}

export function SettingRow({
  icon,
  title,
  subtitle,
  control,
  onClick,
  chevron,
}: {
  icon: ReactNode
  title: string
  subtitle: string
  control?: (ids: { labelledBy: string; describedBy: string }) => ReactNode
  onClick?: () => void
  chevron?: ReactNode
}) {
  const id = useId()
  const content = (
    <>
      <span className="mt-0.5 shrink-0 text-text-muted" aria-hidden>
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span id={`${id}-t`} className="text-base font-medium text-text">
          {title}
        </span>
        <span id={`${id}-d`} className="truncate text-xs text-text-muted">
          {subtitle}
        </span>
      </span>
      {control?.({ labelledBy: `${id}-t`, describedBy: `${id}-d` })}
      {chevron}
    </>
  )
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="flex min-h-12 w-full items-center gap-3 rounded-md px-2 py-1.5 hover:bg-surface">
        {content}
      </button>
    )
  }
  return <div className="flex min-h-12 items-center gap-3">{content}</div>
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="text-2xs font-medium tracking-wide text-text-subtle uppercase">{children}</p>
}
