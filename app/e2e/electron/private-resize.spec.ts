// Overlay not OS-resizable, programmatic sizing intact (feature #39, architecture.md
// revision 8 follow-up, test P6-15). The overlay is a frameless window; leaving it
// resizable:true made Windows paint native resize cursors in an OS border at its edges,
// which CSS can't hide and which outlines the hidden overlay in a share. The fix is
// resizable:false. The gate: that must NOT break the window's programmatic sizing —
// especially fit(), which auto-sizes the overlay to its content.
//
// Two checks, because the live overlay fights injected sizes: it runs its own auto-fit
// loop (a ResizeObserver re-fits the window to real content whenever the window resizes),
// so calling window.fit() with arbitrary numbers is racy — the renderer corrects them to
// the true content size. So (1) we assert the fix and that the live overlay is auto-sized
// to a sensible (non-frozen) size, and (2) we prove resizable:false does NOT clamp
// programmatic setBounds with a deterministic main-process probe window that has the
// overlay's options but no renderer loop. fit() is just o.setBounds() underneath, so the
// probe proving setBounds ⇒ fit() is not frozen either.
import { expect, test } from '@playwright/test'
import { Harness } from './harness'

test('P6-15: overlay is not OS-resizable; programmatic setBounds is not clamped', async () => {
  const h = await new Harness('private-resize').launch()
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })

    // (1) The fix, on the real overlay, plus evidence its auto-fit is alive (not frozen).
    const live = await h.app.evaluate(({ BrowserWindow, screen }) => {
      const o = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('#/overlay'))
      if (!o) return null
      const b = o.getBounds()
      return { b, resizable: o.isResizable(), wa: screen.getDisplayMatching(b).workArea }
    })
    expect(live, 'overlay window').toBeTruthy()
    expect(live!.resizable, 'overlay.isResizable() is false (no OS edge resize border)').toBe(false)
    // Auto-fit produced a real window: within [min, work area], not stuck at the 380x120 floor.
    expect(live!.b.width).toBeGreaterThan(380)
    expect(live!.b.width).toBeLessThanOrEqual(live!.wa.width)
    expect(live!.b.height).toBeGreaterThan(120)
    expect(live!.b.height).toBeLessThanOrEqual(live!.wa.height)

    // (2) Deterministic: a window with the overlay's options, no renderer. setBounds must
    // grow and shrink exactly — i.e. resizable:false does not clamp programmatic sizing,
    // so fit()/setBounds()/moveBy() keep working and no setResizable wrap is needed.
    const probe = await h.app.evaluate(async ({ BrowserWindow }) => {
      const w = new BrowserWindow({
        width: 500, height: 650, x: 120, y: 120,
        frame: false, transparent: true, resizable: false,
        minWidth: 380, minHeight: 120, show: true, hasShadow: false,
      })
      await w.loadURL('data:text/html,<body style="margin:0"></body>')
      const size = () => { const b = w.getBounds(); return { w: b.width, h: b.height } }
      const grow = (w.setBounds({ x: 120, y: 120, width: 640, height: 520 }), size())
      const shrink = (w.setBounds({ x: 120, y: 120, width: 400, height: 300 }), size())
      const resizable = w.isResizable()
      w.destroy()
      return { grow, shrink, resizable }
    })
    expect(probe.grow, 'setBounds grows to exact size under resizable:false').toEqual({ w: 640, h: 520 })
    expect(probe.shrink, 'setBounds shrinks to exact size under resizable:false').toEqual({ w: 400, h: 300 })
    expect(probe.resizable, 'probe window stays non-resizable').toBe(false)

    expect(h.errors).toEqual([])
  } finally {
    await h.close()
  }
})
