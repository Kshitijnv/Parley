import { useEffect, useState } from 'react'
import { Cable, Download, EyeOff, Headphones, Keyboard, Mic } from 'lucide-react'
import { api } from '@renderer/api'
import { Button } from '@renderer/components/ui/button'
import type { SttStatus } from '@shared/types'
import { Callout, SkeletonLines, Spinner } from '@renderer/components/ui/feedback'
import { Field } from '@renderer/components/ui/form'
import { Select } from '@renderer/components/ui/select'
import { errorText, keyGlyphs } from '@renderer/lib/format'
import { useEvent, useQuery, useSettings } from '@renderer/lib/hooks'
import { navigate } from '@renderer/lib/router'
import { Panel } from './OverlayApp'
import { WindowHeader } from './WindowControls'
import { listMics } from './live/capture'

/** S12: last checks, preload the session's speech model, then start capture and speech-to-text. */
export function Connect({ id }: { id: string }) {
  const session = useQuery(() => api.sessions.get({ id }), [id])
  const stt = useQuery(() => api.stt.modelStatus(), [], ['settings'])
  const settings = useSettings()
  const [mics, setMics] = useState<Array<{ value: string; label: string }>>([])
  const [mic, setMic] = useState<string>('default')
  const [phase, setPhase] = useState<'idle' | 'starting'>('idle')
  const [loaded, setLoaded] = useState<SttStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void listMics().then((list) => {
      setMics(list)
      if (list[0]) setMic(list[0].value)
    })
  }, [])

  const s = session.data
  useEffect(() => {
    if (s && s.status === 'live') navigate(`/overlay/live/${id}`, { replace: true })
    if (s && s.status === 'ended') navigate('/overlay', { replace: true })
  }, [s, id])

  // Load the model while the user reads this screen, so Start doesn't wait for it.
  const ready = !!stt.data?.ready
  useEffect(() => {
    if (!s || !ready || s.status === 'live' || s.status === 'ended') return
    let gone = false
    void api.stt
      .prepare({ sessionId: id })
      .then((st) => !gone && setLoaded(st))
      .catch((e) => !gone && setError(errorText(e)))
    return () => {
      gone = true
    }
  }, [s?.id, s?.status, ready, id])
  useEvent('stt:status', (st) => setLoaded(st))

  const connect = async () => {
    setError(null)
    try {
      setPhase('starting')
      if (s?.status === 'left') await api.sessions.rejoin({ id })
      else await api.sessions.start({ id, micDeviceId: mic === 'default' ? undefined : mic })
      navigate(`/overlay/live/${id}`, { replace: true })
    } catch (e) {
      setError(errorText(e))
      setPhase('idle')
    }
  }

  const hk = settings.data?.hotkeys
  const busy = phase !== 'idle'
  return (
    <Panel size="list">
      <WindowHeader />
      <main className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-4">
        <div className="pt-3 pb-5 text-center">
          <h1 className="text-md font-semibold">Connect to your call</h1>
          <p className="mt-1 text-xs text-text-muted">
            {s ? `${s.companyName ?? 'Your session'} is ready.` : 'Your session is ready.'} Connect to start the live transcript.
          </p>
        </div>
        {session.loading || stt.loading ? (
          <SkeletonLines lines={6} />
        ) : session.error ? (
          <Callout tone="danger">{errorText(session.error)}</Callout>
        ) : (
          <div className="space-y-3">
            <Callout icon={<Headphones size={16} />}>
              Use headphones. On laptop speakers your mic also hears the other side, and their words can show up as yours. Try a test call before the real one.
            </Callout>
            {settings.data?.privateMode ? (
              <Callout icon={<EyeOff size={16} />}>Private mode is on: this window stays out of screen shares and recordings. It's still visible to a camera pointed at your screen.</Callout>
            ) : (
              <Callout
                tone="warning"
                action={
                  <Button size="sm" onClick={() => void api.settings.update({ privateMode: true })}>
                    Turn on
                  </Button>
                }
              >
                Private mode is off. If you share your screen, the other side can see this window.
              </Callout>
            )}
            {hk && (
              <Callout tone="warning" icon={<Keyboard size={16} />} role="note">
                While the call is live, {keyGlyphs(hk.answer).join(' ')} and {keyGlyphs(hk.clear_answer).join(' ')} belong to this app, so they won't work in Teams, Slack or other apps until you end the session. You can change them in Settings.
              </Callout>
            )}
            <Field label={<span className="inline-flex items-center gap-1.5"><Mic size={14} aria-hidden /> Microphone</span>} hint="The other side's audio is captured from your PC's speakers output.">
              {({ id: fid, describedBy }) => (
                <Select id={fid} ariaLabel="Microphone" describedBy={describedBy} value={mic} onChange={setMic} options={mics.length ? mics : [{ value: 'default', label: 'System default' }]} disabled={busy} />
              )}
            </Field>
            {!ready ? (
              <Callout
                tone="warning"
                icon={<Download size={16} />}
                action={
                  <Button size="sm" onClick={() => void api.window.openLibrary({ route: '/settings' })}>
                    Install
                  </Button>
                }
              >
                Install the English speech model ({stt.data?.sizeMb ?? 71} MB, one time) in Settings › Speech models. It runs on this PC, offline. Downloads never start during a call.
              </Callout>
            ) : loaded?.state === 'listening' && loaded.modelId ? (
              <p className="text-xs text-text-muted" aria-live="polite">
                Speech model ready: {loaded.language === 'en' ? 'English' : loaded.language} · {loaded.modelId}
                {loaded.loadMs ? ` · loaded in ${(loaded.loadMs / 1000).toFixed(1)} s` : ''}
              </p>
            ) : loaded?.state === 'error' ? null : loaded?.state === 'stopped' ? (
              <p className="text-xs text-text-muted">The speech model loads when you connect.</p>
            ) : (
              <p className="flex items-center gap-1.5 text-xs text-text-muted" aria-live="polite">
                <Spinner /> Loading the speech model…
              </p>
            )}
            {loaded?.state === 'error' && loaded.error && <Callout tone="danger">{loaded.error}</Callout>}
            {error && (
              <Callout tone="danger" role="alert">
                {error}
              </Callout>
            )}
          </div>
        )}
      </main>
      <footer className="grid grid-cols-2 gap-3 border-t border-border px-5 py-3">
        <Button
          variant="secondary"
          size="lg"
          disabled={busy}
          onClick={() => {
            if (s?.status === 'draft') navigate(`/overlay/create?draft=${id}&step=2`)
            else navigate('/overlay')
          }}
        >
          Back
        </Button>
        <Button
          variant="primary"
          size="lg"
          icon={<Cable size={16} />}
          loading={busy}
          busyLabel="Connecting…"
          disabled={!s || !!session.error || !ready}
          onClick={() => void connect()}
        >
          {s?.status === 'left' ? 'Rejoin' : 'Connect'}
        </Button>
      </footer>
    </Panel>
  )
}
