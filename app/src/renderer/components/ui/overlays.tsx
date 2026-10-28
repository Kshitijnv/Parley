import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Dialog, DropdownMenu, Tooltip as RTooltip } from 'radix-ui'
import { X } from 'lucide-react'
import { cn } from './cn'
import { Button } from './button'
import { AppMark } from './brand'

/** Where modals portal to: the overlay frame in the browser preview, else body. */
export const PortalContext = createContext<HTMLElement | null>(null)
export const usePortal = () => useContext(PortalContext) ?? undefined

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'sm',
  initialFocus,
  className,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'two-pane' | 'md'
  initialFocus?: React.RefObject<HTMLElement | null>
  className?: string
}) {
  const container = usePortal()
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal container={container}>
        <Dialog.Overlay className="anim-fade fixed inset-0 z-40 bg-scrim/40" />
        <Dialog.Content
          onOpenAutoFocus={(e) => {
            if (initialFocus?.current) {
              e.preventDefault()
              initialFocus.current.focus()
            }
          }}
          className={cn(
            'anim-rise fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100%-32px)] w-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg bg-bg text-text shadow-pop',
            size === 'sm' && 'max-w-(--tk-layout-modal-sm-w) p-5',
            size === 'md' && 'max-w-160 p-5',
            size === 'two-pane' && 'max-w-(--tk-layout-modal-two-pane-w) p-0',
            className,
          )}
        >
          {size !== 'two-pane' && (
            <div className="mb-4 flex items-start gap-3 pr-6">
              <div className="min-w-0 flex-1">
                <Dialog.Title className="text-md font-semibold">{title}</Dialog.Title>
                {description ? (
                  <Dialog.Description className="mt-1 text-xs text-text-muted">{description}</Dialog.Description>
                ) : (
                  <Dialog.Description className="sr-only">{title}</Dialog.Description>
                )}
              </div>
            </div>
          )}
          {size === 'two-pane' && (
            <>
              <Dialog.Title className="sr-only">{title}</Dialog.Title>
              <Dialog.Description className="sr-only">{typeof description === 'string' ? description : title}</Dialog.Description>
            </>
          )}
          {children}
          {footer && <div className="mt-5 flex items-center justify-end gap-2">{footer}</div>}
          <Dialog.Close asChild>
            <button
              type="button"
              aria-label="Close"
              className="absolute top-3 right-3 flex size-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-2 hover:text-text"
            >
              <X size={16} strokeWidth={1.75} />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  busyLabel,
  danger,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  body: ReactNode
  confirmLabel: string
  busyLabel?: string
  danger?: boolean
  onConfirm: () => Promise<void> | void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (open) setError(null)
  }, [open])
  return (
    <Modal
      open={open}
      onOpenChange={(v) => !busy && onOpenChange(v)}
      title={title}
      description={body}
      initialFocus={danger ? cancelRef : undefined}
      footer={
        <>
          <Button ref={cancelRef} variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={busy}
            busyLabel={busyLabel}
            onClick={async () => {
              setBusy(true)
              setError(null)
              try {
                await onConfirm()
                onOpenChange(false)
              } catch (e) {
                setError((e as Error).message)
              } finally {
                setBusy(false)
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {error && (
        <p role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      )}
    </Modal>
  )
}

export function Tooltip({ content, children, side = 'bottom', shortcut }: { content: string; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right'; shortcut?: string }) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          collisionPadding={6}
          className="anim-fade z-60 max-w-64 rounded-sm bg-primary px-2 py-1 text-xs text-on-primary shadow-pop"
        >
          {content}
          {shortcut && <span className="ml-1.5 font-mono text-2xs opacity-70">{shortcut}</span>}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  )
}

export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <RTooltip.Provider delayDuration={400} skipDelayDuration={200}>
    {children}
  </RTooltip.Provider>
)

// ---- menus ----

export const Menu = DropdownMenu.Root
export const MenuTrigger = DropdownMenu.Trigger

export function MenuContent({ children, align = 'end', className }: { children: ReactNode; align?: 'start' | 'end'; className?: string }) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align={align}
        sideOffset={6}
        collisionPadding={8}
        className={cn('anim-fade z-50 w-(--tk-layout-menu-w) rounded-md border border-border bg-bg p-1 text-text shadow-pop', className)}
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  )
}

const rowCls = 'flex h-8 cursor-pointer items-center gap-2 rounded-sm px-2 text-sm outline-none select-none data-highlighted:bg-surface-2 data-disabled:cursor-not-allowed data-disabled:opacity-(--tk-opacity-disabled)'

export function MenuItem({
  icon,
  children,
  onSelect,
  danger,
  trailing,
  disabled,
}: {
  icon?: ReactNode
  children: ReactNode
  onSelect?: (e: Event) => void
  danger?: boolean
  trailing?: ReactNode
  disabled?: boolean
}) {
  return (
    <DropdownMenu.Item onSelect={onSelect} disabled={disabled} className={cn(rowCls, danger && 'text-danger-text')}>
      <span className={cn('shrink-0', danger ? 'text-danger-text' : 'text-text-muted')} aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </DropdownMenu.Item>
  )
}

export function MenuCheckbox({ checked, onChange, children, icon, info, disabled }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; icon?: ReactNode; info?: ReactNode; disabled?: boolean }) {
  return (
    <DropdownMenu.CheckboxItem
      checked={checked}
      disabled={disabled}
      onCheckedChange={(v) => onChange(v === true)}
      onSelect={(e) => e.preventDefault()}
      className={rowCls}
    >
      <span className="shrink-0 text-text-muted" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {info}
      <span
        aria-hidden
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-pill border transition-colors duration-(--tk-motion-fast)',
          checked ? 'border-accent bg-accent' : 'border-border-input bg-border-input',
        )}
      >
        <span className={cn('block size-4 rounded-pill transition-transform duration-(--tk-motion-fast)', checked ? 'translate-x-[17px] bg-on-accent' : 'translate-x-px bg-bg')} />
      </span>
    </DropdownMenu.CheckboxItem>
  )
}

export const MenuSeparator = () => <DropdownMenu.Separator className="my-1 h-px bg-border" />
export const MenuLabel = ({ children }: { children: ReactNode }) => (
  <DropdownMenu.Label className="truncate px-2 py-1.5 text-xs text-text-muted">{children}</DropdownMenu.Label>
)
export const MenuRadioGroup = DropdownMenu.RadioGroup
export const MenuRadioItem = DropdownMenu.RadioItem

// ---- toasts (S15) ----

export interface ToastItem {
  id: string
  text: string
  action?: { label: string; onClick: () => void }
  tone?: 'default' | 'error'
}

const toastSubs = new Set<() => void>()
let toasts: ToastItem[] = []
const setToasts = (next: ToastItem[]) => {
  toasts = next
  toastSubs.forEach((cb) => cb())
}

export function toast(t: Omit<ToastItem, 'id'>) {
  const item = { ...t, id: crypto.randomUUID() }
  setToasts([...toasts, item].slice(-3))
  return item.id
}

export function dismissToast(id: string) {
  setToasts(toasts.filter((t) => t.id !== id))
}

function ToastView({ t }: { t: ToastItem }) {
  const [paused, setPaused] = useState(false)
  const remaining = useRef(8000)
  const started = useRef(Date.now())
  useEffect(() => {
    if (paused) return
    started.current = Date.now()
    const timer = setTimeout(() => dismissToast(t.id), remaining.current)
    return () => {
      clearTimeout(timer)
      remaining.current -= Date.now() - started.current
    }
  }, [paused, t.id])
  return (
    <div
      role="status"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className="glass anim-rise relative flex w-85 max-w-full items-center gap-2.5 overflow-hidden rounded-lg px-3 py-2.5"
    >
      <AppMark className="text-glass-text" bars="fill-glass-bg" />
      <p className={cn('min-w-0 flex-1 text-sm', t.tone === 'error' ? 'text-glass-highlight' : 'text-glass-text')}>{t.text}</p>
      {t.action && (
        <button
          type="button"
          onClick={() => {
            t.action!.onClick()
            dismissToast(t.id)
          }}
          className="on-glass h-7 shrink-0 rounded-md bg-glass-text px-2.5 text-xs font-medium text-glass-bg hover:opacity-90"
        >
          {t.action.label}
        </button>
      )}
      <button type="button" aria-label="Dismiss" onClick={() => dismissToast(t.id)} className="on-glass flex size-6 items-center justify-center rounded-sm text-glass-text-muted hover:text-glass-text">
        <X size={14} strokeWidth={1.75} />
      </button>
      <span
        aria-hidden
        className="absolute bottom-0 left-0 h-0.5 w-full origin-left bg-glass-accent"
        style={{ animation: 'countdown 8s linear forwards', animationPlayState: paused ? 'paused' : 'running' }}
      />
    </div>
  )
}

export function Toaster({ className }: { className?: string }) {
  const list = useSyncExternalStore(
    (cb) => {
      toastSubs.add(cb)
      return () => toastSubs.delete(cb)
    },
    () => toasts,
  )
  if (!list.length) return null
  return (
    <div className={cn('pointer-events-auto flex flex-col items-end gap-2', className)}>
      {list.map((t) => (
        <ToastView key={t.id} t={t} />
      ))}
    </div>
  )
}
