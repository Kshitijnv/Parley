// The last few seconds of "them" audio (architecture.md revision 7 S4.4), so a new cloud
// session can be given the words spoken while the old one failed. Int16 PCM, addressed
// by absolute sample index since the call started.
export class AudioRing {
  private buf: Int16Array
  /** Total samples ever written; the next sample's absolute index. */
  written = 0

  constructor(readonly capacity: number) {
    this.buf = new Int16Array(capacity)
  }

  write(pcm: Int16Array) {
    for (let i = 0; i < pcm.length; i++) this.buf[(this.written + i) % this.capacity] = pcm[i]!
    this.written += pcm.length
  }

  /** The oldest absolute sample still held. */
  get oldest() {
    return Math.max(0, this.written - this.capacity)
  }

  /** Samples from absolute index `from` (clamped to what's held) to now, as one array. */
  since(from: number): { start: number; pcm: Int16Array } {
    const start = Math.min(this.written, Math.max(from, this.oldest))
    const out = new Int16Array(this.written - start)
    for (let i = 0; i < out.length; i++) out[i] = this.buf[(start + i) % this.capacity]!
    return { start, pcm: out }
  }
}
