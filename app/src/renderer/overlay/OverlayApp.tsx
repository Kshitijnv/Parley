import { useEffect, useState, type ReactNode } from 'react'
import { isElectron, isMock } from '@renderer/api'
import { recoverOnStartup } from '@renderer/api/mock'
import { cn } from '@renderer/components/ui/cn'
import { PortalContext, Toaster } from '@renderer/components/ui/overlays'
import { useFitWindow } from '@renderer/lib/hooks'
import { match, query } from '@renderer/lib/router'
import { useNotesToasts } from './useNotesToasts'
import { SessionList } from './SessionList'
import { CreateSession } from './CreateSession'
import { Connect } from './Connect'
import { LiveView } from './live/LiveView'

let recovered = false

export function OverlayApp({ route }: { route: string }) {
  if (isMock && !recovered) {
    recovered = true
    recoverOnStartup()
  }
  useNotesToasts()
  useEffect(() => {
    if (isElectron) {
      document.body.style.background = 'transparent'
      document.body.style.overflow = 'hidden'
    }
  }, [])

  let m: Record<string, string> | null
  let screen: ReactNode
  if ((m = match('/overlay/live/:id', route))) screen = <LiveView key={m.id} id={m.id} />
  else if ((m = match('/overlay/connect/:id', route))) screen = <Connect key={m.id} id={m.id} />
  else if (match('/overlay/create', route)) {
    const q = query(route)
    screen = <CreateSession key={q.get('draft') ?? 'new'} draftId={q.get('draft')} initialStep={q.get('step') === '2' ? 2 : 1} initialType={q.get('type')} />
  } else screen = <SessionList />

  return <>{screen}</>
}

/** The visible solid window (S03, S07–S12): sized from the layout tokens, reported to main. */
export function Panel({ size, children, className }: { size: 'list' | 'wizard'; children: ReactNode; className?: string }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  useFitWindow(el)
  return (
    <div className={cn(isElectron && 'p-2')}>
      <div
        ref={setEl}
        className={cn(
          'relative flex flex-col overflow-hidden rounded-lg border border-border bg-bg text-text shadow-window transform-[translateZ(0)]',
          size === 'list' ? 'h-(--tk-layout-overlay-list-h) w-(--tk-layout-overlay-list-w)' : 'h-(--tk-layout-overlay-wizard-h) w-(--tk-layout-overlay-wizard-w)',
          // Electron sizes the window to this frame, so it must not shrink to the old window size.
          !isElectron && 'max-w-[calc(100vw-16px)]',
          className,
        )}
      >
        <PortalContext.Provider value={el}>{children}</PortalContext.Provider>
        <Toaster className="absolute right-3 bottom-16 z-30" />
      </div>
    </div>
  )
}
