// Cloud speech (architecture.md revision 7): the pool against a fake Speechmatics server
// (S8 SM-05, SM-06, SM-07 and the error mapping of S4.3), the start message, the ring
// buffer and the vocabulary builder (SM-04's input). No real network, no Electron.
import { expect, test } from '@playwright/test'
import { CHUNK, FakeSpeechmatics, sentence, type KeyBehaviour } from '../fake-speechmatics'
import { CloudLane, type KeyMark, type PoolKey } from '../../src/main/stt/pool'
import { AudioRing } from '../../src/main/stt/ring'
import { classify, joinText, startMessage, testSpeechmaticsKey } from '../../src/main/stt/speechmatics'
import { buildVocab, VOCAB_MAX } from '../../src/main/stt/vocab'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(cond: () => boolean, ms = 5000) {
  const t = Date.now()
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error('timed out')
    await sleep(5)
  }
}

interface Rig {
  fake: FakeSpeechmatics
  lane: CloudLane
  finals: string[]
  states: Array<{ up: boolean; slot?: number }>
  marks: Array<{ slot: number; state: KeyMark; errorType: string | null }>
  usage: Map<string, number>
  logs: Array<{ event: string; fields: Record<string, unknown> }>
  feed(chunks: Int16Array[], everyMs?: number): Promise<void>
}

async function rig(behaviours: KeyBehaviour[], opts: { vocab?: boolean } = {}): Promise<Rig> {
  const fake = await new FakeSpeechmatics().listen()
  const keys: PoolKey[] = behaviours.map((b, i) => ({ id: `id${i + 1}`, slot: i + 1, key: `key-${i + 1}-abcdefghijklmnop` }))
  behaviours.forEach((b, i) => {
    fake.keys.set(keys[i]!.key, b)
    if (b.refuse !== 401) fake.valid.add(keys[i]!.key)
  })
  const blocked = new Set<string>()
  const r: Rig = {
    fake,
    finals: [],
    states: [],
    marks: [],
    usage: new Map(),
    logs: [],
    lane: null as unknown as CloudLane,
    async feed(chunks, everyMs = 2) {
      for (const c of chunks) {
        r.lane.push(c)
        await sleep(everyMs)
      }
    },
  }
  r.lane = new CloudLane(
    {
      config: { url: fake.wsUrl, language: 'en', maxDelayS: 1, eouSilenceS: 0.5, vocab: opts.vocab ? [{ content: 'ASP.NET Core', sounds_like: ['asp dot net core'] }] : [] },
      usableKeys: async () => keys.filter((k) => !blocked.has(k.id)),
      mark: (id, state, errorType) => {
        if (state !== 'ok') blocked.add(id)
        r.marks.push({ slot: keys.find((k) => k.id === id)!.slot, state, errorType })
      },
      addUsage: (id, ms) => r.usage.set(id, (r.usage.get(id) ?? 0) + ms),
      testKey: async (key) => (await testSpeechmaticsKey(key, fetch, fake.testUrl)).result,
      log: (event, fields) => r.logs.push({ event, fields }),
      timing: { connectTimeoutMs: 2000, retryMs: [10, 20, 30], slowRetryMs: 30, restartMs: 60, restartMaxMs: 120, usageFlushMs: 0 },
    },
    {
      partial: () => {},
      final: (text) => r.finals.push(text),
      state: (up, slot) => r.states.push({ up, slot }),
      stats: () => {},
    },
  )
  r.lane.start()
  return r
}

const words = (finals: string[]) => finals.join(' ').split(/\s+/).filter(Boolean)
const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

test.describe('cloud speech pool (fake server)', () => {
  test('a healthy key: every word once, lines end on end-of-utterance, usage counted', async () => {
    const r = await rig([{}])
    await r.feed([...sentence(ids(1, 4)), ...sentence(ids(5, 7))])
    await until(() => r.finals.length === 2)
    expect(r.finals).toEqual(['w1 w2 w3 w4', 'w5 w6 w7'])
    expect(r.states[0]).toEqual({ up: true, slot: 1 })
    await r.lane.stop()
    expect(r.usage.get('id1')).toBeGreaterThan(0)
    await r.fake.close()
  })

  test('SM-05: key 1 runs out mid-sentence, key 2 takes over, no word lost or doubled', async () => {
    const r = await rig([{ failAfterChunks: 14, errorType: 'timelimit_exceeded', closeCode: 4006 }, {}])
    await r.feed([...sentence(ids(1, 6)), ...sentence(ids(7, 9))])
    await until(() => words(r.finals).length >= 9)
    await sleep(100)
    expect(words(r.finals)).toEqual(ids(1, 9).map((i) => `w${i}`))
    expect(r.marks).toContainEqual({ slot: 1, state: 'quota_exhausted', errorType: 'timelimit_exceeded' })
    expect(r.states.filter((s) => s.up).map((s) => s.slot)).toEqual([1, 2])
    const connect = r.logs.filter((l) => l.event === 'stt_connect' && l.fields['outcome'] === 'ok')
    expect(connect[1]!.fields['replayMs']).toBeGreaterThan(0)
    expect(connect[1]!.fields['switchMs']).toBeLessThan(1500)
    await r.lane.stop()
    await r.fake.close()
  })

  test('a finished line is never replayed to the next key', async () => {
    // Fails during the second sentence: only that sentence is sent again.
    const r = await rig([{ failAfterChunks: 40, errorType: 'timelimit_exceeded', closeCode: 4006 }, {}])
    await r.feed([...sentence(ids(1, 4)), ...sentence(ids(5, 8))])
    await until(() => words(r.finals).length >= 8)
    await sleep(100)
    expect(words(r.finals)).toEqual(ids(1, 8).map((i) => `w${i}`))
    await r.lane.stop()
    await r.fake.close()
  })

  test('rejected key on handshake: the REST check marks it auth_failed and the next key serves', async () => {
    const r = await rig([{ refuse: 401 }, {}])
    await r.feed(sentence(ids(1, 3)))
    await until(() => r.finals.length === 1)
    expect(r.finals).toEqual(['w1 w2 w3'])
    expect(r.marks[0]).toEqual({ slot: 1, state: 'auth_failed', errorType: null })
    await r.lane.stop()
    await r.fake.close()
  })

  test('concurrent-session limit (quota_exceeded, 4005) is rate_limited, not used up', async () => {
    const r = await rig([{ failAfterChunks: 2, errorType: 'quota_exceeded', closeCode: 4005 }, {}])
    await r.feed(sentence(ids(1, 3)))
    await until(() => r.finals.length === 1)
    expect(r.marks.filter((m) => m.state !== 'ok')[0]).toEqual({ slot: 1, state: 'rate_limited', errorType: 'quota_exceeded' })
    expect(r.finals).toEqual(['w1 w2 w3'])
    await r.lane.stop()
    await r.fake.close()
  })

  test('SM-07: an unknown error type is retried on the same key and never marks it', async () => {
    const r = await rig([{ failAfterChunks: 6, errorType: 'brand_new_error', closeCode: 1011 }])
    // The scripted failure repeats on every session, so the key is retried then skipped for the round.
    await r.feed(sentence(ids(1, 3)))
    await until(() => r.fake.sessions.length >= 4)
    expect(r.marks.filter((m) => m.state !== 'ok')).toEqual([])
    expect(new Set(r.fake.sessions.map((s) => s.key)).size).toBe(1)
    await r.lane.stop()
    await r.fake.close()
  })

  test('SM-06: every key unreachable: the lane reports down and keeps trying in the background', async () => {
    const r = await rig([{ dropAfterChunks: 3 }, { dropAfterChunks: 3 }])
    await r.feed(sentence(ids(1, 2)))
    await until(() => r.states.some((s) => !s.up))
    const before = r.fake.sessions.length
    await r.feed(sentence(ids(3, 4)), 5)
    await until(() => r.fake.sessions.length > before + 2)
    expect(r.marks.filter((m) => m.state !== 'ok')).toEqual([])
    await r.lane.stop()
    await r.fake.close()
  })

  test('a config the service rejects stops cloud speech for the call (no key marked)', async () => {
    const r = await rig([{ failAfterChunks: 1, errorType: 'invalid_config', closeCode: 1003 }, {}])
    await r.feed(sentence(ids(1, 2)))
    await sleep(200)
    expect(r.fake.sessions.length).toBe(1)
    expect(r.marks.filter((m) => m.state !== 'ok')).toEqual([])
    await r.lane.stop()
    await r.fake.close()
  })

  test('stop() asks for the last words', async () => {
    const r = await rig([{}])
    await r.feed(sentence(ids(1, 3), 1))
    await r.lane.stop()
    expect(words(r.finals)).toEqual(['w1', 'w2', 'w3'])
    await r.fake.close()
  })

  test('the start message: enhanced model, s16le 16 kHz, partials, our timing values, vocabulary', async () => {
    const r = await rig([{}], { vocab: true })
    await until(() => r.fake.sessions[0]?.start['message'] === 'StartRecognition')
    const tc = r.fake.sessions[0]!.start['transcription_config']
    expect(r.fake.sessions[0]!.start['audio_format']).toEqual({ type: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 })
    expect(tc).toMatchObject({ language: 'en', model: 'enhanced', enable_partials: true, max_delay: 1, max_delay_mode: 'flexible', conversation_config: { end_of_utterance_silence_trigger: 0.5 } })
    expect(tc.additional_vocab).toEqual([{ content: 'ASP.NET Core', sounds_like: ['asp dot net core'] }])
    await r.lane.stop()
    await r.fake.close()
  })
})

test('error mapping follows the public API reference (S4.3)', () => {
  expect(classify('not_authorised', 4001)).toBe('rotate_auth')
  expect(classify('timelimit_exceeded', 4006)).toBe('rotate_quota')
  expect(classify('not_allowed', 4003)).toBe('rotate_quota')
  expect(classify('quota_exceeded', 4005)).toBe('rotate_rate')
  expect(classify('invalid_config', null)).toBe('fatal_config')
  expect(classify('job_error', 4013)).toBe('retry_same')
  expect(classify(null, 1006)).toBe('retry_same')
  expect(classify(null, 4006)).toBe('rotate_quota')
  expect(classify('something_new', null)).toBe('retry_same')
  expect(startMessage({ language: 'en', maxDelayS: 1, eouSilenceS: 0.5, vocab: [] }).transcription_config).not.toHaveProperty('additional_vocab')
  expect(joinText('Hello', ',')).toBe('Hello,')
  expect(joinText('Hello,', 'world')).toBe('Hello, world')
})

test('ring buffer keeps the last samples by absolute index', () => {
  const ring = new AudioRing(10)
  ring.write(Int16Array.from([1, 2, 3, 4, 5, 6]))
  ring.write(Int16Array.from([7, 8, 9, 10, 11, 12]))
  expect(ring.written).toBe(12)
  expect(ring.oldest).toBe(2)
  expect(Array.from(ring.since(8).pcm)).toEqual([9, 10, 11, 12])
  const old = ring.since(0)
  expect(old.start).toBe(2)
  expect(Array.from(old.pcm)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  expect(CHUNK).toBe(1600)
})

test.describe('vocabulary (S5)', () => {
  const resume = `# Asha Verma
Backend engineer · Pune, India

## Experience
### Software Engineer, Lumen Freight (2022 – present)
- Built a shipment tracking API in ASP.NET Core serving 2 million requests a day.
- Cut report load time with covering indexes in SQL Server and Entity Framework Core.
- Moved nightly jobs to Azure Functions with Service Bus triggers; deployed with Kubernetes on AKS.

## Skills
C#, ASP.NET Core, LINQ, IAsyncEnumerable, Docker, React, AWS`

  const v = buildVocab({
    company: 'Northwind Logistics',
    role: 'Senior .NET Engineer',
    jobDescription: 'We use C#, .NET 8, Kafka and PostgreSQL. You will design microservices with gRPC and work with our DevOps team.',
    resumeMd: resume,
    documents: [{ title: 'Team handbook' }],
    instructions: 'Be brief.\nVocabulary: Dapr, Orleans; Hangfire',
  })
  const content = v.map((x) => x.content)

  test('user terms first, then the company', () => {
    expect(content.slice(0, 4)).toEqual(['Dapr', 'Orleans', 'Hangfire', 'Northwind Logistics'])
  })

  test('tech terms are kept with their written form and how people say them', () => {
    for (const t of ['ASP.NET Core', 'C#', '.NET', 'SQL Server', 'Entity Framework Core', 'Kubernetes', 'LINQ', 'IAsyncEnumerable', 'Kafka', 'PostgreSQL', 'gRPC', 'AKS', 'AWS', 'Lumen']) expect(content).toContain(t)
    expect(v.find((x) => x.content === 'C#')?.sounds_like).toEqual(['C sharp'])
    expect(v.find((x) => x.content === 'AKS')?.sounds_like).toEqual(['A K S'])
    expect(v.find((x) => x.content === 'SQL Server')?.sounds_like).toEqual(['sequel server'])
  })

  test('no plain English words, no duplicates', () => {
    for (const w of ['the', 'Built', 'Experience', 'Skills', 'We', 'You', 'India', 'Engineer', 'Core', 'NET', 'ASP.NET']) expect(content).not.toContain(w)
    expect(new Set(content.map((c) => c.toLowerCase())).size).toBe(content.length)
  })

  test('capped at 300 items', () => {
    const big = Array.from({ length: 1000 }, (_, i) => `Tool${i}X`).join(', ')
    expect(buildVocab({ company: null, role: null, jobDescription: big, resumeMd: null, documents: [], instructions: '' }).length).toBe(VOCAB_MAX)
  })
})
