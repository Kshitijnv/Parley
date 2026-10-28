import { useRef, type ReactNode } from 'react'
import {
  ArrowUpRight,
  EyeOff,
  Info,
  LibraryBig,
  Minimize2,
  Minus,
  Monitor,
  Moon,
  Move,
  MoreVertical,
  Plus,
  Power,
  RotateCcw,
  Settings as SettingsIcon,
  Sun,
  X,
} from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import type { Settings } from '@shared/types'
import { api, isElectron, isMock } from '@renderer/api'
import { IconButton } from '@renderer/components/ui/button'
import { cn } from '@renderer/components/ui/cn'
import { Wordmark } from '@renderer/components/ui/brand'
import { Menu, MenuCheckbox, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Tooltip } from '@renderer/components/ui/overlays'
import { usePrivacy, useSettings } from '@renderer/lib/hooks'

const NUDGE = 24

/** Drag the simulated window by its header in the browser preview (Electron uses app-region). */
export function useSimDrag() {
  const start = useRef<{ x: number; y: number } | null>(null)
  if (isElectron) return {}
  return {
    onPointerDown: (e: React.PointerEvent) => {
      // React bubbles events from portals (the ⋮ menu, dialogs) through the header; only drag from
      // the header's own DOM, or capturing the pointer swallows the menu item's click.
      if (!(e.currentTarget as HTMLElement).contains(e.target as Node)) return
      if ((e.target as HTMLElement).closest('button,input,a,[role="button"],[role="combobox"]')) return
      start.current = { x: e.clientX, y: e.clientY }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!start.current) return
      const dx = e.clientX - start.current.x
      const dy = e.clientY - start.current.y
      start.current = { x: e.clientX, y: e.clientY }
      void api.window.moveBy({ dx, dy })
    },
    onPointerUp: () => {
      start.current = null
    },
  }
}

export function MoveButton({ glass }: { glass?: boolean }) {
  const held = useRef<ReturnType<typeof setTimeout> | null>(null)
  const snapping = useRef(false)
  const end = () => {
    if (held.current) clearTimeout(held.current)
    held.current = null
    if (snapping.current) {
      snapping.current = false
      void api.window.snap({ phase: 'end' })
    }
  }
  return (
    <Tooltip content="Hold and drag to snap. Arrow keys nudge." shortcut="Ctrl ⇧ arrows">
      <IconButton
        label="Move window"
        tone={glass ? 'glass' : 'neutral'}
        onPointerDown={(e) => {
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
          held.current = setTimeout(() => {
            snapping.current = true
            void api.window.snap({ phase: 'start' })
          }, 200)
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={(e) => {
          const d = { ArrowUp: [0, -NUDGE], ArrowDown: [0, NUDGE], ArrowLeft: [-NUDGE, 0], ArrowRight: [NUDGE, 0] }[e.key]
          if (d) {
            e.preventDefault()
            void api.window.moveBy({ dx: d[0]!, dy: d[1]! })
          }
        }}
      >
        <Move size={16} strokeWidth={1.75} />
      </IconButton>
    </Tooltip>
  )
}

export function HideButton({ glass, privateOn }: { glass?: boolean; privateOn?: boolean }) {
  return (
    <Tooltip content="Hide to a bubble">
      <IconButton label="Hide window" tone={glass ? 'glass' : 'neutral'} onClick={() => void api.window.hide()} className="relative">
        <Minimize2 size={16} strokeWidth={1.75} />
        {privateOn && glass && (
          <span className="absolute -right-0.5 -bottom-0.5 flex size-3 items-center justify-center rounded-pill bg-glass-kbd text-glass-text" aria-hidden>
            <EyeOff size={8} strokeWidth={2.5} />
          </span>
        )}
      </IconButton>
    </Tooltip>
  )
}

/** S04 More menu. Extra items (answer prefs, instructions) are passed in from the live bar. */
export function MoreMenu({ glass, children }: { glass?: boolean; children?: ReactNode }) {
  const { data: s } = useSettings()
  const privacy = usePrivacy()
  const set = (patch: Partial<Settings>) => void api.settings.update(patch)
  const zoom = s?.zoom ?? 1
  return (
    <Menu>
      <Tooltip content="More">
        <MenuTrigger asChild>
          <IconButton label="More options" tone={glass ? 'glass' : 'neutral'}>
            <MoreVertical size={16} strokeWidth={1.75} />
          </IconButton>
        </MenuTrigger>
      </Tooltip>
      <MenuContent>
        <MenuLabel>This PC · data stays local</MenuLabel>
        <MenuSeparator />
        {children}
        <MenuItem icon={<LibraryBig size={16} strokeWidth={1.75} />} trailing={<ArrowUpRight size={14} aria-hidden />} onSelect={() => void api.window.openLibrary({ route: '/calls' })}>
          Library
        </MenuItem>
        <MenuItem icon={<SettingsIcon size={16} strokeWidth={1.75} />} trailing={<ArrowUpRight size={14} aria-hidden />} onSelect={() => void api.window.openLibrary({ route: '/settings' })}>
          Settings and API keys
        </MenuItem>
        <MenuSeparator />
        <MenuCheckbox
          checked={s?.privateMode ?? true}
          onChange={(v) => set({ privateMode: v })}
          disabled={privacy?.mode === 'unsupported'}
          icon={<EyeOff size={16} strokeWidth={1.75} />}
          info={
            <Tooltip content={privacy?.reason ?? 'Keeps this window out of screen shares and recordings (Windows 10 2004 or later). It does not hide it from a camera.'}>
              <span tabIndex={0} aria-label="About Private mode" className="text-text-subtle">
                <Info size={14} strokeWidth={1.75} />
              </span>
            </Tooltip>
          }
        >
          Private {s?.privateMode ? '(on)' : '(off)'}
        </MenuCheckbox>
        <div className="flex h-8 items-center gap-2 px-2 text-sm" role="group" aria-label="Zoom">
          <span className="flex-1">Zoom {Math.round(zoom * 100)}%</span>
          <ZoomBtn label="Zoom out" disabled={zoom <= 0.5} onClick={() => set({ zoom: Math.max(0.5, +(zoom - 0.1).toFixed(2)) })}>
            <Minus size={14} />
          </ZoomBtn>
          <ZoomBtn label="Zoom in" disabled={zoom >= 2} onClick={() => set({ zoom: Math.min(2, +(zoom + 0.1).toFixed(2)) })}>
            <Plus size={14} />
          </ZoomBtn>
          <ZoomBtn label="Reset zoom" disabled={zoom === 1} onClick={() => set({ zoom: 1 })}>
            <RotateCcw size={14} />
          </ZoomBtn>
        </div>
        <div className="flex h-8 items-center gap-2 px-2 text-sm">
          <span className="flex-1">Theme</span>
          <DropdownMenu.RadioGroup value={s?.theme ?? 'system'} onValueChange={(v) => set({ theme: v as Settings['theme'] })} className="flex rounded-sm bg-surface-2 p-0.5">
            {(
              [
                ['light', Sun, 'Light'],
                ['dark', Moon, 'Dark'],
                ['system', Monitor, 'System'],
              ] as const
            ).map(([v, Icon, l]) => (
              <DropdownMenu.RadioItem
                key={v}
                value={v}
                aria-label={l}
                onSelect={(e) => e.preventDefault()}
                className="flex size-6 cursor-pointer items-center justify-center rounded-xs text-text-muted outline-none data-highlighted:text-text data-[state=checked]:bg-bg data-[state=checked]:text-text data-[state=checked]:shadow-card"
              >
                <Icon size={14} strokeWidth={1.75} />
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </div>
        <MenuSeparator />
        <MenuItem icon={<Power size={16} strokeWidth={1.75} />} onSelect={() => void api.window.close()}>
          Quit
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

function ZoomBtn({ label, onClick, children, disabled }: { label: string; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault()
        onClick()
      }}
      className="flex size-6 items-center justify-center rounded-xs text-text-muted hover:bg-surface-2 hover:text-text"
    >
      {children}
    </button>
  )
}

/** Header for S03–S12 (solid panel). */
export function WindowHeader({ action }: { action?: ReactNode }) {
  const drag = useSimDrag()
  return (
    <header className={cn('drag flex h-(--tk-size-header-h) shrink-0 items-center gap-1 px-3', !isElectron && 'cursor-grab active:cursor-grabbing')} {...drag}>
      <Wordmark />
      {isMock && isElectron && (
        <Tooltip content="Demo mode (PARLEY_MOCK=1): transcripts and answers are simulated, not real AI output.">
          <span tabIndex={0} className="ml-1 rounded-pill border border-border px-1.5 text-2xs font-medium text-text-muted">
            Demo data
          </span>
        </Tooltip>
      )}
      <div className="flex-1" />
      {action}
      <HideButton />
      <MoveButton />
      <MoreMenu />
      <Tooltip content="Quit">
        <IconButton label="Close app" tone="danger" onClick={() => void api.window.close()}>
          <X size={16} strokeWidth={2} />
        </IconButton>
      </Tooltip>
    </header>
  )
}
