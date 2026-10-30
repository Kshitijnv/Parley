import { useState } from 'react'
import { ArrowDown, ArrowUp, Check, ExternalLink, KeyRound, Trash2 } from 'lucide-react'
import type { Settings, SpeechKey } from '@shared/types'
import { api } from '@renderer/api'
import { Button } from '@renderer/components/ui/button'
import { Callout, SkeletonLines, Tag } from '@renderer/components/ui/feedback'
import { Switch, TextInput } from '@renderer/components/ui/form'
import { ConfirmDialog, toast } from '@renderer/components/ui/overlays'
import { dateTime, duration, errorText } from '@renderer/lib/format'
import { useQuery } from '@renderer/lib/hooks'

const STATE: Record<SpeechKey['state'], string> = {
  unchecked: 'Not checked',
  ok: 'Working',
  rate_limited: 'Busy: waiting',
  quota_exhausted: 'Used up',
  auth_failed: 'Rejected',
}

const PORTAL = 'https://portal.speechmatics.com/'

/** Settings › Cloud speech (architecture.md revision 7 S6): opt-in Speechmatics for the other side of the call. */
export function CloudSpeech({ settings, update }: { settings: Settings; update: (p: Partial<Settings>) => Promise<void> }) {
  const keys = useQuery(() => api.speechKeys.list(), [], ['speechKeys'])
  const [consent, setConsent] = useState(false)
  const c = settings.cloudStt
  const list = keys.data ?? []
  const working = list.some((k) => k.state === 'ok' || k.state === 'unchecked')

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-base font-medium">Use cloud speech for the other side</p>
          <p id="cloud-hint" className="text-xs text-text-muted">
            {c.enabled
              ? working
                ? 'On. Calls start on local text and switch to Speechmatics within a few seconds. If it drops, local text takes over within a second.'
                : 'On, but no key is working, so calls use local speech. Add or check a key below.'
              : 'Off. Everything is transcribed on this PC. Turn on for faster, more accurate text of the other side, using your own Speechmatics keys.'}
          </p>
        </div>
        <Switch
          id="cloud-stt"
          label="Use cloud speech for the other side"
          describedBy="cloud-hint"
          checked={c.enabled}
          onCheckedChange={(on) => {
            if (on && c.consentedAt === null) setConsent(true)
            else void update({ cloudStt: { ...c, enabled: on } })
          }}
        />
      </div>

      {keys.loading && !keys.data ? (
        <SkeletonLines lines={2} />
      ) : (
        <>
          {list.length > 0 && (
            <ol className="divide-y divide-border rounded-md border border-border" aria-label="Speechmatics keys, in the order they're tried">
              {list.map((k, i) => (
                <SpeechKeyRow key={k.id} k={k} first={i === 0} last={i === list.length - 1} />
              ))}
            </ol>
          )}
          {list.length < 5 && <AddKey count={list.length} />}
        </>
      )}
      <p className="text-xs text-text-subtle">
        Keys are tried in this order: when one is rejected, busy or used up during a call, the next takes over and the words spoken during the switch are sent again. The minutes shown are Parley's own count; Speechmatics' portal shows what you're billed.{' '}
        <a href={PORTAL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
          Open the Speechmatics portal <ExternalLink size={12} aria-hidden />
        </a>
      </p>

      <ConfirmDialog
        open={consent}
        onOpenChange={setConsent}
        title="Send the other side's audio to Speechmatics?"
        body={
          <span className="space-y-2">
            <span className="block">
              While a call is live, the audio of the other side, and words from your resume and job description (to spell names and tech terms right), are sent to Speechmatics to be transcribed. Your microphone stays on this PC.
            </span>
            <span className="block">Speechmatics bills your account for minutes beyond any free usage. You can turn this off at any time.</span>
          </span>
        }
        confirmLabel="Turn on cloud speech"
        onConfirm={async () => {
          await api.settings.update({ cloudStt: { ...c, enabled: true, consentedAt: Date.now() } })
        }}
      />
    </div>
  )
}

function usage(k: SpeechKey): string {
  const month = `This month: ${duration(k.usedMs)} streamed`
  if (k.budgetMs === null) return month
  return `${month} · ${duration(k.usedTotalMs)} of ${duration(k.budgetMs)} budget used`
}

function SpeechKeyRow({ k, first, last }: { k: SpeechKey; first: boolean; last: boolean }) {
  const [busy, setBusy] = useState<null | 'test' | 'move'>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [budget, setBudget] = useState(k.budgetMs === null ? '' : String(Math.round((k.budgetMs / 3_600_000) * 10) / 10))
  const name = k.label || `Key ${k.position}`
  const waiting = k.stateUntil && k.stateUntil > Date.now() ? ` until ${dateTime(k.stateUntil)}` : ''

  const test = async () => {
    setBusy('test')
    setResult(null)
    const r = await api.speechKeys.test({ id: k.id }).catch((e) => ({ ok: false, error: errorText(e) }))
    setResult(r.ok ? { ok: true, text: 'Working.' } : { ok: false, text: r.error ?? 'The key did not work.' })
    setBusy(null)
  }
  const move = async (by: -1 | 1) => {
    setBusy('move')
    await api.speechKeys.move({ id: k.id, by }).catch((e) => toast({ text: errorText(e), tone: 'error' }))
    setBusy(null)
  }
  const saveBudget = async () => {
    const v = budget.trim() === '' ? null : Number(budget)
    if (v !== null && !(v >= 0.1)) return setResult({ ok: false, text: 'Enter the hours as a number, like 8.' })
    await api.speechKeys.update({ id: k.id, budgetHours: v }).catch((e) => setResult({ ok: false, text: errorText(e) }))
  }

  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <KeyRound size={16} className="text-text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-base font-medium">
            <span className="text-text-subtle">{k.position}.</span>
            <span className="truncate">{name}</span>
            <Tag className={k.state === 'auth_failed' || k.state === 'quota_exhausted' ? 'text-danger-text' : undefined}>
              {STATE[k.state]}
              {waiting}
            </Tag>
          </p>
          <p className="text-xs text-text-subtle">
            Key ending {k.last4} · {usage(k)}
            {k.verifiedAt ? ` · checked ${dateTime(k.verifiedAt)}` : ''}
          </p>
        </div>
        <Button size="sm" variant="ghost" icon={<ArrowUp size={14} />} disabled={first || busy !== null} onClick={() => void move(-1)} aria-label={`Move ${name} up`} />
        <Button size="sm" variant="ghost" icon={<ArrowDown size={14} />} disabled={last || busy !== null} onClick={() => void move(1)} aria-label={`Move ${name} down`} />
        <Button size="sm" variant="ghost" onClick={() => void test()} loading={busy === 'test'} busyLabel="Checking…">
          {k.state === 'quota_exhausted' || k.state === 'rate_limited' || k.state === 'auth_failed' ? 'Try again' : 'Check'}
        </Button>
        <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => setConfirm(true)} aria-label={`Remove ${name}`}>
          Remove
        </Button>
      </div>
      <form
        className="flex flex-wrap items-center gap-2 pl-7"
        onSubmit={(e) => {
          e.preventDefault()
          void saveBudget()
        }}
      >
        <label htmlFor={`budget-${k.id}`} className="text-xs text-text-muted">
          Hours this key's credit covers (optional)
        </label>
        <TextInput id={`budget-${k.id}`} inputMode="decimal" className="w-20" placeholder="e.g. 8" value={budget} onChange={(e) => setBudget(e.target.value)} onBlur={() => void saveBudget()} />
      </form>
      {result && (
        <p role="status" className={result.ok ? 'pl-7 text-xs text-success' : 'pl-7 text-xs text-danger-text'}>
          {result.ok && <Check size={12} className="mr-1 inline" aria-hidden />}
          {result.text}
        </p>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Remove ${name}?`}
        body="Parley forgets this key. The Speechmatics account and its credit aren't affected."
        confirmLabel="Remove key"
        busyLabel="Removing…"
        danger
        onConfirm={async () => {
          await api.speechKeys.remove({ id: k.id })
        }}
      />
    </li>
  )
}

function AddKey({ count }: { count: number }) {
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const [label, setLabel] = useState('')
  const [hours, setHours] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const save = async () => {
    setBusy(true)
    setResult(null)
    try {
      const h = hours.trim() === '' ? null : Number(hours)
      if (h !== null && !(h >= 0.1)) throw new Error('Enter the hours as a number, like 8.')
      const r = await api.speechKeys.add({ key: key.trim(), label: label.trim(), budgetHours: h })
      setKey('')
      setLabel('')
      setHours('')
      setOpen(false)
      setResult(r.test.ok ? { ok: true, text: 'Saved and working.' } : { ok: false, text: `Saved, but the check failed: ${r.test.error ?? 'the key did not work.'}` })
    } catch (e) {
      setResult({ ok: false, text: errorText(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      {open ? (
        <form
          className="space-y-2 rounded-md border border-border px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="sm-key" className="sr-only">
              Speechmatics API key
            </label>
            <TextInput id="sm-key" type="password" autoComplete="off" autoFocus className="min-w-60 flex-1" placeholder="Paste the Speechmatics API key" value={key} onChange={(e) => setKey(e.target.value)} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="sm-label" className="sr-only">
              Label
            </label>
            <TextInput id="sm-label" className="w-48" maxLength={40} placeholder={`Label (e.g. Key ${count + 1})`} value={label} onChange={(e) => setLabel(e.target.value)} />
            <label htmlFor="sm-hours" className="sr-only">
              Hours this key's credit covers
            </label>
            <TextInput id="sm-hours" inputMode="decimal" className="w-36" placeholder="Hours (optional)" value={hours} onChange={(e) => setHours(e.target.value)} />
            <Button type="submit" size="md" variant="primary" disabled={key.trim().length < 16} loading={busy} busyLabel="Saving…">
              Save and check
            </Button>
            <Button size="md" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
          <p className="text-xs text-text-subtle">With the hours filled in, a key with less than an hour left is skipped when a call starts, so it runs out between calls rather than during one.</p>
        </form>
      ) : (
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          {count ? 'Add another key' : 'Add a Speechmatics key'}
        </Button>
      )}
      {result && (
        <p role="status" className={result.ok ? 'text-xs text-success' : 'text-xs text-danger-text'}>
          {result.ok && <Check size={12} className="mr-1 inline" aria-hidden />}
          {result.text}
        </p>
      )}
      {count === 0 && !open && (
        <Callout tone="info">
          Create a key in the Speechmatics portal (Settings › API keys). It's encrypted on this PC and only the last 4 characters are shown again.
        </Callout>
      )}
    </div>
  )
}
