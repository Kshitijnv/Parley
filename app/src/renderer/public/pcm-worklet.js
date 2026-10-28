// Downmix to mono, resample to 16 kHz, and post 100 ms Int16 frames plus an RMS level.
class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / 16000
    this.buf = new Int16Array(1600)
    this.n = 0
    this.pos = 0
    this.sum = 0
    this.count = 0
  }
  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0]) return true
    const ch = input.length
    const len = input[0].length
    for (let i = 0; i < len; i++) {
      let v = 0
      for (let c = 0; c < ch; c++) v += input[c][i]
      v /= ch
      this.sum += v * v
      this.count++
      this.pos += 1
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio
        const s = Math.max(-1, Math.min(1, v))
        this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff
        if (this.n === this.buf.length) {
          const rms = Math.sqrt(this.sum / Math.max(1, this.count))
          this.port.postMessage({ pcm: this.buf.buffer, rms }, [this.buf.buffer])
          this.buf = new Int16Array(1600)
          this.n = 0
          this.sum = 0
          this.count = 0
        }
      }
    }
    return true
  }
}
registerProcessor('pcm-worklet', PcmWorklet)
