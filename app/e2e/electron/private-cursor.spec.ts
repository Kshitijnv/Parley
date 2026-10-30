// Private mode static cursor (feature #39, architecture.md revision 8, test P6-14).
// The overlay layer (body:not(.solid-page): overlay, bubble, snap) forces cursor:default
// on every element so a screen share can't read the hidden overlay from the pointer's
// shape. The library window (body.solid-page) keeps native cursors. This checks the
// computed cursor in the real Electron/Chromium DOM, so the CSS cascade and the
// unlayered !important actually resolve (jsdom wouldn't). Elements are injected rather
// than hunted through app states, so the test exercises the selectors directly and
// doesn't depend on being live or on an answer card existing.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { Harness } from './harness'

/** Append the four element types, read their computed cursor, then clean up. */
const CURSORS = `(() => {
  const mk = (tag, fn) => { const el = document.createElement(tag); fn && fn(el); el.dataset.p6 = '1'; document.body.appendChild(el); return el }
  const input = mk('input')
  const button = mk('button', (b) => (b.textContent = 'x'))
  const disabled = mk('button', (b) => { b.textContent = 'x'; b.disabled = true })
  const handle = mk('div', (d) => (d.className = 'resize-handle'))
  const cur = (el) => getComputedStyle(el).cursor
  const out = { input: cur(input), button: cur(button), disabled: cur(disabled), handle: cur(handle) }
  // The pointer shape is the only thing forced: the caret and selection must be intact.
  input.focus()
  out.caretWorks = document.activeElement === input
  out.userSelect = getComputedStyle(input).userSelect
  for (const el of document.querySelectorAll('[data-p6]')) el.remove()
  return out
})()`

async function cursors(page: Page) {
  return page.evaluate(CURSORS) as Promise<Record<string, string | boolean>>
}

/** The library window's Playwright page, once it has opened and loaded its route. */
async function libraryPage(h: Harness): Promise<Page | null> {
  for (let i = 0; i < 100; i++) {
    const p = h.app.windows().find((w) => w.url().includes('#/library'))
    if (p) return p
    await h.page.waitForTimeout(100)
  }
  return null
}

test('P6-14: overlay forces a default cursor on every element; library keeps native cursors', async () => {
  const h = await new Harness('private-cursor').launch()
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })

    // Overlay (body has no solid-page): every element resolves to the plain arrow.
    await expect.poll(() => h.page.evaluate(() => document.body.classList.contains('solid-page'))).toBe(false)
    const ov = await cursors(h.page)
    expect(ov.input, 'overlay text input').toBe('default')
    expect(ov.button, 'overlay button (base rule says pointer)').toBe('default')
    expect(ov.disabled, 'overlay disabled button (base rule says not-allowed)').toBe('default')
    expect(ov.handle, 'overlay .resize-handle (nwse-resize)').toBe('default')
    // Only the pointer shape is forced: focus/caret and text selection are untouched.
    expect(ov.caretWorks, 'overlay input still takes focus/caret').toBe(true)
    expect(ov.userSelect, 'overlay input selection not disabled').not.toBe('none')

    // Independent of the Private setting.
    await h.call('settings.update', { privateMode: false })
    expect((await cursors(h.page)).button, 'still default with Private off').toBe('default')
    await h.call('settings.update', { privateMode: true })

    // Library window (body.solid-page): the rule did not leak; native cursors return.
    expect((await h.call('window.openLibrary', { route: '/' })).ok).toBe(true)
    const page = await libraryPage(h)
    expect(page, 'library window opened').toBeTruthy()
    if (!page) return
    await page.waitForLoadState('domcontentloaded')
    await expect.poll(() => page.evaluate(() => document.body.classList.contains('solid-page')), { timeout: 10_000 }).toBe(true)
    const libc = await cursors(page)
    expect(libc.input, 'library text input is native text').toBe('text')
    expect(libc.button, 'library button is native pointer').toBe('pointer')
    expect(libc.disabled, 'library disabled button is not-allowed').toBe('not-allowed')

    expect(h.errors).toEqual([])
  } finally {
    await h.close()
  }
})
