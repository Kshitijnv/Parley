// A fake Speechmatics real-time server for tests (architecture.md revision 7 S7). Speaks
// the subset of the public protocol Parley uses, over a minimal WebSocket implementation
// on node:http, and a fake temporary-key endpoint for key checks.
//
// The "recognizer" reads words out of the audio itself: every 0.1 s chunk whose first
// sample is v > 0 is word "w<v>", and 0 is silence. Tests encode a sentence as audio and
// can then check that every word reaches the transcript exactly once, across key
// switches and replays.
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

export const CHUNK = 1600

/** What a key does. Default: works. */
export interface KeyBehaviour {
  /** Refuse the WebSocket handshake with this HTTP status (401: bad key). */
  refuse?: number
  /** After this many audio chunks, send an Error of `errorType` and close with `closeCode`. */
  failAfterChunks?: number
  errorType?: string
  closeCode?: number
  /** After this many chunks, cut the TCP connection with no close frame. */
  dropAfterChunks?: number
  /** Delay before RecognitionStarted (ms). */
  startDelayMs?: number
}

export interface FakeSession {
  key: string
  start: Record<string, any>
  chunks: number
  closed: boolean
}

export class FakeSpeechmatics {
  private server: Server
  readonly sessions: FakeSession[] = []
  keys = new Map<string, KeyBehaviour>()
  private sockets = new Set<Duplex>()
  /** Keys the REST check treats as valid. */
  valid = new Set<string>()
  port = 0

  constructor() {
    this.server = createServer((req, res) => {
      if (req.method === 'POST' && req.url?.startsWith('/v1/api_keys')) {
        const key = (req.headers.authorization ?? '').replace(/^Bearer /, '')
        req.resume()
        res.writeHead(this.valid.has(key) ? 201 : 401, { 'content-type': 'application/json' })
        res.end(JSON.stringify(this.valid.has(key) ? { apikey_id: null, key_value: 'eyJ.fake' } : { detail: 'unauthorized' }))
        return
      }
      res.writeHead(404).end()
    })
    this.server.on('upgrade', (req, socket) => this.upgrade(req.headers, socket))
  }

  async listen() {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r))
    this.port = (this.server.address() as AddressInfo).port
    return this
  }

  get wsUrl() {
    return `ws://127.0.0.1:${this.port}/v2`
  }

  get testUrl() {
    return `http://127.0.0.1:${this.port}/v1/api_keys?type=rt`
  }

  /** Cut every open connection with no close frame (a network drop). */
  dropAll() {
    for (const s of this.sockets) s.destroy()
    this.sockets.clear()
  }

  close() {
    this.dropAll()
    return new Promise<void>((r) => this.server.close(() => r()))
  }

  private upgrade(headers: Record<string, string | string[] | undefined>, socket: Duplex) {
    const key = String(headers['authorization'] ?? '').replace(/^Bearer /, '')
    const b = this.keys.get(key) ?? {}
    if (b.refuse) {
      socket.end(`HTTP/1.1 ${b.refuse} Unauthorized\r\nContent-Length: 0\r\n\r\n`)
      return
    }
    const accept = createHash('sha1').update(`${headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    this.sockets.add(socket)
    socket.on('close', () => this.sockets.delete(socket))
    const sess: FakeSession = { key, start: {}, chunks: 0, closed: false }
    this.sessions.push(sess)
    // Read per frame, so a test can change a key's behaviour mid-session.
    new Conn(socket, sess, () => this.keys.get(key) ?? {})
  }
}

class Conn {
  private buf = Buffer.alloc(0)
  private pcm: number[] = []
  private eouS = 0.5
  private started = false
  private word: number | null = null
  private wordStart = 0
  private silence = 0
  private hasWords = false
  private done = false

  constructor(
    private socket: Duplex,
    private sess: FakeSession,
    private behaviour: () => KeyBehaviour,
  ) {
    socket.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d])
      this.parse()
    })
    socket.on('error', () => {})
    socket.on('close', () => (sess.closed = true))
  }

  private parse() {
    while (this.buf.length >= 2) {
      const op = this.buf[0]! & 0x0f
      const masked = (this.buf[1]! & 0x80) !== 0
      let len = this.buf[1]! & 0x7f
      let off = 2
      if (len === 126) {
        if (this.buf.length < 4) return
        len = this.buf.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (this.buf.length < 10) return
        len = Number(this.buf.readBigUInt64BE(2))
        off = 10
      }
      const need = off + (masked ? 4 : 0) + len
      if (this.buf.length < need) return
      const mask = masked ? this.buf.subarray(off, off + 4) : null
      const data = Buffer.from(this.buf.subarray(off + (masked ? 4 : 0), need))
      if (mask) for (let i = 0; i < data.length; i++) data[i]! ^= mask[i % 4]!
      this.buf = this.buf.subarray(need)
      if (op === 1) this.onText(data.toString('utf8'))
      else if (op === 2) this.onAudio(data)
      else if (op === 8) this.close(1000)
      else if (op === 9) this.frame(10, data)
    }
  }

  private frame(op: number, data: Buffer) {
    if (this.done) return
    const head = data.length < 126 ? Buffer.from([0x80 | op, data.length]) : Buffer.from([0x80 | op, 126, data.length >> 8, data.length & 0xff])
    this.socket.write(Buffer.concat([head, data]))
  }

  private send(m: Record<string, unknown>) {
    this.frame(1, Buffer.from(JSON.stringify(m)))
  }

  private close(code: number) {
    if (this.done) return
    const p = Buffer.alloc(2)
    p.writeUInt16BE(code)
    this.frame(8, p)
    this.done = true
    this.socket.end()
  }

  private get b() {
    return this.behaviour()
  }

  private onText(t: string) {
    const m = JSON.parse(t)
    if (m.message === 'StartRecognition') {
      this.sess.start = m
      this.eouS = m.transcription_config?.conversation_config?.end_of_utterance_silence_trigger ?? 0.5
      setTimeout(() => {
        this.started = true
        this.send({ message: 'RecognitionStarted', id: 'fake' })
      }, this.b.startDelayMs ?? 5)
    } else if (m.message === 'EndOfStream') {
      this.flushWord(this.sess.chunks * 0.1)
      if (this.hasWords) this.send({ message: 'EndOfUtterance', metadata: { start_time: this.sess.chunks * 0.1, end_time: this.sess.chunks * 0.1 } })
      this.send({ message: 'EndOfTranscript' })
      setTimeout(() => this.close(1000), 5)
    }
  }

  private onAudio(d: Buffer) {
    if (!this.started || this.done) return
    for (let i = 0; i + 1 < d.length; i += 2) this.pcm.push(d.readInt16LE(i))
    while (this.pcm.length >= CHUNK) {
      const v = this.pcm[0]!
      this.pcm.splice(0, CHUNK)
      this.chunk(v)
      this.sess.chunks++
      if (this.b.failAfterChunks !== undefined && this.sess.chunks >= this.b.failAfterChunks) {
        this.send({ message: 'Error', type: this.b.errorType ?? 'unknown_error', reason: 'scripted' })
        return this.close(this.b.closeCode ?? 1011)
      }
      if (this.b.dropAfterChunks !== undefined && this.sess.chunks >= this.b.dropAfterChunks) {
        this.done = true
        return void this.socket.destroy()
      }
    }
  }

  private flushWord(t: number) {
    if (this.word === null) return
    this.send({ message: 'AddTranscript', metadata: { start_time: this.wordStart, end_time: t, transcript: `w${this.word} ` }, results: [] })
    this.word = null
  }

  private chunk(v: number) {
    const t = this.sess.chunks * 0.1
    if (v > 0) {
      if (this.word !== v) {
        this.flushWord(t)
        this.word = v
        this.wordStart = t
      }
      this.silence = 0
      this.hasWords = true
      this.send({ message: 'AddPartialTranscript', metadata: { start_time: this.wordStart, end_time: t + 0.1, transcript: `w${v}` }, results: [] })
    } else {
      this.flushWord(t)
      this.silence++
      if (this.hasWords && this.silence * 0.1 >= this.eouS - 1e-9) {
        this.send({ message: 'EndOfUtterance', metadata: { start_time: t, end_time: t + 0.1 } })
        this.hasWords = false
      }
    }
  }
}

/** Audio for a sentence: each word 3 chunks of its id, a 1-chunk gap, then `tail` chunks of silence. */
export function sentence(ids: number[], tail = 8): Int16Array[] {
  const out: Int16Array[] = []
  const chunk = (v: number) => new Int16Array(CHUNK).fill(v)
  for (const id of ids) {
    out.push(chunk(id), chunk(id), chunk(id), chunk(0))
  }
  for (let i = 0; i < tail; i++) out.push(chunk(0))
  return out
}
