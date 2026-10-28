// F03: capture the display that holds the overlay at its native resolution and save
// it as a PNG. With Private mode on (and real exclusion on this OS) the overlay is
// already invisible to capture; otherwise it is hidden for the one frame the capture
// takes. Opacity goes through privacy.ts so a pending reveal can't fade it back in.
import { desktopCapturer, screen } from 'electron'
import { writeFileSync } from 'node:fs'
import { filePath } from '../paths'
import { wins } from '../windows'
import { AppError } from '../errors'
import { capability, hold, release } from '../privacy'

export async function captureScreen(id: string, privateMode: boolean): Promise<{ rel: string; png: Buffer }> {
  const o = wins.overlay
  const display = o && !o.isDestroyed() ? screen.getDisplayMatching(o.getBounds()) : screen.getPrimaryDisplay()
  const size = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) }
  const excluded = privateMode && capability.mode === 'exclude'
  const hide = !excluded && o && !o.isDestroyed() && o.isVisible()
  if (hide) {
    hold(o, 'screenshot')
    await new Promise((r) => setTimeout(r, 120))
  }
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
    const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    if (!src || src.thumbnail.isEmpty()) throw new AppError('Windows did not return a screenshot. Check that screen capture is allowed for this app.', 'capture_failed')
    const png = src.thumbnail.toPNG()
    const rel = `screenshots/${id}.png`
    const abs = filePath(rel)!
    writeFileSync(abs, png)
    return { rel, png }
  } finally {
    if (hide) release(o, 'screenshot')
  }
}
