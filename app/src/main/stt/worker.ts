// Speech-to-text worker (Electron utilityProcess). 16 kHz mono Int16 frames in, partial
// and final text out, one recognizer stream per speaker so the mic ("you") and the
// system loopback ("them") never mix. Each lane numbers its utterances (utteranceId),
// and `ready` reports the model actually loaded. No network access.
// Revision 6 T1: each lane also reports its timing (numbers only) every 5 s of audio.
import sherpa from 'sherpa-onnx-node'

type Speaker = 'you' | 'them'

type In =
  | { type: 'init'; modelId: string; language: string; files: { encoder: string; decoder: string; joiner: string; tokens: string }; threads?: number }
  | { type: 'audio'; speaker: Speaker; pcm: ArrayBuffer | Uint8Array; at?: number }
  | { type: 'flush' }

interface Lane {
  stream: any
  samples: number
  uttStart: number | null
  last: string
  utteranceId: number
  rev: number
  /** Revision 6 T1: last voiced sample, tokens already timed, and the stats window. */
  voicedEnd: number
  tokens: number
  stats: Stats
}

interface Stats {
  from: number
  decodeMs: number
  backlogMs: number
  lags: number[]
  changes: number[]
}

const STATS_EVERY_S = 5
// Same voice threshold as live.ts (about -38 dBFS).
const VOICE_RMS = 0.0125

const SR = 16000
const port = process.parentPort
let rec: any = null
const lanes = {} as Record<Speaker, Lane>

const send = (m: Record<string, unknown>) => port.postMessage(m)

function lane(speaker: Speaker): Lane {
  return (lanes[speaker] ??= { stream: rec.createStream(), samples: 0, uttStart: null, last: '', utteranceId: 0, rev: 0, voicedEnd: 0, tokens: 0, stats: newStats(0) })
}

const newStats = (from: number): Stats => ({ from, decodeMs: 0, backlogMs: 0, lags: [], changes: [] })

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined
  const a = [...xs].sort((x, y) => x - y)
  return Math.round(a[a.length >> 1]!)
}

/** One `stats` message per lane per 5 s of audio, only for windows that had words. */
function reportStats(speaker: Speaker, l: Lane) {
  const st = l.stats
  const audioMs = ((l.samples - st.from) / SR) * 1000
  if (audioMs < STATS_EVERY_S * 1000) return
  if (st.lags.length) {
    const gaps = st.changes.slice(1).map((t, i) => t - st.changes[i]!)
    send({ type: 'stats', speaker, rtf: Math.round((st.decodeMs / audioMs) * 1000) / 1000, backlogMs: Math.round(st.backlogMs), partialLagMs: median(st.lags), partialEveryMs: median(gaps), count: st.lags.length })
  }
  l.stats = newStats(l.samples)
}

/** Audio time (ms) between each newly recognized token and the newest audio fed. */
function timeTokens(l: Lane, r: { tokens?: string[]; timestamps?: number[]; start_time?: number }) {
  const ts = r.timestamps ?? []
  const start = r.start_time ?? 0
  const fedS = l.samples / SR
  for (let i = l.tokens; i < ts.length; i++) l.stats.lags.push(Math.max(0, (fedS - (start + ts[i]!)) * 1000))
  l.tokens = ts.length
}

function endUtterance(speaker: Speaker, l: Lane, text: string, endpoint: 'model' | 'flush') {
  if (text) {
    const end = l.samples
    const start = l.uttStart ?? end
    // Speech end → final, in audio time: what the endpoint rule waited after the last voiced frame.
    const sttMs = l.voicedEnd > start ? Math.round(((end - l.voicedEnd) / SR) * 1000) : undefined
    send({ type: 'final', speaker, utteranceId: l.utteranceId, text, startMs: Math.round((start / SR) * 1000), endMs: Math.round((end / SR) * 1000), endpoint, sttMs })
  }
  l.tokens = 0
  rec.reset(l.stream)
  l.uttStart = null
  if (l.last) send({ type: 'partial', speaker, utteranceId: l.utteranceId, rev: ++l.rev, text: '' })
  l.last = ''
  l.utteranceId++
  l.rev = 0
}

function onAudio(speaker: Speaker, pcm: ArrayBuffer | Uint8Array, at?: number) {
  const bytes = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm)
  const n = bytes.byteLength >> 1
  if (!n) return
  const ints = new Int16Array(bytes.buffer, bytes.byteOffset, n)
  const samples = new Float32Array(n)
  let sum = 0
  for (let i = 0; i < n; i++) {
    samples[i] = ints[i]! / 32768
    sum += samples[i]! * samples[i]!
  }
  const l = lane(speaker)
  l.stream.acceptWaveform({ samples, sampleRate: SR })
  l.samples += n
  if (Math.sqrt(sum / n) > VOICE_RMS) l.voicedEnd = l.samples
  const t0 = performance.now()
  while (rec.isReady(l.stream)) rec.decode(l.stream)
  l.stats.decodeMs += performance.now() - t0
  // `at` is when main received the frame (epoch ms): main → worker queueing plus decode.
  if (at !== undefined) l.stats.backlogMs = Math.max(l.stats.backlogMs, Date.now() - at)
  const r = rec.getResult(l.stream)
  const text = String(r.text ?? '').trim()
  if (text && l.uttStart === null) l.uttStart = Math.max(0, l.samples - n)
  if (text !== l.last) {
    l.last = text
    if (text) {
      timeTokens(l, r)
      l.stats.changes.push((l.samples / SR) * 1000)
    }
    send({ type: 'partial', speaker, utteranceId: l.utteranceId, rev: ++l.rev, text })
  }
  // The model's own endpoint: complete, punctuated lines about 1.5 to 2.5 s after speech
  // stops. A text-stability shortcut cut off the last words (the model lags the audio).
  if (rec.isEndpoint(l.stream)) endUtterance(speaker, l, text, 'model')
  reportStats(speaker, l)
}

function flush() {
  for (const speaker of Object.keys(lanes) as Speaker[]) {
    const l = lanes[speaker]
    endUtterance(speaker, l, String(rec.getResult(l.stream).text ?? '').trim(), 'flush')
  }
  send({ type: 'flushed' })
}

port.on('message', (e: { data: In }) => {
  const m = e.data
  try {
    if (m.type === 'init') {
      const t0 = Date.now()
      rec = new sherpa.OnlineRecognizer({
        featConfig: { sampleRate: SR, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: m.files.encoder, decoder: m.files.decoder, joiner: m.files.joiner },
          tokens: m.files.tokens,
          numThreads: m.threads ?? 2,
          provider: 'cpu',
          debug: 0,
        },
        decodingMethod: 'greedy_search',
        enableEndpoint: true,
        // No speech for 2.4 s, or 0.9 s of silence after speech, or 20 s of speech, ends a line.
        rule1MinTrailingSilence: 2.4,
        rule2MinTrailingSilence: 0.9,
        rule3MinUtteranceLength: 20,
      })
      send({ type: 'ready', modelId: m.modelId, language: m.language, loadMs: Date.now() - t0 })
    } else if (!rec) {
      return
    } else if (m.type === 'audio') {
      onAudio(m.speaker, m.pcm, m.at)
    } else if (m.type === 'flush') {
      flush()
    }
  } catch (err) {
    send({ type: m.type === 'init' ? 'load_error' : 'error', message: (err as Error).name })
  }
})
