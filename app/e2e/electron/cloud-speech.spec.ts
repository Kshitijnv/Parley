// Cloud speech in the built app against a fake Speechmatics server (architecture.md
// revision 7 S8): consent, key storage, the "them" lane switching to cloud text, a key
// running out mid-sentence (SM-05), a dropped connection falling back to local text
// (SM-06), usage counting and a log with no transcript text (SM-09). Zero real calls.
//
// The fake recognizer reads words out of the audio: a 100 ms frame of constant value v is
// word "w<v>". Values ≥ 1000 are loud enough to count as voice for the turn detector.
import { expect, test } from '@playwright/test'
import { FakeSpeechmatics } from '../fake-speechmatics'
import { Harness } from './harness'

/** Real-time frames: each word 3 × 100 ms of its id, a 100 ms gap, then `tail` frames of silence. */
async function feedWords(h: Harness, ids: number[], tail = 10) {
  const frames: number[] = []
  for (const id of ids) frames.push(id, id, id, 0)
  for (let i = 0; i < tail; i++) frames.push(0)
  await h.page.evaluate(async (frames) => {
    const s = performance.now()
    for (let k = 0; k < frames.length; k++) {
      ;(window as any).api.audio.frame({ speaker: 'them', pcm: new Int16Array(1600).fill(frames[k]!).buffer })
      const wait = s + (k + 1) * 100 - performance.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    }
  }, frames)
}

const KEY1 = 'sm-test-key-one-0123456789abcdef'
const KEY2 = 'sm-test-key-two-0123456789abcdef'

test('cloud speech: consent, keys, cloud text, key switch mid-sentence, local fallback', async () => {
  const fake = await new FakeSpeechmatics().listen()
  fake.valid.add(KEY1)
  fake.valid.add(KEY2)
  const h = await new Harness('cloud', {
    extraEnv: {
      PARLEY_SPEECHMATICS_URL: fake.wsUrl,
      PARLEY_SPEECHMATICS_TEST_URL: fake.testUrl,
      PARLEY_SPEECHMATICS_TIMING: JSON.stringify({ connectTimeoutMs: 3000, retryMs: [50, 50, 50], restartMs: 500, restartMaxMs: 1000, usageFlushMs: 0 }),
    },
  }).launch()
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })

    // S6: on only with consent; main stamps the time.
    const refused = await h.call('settings.update', { cloudStt: { enabled: true } })
    expect(refused.ok).toBe(false)
    const on = await h.call('settings.update', { cloudStt: { enabled: true, consentedAt: 1 } })
    expect(on.ok, on.error).toBe(true)
    expect(on.value.cloudStt.consentedAt).toBeGreaterThan(1_700_000_000_000)

    // S4.1: keys saved and checked; only the last 4 characters come back.
    const a = await h.call('speechKeys.add', { key: KEY1, label: 'Account A', budgetHours: null })
    expect(a.ok, a.error).toBe(true)
    expect(a.value.test.ok).toBe(true)
    expect(JSON.stringify(a.value)).not.toContain(KEY1)
    const dup = await h.call('speechKeys.add', { key: KEY1, label: 'again', budgetHours: null })
    expect(dup.ok).toBe(false)
    const b = await h.call('speechKeys.add', { key: KEY2, label: 'Account B', budgetHours: 8 })
    expect(b.ok, b.error).toBe(true)
    expect(b.value.key.position).toBe(2)

    const s = await h.createSession({ autoGenerate: false })
    await h.goLive(s.id)
    const cloudUp = await h.until((ev) => ev.find((e) => e.n === 'stt:status' && e.p.speech?.mode === 'cloud' && e.p.speech.keySlot === 1), 10_000)
    expect(cloudUp, 'the "them" lane switched to cloud text on key 1').toBeTruthy()

    // A line of cloud text; key A will run out 10 frames into the second sentence (26 frames per sentence below).
    const startChunks = fake.sessions[0]!.chunks
    fake.keys.set(KEY1, { failAfterChunks: startChunks + 36, errorType: 'timelimit_exceeded', closeCode: 4006 })
    await feedWords(h, [1001, 1002, 1003, 1004])
    const first = await h.until((ev) => ev.find((e) => e.n === 'transcript:final' && e.p.speaker === 'them'), 5000)
    expect(first?.p.text).toBe('w1001 w1002 w1003 w1004')

    // SM-05: key A fails mid-sentence; key B serves; each word once.
    await feedWords(h, [1005, 1006, 1007, 1008, 1009])
    const second = await h.until((ev) => ev.filter((e) => e.n === 'transcript:final' && e.p.speaker === 'them')[1], 6000)
    expect(second?.p.text).toBe('w1005 w1006 w1007 w1008 w1009')
    const onB = await h.until((ev) => ev.find((e) => e.n === 'stt:status' && e.p.speech?.mode === 'cloud' && e.p.speech.keySlot === 2), 3000)
    expect(onB?.p.speech.keyLabel).toBe('Account B')
    const keys = (await h.call('speechKeys.list')).value as Array<{ label: string; state: string; usedMs: number; usedTotalMs: number }>
    expect(keys.find((k) => k.label === 'Account A')?.state).toBe('quota_exhausted')
    expect(keys.find((k) => k.label === 'Account A')!.usedMs).toBeGreaterThan(0)

    // SM-06: the connection drops and no key works: local text within ~1 s.
    fake.keys.set(KEY2, { refuse: 503 })
    const dropAt = Date.now()
    fake.dropAll()
    const local = await h.until((ev) => ev.find((e) => e.n === 'stt:status' && e.p.speech?.mode === 'local_fallback' && e.t >= dropAt), 4000)
    expect(local, 'fell back to local text').toBeTruthy()
    expect(local!.t - dropAt).toBeLessThan(1800)

    await h.call('sessions.end', { id: s.id, mode: 'end' })

    // SM-09: numbers and enums only; no words, no keys.
    const text = h.logText()
    expect(text).not.toMatch(/w100\d/)
    expect(text).not.toContain(KEY1.slice(0, 12))
    const lines = h.logLines()
    expect(lines.some((l) => l.event === 'stt_final' && l.sttEngine === 'speechmatics' && typeof l.sttMs === 'number')).toBe(true)
    expect(lines.some((l) => l.event === 'stt_error' && l.errorType === 'timelimit_exceeded' && l.outcome === 'rotate_quota')).toBe(true)
    expect(lines.some((l) => l.event === 'stt_switch' && l.sttEngine === 'local' && l.outcome === 'cloud_down')).toBe(true)
    expect(h.errors).toEqual([])
  } finally {
    await h.close()
    await fake.close()
  }
})
