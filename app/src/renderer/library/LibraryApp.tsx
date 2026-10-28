import { useEffect, type ReactNode } from 'react'
import { AudioLines, Bot, FileUser, Files, HardDrive, Monitor, Moon, Plus, Settings as SettingsIcon, Sun } from 'lucide-react'
import type { Theme } from '@shared/types'
import { api } from '@renderer/api'
import { Wordmark } from '@renderer/components/ui/brand'
import { cn } from '@renderer/components/ui/cn'
import { PortalContext, Toaster } from '@renderer/components/ui/overlays'
import { useSettings } from '@renderer/lib/hooks'
import { match, navigate, query } from '@renderer/lib/router'
import { CallsPage } from './CallsPage'
import { CallDetail } from './CallDetail'
import { ResumesPage } from './ResumesPage'
import { ResumeDetail } from './ResumeDetail'
import { DocumentsPage, DocumentDetail } from './DocumentsPage'
import { MockPage } from './MockPage'
import { SettingsPage } from './SettingsPage'

export function LibraryApp({ route }: { route: string }) {
  useEffect(() => {
    if (route === '/library' || route === '/library/') navigate('/library/calls', { replace: true })
  }, [route])

  let page: ReactNode = null
  let m: Record<string, string> | null
  const path = route.split('?')[0]!
  if ((m = match('/library/calls/:id', path))) page = <CallDetail key={m.id} id={m.id} pane={query(route).get('pane')} />
  else if (match('/library/calls', path)) page = <CallsPage />
  else if ((m = match('/library/resumes/:id', path))) page = <ResumeDetail key={m.id} id={m.id} />
  else if (match('/library/resumes', path)) page = <ResumesPage />
  else if ((m = match('/library/documents/:id', path))) page = <DocumentDetail key={m.id} id={m.id} />
  else if (match('/library/documents', path)) page = <DocumentsPage />
  else if (match('/library/mock', path)) page = <MockPage />
  else if (match('/library/settings', path)) page = <SettingsPage />

  const section = path.split('/')[2] ?? 'calls'
  return (
    <PortalContext.Provider value={null}>
      <div className="flex min-h-full flex-col bg-bg text-text md:h-full md:flex-row">
        <Sidebar active={section} />
        <main className="scroll-thin min-w-0 flex-1 md:overflow-y-auto" id="content">
          {page ?? (
            <div className="p-8 text-sm text-text-muted">
              Page not found.{' '}
              <button type="button" className="underline" onClick={() => navigate('/library/calls')}>
                Go to calls
              </button>
            </div>
          )}
        </main>
      </div>
      <Toaster className="fixed right-4 bottom-4 z-50" />
    </PortalContext.Provider>
  )
}

function Sidebar({ active }: { active: string }) {
  const { data: settings } = useSettings()
  return (
    <aside className="flex shrink-0 flex-col gap-4 border-b border-border bg-surface p-3 md:h-full md:w-(--tk-layout-library-sidebar-w) md:border-r md:border-b-0">
      <div className="flex h-10 items-center px-2.5">
        <Wordmark />
      </div>
      <nav aria-label="Library" className="flex flex-col gap-4 max-md:flex-row max-md:overflow-x-auto">
        <NavGroup label="Call assistant">
          <NavItem icon={<Plus size={16} />} label="Create session" onClick={() => void api.window.openOverlay({ route: '/create' })} />
          <NavItem icon={<AudioLines size={16} />} label="Calls" current={active === 'calls'} onClick={() => navigate('/library/calls')} />
          <NavItem icon={<FileUser size={16} />} label="Resumes" current={active === 'resumes'} onClick={() => navigate('/library/resumes')} />
          <NavItem icon={<Files size={16} />} label="Documents" current={active === 'documents'} onClick={() => navigate('/library/documents')} />
        </NavGroup>
        <NavGroup label="Practise">
          <NavItem icon={<Bot size={16} />} label="Mock interview" current={active === 'mock'} onClick={() => navigate('/library/mock')} />
        </NavGroup>
        <NavGroup label="App">
          <NavItem icon={<SettingsIcon size={16} />} label="Settings" current={active === 'settings'} onClick={() => navigate('/library/settings')} />
        </NavGroup>
      </nav>
      <div className="mt-auto flex flex-col gap-2 max-md:hidden">
        <div className="flex items-center justify-between px-2.5">
          <span className="text-xs text-text-muted" id="theme-label">
            Theme
          </span>
          <div role="radiogroup" aria-labelledby="theme-label" className="flex rounded-sm bg-surface-2 p-0.5">
            {(
              [
                ['light', Sun, 'Light'],
                ['dark', Moon, 'Dark'],
                ['system', Monitor, 'System'],
              ] as const
            ).map(([v, Icon, l]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={settings?.theme === v}
                aria-label={l}
                onClick={() => void api.settings.update({ theme: v as Theme })}
                className={cn('flex size-6 items-center justify-center rounded-xs text-text-muted', settings?.theme === v && 'bg-bg text-text shadow-card')}
              >
                <Icon size={14} />
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-md px-2.5 py-2">
          <HardDrive size={16} className="text-text-muted" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium">This PC</p>
            <p className="truncate text-xs text-text-muted">Everything is stored locally</p>
          </div>
        </div>
      </div>
    </aside>
  )
}

function NavGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 max-md:shrink-0">
      <p className="px-2.5 pb-1 text-2xs font-medium tracking-wide text-text-subtle uppercase max-md:sr-only">{label}</p>
      <div className="flex flex-col gap-0.5 max-md:flex-row">{children}</div>
    </div>
  )
}

function NavItem({ icon, label, current, onClick }: { icon: ReactNode; label: string; current?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current ? 'page' : undefined}
      className={cn(
        'flex h-9 shrink-0 items-center gap-2 rounded-md px-2.5 text-sm transition-colors duration-(--tk-motion-fast)',
        current ? 'bg-surface-2 font-medium text-text' : 'text-text-muted hover:bg-surface-2 hover:text-text',
      )}
    >
      <span aria-hidden>{icon}</span>
      {label}
    </button>
  )
}

export function PageHeader({ title, description, actions, back }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <header className="border-b border-border px-6 pt-6 pb-4">
      {back}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-medium">{title}</h1>
          {description && <p className="mt-1 text-xs text-text-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  )
}

export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <button type="button" onClick={() => navigate(to)} className="mb-2 inline-flex items-center gap-1 rounded-sm text-xs text-text-muted hover:text-text">
      ← {label}
    </button>
  )
}

export { query }
