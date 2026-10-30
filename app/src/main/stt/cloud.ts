// Wires the cloud speech pool to Parley (architecture.md revision 7 S2–S6): the saved
// settings and consent, the session's vocabulary, the key store and the logger.
// Returns null when cloud speech isn't on, so the call stays fully local.
import { getSettings, requireSession } from '../db/repo'
import { contextFor } from '../ai/engine'
import { providerFetch } from '../ai/transport'
import { isDev } from '../env'
import { log } from '../log'
import { addSpeechUsage, keyTestUrl, markSpeechKey, usableSpeechKeys } from './keys'
import { CloudLane, type PoolEvents, type PoolTiming } from './pool'
import { SM_DEFAULT_URL, testSpeechmaticsKey } from './speechmatics'
import { buildVocab } from './vocab'

/** Development builds only: a local fake server for the e2e tests (S7). */
const devUrl = (name: string) => (isDev ? process.env[name] : undefined)

/** Whether a call started now would try cloud speech (switch on, consent given). */
export function cloudWanted(): boolean {
  const c = getSettings().cloudStt
  return c.enabled && c.consentedAt !== null
}

export async function createCloudLane(sessionId: string, events: PoolEvents): Promise<CloudLane | null> {
  if (!cloudWanted()) return null
  const c = getSettings().cloudStt
  const s = requireSession(sessionId)
  const minLeftMs = c.minLeftMin * 60_000
  // Only the first key choice of a call honours the budget margin; a mid-call switch takes any key.
  if (!(await usableSpeechKeys(minLeftMs)).length && !(await usableSpeechKeys(0)).length) {
    log('stt_connect', { sessionId, outcome: 'no_key' })
    return null
  }
  let first = true
  const vocab = c.vocab ? buildVocab(contextFor(s)) : []
  const testTiming = devUrl('PARLEY_SPEECHMATICS_TIMING')
  const lane = new CloudLane(
    {
      config: { url: devUrl('PARLEY_SPEECHMATICS_URL') ?? SM_DEFAULT_URL, language: s.language.slice(0, 2).toLowerCase(), maxDelayS: c.maxDelayS, eouSilenceS: c.eouSilenceS, vocab },
      usableKeys: async () => {
        const withMargin = first ? await usableSpeechKeys(minLeftMs) : []
        return withMargin.length ? withMargin : usableSpeechKeys(0)
      },
      mark: markSpeechKey,
      addUsage: addSpeechUsage,
      testKey: async (key) => (await testSpeechmaticsKey(key, providerFetch, keyTestUrl())).result,
      log: (event, fields) => log(event, { sessionId, ...fields }),
      timing: testTiming ? (JSON.parse(testTiming) as Partial<PoolTiming>) : undefined,
    },
    {
      ...events,
      state: (up, slot) => {
        if (up) first = false
        events.state(up, slot)
      },
    },
  )
  lane.start()
  return lane
}
