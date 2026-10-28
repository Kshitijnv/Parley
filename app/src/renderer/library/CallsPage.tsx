import { useState } from 'react'
import { ArrowDownUp, AudioLines, Plus, Search, SearchX } from 'lucide-react'
import { api } from '@renderer/api'
import { SessionCardView } from '@renderer/components/SessionCard'
import { Button, IconButton } from '@renderer/components/ui/button'
import { Callout, EmptyState, Skeleton } from '@renderer/components/ui/feedback'
import { TextInput } from '@renderer/components/ui/form'
import { Tooltip } from '@renderer/components/ui/overlays'
import { errorText } from '@renderer/lib/format'
import { useDebounced, useQuery } from '@renderer/lib/hooks'
import { navigate } from '@renderer/lib/router'
import { PageHeader } from './LibraryApp'

/** S22: every past call. */
export function CallsPage() {
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest')
  const dq = useDebounced(q, 200)
  const list = useQuery(() => api.sessions.list({ q: dq || undefined, sort }), [dq, sort], ['sessions', 'transcript'])
  const cards = list.data ?? []
  return (
    <>
      <PageHeader
        title="Calls"
        description="Transcripts, answers and notes from your past sessions."
        actions={
          <Button variant="accent" icon={<Plus size={16} />} onClick={() => void api.window.openOverlay({ route: '/create' })}>
            Create session
          </Button>
        }
      />
      <div className="mx-auto max-w-(--tk-layout-library-content-max) p-6">
        <div className="mb-4 flex items-center gap-2">
          <TextInput
            className="max-w-md flex-1"
            role="searchbox"
            aria-label="Search calls"
            placeholder="Search by company, role or job text"
            leading={<Search size={14} />}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onClear={() => setQ('')}
          />
          <Tooltip content={sort === 'newest' ? 'Newest first' : 'Oldest first'}>
            <IconButton size="md" label={`Sort: ${sort === 'newest' ? 'newest first' : 'oldest first'}. Change order`} onClick={() => setSort((s) => (s === 'newest' ? 'oldest' : 'newest'))}>
              <ArrowDownUp size={16} />
            </IconButton>
          </Tooltip>
        </div>
        {list.loading && !list.data ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-label="Loading calls">
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-2 rounded-md border border-border p-3">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-28" />
              </div>
            ))}
          </div>
        ) : list.error ? (
          <Callout tone="danger" action={<Button size="sm" onClick={() => void list.reload()}>Try again</Button>}>
            Couldn't load your calls. {errorText(list.error)}
          </Callout>
        ) : cards.length === 0 && dq ? (
          <EmptyState className="mt-16" icon={<SearchX size={24} />} title="Nothing matches" line={`No calls mention "${dq}".`} action={<Button variant="link" size="sm" onClick={() => setQ('')}>Clear search</Button>} />
        ) : cards.length === 0 ? (
          <EmptyState
            className="mt-16"
            icon={<AudioLines size={24} />}
            title="No calls yet"
            line="Set one up before your next interview. It shows up here when it starts."
            action={
              <Button variant="secondary" icon={<Plus size={14} />} onClick={() => void api.window.openOverlay({ route: '/create' })}>
                Create session
              </Button>
            }
          />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Calls">
            {cards.map((c) => (
              <li key={c.id}>
                <SessionCardView card={c} onOpen={() => navigate(`/library/calls/${c.id}?pane=transcript`)} onReturn={() => void api.window.openOverlay({ route: `/live/${c.id}` })} onRejoin={() => void api.window.openOverlay({ route: `/connect/${c.id}` })} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
