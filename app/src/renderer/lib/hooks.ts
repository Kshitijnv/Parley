import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ApiEventName, ApiEvents } from '@shared/api'
import type { PrivacyCapability, Settings } from '@shared/types'
import { api } from '@renderer/api'
import { windowApi } from '@renderer/api/window'

type Area = ApiEvents['data:changed']['area']

export interface Query<T> {
  data: T | undefined
  error: Error | null
  loading: boolean
  reload: () => Promise<void>
  setData: (v: T) => void
}

/** Fetch through the api and refetch when another write touches one of `areas`. */
export function useQuery<T>(fn: () => Promise<T>, deps: unknown[], areas: Area[] = []): Query<T> {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const fnRef = useRef(fn)
  fnRef.current = fn
  const seq = useRef(0)

  const reload = useCallback(async () => {
    const mine = ++seq.current
    try {
      const v = await fnRef.current()
      if (mine === seq.current) {
        setData(v)
        setError(null)
      }
    } catch (e) {
      if (mine === seq.current) setError(e as Error)
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => {
    if (!areas.length) return
    return api.on('data:changed', (e) => {
      if (areas.includes(e.area)) void reload()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areas.join(',')])

  return { data, error, loading, reload, setData }
}

export function useEvent<E extends ApiEventName>(event: E, cb: (p: ApiEvents[E]) => void) {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => api.on(event, (p) => ref.current(p)), [event])
}

export function useSettings() {
  return useQuery<Settings>(() => api.settings.get(), [], ['settings'])
}

/** What Private mode can do on this OS; null until main has answered. */
export function usePrivacy(): PrivacyCapability | null {
  const [p, setP] = useState<PrivacyCapability | null>(null)
  useEffect(() => {
    void api.window.state().then((st) => setP(st.privacy ?? null)).catch(() => {})
  }, [])
  useEvent('window:state', (st) => st.privacy && setP(st.privacy))
  return p
}

/** Apply theme, zoom and glass opacity from Settings to this window. */
export function useAppearance() {
  const { data } = useSettings()
  useLayoutEffect(() => {
    if (!data) return
    const root = document.documentElement
    if (data.theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', data.theme)
    root.style.setProperty('--tk-glass-opacity', String(Math.min(1, Math.max(0.78, data.overlayOpacity))))
    windowApi.setZoom(data.zoom)
  }, [data])
  return data
}

export function useInterval(cb: () => void, ms: number | null) {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => {
    if (ms === null) return
    const t = setInterval(() => ref.current(), ms)
    return () => clearInterval(t)
  }, [ms])
}

export function useNow(ms = 1000) {
  const [t, setT] = useState(Date.now())
  useInterval(() => setT(Date.now()), ms)
  return t
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/** Report the rendered size of the overlay frame so main can size the window. */
export function useFitWindow(el: HTMLElement | null, enabled = true) {
  useLayoutEffect(() => {
    if (!el || !enabled) return
    const send = () => {
      const r = el.getBoundingClientRect()
      void api.window.fit({ width: Math.ceil(r.width), height: Math.ceil(r.height) })
    }
    send()
    const ro = new ResizeObserver(send)
    ro.observe(el)
    // a zoom change keeps the CSS size but changes the window size it needs; it fires resize
    window.addEventListener('resize', send)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', send)
    }
  }, [el, enabled])
}
