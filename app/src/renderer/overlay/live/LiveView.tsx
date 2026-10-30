import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Bot, Camera, MessageSquareText, Mic, Send, Sparkles, TriangleAlert, Volume2, WandSparkles, X, RotateCw } from 'lucide-react'
import type { AnswerTrigger, GateStatus, HotkeyAction, Hotkeys, Model, Speaker, SttStatus } from '@shared/types'
import { DEFAULT_HOTKEYS, modelLabel, providerOf } from '@shared/catalog'
import { api, isElectron, isMock } from '@renderer/api'
import { simulatedLevel } from '@renderer/api/mock/stt'
import { AnswerPrefsModal, InstructionsModal } from '@renderer/components/PrefsModals'
import { IconButton } from '@renderer/components/ui/button'
import { cn } from '@renderer/components/ui/cn'
import { LevelMeter, Spinner } from '@renderer/components/ui/feedback'
import { MenuItem, MenuSeparator, PortalContext, Toaster, Tooltip, toast } from '@renderer/components/ui/overlays'
import { Select } from '@renderer/components/ui/select'
import { clock, errorText, matchesAccel } from '@renderer/lib/format'
import { useEvent, useFitWindow, useInterval, useNow, useQuery, useSettings } from '@renderer/lib/hooks'
import { navigate } from '@renderer/lib/router'
import { HideButton, MoreMenu, MoveButton, useSimDrag } from '../WindowControls'
import { AnswerPanel } from './AnswerPanel'
import { useAnswerStore } from './answerStore'
import { EndDialog } from './EndDialog'
import { GateChip } from './GateChip'
import { GlassChip } from './GlassChip'
import { TranscriptStrip, type Line } from './TranscriptStrip'
import { listMics, startCapture, type Capture } from './capture'

/** S13 live bar + strip, S14 answer panel, chat input (F04), S26 on End. */
export function LiveView({ id }: { id: string }) {
  const session = useQuery(() => api.sessions.get({ id }), [id], ['sessions'])
  const settings = useSettings()
  const models = useQuery<Model[]>(() => api.models.list(), [], ['keys'])
  const s = session.data
  const hotkeys: Hotkeys = { ...DEFAULT_HOTKEYS, ...(settings.data?.hotkeys ?? {}) }

  const [stt, setStt] = useState<SttStatus>({ state: 'starting' })
  const [lines, setLines] = useState<Line[]>([])
  const [partial, setPartial] = useState<{ speaker: Speaker; text: string } | null>(null)
  const { answers } = useAnswerStore(id)
  const answersRef = useRef(answers)
  answersRef.current = answers
  const [gate, setGate] = useState<GateStatus | null>(null)
  const [index, setIndex] = useState(0)
  const [cleared, setCleared] = useState(false)
  const [chat, setChat] = useState<{ open: boolean; text: string }>({ open: false, text: '' })
  const [expanded, setExpanded] = useState(false)
  const [dialog, setDialog] = useState<null | 'end' | 'prefs' | 'instructions'>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [levels, setLevels] = useState<Record<Speaker, number>>({ you: 0, them: 0 })
  const [mics, setMics] = useState<Array<{ value: string; label: string }>>([])
  const [mic, setMic] = useState('default')
  const [hotkeyFails, setHotkeyFails] = useState<string[]>([])
  const capture = useRef<Capture | null>(null)
  const chatRef = useRef<HTMLInputElement>(null)
  const [frameEl, setFrameEl] = useState<HTMLDivElement | null>(null)
  const drag = useSimDrag()
  const now = useNow(1000)
  useFitWindow(frameEl)

  // The window is sized to the frame, so anything overflowing the bar (⋮, End) would be cut off.
  // When the chips don't fit, drop the key hints (they stay in the accessible names and tooltips).
  const barRef = useRef<HTMLDivElement>(null)
  const [tightBar, setTightBar] = useState(false)
  const longCall = !!s && s.activeMs + (s.liveSince ? now - s.liveSince : 0) >= 3_600_000
  const barContent = `${s?.type}|${hotkeyFails.length}|${stt.state}|${longCall}|${Object.values(hotkeys).join()}|${settings.data?.zoom}`
  useLayoutEffect(() => setTightBar(false), [barContent])
  useLayoutEffect(() => {
    const el = barRef.current
    if (el && !tightBar && el.scrollWidth > el.clientWidth) setTightBar(true)
  })

  // Not live (e.g. reopened after a crash): send to Connect to rejoin, or home if ended.
  useEffect(() => {
    if (!s) return
    if (s.status === 'ended') navigate('/overlay', { replace: true })
    else if (s.status !== 'live') navigate(`/overlay/connect/${id}`, { replace: true })
  }, [s, id])

  // Transcript so far (rejoin keeps it); answers come from the store.
  useEffect(() => {
    void api.transcript.get({ sessionId: id }).then((items) => {
      const segs = items.flatMap((i) => (i.kind === 'segment' ? [{ id: i.segment.id, speaker: i.segment.speaker, text: i.segment.text }] : []))
      setLines(segs.slice(-20))
    })
    void listMics().then((m) => setMics(m))
  }, [id])

  // Capture and hotkeys only while the call is live.
  const live = s?.status === 'live'
  useEffect(() => {
    if (!live) return
    let cancelled = false
    void startCapture({ micDeviceId: mic === 'default' ? undefined : mic, onLevel: (speaker, rms) => setLevels((l) => ({ ...l, [speaker]: rms })) }).then((c) => {
      if (cancelled) c.stop()
      else capture.current = c
    })
    if (isMock) setStt((x) => (x.state === 'stopped' ? { state: 'listening' } : x))
    else void api.stt.status().then((st) => setStt((x) => (x.state === 'starting' && st.state !== 'stopped' ? st : x)))
    return () => {
      cancelled = true
      capture.current?.stop()
      capture.current = null
    }
  }, [live, mic])

  useEffect(() => {
    if (!live || !settings.data) return
    void api.window.setHotkeysActive({ active: true, hotkeys }).then((r) => setHotkeyFails(r.failed))
    return () => {
      void api.window.setHotkeysActive({ active: false, hotkeys: {} })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, JSON.stringify(settings.data?.hotkeys)])

  // Simulated meters only with demo data. With the real data layer a failed device shows
  // a flat meter, never fake activity.
  useInterval(() => {
    const c = capture.current
    setLevels((l) => ({
      you: c?.real.you ? l.you : isMock ? simulatedLevel(partial?.speaker ?? null, 'you') : 0,
      them: c?.real.them ? l.them : isMock ? simulatedLevel(partial?.speaker ?? null, 'them') : 0,
    }))
  }, live ? 120 : null)

  // Revision 7 S4.4: say so briefly when the other side's text changes engine or key.
  const speechRef = useRef<SttStatus['speech']>(undefined)
  const speechWasCloud = useRef(false)
  useEvent('stt:status', (p) => {
    const was = speechRef.current
    const now = p.speech
    speechRef.current = now
    setStt(p)
    if (!was || !now || (was.mode === now.mode && was.keySlot === now.keySlot)) return
    const name = now.keyLabel || `key ${now.keySlot ?? ''}`.trim()
    if (now.mode === 'cloud' && was.mode === 'cloud') toast({ text: `Switched to Speechmatics ${name}` })
    else if (now.mode === 'cloud' && was.mode === 'local_fallback' && speechWasCloud.current) toast({ text: `Cloud speech is back (${name})` })
    else if (now.mode === 'local_fallback' && was.mode === 'cloud') toast({ text: 'Cloud speech dropped: showing local text' })
    if (now.mode === 'cloud') speechWasCloud.current = true
  })
  useEvent('transcript:partial', (p) => {
    if (p.sessionId === id) setPartial(p.text ? { speaker: p.speaker, text: p.text } : null)
  })
  useEvent('transcript:final', (seg) => {
    if (seg.sessionId !== id) return
    setLines((l) => [...l, { id: seg.id, speaker: seg.speaker, text: seg.text }].slice(-40))
  })
  useEvent('gate:status', (g) => {
    if (g.sessionId === id) setGate(g)
  })
  useEffect(() => {
    if (live) void api.answers.gateStatus({ sessionId: id }).then((g) => g && setGate(g))
  }, [live, id])

  // The newest answer (by seq) is the current one, whether it was started by a key
  // press or automatically by main. A late event for an older answer never moves it.
  const newestSeq = answers.at(-1)?.seq ?? -1
  const seenSeq = useRef(-1)
  useEffect(() => {
    if (newestSeq > seenSeq.current) {
      seenSeq.current = newestSeq
      setIndex(Math.max(0, answers.length - 1))
      setCleared(false)
    }
  }, [newestSeq, answers.length])

  const flashChip = (name: string) => {
    setFlash(name)
    setTimeout(() => setFlash((f) => (f === name ? null : f)), 160)
  }

  const showAnswer = (answerId: string) => {
    const i = answersRef.current.findIndex((a) => a.id === answerId)
    if (i >= 0) {
      setIndex(i)
      setCleared(false)
    }
  }

  const generate = useCallback(
    async (trigger: AnswerTrigger, text?: string, opts: { force?: boolean; retryOf?: string; useFallback?: boolean } = {}) => {
      try {
        // Every press is one gate request; the answer itself arrives via answer:start.
        const r = await api.answers.generate({ sessionId: id, trigger, text, clientRequestId: crypto.randomUUID(), ...opts })
        if (r.outcome === 'started') setCleared(false)
        else if (r.answerId) showAnswer(r.answerId)
        if (r.message && r.outcome !== 'started') toast({ text: r.message, tone: r.outcome === 'suppressed' ? 'error' : undefined })
      } catch (e) {
        toast({ text: errorText(e), tone: 'error' })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id],
  )

  const openChat = (prefill = '') => {
    setChat({ open: true, text: prefill })
    setTimeout(() => chatRef.current?.focus(), 0)
  }

  const clearTranscript = async () => {
    await api.transcript.clear({ sessionId: id })
    setLines([])
    setPartial(null)
  }

  const runAction = (action: HotkeyAction) => {
    switch (action) {
      case 'answer':
        flashChip('answer')
        void generate('answer')
        break
      case 'screenshot':
        flashChip('screenshot')
        void generate('screenshot')
        break
      case 'chat':
        flashChip('chat')
        openChat()
        break
      case 'clear_transcript':
        void clearTranscript()
        break
      case 'clear_answer':
        setCleared(true)
        break
      case 'history_prev':
        setCleared(false)
        setIndex((i) => Math.max(0, i - 1))
        break
      case 'history_next':
        setCleared(false)
        setIndex((i) => Math.min(answers.length - 1, i + 1))
        break
      default:
        if (!isElectron) {
          const step = 24
          const d = { move_up: [0, -step], move_down: [0, step], move_left: [-step, 0], move_right: [step, 0] }[action]
          if (d) void api.window.moveBy({ dx: d[0]!, dy: d[1]! })
        }
    }
  }

  useEvent('hotkey:fired', ({ action }) => {
    if (live) runAction(action)
  })

  // Browser preview: no global hotkeys, so listen while this page has focus.
  useEffect(() => {
    if (isElectron || !live) return
    const onKey = (e: KeyboardEvent) => {
      if (dialog) return
      const inField = (e.target as HTMLElement).closest('input,textarea')
      for (const [action, accel] of Object.entries(hotkeys)) {
        if (matchesAccel(e, accel)) {
          if (inField && !['answer', 'screenshot'].includes(action)) return
          e.preventDefault()
          runAction(action as HotkeyAction)
          return
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const end = async (mode: 'leave' | 'end') => {
    await api.sessions.end({ id, mode })
    setDialog(null)
    navigate('/overlay', { replace: true })
    toast({ text: mode === 'leave' ? 'Call paused. Rejoin it from the list.' : s?.saveTranscript ? 'Call ended. Your notes are being written.' : 'Call ended.' })
  }

  const fallback = models.data?.find((m) => s && providerOf(m.id) !== providerOf(s.model)) ?? models.data?.find((m) => s && m.id !== s.model) ?? null
  const visionOk = !!settings.data && !!models.data?.some((m) => m.id === settings.data!.visionModel)
  // The status shows the model the worker actually loaded; a language mismatch is an error, not a label.
  const sttMismatch = !!stt.language && !!s && !s.language.toLowerCase().startsWith(stt.language.toLowerCase())
  const sttShown = sttMismatch ? { state: 'error' as const, error: `the loaded speech model is for "${stt.language}", not this call's language` } : stt
  const sttReady = stt.state === 'listening' && !sttMismatch
  const activeMs = s ? s.activeMs + (s.liveSince ? now - s.liveSince : 0) : 0
  const generating = answers.some((a) => a.status === 'streaming')

  if (!s) {
    return (
      <div className={cn(isElectron && 'p-2')}>
        <div className="glass flex h-10 w-(--tk-layout-livebar-w) max-w-[calc(100vw-16px)] items-center gap-2 rounded-lg px-3 text-sm text-glass-text-muted">
          {session.error ? `Couldn't open this call: ${errorText(session.error)}` : (<><Spinner glass /> Opening the call…</>)}
        </div>
      </div>
    )
  }

  return (
    <div className={cn(isElectron && 'p-2')}>
      <div
        ref={setFrameEl}
        className={cn(
          '@container relative flex w-(--tk-layout-livebar-w) min-w-0 flex-col gap-1 transform-[translateZ(0)]',
          !isElectron && 'max-w-[calc(100vw-16px)]',
          dialog && 'min-h-(--tk-layout-answer-panel-h)',
          // room for the whole two-pane modal (its 16px inset on each side), so the Format pane doesn't scroll
          dialog === 'prefs' && 'min-h-[calc(var(--tk-layout-modal-two-pane-h)+32px)]',
        )}
      >
        <PortalContext.Provider value={frameEl}>
          <h1 className="sr-only">Live call{s.companyName ? ` with ${s.companyName}` : ''}</h1>
          <div
            ref={barRef}
            role="toolbar"
            aria-label="Call controls"
            className={cn('glass drag flex h-(--tk-size-livebar-h) min-w-0 items-center gap-1 rounded-lg px-1.5', !isElectron && 'cursor-grab')}
            {...drag}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
              const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),[role="combobox"]')]
              const i = items.indexOf(document.activeElement as HTMLElement)
              if (i < 0) return
              e.preventDefault()
              items[(i + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length]?.focus()
            }}
          >
            <DevicePicker
              icon={<Mic size={14} />}
              label="Microphone"
              level={levels.you}
              live={sttReady}
              error={capture.current?.errors.you}
              value={mic}
              options={mics.length ? mics : [{ value: 'default', label: 'System default' }]}
              onChange={setMic}
            />
            <DevicePicker
              icon={<Volume2 size={14} />}
              label="Call audio"
              level={levels.them}
              live={sttReady}
              error={capture.current?.errors.them}
              value="loopback"
              options={[{ value: 'loopback', label: 'Speakers (everything this PC plays)' }]}
              onChange={() => {}}
            />
            {stt.state === 'error' ? (
              <GlassChip
                label="Restart transcription"
                icon={<RotateCw size={14} />}
                onClick={() => {
                  setStt({ state: 'starting' })
                  void api.sessions.start({ id }).catch((e) => toast({ text: errorText(e), tone: 'error' }))
                }}
              />
            ) : (
              <>
                <Tooltip content={sttReady ? 'Answer the latest question' : 'Waiting for the speech model'}>
                  <GlassChip label="Answer" accel={hotkeys.answer} hideKeys={tightBar} icon={<Sparkles size={14} />} flash={flash === 'answer'} busy={generating} onClick={() => runAction('answer')} disabled={stt.state === 'starting'} />
                </Tooltip>
                <Tooltip content={visionOk ? 'Answer from what is on your screen' : `Add a key for ${modelLabel(settings.data?.visionModel ?? '')} to use this`}>
                  <GlassChip label="Screenshot" accel={hotkeys.screenshot} hideKeys={tightBar} icon={<Camera size={14} />} flash={flash === 'screenshot'} onClick={() => runAction('screenshot')} aria-disabled={!visionOk || undefined} disabled={!visionOk} />
                </Tooltip>
                <GlassChip label="Chat" accel={hotkeys.chat} hideKeys={tightBar} icon={<MessageSquareText size={14} />} flash={flash === 'chat'} onClick={() => runAction('chat')} />
                {s.type === 'mock' && (
                  <GlassChip
                    label="Next question"
                    icon={<Bot size={14} />}
                    onClick={() => void api.mock.nextQuestion({ sessionId: id }).catch((e) => toast({ text: errorText(e), tone: 'error' }))}
                    disabled={!sttReady || !!partial}
                  />
                )}
              </>
            )}
            <span className="flex-1" />
            <GateChip gate={gate} stt={stt} autoOn={s.autoGenerate} />
            {hotkeyFails.length > 0 && (
              <Tooltip content={`Another app already uses: ${hotkeyFails.map((a) => hotkeys[a as HotkeyAction]).join(', ')}. Change them in Settings.`}>
                <span tabIndex={0} aria-label={`${hotkeyFails.length} shortcuts unavailable`} className="on-glass flex size-7 items-center justify-center text-glass-highlight">
                  <TriangleAlert size={16} />
                </span>
              </Tooltip>
            )}
            <MoveButton glass />
            <HideButton glass privateOn={settings.data?.privateMode} />
            <Tooltip content="Call time">
              <span role="timer" aria-live="off" aria-label={`Call time ${clock(activeMs)}`} tabIndex={0} className="on-glass glass-chip flex h-6 items-center rounded-pill px-1.5 font-mono text-2xs">
                {clock(activeMs)}
              </span>
            </Tooltip>
            <MoreMenu glass>
              <MenuItem icon={<Sparkles size={16} />} onSelect={() => setDialog('prefs')}>
                Answer preferences
              </MenuItem>
              <MenuItem icon={<WandSparkles size={16} />} onSelect={() => setDialog('instructions')}>
                AI instructions
              </MenuItem>
              <MenuSeparator />
            </MoreMenu>
            <IconButton label="End call" tone="glass-danger" className="w-auto! px-2.5 text-sm font-semibold" onClick={() => setDialog('end')}>
              End
            </IconButton>
          </div>

          <TranscriptStrip
            lines={lines}
            partial={partial}
            stt={sttShown}
            level={Math.max(levels.you, levels.them)}
            expanded={expanded}
            onToggle={() => setExpanded((v) => !v)}
            onClear={() => void clearTranscript()}
            clearAccel={hotkeys.clear_transcript}
          />

          {chat.open && (
            <form
              className="glass flex items-center gap-1.5 rounded-lg p-1.5"
              onSubmit={(e) => {
                e.preventDefault()
                const t = chat.text.trim()
                if (!t) return
                void generate('chat', t)
                setChat({ open: false, text: '' })
              }}
            >
              <label htmlFor="chat-input" className="sr-only">
                Type a question
              </label>
              <input
                id="chat-input"
                ref={chatRef}
                value={chat.text}
                maxLength={4000}
                onChange={(e) => setChat({ open: true, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setChat({ open: false, text: '' })
                }}
                placeholder="Type a question and press Enter"
                className="on-glass glass-chip h-9 min-w-0 flex-1 rounded-md border border-glass-border px-3 text-sm text-glass-text placeholder:text-glass-text-muted"
              />
              <IconButton label="Send" tone="glass" size="md" type="submit" disabled={!chat.text.trim()}>
                <Send size={16} />
              </IconButton>
              <IconButton label="Close chat" tone="glass" size="md" onClick={() => setChat({ open: false, text: '' })}>
                <X size={16} />
              </IconButton>
            </form>
          )}

          <div className="flex justify-start">
            <AnswerPanel
              answers={answers}
              index={Math.min(index, Math.max(0, answers.length - 1))}
              cleared={cleared}
              hotkeys={hotkeys}
              onPrev={() => runAction('history_prev')}
              onNext={() => runAction('history_next')}
              onClear={() => setCleared(true)}
              onStop={(answerId) => void api.answers.cancel({ answerId })}
              onRetry={(a) => void generate(a.trigger === 'auto' ? 'answer' : a.trigger, a.userPrompt ?? undefined, { retryOf: a.id })}
              fallbackLabel={fallback?.label ?? null}
              onFallback={
                fallback
                  ? (a) => {
                      void api.sessions.update({ id, patch: { model: fallback.id } }).then(() => generate(a.trigger === 'auto' ? 'answer' : a.trigger, a.userPrompt ?? undefined, { retryOf: a.id }))
                    }
                  : null
              }
              onAnswerWithFallback={(a) => void generate(a.trigger === 'auto' ? 'answer' : a.trigger, a.userPrompt ?? undefined, { retryOf: a.id, useFallback: true })}
              onFollowUp={(a) => openChat(`About "${a.question ?? 'that'}": `)}
            />
          </div>

          <EndDialog open={dialog === 'end'} onOpenChange={(v) => setDialog(v ? 'end' : null)} onChoose={end} />
          <AnswerPrefsModal
            midCall
            open={dialog === 'prefs'}
            onOpenChange={(v) => setDialog(v ? 'prefs' : null)}
            value={s.answerPrefs}
            onSave={async (answerPrefs) => {
              await api.sessions.update({ id, patch: { answerPrefs } })
            }}
          />
          <InstructionsModal
            open={dialog === 'instructions'}
            onOpenChange={(v) => setDialog(v ? 'instructions' : null)}
            value={s.instructions}
            onSave={async (instructions) => {
              await api.sessions.update({ id, patch: { instructions } })
            }}
          />
          <Toaster className="mt-1" />
        </PortalContext.Provider>
      </div>
    </div>
  )
}

function DevicePicker({
  icon,
  label,
  level,
  live,
  error,
  value,
  options,
  onChange,
}: {
  icon: React.ReactNode
  label: string
  level: number
  live: boolean
  error?: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (v: string) => void
}) {
  const receiving = level > 0.08
  return (
    <div className="relative w-14 shrink-0">
      <Select
        glass
        size="sm"
        menuWidth="auto"
        ariaLabel={`${label}, ${error ? error : receiving ? 'receiving audio' : 'no audio'}`}
        value={value}
        onChange={onChange}
        options={options}
        triggerIcon={
          <span className="flex items-center gap-1">
            <span className={error ? 'text-glass-highlight' : undefined}>{icon}</span>
            <LevelMeter level={level} live={live && !error} />
          </span>
        }
        placeholder=""
        hideChevron
        className="px-1.5 [&>span:nth-child(2)]:hidden"
      />
      {error && <span aria-hidden className="absolute top-0.5 right-0.5 size-1.5 rounded-pill bg-glass-danger" />}
    </div>
  )
}
