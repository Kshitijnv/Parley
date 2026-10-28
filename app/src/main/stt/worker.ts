// Speech-to-text worker (Electron utilityProcess). 16 kHz mono Int16 frames in, partial
// and final text out, one recognizer stream per speaker so the mic ("you") and the
// system loopback ("them") never mix. Each lane numbers its utterances (utteranceId),
// and `ready` reports the model actually loaded. No network access.
import sherpa from 'sherpa-onnx-node'

type Speaker = 'you' | 'them'

type In =
  | { type: 'init'; modelId: string; language: string; files: { encoder: string; decoder: string; joiner: string; tokens: string }; threads?: number }
  | { type: 'audio'; speaker: Speaker; pcm: ArrayBuffer | Uint8Array }
  | { type: 'flush' }

interface Lane {
  stream: any
  samples: number
  uttStart: number | null
  last: string
  utteranceId: number
  rev: number
}

const SR = 16000
const port = process.parentPort
let rec: any = null
const lanes = {} as Record<Speaker, Lane>

const send = (m: Record<string, unknown>) => port.postMessage(m)

function lane(speaker: Speaker): Lane {
  return (lanes[speaker] ??= { stream: rec.createStream(), samples: 0, uttStart: null, last: '', utteranceId: 0, rev: 0 })
}

function endUtterance(speaker: Speaker, l: Lane, text: string) {
  if (text) {
    const end = l.samples
    const start = l.uttStart ?? end
    send({ type: 'final', speaker, utteranceId: l.utteranceId, text, startMs: Math.round((start / SR) * 1000), endMs: Math.round((end / SR) * 1000) })
  }
  rec.reset(l.stream)
  l.uttStart = null
  if (l.last) send({ type: 'partial', speaker, utteranceId: l.utteranceId, rev: ++l.rev, text: '' })
  l.last = ''
  l.utteranceId++
  l.rev = 0
}

function onAudio(speaker: Speaker, pcm: ArrayBuffer | Uint8Array) {
  const bytes = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm)
  const n = bytes.byteLength >> 1
  if (!n) return
  const ints = new Int16Array(bytes.buffer, bytes.byteOffset, n)
  const samples = new Float32Array(n)
  for (let i = 0; i < n; i++) samples[i] = ints[i]! / 32768
  const l = lane(speaker)
  l.stream.acceptWaveform({ samples, sampleRate: SR })
  l.samples += n
  while (rec.isReady(l.stream)) rec.decode(l.stream)
  const text = String(rec.getResult(l.stream).text ?? '').trim()
  if (text && l.uttStart === null) l.uttStart = Math.max(0, l.samples - n)
  if (text !== l.last) {
    l.last = text
    send({ type: 'partial', speaker, utteranceId: l.utteranceId, rev: ++l.rev, text })
  }
  // The model's own endpoint: complete, punctuated lines about 1.5 to 2.5 s after speech
  // stops. A text-stability shortcut cut off the last words (the model lags the audio).
  if (rec.isEndpoint(l.stream)) endUtterance(speaker, l, text)
}

function flush() {
  for (const speaker of Object.keys(lanes) as Speaker[]) {
    const l = lanes[speaker]
    endUtterance(speaker, l, String(rec.getResult(l.stream).text ?? '').trim())
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
      onAudio(m.speaker, m.pcm)
    } else if (m.type === 'flush') {
      flush()
    }
  } catch (err) {
    send({ type: m.type === 'init' ? 'load_error' : 'error', message: (err as Error).name })
  }
})
