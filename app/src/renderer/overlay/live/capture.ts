// Audio capture in the overlay renderer (architecture.md "Audio path"): the mic via
// getUserMedia and, in Electron, system loopback via getDisplayMedia (main answers
// with the primary screen + loopback audio, and the video track is stopped at once).
// Both run through an AudioWorklet that emits 100 ms frames of 16 kHz mono Int16.
import type { Speaker } from '@shared/types'
import { api, isElectron } from '@renderer/api'

export async function listMics(): Promise<Array<{ value: string; label: string }>> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const mics = devices.filter((d) => d.kind === 'audioinput')
    const out = mics.map((d, i) => ({ value: d.deviceId || 'default', label: d.label || (d.deviceId === 'default' ? 'System default' : `Microphone ${i + 1}`) }))
    const seen = new Set<string>()
    return out.filter((o) => (seen.has(o.value) ? false : (seen.add(o.value), true)))
  } catch {
    return []
  }
}

export interface Capture {
  stop(): void
  real: Record<Speaker, boolean>
  errors: Partial<Record<Speaker, string>>
}

export async function startCapture(opts: { micDeviceId?: string; onLevel: (speaker: Speaker, rms: number) => void }): Promise<Capture> {
  const streams: MediaStream[] = []
  const nodes: AudioNode[] = []
  const real: Record<Speaker, boolean> = { you: false, them: false }
  const errors: Partial<Record<Speaker, string>> = {}
  let ctx: AudioContext | null = null
  // The browser preview has no loopback and would prompt for the mic on every call;
  // it shows simulated levels instead.
  if (!isElectron) return { real, errors, stop() {} }

  const hook = async (stream: MediaStream, speaker: Speaker) => {
    ctx ??= new AudioContext()
    await ctx.audioWorklet.addModule('./pcm-worklet.js').catch(() => {})
    const src = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'pcm-worklet')
    node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
      opts.onLevel(speaker, Math.min(1, e.data.rms * 6))
      api.audio.frame({ speaker, pcm: e.data.pcm })
    }
    src.connect(node)
    nodes.push(src, node)
    real[speaker] = true
  }

  try {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: opts.micDeviceId ? { exact: opts.micDeviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
      },
    })
    streams.push(mic)
    await hook(mic, 'you')
  } catch (e) {
    errors.you = (e as Error).name === 'NotAllowedError' ? 'Microphone access was blocked.' : 'No microphone found.'
  }

  if (isElectron) {
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      display.getVideoTracks().forEach((t) => t.stop())
      if (display.getAudioTracks().length) {
        streams.push(display)
        await hook(display, 'them')
      } else errors.them = 'No system audio track.'
    } catch {
      errors.them = 'Could not capture system audio.'
    }
  }

  return {
    real,
    errors,
    stop() {
      nodes.forEach((n) => n.disconnect())
      streams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
      void ctx?.close()
    },
  }
}
