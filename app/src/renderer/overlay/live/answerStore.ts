// One reducer for every answer event (architecture.md revision 2 §7): upsert on
// answer:start (so automatic answers appear while they stream), apply deltas by
// offset, resync through answers:get on a gap, ignore late events for finished
// answers, and reload streaming text after a renderer reload.
import { useCallback, useEffect, useReducer, useRef } from 'react'
import { api } from '@renderer/api'
import { useEvent } from '@renderer/lib/hooks'
import { reduce } from './answerReduce'

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
