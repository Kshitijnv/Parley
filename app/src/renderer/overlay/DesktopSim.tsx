import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { api, isMock } from '@renderer/api'
import { resetDb, scenario } from '@renderer/api/mock/store'
import { sim, simReopen, simSetDesktop, simSetHover, simSubscribe } from '@renderer/api/window'
import { AppMark } from '@renderer/components/ui/brand'
import { cn } from '@renderer/components/ui/cn'

let simVersion = 0
simSubscribe(() => {
  simVersion++
})

/** Browser preview only: a stand-in desktop so the overlay can float, hide to a bubble and snap. */
export function DesktopSim({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useSyncExternalStore(simSubscribe, () => simVersion)
  const s = sim

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => simSetDesktop(el.clientWidth, el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!sim.snapping) return
    const move = (e: PointerEvent) => {
      const r = ref.current!.getBoundingClientRect()
      const col = Math.min(2, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * 3)))
      const row = Math.min(1, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * 2)))
      simSetHover(row * 3 + col)
    }
    window.addEventListener('pointermove', move)
    return () => window.removeEventListener('pointermove', move)
  }, [s.snapping])

  return (
    <div ref={ref} className="relative h-full w-full overflow-hidden bg-surface-2" data-testid="desktop">
      <FakeCallWindow />
      {!s.hidden && !s.closed && (
        <div className="absolute" style={{ left: s.bounds.x, top: s.bounds.y }} data-testid="overlay-window">
          {children}
        </div>
      )}
      {s.hidden && !s.closed && (
        <div className="absolute" style={{ left: s.bounds.x + s.bounds.width - 52, top: s.bounds.y + 8 }}>
          <BubbleButton onRestore={() => void api.window.restore()} />
        </div>
      )}
      {s.snapping && <SnapZones hover={s.hoverZone} />}
      {s.closed && (
        <div className="absolute inset-0 flex items-center justify-center">
          <button type="button" onClick={simReopen} className="rounded-md bg-bg px-4 py-2 text-sm shadow-window">
            The app was closed. Open it again
          </button>
        </div>
      )}
      {isMock && <PreviewBar />}
    </div>
  )
}

function FakeCallWindow() {
  return (
    <div aria-hidden className="pointer-events-none absolute top-[12%] left-[6%] h-[64%] w-[52%] rounded-lg border border-border bg-bg/70 p-4">
      <div className="mb-3 h-3 w-40 rounded-sm bg-border" />
      <div className="grid h-[85%] grid-cols-2 gap-3">
        <div className="rounded-md bg-surface" />
        <div className="rounded-md bg-surface" />
      </div>
    </div>
  )
}

export function BubbleButton({ onRestore }: { onRestore: () => void }) {
  return (
    <button
      type="button"
      aria-label="Show assistant"
      title="Parley: click to show"
      onClick={onRestore}
      className="flex size-11 items-center justify-center rounded-pill bg-bg text-primary shadow-window transition-transform duration-(--tk-motion-fast) hover:scale-105"
    >
      <AppMark size={22} />
    </button>
  )
}

export function SnapZones({ hover }: { hover: number | null }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-2 gap-4 p-4">
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          className={cn(
            'rounded-xl border border-border bg-bg transition-opacity duration-(--tk-motion-base)',
            hover === i ? 'opacity-70 outline-2 outline-offset-2 outline-focus' : 'opacity-(--tk-opacity-snap-zone)',
          )}
        />
      ))}
    </div>
  )
}

const SCENARIOS = [
  ['', 'Normal'],
  ['slow', 'Slow model'],
  ['rate_limit', 'Rate limited'],
  ['provider_error', 'Model error'],
  ['offline', 'Offline'],
  ['stt_error', 'Speech error'],
  ['stt_download_fail', 'Model download fails'],
  ['convert_fail', 'PDF conversion fails'],
  ['job_fail', 'Job link fails'],
  ['notes_fail', 'Notes fail'],
  ['bad_key', 'Key rejected'],
]

function PreviewBar() {
  const [open, setOpen] = useState(false)
  return (
    <div className="absolute bottom-3 left-3 z-10 flex items-center gap-2 rounded-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text-muted shadow-card">
      <span>Browser preview · demo data</span>
      <button type="button" className="underline" onClick={() => void api.window.openLibrary({ route: '/calls' })}>
        Library
      </button>
      <button type="button" className="underline" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        Test controls
      </button>
      {open && (
        <span className="flex items-center gap-2">
          <label className="flex items-center gap-1">
            Scenario
            <select
              className="rounded-sm border border-border-input bg-surface px-1"
              defaultValue={scenario()}
              onChange={(e) => {
                localStorage.setItem('parley:mock', e.target.value)
                location.search = ''
              }}
            >
              {SCENARIOS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="underline"
            onClick={() => {
              resetDb('seed')
              location.reload()
            }}
          >
            Reset demo data
          </button>
          <button
            type="button"
            className="underline"
            onClick={() => {
              resetDb('empty')
              location.reload()
            }}
          >
            Start empty
          </button>
        </span>
      )}
    </div>
  )
}
