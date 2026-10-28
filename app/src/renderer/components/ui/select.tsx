import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Popover } from 'radix-ui'
import { Check, ChevronDown, Search } from 'lucide-react'
import { cn } from './cn'

export interface Option {
  value: string
  label: string
  hint?: string
  icon?: ReactNode
  disabled?: boolean
}

interface Common {
  options: Option[]
  placeholder?: string
  emptyText?: string
  searchable?: boolean
  footer?: ReactNode
  size?: 'sm' | 'md'
  id?: string
  ariaLabel?: string
  labelledBy?: string
  describedBy?: string
  disabled?: boolean
  invalid?: boolean
  className?: string
  glass?: boolean
  align?: 'start' | 'end'
  triggerIcon?: ReactNode
  menuWidth?: 'trigger' | 'auto'
  hideChevron?: boolean
}

type SingleProps = Common & { multiple?: false; value: string | null; onChange: (v: string) => void }
type MultiProps = Common & { multiple: true; value: string[]; onChange: (v: string[]) => void }

/** Listbox select: single, searchable or multi, with optional footer actions inside the menu. */
export function Select(props: SingleProps | MultiProps) {
  const {
    options,
    placeholder = 'Choose…',
    emptyText = 'Nothing here yet',
    searchable,
    footer,
    size = 'md',
    id,
    ariaLabel,
    labelledBy,
    describedBy,
    disabled,
    invalid,
    className,
    glass,
    align = 'start',
    triggerIcon,
    menuWidth = 'trigger',
    hideChevron,
  } = props
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const typed = useRef({ text: '', t: 0 })

  const selected = props.multiple ? new Set(props.value) : new Set(props.value ? [props.value] : [])
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase()
    return t ? options.filter((o) => o.label.toLowerCase().includes(t) || o.hint?.toLowerCase().includes(t)) : options
  }, [options, q])

  useEffect(() => {
    if (!open) return
    setQ('')
    const i = options.findIndex((o) => selected.has(o.value))
    setActive(Math.max(0, i))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const choose = (o: Option) => {
    if (o.disabled) return
    if (props.multiple) {
      const next = selected.has(o.value) ? props.value.filter((v) => v !== o.value) : [...props.value, o.value]
      props.onChange(next)
    } else {
      props.onChange(o.value)
      setOpen(false)
    }
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(filtered.length - 1, a + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(0, a - 1))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActive(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActive(filtered.length - 1)
    } else if (e.key === 'Enter' || (e.key === ' ' && !searchable)) {
      e.preventDefault()
      const o = filtered[active]
      if (o) choose(o)
    } else if (!searchable && e.key.length === 1) {
      const now = Date.now()
      typed.current.text = now - typed.current.t > 600 ? e.key : typed.current.text + e.key
      typed.current.t = now
      const i = filtered.findIndex((o) => o.label.toLowerCase().startsWith(typed.current.text.toLowerCase()))
      if (i >= 0) setActive(i)
    }
  }

  let triggerText: ReactNode
  if (props.multiple) {
    const chosen = options.filter((o) => selected.has(o.value))
    triggerText = chosen.length === 0 ? null : chosen.length === 1 ? chosen[0]!.label : `${chosen.length} selected`
  } else {
    triggerText = options.find((o) => o.value === props.value)?.label ?? null
  }
  const chosenIcon = !props.multiple ? options.find((o) => o.value === props.value)?.icon : null

  return (
    <Popover.Root open={open} onOpenChange={(v) => !disabled && setOpen(v)}>
      <Popover.Trigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={open ? listId : undefined}
          aria-label={ariaLabel ? `${ariaLabel}${triggerText ? `: ${typeof triggerText === 'string' ? triggerText : ''}` : ''}` : undefined}
          aria-labelledby={ariaLabel ? undefined : labelledBy}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          disabled={disabled}
          onKeyDown={(e) => {
            if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault()
              setOpen(true)
            }
          }}
          className={cn(
            'flex w-full min-w-0 items-center gap-2 rounded-md border text-left transition-colors duration-(--tk-motion-fast)',
            size === 'md' ? 'h-9 px-3 text-sm' : 'h-7 px-2.5 text-xs',
            glass
              ? 'on-glass border-glass-border bg-glass-chip text-glass-text hover:bg-glass-kbd'
              : 'border-border-input bg-surface text-text hover:border-text-muted aria-invalid:border-danger-text',
            className,
          )}
        >
          {triggerIcon ?? chosenIcon}
          <span className={cn('min-w-0 flex-1 truncate', !triggerText && (glass ? 'text-glass-text-muted' : 'text-text-subtle'))}>
            {triggerText ?? placeholder}
          </span>
          {!hideChevron && <ChevronDown size={14} strokeWidth={1.75} aria-hidden className={glass ? 'text-glass-text-muted' : 'text-text-muted'} />}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align={align}
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            ;(searchable ? searchRef.current : listRef.current)?.focus()
          }}
          className={cn(
            'anim-fade z-50 overflow-hidden rounded-md border border-border bg-bg text-text shadow-pop',
            menuWidth === 'trigger' ? 'w-(--radix-popover-trigger-width) min-w-48' : 'min-w-56',
          )}
        >
          {searchable && (
            <div className="border-b border-border p-1.5">
              <div className="relative">
                <Search size={14} strokeWidth={1.75} aria-hidden className="absolute top-1/2 left-2.5 -translate-y-1/2 text-text-muted" />
                <input
                  ref={searchRef}
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value)
                    setActive(0)
                  }}
                  onKeyDown={onKey}
                  placeholder="Search"
                  aria-label="Search options"
                  aria-controls={listId}
                  aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
                  className="h-8 w-full rounded-sm bg-surface pr-2 pl-8 text-sm outline-none placeholder:text-text-subtle focus-visible:outline-2 focus-visible:outline-focus"
                />
              </div>
            </div>
          )}
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            tabIndex={searchable ? -1 : 0}
            aria-multiselectable={props.multiple || undefined}
            aria-activedescendant={!searchable && filtered[active] ? `${listId}-${active}` : undefined}
            onKeyDown={searchable ? undefined : onKey}
            className="scroll-thin max-h-64 overflow-y-auto p-1 outline-none"
          >
            {filtered.length === 0 && <p className="px-2.5 py-2 text-sm text-text-subtle">{q ? 'No match' : emptyText}</p>}
            {filtered.map((o, i) => {
              const isSel = selected.has(o.value)
              return (
                <div
                  key={o.value}
                  id={`${listId}-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={isSel}
                  aria-disabled={o.disabled || undefined}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(o)}
                  className={cn(
                    'flex h-8 cursor-pointer items-center gap-2 rounded-sm px-2.5 text-sm',
                    i === active && 'bg-surface-2',
                    o.disabled && 'cursor-not-allowed opacity-(--tk-opacity-disabled)',
                  )}
                >
                  {props.multiple && (
                    <span
                      aria-hidden
                      className={cn('flex size-4 shrink-0 items-center justify-center rounded-xs border', isSel ? 'border-accent bg-accent text-on-accent' : 'border-border-input')}
                    >
                      {isSel && <Check size={12} strokeWidth={2.5} />}
                    </span>
                  )}
                  {o.icon}
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.hint && <span className="shrink-0 text-xs text-text-subtle">{o.hint}</span>}
                  {!props.multiple && isSel && <Check size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />}
                </div>
              )
            })}
          </div>
          {footer && <div className="flex items-center gap-1 border-t border-border p-1">{footer}</div>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

export function MenuFooterButton({ icon, children, onClick, disabled }: { icon?: ReactNode; children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs text-text-muted hover:bg-surface-2 hover:text-text"
    >
      {icon}
      {children}
    </button>
  )
}
