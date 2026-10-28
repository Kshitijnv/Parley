// One reducer for every answer event (architecture.md revision 2 §7): upsert on
// answer:start (so automatic answers appear while they stream), apply deltas by
// offset, resync through answers:get on a gap, ignore late events for finished
// answers, and reload streaming text after a renderer reload.
import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { Answer } from '@shared/types'
import type { ApiEvents, AnswerStartEvent } from '@shared/api'
import { api } from '@renderer/api'
import { useEvent } from '@renderer/lib/hooks'
import type { AnswerView } from './AnswerPanel'

type State = Record<string, AnswerView>

type Action =
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

function reduce(s: State, a: Action): State {
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
      if (d.part === 'question') return { ...s, [d.answerId]: { ...v, question: d.text } }
      // Offset rules: equal -> append; smaller -> append only the new part; larger -> gap.
      if (d.offset === undefined || d.offset === v.md.length) return { ...s, [d.answerId]: { ...v, md: v.md + d.text } }
      if (d.offset < v.md.length) {
        const extra = d.text.slice(v.md.length - d.offset)
        return extra ? { ...s, [d.answerId]: { ...v, md: v.md + extra } } : s
      }
      return { ...s, [d.answerId]: { ...v, needsResync: true } }
    }
    case 'done':
      return { ...s, [a.a.id]: toView(a.a) }
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
      return { ...s, [a.r.answerId]: { ...v, servedModel: a.r.servedModel, fallbackReason: a.r.reason } }
    }
    case 'resync': {
      const v = toView(a.a, a.a.liveText)
      return { ...s, [a.a.id]: { ...v, question: v.question ?? s[a.a.id]?.question ?? null } }
    }
  }
}

/** The session's answers, ordered by seq. The newest seq is the current answer. */
export function useAnswerStore(sessionId: string) {
  const [state, dispatch] = useReducer(reduce, {})
  const ref = useRef(state)
  ref.current = state
  const syncing = useRef(new Set<string>())

  const resync = useCallback((answerId: string) => {
    if (syncing.current.has(answerId)) return
    syncing.current.add(answerId)
    void api.answers
      .get({ answerId })
      .then((a) => {
        if (a.sessionId === sessionId) dispatch({ type: 'resync', a })
      })
      .catch(() => {})
      .finally(() => syncing.current.delete(answerId))
  }, [sessionId])

  useEffect(() => {
    void api.answers.list({ sessionId }).then((list) => {
      dispatch({ type: 'load', list })
      for (const a of list) if (a.status === 'streaming') resync(a.id)
    })
  }, [sessionId, resync])

  useEvent('answer:start', (e) => {
    if (e.sessionId === sessionId) dispatch({ type: 'start', e })
  })
  useEvent('answer:delta', (d) => {
    if (d.sessionId && d.sessionId !== sessionId) return
    // A delta for an answer this window never saw start: fetch it.
    if (!ref.current[d.answerId]) {
      if (d.sessionId === sessionId) resync(d.answerId)
      return
    }
    dispatch({ type: 'delta', d })
  })
  useEvent('answer:route', (r) => {
    if (r.sessionId === sessionId) dispatch({ type: 'route', r })
  })
  useEvent('answer:done', (a) => {
    if (a.sessionId === sessionId) dispatch({ type: 'done', a })
  })
  useEvent('answer:error', (e) => {
    if (e.sessionId && e.sessionId !== sessionId) return
    dispatch({ type: 'error', e })
  })

  useEffect(() => {
    for (const v of Object.values(state)) if (v.needsResync) resync(v.id)
  }, [state, resync])

  const answers = Object.values(state).sort((a, b) => a.seq - b.seq)
  return { answers }
}
