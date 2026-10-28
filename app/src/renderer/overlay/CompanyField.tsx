import { useEffect, useId, useRef, useState } from 'react'
import { Popover } from 'radix-ui'
import { Building2, X } from 'lucide-react'
import type { CompanyHit } from '@shared/types'
import { LIMITS } from '@shared/ipc'
import { api } from '@renderer/api'
import { CompanyLogo } from '@renderer/components/SessionCard'
import { cn } from '@renderer/components/ui/cn'
import { Spinner } from '@renderer/components/ui/feedback'
import { useDebounced } from '@renderer/lib/hooks'

/** Company autocomplete: free text always works; picking a result also sets the domain. */
export function CompanyField({
  id,
  name,
  domain,
  onChange,
  describedBy,
}: {
  id: string
  name: string
  domain: string | null
  onChange: (name: string, domain: string | null) => void
  describedBy?: string
}) {
  const [open, setOpen] = useState(false)
  const [hits, setHits] = useState<CompanyHit[]>([])
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const typed = useRef(false)
  const q = useDebounced(name, 250)
  const listId = useId()

  useEffect(() => {
    if (!typed.current || !q.trim()) {
      setHits([])
      return
    }
    let alive = true
    setLoading(true)
    api.companies
      .search({ q })
      .then((h) => {
        if (!alive) return
        setHits(h)
        setActive(0)
        setOpen(true)
      })
      .catch(() => alive && setHits([]))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [q])

  const typedText = name.trim()
  const options: Array<CompanyHit | { name: string; domain: null; logoUrl: null; free: true }> = [
    ...hits,
    ...(typedText && !hits.some((h) => h.name.toLowerCase() === typedText.toLowerCase()) ? [{ name: typedText, domain: null, logoUrl: null, free: true as const }] : []),
  ]

  const pick = (o: (typeof options)[number]) => {
    typed.current = false
    onChange(o.name, o.domain)
    setOpen(false)
  }

  return (
    <Popover.Root open={open && options.length > 0} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <div className="relative flex items-center">
          <span className="pointer-events-none absolute left-3 flex text-text-muted">
            {domain ? <CompanyLogo name={name} /> : <Building2 size={14} strokeWidth={1.75} aria-hidden />}
          </span>
          <input
            id={id}
            role="combobox"
            aria-expanded={open && options.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-describedby={describedBy}
            aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
            autoComplete="off"
            maxLength={LIMITS.company}
            value={name}
            placeholder="Who is the call with?"
            onChange={(e) => {
              typed.current = true
              onChange(e.target.value, null)
            }}
            onKeyDown={(e) => {
              if (!open || !options.length) return
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(options.length - 1, a + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(0, a - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                pick(options[active]!)
              } else if (e.key === 'Escape') {
                setOpen(false)
              }
            }}
            className="h-9 w-full rounded-md border border-border-input bg-surface pr-9 pl-9 text-sm placeholder:text-text-subtle hover:border-text-muted focus-visible:border-focus"
          />
          <span className="absolute right-2 flex items-center">
            {loading ? (
              <Spinner />
            ) : name ? (
              <button
                type="button"
                aria-label="Clear company"
                onClick={() => {
                  typed.current = false
                  onChange('', null)
                }}
                className="flex size-6 items-center justify-center rounded-sm text-text-muted hover:bg-surface-2 hover:text-text"
              >
                <X size={14} strokeWidth={1.75} />
              </button>
            ) : null}
          </span>
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="anim-fade z-50 w-(--radix-popover-trigger-width) rounded-md border border-border bg-bg p-1 shadow-pop"
        >
          <div id={listId} role="listbox" aria-label="Companies">
            {options.map((o, i) => (
              <div
                key={`${o.name}-${o.domain ?? 'free'}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(o)}
                className={cn('flex h-8 cursor-pointer items-center gap-2 rounded-sm px-2.5 text-sm', i === active && 'bg-surface-2')}
              >
                {'free' in o ? <Building2 size={14} className="text-text-muted" aria-hidden /> : <CompanyLogo name={o.name} />}
                <span className="min-w-0 flex-1 truncate">{'free' in o ? `Use "${o.name}"` : o.name}</span>
                {o.domain && <span className="text-xs text-text-subtle">{o.domain}</span>}
              </div>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
