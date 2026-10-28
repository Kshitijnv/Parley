import type { GateReason, GateStatus, SttStatus } from '@shared/types'
import { modelLabel } from '@shared/catalog'
import { cn } from '@renderer/components/ui/cn'
import { Tooltip } from '@renderer/components/ui/overlays'
import { useNow } from '@renderer/lib/hooks'

const AUTO_LABEL: Record<GateStatus['auto'], string> = {
  on: 'Auto',
  off: 'Auto off',
  cooldown: 'Auto · wait',
  queued: 'Queued',
  paused_budget: 'Auto paused',
  paused_quota: 'Quota used',
  paused_auth: 'Key rejected',
  paused_offline: 'Offline',
}

const AUTO_HELP: Record<GateStatus['auto'], string> = {
  on: 'Automatic answers are on: a finished question from the other side gets one answer.',
  off: 'Automatic answers are off for this call. Press Answer when you need one.',
  cooldown: 'Automatic answers are on, waiting out the gap between answers.',
  queued: 'A question is queued and will be answered when the current answer finishes.',
  paused_budget: "Automatic answers paused: this call reached its automatic-answer budget. Manual Answer still works.",
  paused_quota: "The model's daily quota is used up. Switch model in the ⋮ menu or Settings.",
  paused_auth: 'The provider rejected the API key. Auto answers wait for a working key: replace it in Settings, or switch model in the ⋮ menu.',
  paused_offline: 'No connection. Automatic answers resume after the next successful request.',
}

const REASON: Record<GateReason, string> = {
  not_live: 'call not live',
  quota_exhausted: 'daily quota used up',
  auth_failed: 'key rejected',
  cooling: 'rate limited',
  offline: 'offline',
  joined: 'already answering it',
  duplicate: 'already answered',
  no_new_material: 'nothing new said',
  auto_off: 'auto off',
  rate_cap: 'per-minute cap',
  budget: 'call budget used',
  stale: 'question too old',
  too_soon: 'pressed twice',
  merged: 'combined with the next question',
  replaced: 'too many questions waiting',
  session_end: 'call ended',
}

/** A merged / skipped notice stays in the label this long after it happens. */
const NOTICE_MS = 10_000

/** Live bar status chip driven by gate:status (architecture.md revision 2 §8, revision 4 A1–A4). */
export function GateChip({ gate, stt, autoOn }: { gate: GateStatus | null; stt: SttStatus; autoOn: boolean }) {
  const now = useNow(1000)
  const auto = gate?.auto ?? (autoOn ? 'on' : 'off')
  const coolingFor = gate?.provider === 'cooling' && gate.retryAt ? Math.max(0, Math.ceil((gate.retryAt - now) / 1000)) : 0
  const waitingFor = gate?.waiting ? Math.max(0, Math.floor((now - gate.waiting.since) / 1000)) : 0
  const last = gate?.last && now - gate.last.at < NOTICE_MS ? gate.last : null
  const skipped = last && (last.outcome === 'replaced' || (last.outcome === 'suppressed' && last.reason === 'stale'))
  const label =
    coolingFor > 0
      ? `Wait ${coolingFor}s`
      : gate?.waiting
        ? `Waiting for ${modelLabel(gate.waiting.model)}… ${waitingFor} s`
        : last?.outcome === 'merged'
          ? `${last.count ?? 2} questions combined`
          : skipped
            ? 'Skipped 1 question'
            : AUTO_LABEL[auto]
  const warn = coolingFor > 0 || auto.startsWith('paused') || !!skipped
  const lines = [
    coolingFor > 0
      ? `The model is rate limited: requests resume in ${coolingFor} s.`
      : gate?.waiting
        ? `${modelLabel(gate.waiting.model)} hasn't started answering yet. The delay is on the provider's side; press Answer to ask again, or switch model in the ⋮ menu.`
        : AUTO_HELP[auto],
    gate?.route === 'fallback' ? 'Answers use your fallback model while this key is rejected.' : null,
    skipped ? 'A question waited too long and was skipped. Press Answer to answer what was said.' : null,
    gate
      ? `This call: ${gate.counts.auto} automatic · ${gate.counts.manual} manual · ${gate.counts.suppressed} skipped${gate.counts.merged ? ` · ${gate.counts.merged} combined` : ''}${gate.counts.replaced ? ` · ${gate.counts.replaced} replaced` : ''}.`
      : null,
    gate?.last?.outcome === 'suppressed' && gate.last.reason ? `Last skipped: ${REASON[gate.last.reason] ?? 'skipped'}.` : null,
    stt.modelId ? `Speech: ${stt.language ?? '?'} · ${stt.modelId}${stt.loadMs !== undefined ? ` · loaded in ${(stt.loadMs / 1000).toFixed(1)} s` : ''}` : null,
  ].filter(Boolean)
  return (
    <Tooltip content={lines.join('\n')}>
      <span
        tabIndex={0}
        role="status"
        aria-label={`${label}. ${lines.join(' ')}`}
        className={cn('on-glass glass-chip flex h-6 shrink-0 items-center rounded-pill px-2 text-2xs whitespace-nowrap', warn ? 'text-glass-highlight' : 'text-glass-text-muted')}
      >
        {label}
      </span>
    </Tooltip>
  )
}
