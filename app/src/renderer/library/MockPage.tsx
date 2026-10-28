import { Bot, Play } from 'lucide-react'
import { api } from '@renderer/api'
import { SessionCardView } from '@renderer/components/SessionCard'
import { Button } from '@renderer/components/ui/button'
import { Callout, EmptyState, Skeleton } from '@renderer/components/ui/feedback'
import { errorText } from '@renderer/lib/format'
import { useQuery } from '@renderer/lib/hooks'
import { navigate } from '@renderer/lib/router'
import { PageHeader } from './LibraryApp'

/** S24: practise with an AI interviewer, using the same live overlay. */
export function MockPage() {
  const list = useQuery(() => api.sessions.list({}), [], ['sessions'])
  const mocks = (list.data ?? []).filter((c) => c.type === 'mock')
  const start = () => void api.window.openOverlay({ route: '/create?type=mock' })
  return (
    <>
      <PageHeader
        title="Mock interview"
        description="An AI interviewer asks questions from the job description and your resume. You answer out loud, with the assistant running just like in a real call."
        actions={
          <Button variant="accent" icon={<Play size={16} />} onClick={start}>
            Start a mock interview
          </Button>
        }
      />
      <div className="mx-auto max-w-(--tk-layout-library-content-max) space-y-6 p-6">
        <ol className="grid gap-3 sm:grid-cols-3">
          {[
            ['Set it up', 'Pick Mock as the session type, then add the job and your resume.'],
            ['Practise', 'Press Next question in the live bar. The interviewer speaks; you answer.'],
            ['Review', 'End the call to get notes on each answer and what to work on.'],
          ].map(([t, l], i) => (
            <li key={t} className="rounded-md border border-border p-4">
              <p className="text-2xs font-medium tracking-wide text-text-subtle uppercase">Step {i + 1}</p>
              <p className="mt-1 text-base font-medium">{t}</p>
              <p className="mt-1 text-xs text-text-muted">{l}</p>
            </li>
          ))}
        </ol>
        <section aria-labelledby="past-mocks">
          <h2 id="past-mocks" className="mb-3 text-base font-medium">
            Past practice
          </h2>
          {list.loading && !list.data ? (
            <Skeleton className="h-28 w-full" />
          ) : list.error ? (
            <Callout tone="danger">{errorText(list.error)}</Callout>
          ) : mocks.length === 0 ? (
            <EmptyState icon={<Bot size={24} />} title="No practice yet" line="Your mock interviews show up here with their notes." />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {mocks.map((c) => (
                <li key={c.id}>
                  <SessionCardView card={c} onOpen={() => navigate(`/library/calls/${c.id}?pane=notes`)} onRejoin={() => void api.window.openOverlay({ route: `/connect/${c.id}` })} onReturn={() => void api.window.openOverlay({ route: `/live/${c.id}` })} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  )
}
