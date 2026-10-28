// The answer-event reducer (architecture.md revision 2 §7, revision 5 D4), kept free of
// React and the api so it can be unit-tested. Rules: upsert on answer:start; apply deltas
// by offset (equal → append, smaller → append only the new part, larger → gap: resync);
// drop deltas from an older provider attempt and for finished answers; on answer:done keep
// the streamed text when it matches the row, so finalizing doesn't re-mount the blocks.
import type { Answer } from '@shared/types'
import type { ApiEvents, AnswerStartEvent } from '@shared/api'
import type { AnswerView } from './AnswerPanel'

export type State = Record<string, AnswerView>

export type Action =
  | { type: 'load'; list: Answer[] }
  | { type: 'start'; e: AnswerStartEvent }
  | { type: 'delta'; d: ApiEvents['answer:delta'] }
  | { type: 'done'; a: Answer }
  | { type: 'error'; e: ApiEvents['answer:error'] }
  | { type: 'resync'; a: Answer & { liveText?: string } }
  | { type: 'route'; r: ApiEvents['answer:route'] }

export function toView(a: Answer, liveText?: string): AnswerView {
  return {
    id: a.id,
    seq: a.seq,
    trigger: a.trigger,
    userPrompt: a.userPrompt,
    question: a.question,
    md: a.status === 'streaming' ? (liveText ?? a.answerMd) : a.answerMd,
    status: a.status,
    error: a.error,
    code: a.status === 'failed' ? (a.endReason === 'interrupted' ? 'interrupted' : a.endReason === 'quota_exhausted' ? 'quota_exhausted' : a.endReason === 'rate_limited' ? 'rate_limited' : a.endReason === 'overloaded' ? 'overloaded' : 'provider_error') : undefined,
    createdAt: a.createdAt,
    firstTokenMs: a.firstTokenMs,
    servedModel: a.servedModel ?? null,
    fallbackReason: a.fallbackReason ?? null,
  }
}

const finished = (v: AnswerView | undefined) => !!v && v.status !== 'streaming'

export function reduce(s: State, a: Action): State {
  switch (a.type) {
    case 'load': {
      const next = { ...s }
      for (const x of a.list) if (x.status !== 'failed' || x.error) next[x.id] = toView(x)
      return next
    }
    case 'start': {
      const e = a.e
      if (s[e.answerId]) return s
      return { ...s, [e.answerId]: { id: e.answerId, seq: e.seq, trigger: e.trigger, userPrompt: e.trigger === 'chat' ? e.questionDraft : null, question: e.trigger === 'chat' ? e.questionDraft : null, draft: e.questionDraft, md: '', status: 'streaming', createdAt: e.createdAt } }
    }
    case 'delta': {
      const d = a.d
      const v = s[d.answerId]
      if (!v || finished(v)) return s
      // Revision 5 D4: text from an older provider attempt never mixes into the served one.
      // A switch happens only before any text (A4.3), so this should never fire.
      if (d.attempt !== undefined && v.attempt !== undefined && d.attempt < v.attempt) return s
      const w = d.attempt !== undefined && d.attempt !== v.attempt ? { ...v, attempt: d.attempt } : v
      if (d.part === 'question') return { ...s, [d.answerId]: { ...w, question: d.text } }
      // Offset rules: equal -> append; smaller -> append only the new part; larger -> gap.
      if (d.offset === undefined || d.offset === w.md.length) return { ...s, [d.answerId]: { ...w, md: w.md + d.text } }
      if (d.offset < w.md.length) {
        const extra = d.text.slice(w.md.length - d.offset)
        return extra ? { ...s, [d.answerId]: { ...w, md: w.md + extra } } : w === v ? s : { ...s, [d.answerId]: w }
      }
      return { ...s, [d.answerId]: { ...w, needsResync: true } }
    }
    case 'done': {
      const next = toView(a.a)
      const v = s[a.a.id]
      // The row is authoritative. When it matches what streamed, keep the same string so the
      // memoized blocks don't re-render; only status, timing and the caret change.
      if (v && v.md.trim() === next.md.trim()) return { ...s, [a.a.id]: { ...next, md: v.md } }
      return { ...s, [a.a.id]: next }
    }
    case 'error': {
      const e = a.e
      const v = s[e.answerId]
      if (!v || finished(v)) return s
      const md = e.partial && e.partial.length > v.md.length ? e.partial : v.md
      return {
        ...s,
        [e.answerId]: { ...v, md, status: e.code === 'cancelled' ? 'cancelled' : 'failed', code: e.code, error: e.code === 'cancelled' ? null : e.message, retryAt: e.retryAt ?? (e.retryAfterS ? Date.now() + e.retryAfterS * 1000 : undefined), fallbackOffer: e.fallbackModel },
      }
    }
    case 'route': {
      const v = s[a.r.answerId]
      if (!v || finished(v)) return s
      return { ...s, [a.r.answerId]: { ...v, servedModel: a.r.servedModel, fallbackReason: a.r.reason, attempt: a.r.attempt } }
    }
    case 'resync': {
      const v = toView(a.a, a.a.liveText)
      return { ...s, [a.a.id]: { ...v, question: v.question ?? s[a.a.id]?.question ?? null, attempt: s[a.a.id]?.attempt } }
    }
  }
}
