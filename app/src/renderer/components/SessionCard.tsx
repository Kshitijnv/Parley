import { useState } from 'react'
import { Bot, Briefcase, FileText, MoreVertical, Phone, Play, Trash2, ArrowUpRight } from 'lucide-react'
import type { SessionCard as Card } from '@shared/types'
import { api } from '@renderer/api'
import { Button, IconButton } from './ui/button'
import { cn } from './ui/cn'
import { Tag } from './ui/feedback'
import { ConfirmDialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from './ui/overlays'
import { dayLabel, duration, initials, timeOfDay } from '@renderer/lib/format'

export const TYPE_META = {
  interview: { label: 'Interview', Icon: Briefcase },
  regular: { label: 'Regular call', Icon: Phone },
  mock: { label: 'Mock interview', Icon: Bot },
} as const

export const STATUS_META = {
  live: { label: 'Live', dot: 'bg-success anim-pulse' },
  left: { label: 'Paused', dot: 'bg-warning-icon' },
  ended: { label: 'Ended', dot: 'bg-text-subtle' },
  draft: { label: 'Not started', dot: 'bg-border-input' },
} as const

export function CompanyLogo({ name, className }: { name: string | null; className?: string }) {
  return (
    <span aria-hidden className={cn('flex size-4 shrink-0 items-center justify-center rounded-xs bg-primary text-2xs leading-none font-semibold text-on-primary', className)}>
      {initials(name).slice(0, 1)}
    </span>
  )
}

export function SessionCardView({
  card,
  onOpen,
  onRejoin,
  onReturn,
  rejoining,
}: {
  card: Card
  onOpen: () => void
  onRejoin?: () => void
  onReturn?: () => void
  rejoining?: boolean
}) {
  const [confirm, setConfirm] = useState(false)
  const t = TYPE_META[card.type]
  const st = STATUS_META[card.status]
  const title = card.companyName || 'Untitled call'
  const when = card.startedAt ?? card.createdAt
  return (
    <article
      className="group relative rounded-md border border-border bg-bg p-3 shadow-card transition-colors duration-(--tk-motion-fast) hover:border-text-subtle focus-within:border-text-subtle"
      aria-labelledby={`card-${card.id}`}
    >
      <p className="text-2xs font-medium tracking-wide text-text-subtle uppercase">
        {dayLabel(when)} · {timeOfDay(when)}
      </p>
      <div className="mt-1 flex items-center gap-2">
        <CompanyLogo name={card.companyName} />
        <h3 id={`card-${card.id}`} className="min-w-0 truncate text-base font-semibold">
          {/* the whole card opens the transcript; the link stretches over it */}
          <button type="button" onClick={onOpen} className="text-left after:absolute after:inset-0 after:rounded-md focus-visible:outline-none">
            {title}
          </button>
        </h3>
      </div>
      {card.roleTitle && <p className="mt-0.5 truncate text-xs text-text-muted">{card.roleTitle}</p>}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Tag icon={<t.Icon size={12} strokeWidth={1.75} />}>{t.label}</Tag>
        {card.hasTranscript && <Tag icon={<FileText size={12} strokeWidth={1.75} />}>Transcript</Tag>}
        {card.answerCount > 0 && <Tag>{card.answerCount === 1 ? '1 answer' : `${card.answerCount} answers`}</Tag>}
      </div>
      <div className="relative z-10 mt-3 flex items-center gap-2">
        <span className={cn('size-2 rounded-pill', st.dot)} aria-hidden />
        <span className="text-xs text-text-muted">
          {st.label}
          {card.activeMs > 0 && ` · ${duration(card.activeMs)}`}
        </span>
        <span className="flex-1" />
        {card.status === 'live' && onReturn && (
          <Button size="sm" variant="primary" icon={<Play size={14} />} onClick={onReturn}>
            Return to call
          </Button>
        )}
        {card.status === 'left' && onRejoin && (
          <Button size="sm" variant="secondary" icon={<Play size={14} />} onClick={onRejoin} loading={rejoining} busyLabel="Rejoining…" aria-label={`Rejoin ${title}`}>
            Rejoin
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onOpen} aria-label={`View transcript of ${title}`}>
          View transcript
        </Button>
        <Menu>
          <MenuTrigger asChild>
            <IconButton label={`More actions for ${title}`}>
              <MoreVertical size={16} strokeWidth={1.75} />
            </IconButton>
          </MenuTrigger>
          <MenuContent>
            <MenuItem icon={<ArrowUpRight size={16} />} onSelect={onOpen}>
              Open in library
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Trash2 size={16} />} danger disabled={card.status === 'live'} onSelect={() => setConfirm(true)}>
              Delete call
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete this call?"
        body={`${title}: its transcript, answers and notes are removed from this PC. This can't be undone.`}
        confirmLabel="Delete call"
        busyLabel="Deleting…"
        danger
        onConfirm={async () => {
          await api.sessions.delete({ id: card.id })
        }}
      />
    </article>
  )
}
