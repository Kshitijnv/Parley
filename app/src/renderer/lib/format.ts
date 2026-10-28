export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${sec}s`
  return `${sec}s`
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function timeOfDay(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function dayLabel(t: number): string {
  const d = new Date(t)
  const today = new Date()
  const y = new Date()
  y.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

export function dateTime(t: number): string {
  return `${dayLabel(t)}, ${timeOfDay(t)}`
}

export function bytes(n: number | null): string {
  if (!n) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function errorText(e: unknown): string {
  if (!e) return ''
  if (e instanceof Error) return e.message
  return String(e)
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?'
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')
}

/** "Control+Shift+Enter" -> ["Ctrl", "⇧", "↵"] */
export function keyGlyphs(accel: string): string[] {
  const map: Record<string, string> = {
    Control: 'Ctrl',
    CommandOrControl: 'Ctrl',
    Shift: '⇧',
    Enter: '↵',
    Return: '↵',
    Backspace: '⌫',
    Left: '←',
    Right: '→',
    Up: '↑',
    Down: '↓',
    Space: '␣',
    Alt: 'Alt',
  }
  return accel.split('+').map((k) => map[k] ?? k)
}

/** "Control+Shift+Enter" -> "Control+Shift+Enter" for aria-keyshortcuts. */
export function ariaKeys(accel: string): string {
  return accel.replace('CommandOrControl', 'Control')
}

/** Does a keydown match an Electron accelerator string? */
export function matchesAccel(e: KeyboardEvent, accel: string): boolean {
  const parts = accel.split('+')
  const key = parts[parts.length - 1]
  const want = new Set(parts.slice(0, -1))
  if (want.has('Control') !== e.ctrlKey) return false
  if (want.has('Shift') !== e.shiftKey) return false
  if (want.has('Alt') !== e.altKey) return false
  const k = e.key === ' ' ? 'Space' : e.key.replace('Arrow', '')
  return k.toLowerCase() === key.toLowerCase()
}
