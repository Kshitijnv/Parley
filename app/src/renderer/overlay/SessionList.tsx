import { useState } from 'react'
import { ArrowDownUp, AudioLines, Plus, Search, SearchX } from 'lucide-react'
import { api } from '@renderer/api'
import { SessionCardView } from '@renderer/components/SessionCard'
import { Button, IconButton } from '@renderer/components/ui/button'
import { Callout, EmptyState, Skeleton } from '@renderer/components/ui/feedback'
import { TextInput } from '@renderer/components/ui/form'
import { Tooltip, toast } from '@renderer/components/ui/overlays'
import { errorText } from '@renderer/lib/format'
import { useDebounced, useQuery } from '@renderer/lib/hooks'
import { navigate } from '@renderer/lib/router'
import { Panel } from './OverlayApp'
import { WindowHeader } from './WindowControls'

/** S03: open or create a session. */
export function SessionList() {
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest')
  const dq = useDebounced(q, 200)
  const list = useQuery(() => api.sessions.list({ q: dq || undefined, sort }), [dq, sort], ['sessions', 'transcript'])
  const [rejoining, setRejoining] = useState<string | null>(null)
  const stt = useQuery(() => api.stt.modelStatus(), [], ['settings'])

  const rejoin = async (id: string) => {
    setRejoining(id)
    try {
      const st = await api.stt.modelStatus()
      if (!st.ready) {
        navigate(`/overlay/connect/${id}`)
        return
      }
      await api.sessions.rejoin({ id })
      navigate(`/overlay/live/${id}`)
    } catch (e) {
      toast({ text: errorText(e), tone: 'error' })
    } finally {
      setRejoining(null)
    }
  }

  const cards = list.data ?? []
  return (
    <Panel size="list">
      <WindowHeader />
      <main className="flex min-h-0 flex-1 flex-col">
        <h1 className="sr-only">Calls</h1>
        <div className="flex items-center gap-2 px-4 pt-2 pb-3">
          <TextInput
            className="flex-1"
            role="searchbox"
            aria-label="Search calls"
            placeholder="Search by company, role or job text"
            leading={<Search size={14} strokeWidth={1.75} />}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onClear={() => setQ('')}
          />
          <Tooltip content={sort === 'newest' ? 'Newest first' : 'Oldest first'}>
            <IconButton
              size="md"
              label={`Sort: ${sort === 'newest' ? 'newest first' : 'oldest first'}. Change order`}
              onClick={() => setSort((s) => (s === 'newest' ? 'oldest' : 'newest'))}
            >
              <ArrowDownUp size={16} strokeWidth={1.75} />
            </IconButton>
          </Tooltip>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {stt.data && !stt.data.ready && (
            <Callout
              tone="warning"
              className="mb-3"
              action={
                <Button size="sm" onClick={() => void api.window.openLibrary({ route: '/settings' })}>
                  Set up
                </Button>
              }
            >
              First, install the English speech model ({stt.data.sizeMb} MB, one time). Calls can't start without it.
            </Callout>
          )}
          {list.loading && !list.data ? (
            <div className="space-y-3" aria-busy="true" aria-label="Loading calls">
              {[0, 1, 2].map((i) => (
                <div key={i} className="space-y-2 rounded-md border border-border p-3">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-32" />
                </div>
              ))}
            </div>
          ) : list.error ? (
            <Callout tone="danger" action={<Button size="sm" onClick={() => void list.reload()}>Try again</Button>}>
              Couldn't load your calls. {errorText(list.error)}
            </Callout>
          ) : cards.length === 0 && dq ? (
            <EmptyState
              className="mt-24"
              icon={<SearchX size={24} strokeWidth={1.5} />}
              title="Nothing matches"
              line={`No calls mention "${dq}".`}
              action={
                <Button variant="link" size="sm" onClick={() => setQ('')}>
                  Clear search
                </Button>
              }
            />
          ) : cards.length === 0 ? (
            <EmptyState className="mt-32" icon={<AudioLines size={24} strokeWidth={1.5} />} title="No calls yet" line="Set one up before your next interview." />
          ) : (
            <ul className="space-y-3" aria-label="Calls">
              {cards.map((c) => (
                <li key={c.id}>
                  <SessionCardView
                    card={c}
                    rejoining={rejoining === c.id}
                    onOpen={() => void api.window.openLibrary({ route: `/calls/${c.id}?pane=transcript` })}
                    onRejoin={() => void rejoin(c.id)}
                    onReturn={() => navigate(`/overlay/live/${c.id}`)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
      <footer className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
        <Button variant="ghost" external onClick={() => void api.window.openLibrary({ route: '/calls' })}>
          Open library
        </Button>
        <Button variant="accent" size="lg" icon={<Plus size={16} strokeWidth={2} />} onClick={() => navigate('/overlay/create')} className="min-w-40">
          Create session
        </Button>
      </footer>
    </Panel>
  )
}
