import { api } from '@renderer/api'
import { toast } from '@renderer/components/ui/overlays'
import { useEvent } from '@renderer/lib/hooks'

/** S15: after a call ends, nudge when its notes are ready (or failed). */
export function useNotesToasts() {
  useEvent('notes:status', async ({ sessionId, status }) => {
    if (status !== 'ready' && status !== 'failed') return
    const s = await api.sessions.get({ id: sessionId }).catch(() => null)
    if (!s || s.status !== 'ended' || Date.now() - (s.endedAt ?? 0) > 10 * 60_000) return
    const name = s.companyName ?? 'your call'
    if (status === 'ready') {
      toast({ text: `Notes for ${name} are ready.`, action: { label: 'View notes', onClick: () => void api.window.openLibrary({ route: `/calls/${sessionId}?pane=notes` }) } })
    } else {
      toast({ text: `Couldn't write notes for ${name}.`, tone: 'error', action: { label: 'Open', onClick: () => void api.window.openLibrary({ route: `/calls/${sessionId}?pane=notes` }) } })
    }
  })
}
