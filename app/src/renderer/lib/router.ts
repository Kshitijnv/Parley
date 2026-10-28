import { useEffect, useSyncExternalStore } from 'react'

function current(): string {
  const h = location.hash.replace(/^#/, '')
  return h || '/overlay'
}

function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}

export function useRoute(): string {
  return useSyncExternalStore(subscribe, current)
}

export function navigate(path: string, opts: { replace?: boolean } = {}) {
  const url = `${location.pathname}${location.search}#${path}`
  if (opts.replace) history.replaceState(null, '', url)
  else history.pushState(null, '', url)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

/** Main can tell a window to go somewhere (library "Create session", overlay "View transcript"). */
export function useNativeNav() {
  useEffect(() => window.native?.onNav((route) => navigate(route)), [])
}

/** Match "/library/resumes/:id" style patterns. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean)
  const a = path.split('?')[0].split('/').filter(Boolean)
  if (p.length !== a.length) return null
  const out: Record<string, string> = {}
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) out[p[i].slice(1)] = decodeURIComponent(a[i])
    else if (p[i] !== a[i]) return null
  }
  return out
}

export function query(path: string): URLSearchParams {
  return new URLSearchParams(path.split('?')[1] ?? '')
}
