// Private mode taskbar button (feature #39, architecture.md revision 8, test P6-13).
// Electron 45 has setSkipTaskbar but no isSkipTaskbar getter, and on Windows the flag
// goes through the ITaskbarList shell API, not window styles, so there is no reliable
// way to read the real taskbar state back from code. This test therefore checks the
// code contract we changed: toggling Private flips the OVERLAY's taskbar flag and never
// touches the bubble or snap window. Whether the button visually disappears in a real
// share is the manual half of P6-13, like the P6-12 app checks. Cross-platform: the
// call contract holds on every OS; the visual effect is Windows-only.
import { expect, test } from '@playwright/test'
import { Harness } from './harness'

type Call = { which: string; skip: boolean }

/** Wrap setSkipTaskbar on every live window so we can see which window our code calls. */
async function spy(h: Harness) {
  await h.app.evaluate(({ BrowserWindow }) => {
    const g = globalThis as any
    g.__taskbar = [] as { which: string; skip: boolean }[]
    const name = (u: string) => (u.includes('#/overlay') ? 'overlay' : u.includes('#/bubble') ? 'bubble' : u.includes('#/snap') ? 'snap' : 'other')
    for (const w of BrowserWindow.getAllWindows()) {
      const which = name(w.webContents.getURL())
      const orig = w.setSkipTaskbar.bind(w)
      w.setSkipTaskbar = (skip: boolean) => {
        g.__taskbar.push({ which, skip })
        return orig(skip)
      }
    }
  })
}

async function calls(h: Harness): Promise<Call[]> {
  return h.app.evaluate(() => (globalThis as any).__taskbar as Call[])
}
async function clear(h: Harness) {
  await h.app.evaluate(() => void ((globalThis as any).__taskbar = []))
}

test('P6-13: Private toggle flips the overlay taskbar flag only; bubble and snap untouched', async () => {
  const h = await new Harness('private-taskbar').launch()
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    expect((await h.call('settings.get')).value.privateMode).toBe(true)
    await spy(h)

    // Private on -> off: the overlay's button comes back, nothing else is touched.
    await clear(h)
    expect((await h.call('settings.update', { privateMode: false })).ok).toBe(true)
    const off = await calls(h)
    expect(off, 'off: exactly the overlay, skip=false').toEqual([{ which: 'overlay', skip: false }])

    // off -> on: the overlay's button is hidden again, nothing else is touched.
    await clear(h)
    expect((await h.call('settings.update', { privateMode: true })).ok).toBe(true)
    const on = await calls(h)
    expect(on, 'on: exactly the overlay, skip=true').toEqual([{ which: 'overlay', skip: true }])

    // A second round, to show it tracks the setting and never leaks onto bubble/snap.
    await clear(h)
    await h.call('settings.update', { privateMode: false })
    await h.call('settings.update', { privateMode: true })
    const round2 = await calls(h)
    expect(round2).toEqual([
      { which: 'overlay', skip: false },
      { which: 'overlay', skip: true },
    ])
    expect(round2.some((c) => c.which !== 'overlay'), 'bubble/snap never touched').toBe(false)

    // The overlay is still there and focusable after toggling (no taskbar button needed).
    const st = await h.app.evaluate(({ BrowserWindow }) => {
      const o = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('#/overlay'))
      if (!o) return null
      o.focus()
      return { visible: o.isVisible(), focused: o.isFocused(), destroyed: o.isDestroyed() }
    })
    expect(st?.visible).toBe(true)
    expect(st?.destroyed).toBe(false)

    expect((await h.call('settings.get')).value.privateMode).toBe(true)
  } finally {
    await h.close()
  }
})
