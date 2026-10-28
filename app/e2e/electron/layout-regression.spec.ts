// Functional regression for the /replica-diff layout fixes (parity.md V-01..V-03), in the real
// Electron window (main sizes it to the overlay frame, so anything outside the frame is cut off).
// Fake provider, 0 Gemini calls. Job pages come from a local HTTP server on 127.0.0.1.
import { expect, test, type Locator } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Harness, WORK } from './harness'

const report: Record<string, unknown> = {}

/** On screen in the window and the topmost element at its centre (so a real click lands on it). */
async function reachable(loc: Locator) {
  return loc.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const top = document.elementFromPoint(cx, cy)
    return {
      inWindow: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5,
      onTop: !!top && (top === el || el.contains(top)),
      right: Math.round(r.right),
      bottom: Math.round(r.bottom),
      win: [window.innerWidth, window.innerHeight],
    }
  })
}
const ok = (r: { inWindow: boolean; onTop: boolean }) => r.inWindow && r.onTop

async function overlayBounds(h: Harness) {
  return h.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('#/overlay'))
    return w?.getContentBounds() ?? null
  })
}

test.afterAll(() => writeFileSync(join(WORK, 'report-layout.json'), JSON.stringify(report, null, 2)))

test('LB: live bar End and ⋮ reachable and working at normal and narrow widths', async () => {
  const h = await new Harness('layout-bar').launch()
  const r: Record<string, unknown> = {}
  report.liveBar = r
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    const s = await h.createSession({ autoGenerate: false })
    await h.goLive(s.id)
    const bar = h.page.getByRole('toolbar', { name: 'Call controls' })
    const more = bar.getByRole('button', { name: 'More options' })
    const end = bar.getByRole('button', { name: 'End call' })
    await h.page.waitForTimeout(1500) // fit() settles the window size

    const check = async (label: string) => {
      await h.page.waitForTimeout(800)
      const o = { more: await reachable(more), end: await reachable(end), bar: await bar.evaluate((el) => [el.scrollWidth, el.clientWidth]), keyHints: await bar.locator('kbd').count(), bounds: await overlayBounds(h) }
      r[label] = o
      expect.soft(ok(o.more), `${label}: ⋮ reachable ${JSON.stringify(o.more)}`).toBe(true)
      expect.soft(ok(o.end), `${label}: End reachable ${JSON.stringify(o.end)}`).toBe(true)
      expect.soft(o.bar[0]! <= o.bar[1]!, `${label}: bar content fits ${o.bar}`).toBe(true)
      return o
    }

    const normal = await check('760 (default)')
    expect.soft(normal.keyHints, 'key hints shown at the default width').toBeGreaterThan(0)
    // accessible names keep the shortcut even when hints are dropped
    const answerName = await bar.getByRole('button', { name: /^Answer/ }).getAttribute('aria-keyshortcuts')
    r.answerKeyshortcuts = answerName
    expect.soft(answerName, 'Answer keeps aria-keyshortcuts').toBeTruthy()

    for (const w of ['700px', '640px']) {
      await h.page.evaluate((v) => document.documentElement.style.setProperty('--tk-layout-livebar-w', v), w)
      const o = await check(w)
      expect.soft(o.keyHints, `${w}: key hints dropped`).toBe(0)
      expect.soft(await bar.getByRole('button', { name: /^Answer/ }).getAttribute('aria-keyshortcuts'), `${w}: Answer keeps aria-keyshortcuts`).toBe(answerName)
    }
    await h.page.evaluate(() => document.documentElement.style.removeProperty('--tk-layout-livebar-w'))

    // zoom 125% (the S04 zoom setting): the window grows with the bar, End still inside
    const z = await h.call('settings.update', { zoom: 1.25 })
    expect(z.ok, z.error).toBe(true)
    await check('zoom 1.25')
    await h.call('settings.update', { zoom: 1 })
    const back = await check('zoom back to 1')
    expect.soft(back.keyHints, 'key hints come back at 100%').toBeGreaterThan(0)

    // ⋮ by mouse → Answer preferences opens; Escape closes
    await more.click()
    await h.page.getByRole('menuitem', { name: 'Answer preferences' }).click()
    await expect(h.page.getByRole('dialog')).toBeVisible()
    await h.page.keyboard.press('Escape')
    await expect(h.page.getByRole('dialog')).toHaveCount(0)
    await more.click()
    await h.page.getByRole('menuitem', { name: 'AI instructions' }).click()
    await expect(h.page.getByRole('dialog')).toBeVisible()
    await h.page.keyboard.press('Escape')
    await expect(h.page.getByRole('dialog')).toHaveCount(0)
    r.menuByMouse = 'ok'

    // End by mouse → S26 → Leave for now: the session is left
    await end.click()
    const dlg = h.page.getByRole('dialog', { name: 'Leave or end this call?' })
    await expect(dlg).toBeVisible()
    const leave = dlg.getByRole('button', { name: 'Leave for now' })
    r.s26Leave = await reachable(leave)
    expect.soft(ok(r.s26Leave as any), 'S26 Leave reachable').toBe(true)
    await leave.click()
    await expect.poll(async () => (await h.call('sessions.get', { id: s.id })).value?.status, { timeout: 10_000 }).toBe('left')
    r.leftStatus = 'left'
    expect(h.errors, 'no console errors').toEqual([])
  } finally {
    await h.close()
  }
})

test('LB-M: Mock session (extra "Next question" chip) keeps End and ⋮ inside', async () => {
  const h = await new Harness('layout-mock').launch()
  const r: Record<string, unknown> = {}
  report.liveBarMock = r
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    const c = await h.call('sessions.create', {
      type: 'mock', companyName: 'Contoso', companyDomain: null, roleTitle: 'Backend Engineer', jobUrl: null, jobDescription: 'C#.',
      resumeId: null, documentIds: [], language: 'en-US', model: 'google:gemini-flash-lite', instructions: '', autoGenerate: false, saveTranscript: true,
    })
    expect(c.ok, c.error).toBe(true)
    await h.goLive(c.value.id)
    const bar = h.page.getByRole('toolbar', { name: 'Call controls' })
    await h.page.waitForTimeout(1500)
    r.chips = await bar.getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent?.trim()))
    r.end = await reachable(bar.getByRole('button', { name: 'End call' }))
    r.more = await reachable(bar.getByRole('button', { name: 'More options' }))
    r.bar = await bar.evaluate((el) => [el.scrollWidth, el.clientWidth])
    expect.soft(ok(r.end as any), `mock: End reachable ${JSON.stringify(r.end)}`).toBe(true)
    expect.soft(ok(r.more as any), 'mock: ⋮ reachable').toBe(true)
    await bar.getByRole('button', { name: 'End call' }).click()
    await expect(h.page.getByRole('dialog', { name: 'Leave or end this call?' })).toBeVisible()
    await h.page.keyboard.press('Escape')
  } finally {
    await h.close()
  }
})

test('PM: mid-call Answer preferences grows the window, every control reachable, shrinks on close', async () => {
  const h = await new Harness('layout-prefs').launch()
  const r: Record<string, unknown> = {}
  report.prefs = r
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    const s = await h.createSession({ autoGenerate: false })
    await h.goLive(s.id)
    await h.page.waitForTimeout(1500)
    const before = await overlayBounds(h)
    r.before = before
    await h.page.getByRole('button', { name: 'More options' }).click()
    await h.page.getByRole('menuitem', { name: 'Answer preferences' }).click()
    const dlg = h.page.getByRole('dialog')
    await expect(dlg).toBeVisible()
    await h.page.waitForTimeout(1200)
    const open = await overlayBounds(h)
    r.open = open
    expect.soft(open!.height, 'window grows for the modal').toBeGreaterThan(before!.height)
    r.dialogBox = await dlg.boundingBox()

    const panes: Record<string, unknown> = {}
    r.panes = panes
    for (const p of ['Format', 'Length', 'Tone']) {
      await dlg.getByRole('button', { name: new RegExp(`^${p}`) }).click()
      await h.page.waitForTimeout(300)
      const controls = dlg.locator('[role="radio"],[role="switch"],input[type="radio"],input[type="checkbox"]')
      const n = await controls.count()
      const res = []
      for (let i = 0; i < n; i++) {
        const c = controls.nth(i)
        if (!(await c.isVisible())) continue
        const rr = await reachable(c)
        res.push({ name: (await c.getAttribute('aria-label')) ?? (await c.evaluate((e) => (e.closest('label') ?? e.parentElement)?.textContent?.trim().slice(0, 40))), ...rr })
      }
      const scroll = await dlg.locator('.overflow-y-auto').first().evaluate((el) => [el.scrollHeight, el.clientHeight]).catch(() => null)
      panes[p] = { controls: res, scroll }
      expect.soft(res.length, `${p}: has controls`).toBeGreaterThan(0)
      for (const c of res) expect.soft(c.inWindow && c.onTop, `${p}: ${c.name} reachable ${JSON.stringify(c)}`).toBe(true)
      if (scroll) expect.soft(scroll[0]! <= scroll[1]! + 1, `${p}: pane doesn't scroll ${scroll}`).toBe(true)
      // operate one control: the first unchecked radio/switch toggles
      await dlg.getByRole('button', { name: p, exact: true }).click().catch(() => {})
      await h.page.waitForTimeout(200)
    }

    // change Length by mouse and save; the session's prefs change
    await dlg.getByRole('button', { name: /^Length/ }).click()
    const radios = dlg.getByRole('radio')
    const target = radios.nth(0)
    const targetLabel = await target.evaluate((e) => (e.closest('label') ?? e.parentElement)?.textContent?.trim() ?? '')
    await target.click()
    const save = dlg.getByRole('button', { name: 'Save' })
    r.save = await reachable(save)
    expect.soft(ok(r.save as any), 'Save reachable').toBe(true)
    await save.click()
    await expect(dlg).toHaveCount(0)
    const sess = (await h.call('sessions.get', { id: s.id })).value
    r.savedPrefs = { length: sess?.answerPrefs?.length, picked: targetLabel.slice(0, 30) }
    await h.page.waitForTimeout(1500)
    const after = await overlayBounds(h)
    r.after = after
    expect.soft(after!.height, 'window shrinks back after close').toBeLessThanOrEqual(before!.height + 2)
    expect.soft(Math.abs(after!.width - before!.width), 'width unchanged').toBeLessThanOrEqual(2)
    expect(h.errors, 'no console errors').toEqual([])
  } finally {
    await h.close()
  }
})

test('ZM: overlay panel (S03) at 125% zoom: window grows, footer button and ⋮ reachable', async () => {
  const h = await new Harness('layout-zoom').launch()
  const r: Record<string, unknown> = {}
  report.panelZoom = r
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    await h.page.waitForTimeout(800)
    const create = h.page.getByRole('button', { name: 'Create session' })
    const more = h.page.locator('header').getByRole('button', { name: 'More options' })
    r.at100 = { bounds: await overlayBounds(h), create: await reachable(create), more: await reachable(more) }
    expect((await h.call('settings.update', { zoom: 1.25 })).ok).toBe(true)
    await h.page.waitForTimeout(1200)
    r.at125 = { bounds: await overlayBounds(h), create: await reachable(create), more: await reachable(more) }
    const a = r.at100 as any, b = r.at125 as any
    expect.soft(b.bounds.width, 'window wider at 125%').toBeGreaterThan(a.bounds.width * 1.2)
    expect.soft(ok(b.create), `Create session reachable at 125% ${JSON.stringify(b.create)}`).toBe(true)
    expect.soft(ok(b.more), 'header ⋮ reachable at 125%').toBe(true)
    // reset from the ⋮ menu by mouse
    await more.click()
    await h.page.getByRole('button', { name: 'Reset zoom' }).click()
    await expect.poll(async () => (await h.call('settings.get', {})).value?.zoom, { timeout: 5000 }).toBe(1)
    await h.page.keyboard.press('Escape')
    await h.page.waitForTimeout(1200)
    r.reset = await overlayBounds(h)
    expect.soft(Math.abs((r.reset as any).width - a.bounds.width), 'back to the 100% width').toBeLessThanOrEqual(2)
    expect(h.errors, 'no console errors').toEqual([])
  } finally {
    await h.call('settings.update', { zoom: 1 }).catch(() => {})
    await h.close()
  }
})

let server: Server
let base = ''
test.beforeAll(async () => {
  const desc = 'We are looking for a Backend Engineer to build distributed services in C# and .NET. ' + 'You will design APIs, own reliability, and mentor others. '.repeat(4)
  const ld = { '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Senior Backend Engineer', hiringOrganization: { '@type': 'Organization', name: 'Northwind Traders' }, description: `<p>${desc}</p>` }
  const page = `<html><head><title>Job</title><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><h1>Senior Backend Engineer</h1></body></html>`
  server = createServer((req, res) => {
    if (req.url === '/job') return res.writeHead(200, { 'content-type': 'text/html' }).end(page)
    if (req.url === '/slow') return void setTimeout(() => res.writeHead(200, { 'content-type': 'text/html' }).end(page), 2500)
    if (req.url === '/empty') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>Sign in</body></html>')
    res.writeHead(404).end('nope')
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
test.afterAll(() => server?.close())

test('CS: Create session half-width Company autocomplete, validation, and job-link import states', async () => {
  const h = await new Harness('layout-create').launch()
  const r: Record<string, unknown> = {}
  report.create = r
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    await h.page.getByRole('button', { name: 'Create session' }).click()
    const company = h.page.getByRole('combobox', { name: 'Company' })
    await company.waitFor()
    await h.page.waitForTimeout(800)
    const cb = (await company.boundingBox())!
    r.companyBox = cb
    r.window = await h.page.evaluate(() => [window.innerWidth, window.innerHeight])
    // half-width: Company and Role share one row
    const role = h.page.getByLabel(/Role|job title/i).first()
    const rb = (await role.boundingBox())!
    r.roleBox = rb
    expect.soft(Math.abs(cb.y - rb.y) < 4 && rb.x > cb.x + cb.width - 4, 'Company and Role side by side').toBe(true)

    // autocomplete: a known company appears in the list, inside the window, and picking it fills the field
    await company.fill('Micro')
    const list = h.page.getByRole('listbox')
    await expect(list).toBeVisible()
    const opt = h.page.getByRole('option', { name: /Microsoft/ }).first()
    r.option = await reachable(opt)
    expect.soft(ok(r.option as any), `option reachable ${JSON.stringify(r.option)}`).toBe(true)
    r.listBox = await list.boundingBox()
    await opt.click()
    await expect(company).toHaveValue(/Microsoft/)
    await expect(list).toHaveCount(0)
    // keyboard: free text option via arrows + Enter
    await company.fill('Zyxwv Labs')
    await expect(h.page.getByRole('option', { name: /Use "Zyxwv Labs"/ })).toBeVisible()
    await company.press('ArrowDown')
    await company.press('Enter')
    await expect(company).toHaveValue('Zyxwv Labs')
    r.autocomplete = 'ok'

    // over-long names can't be typed: the field caps at its maxlength (the "too long" error is a backstop)
    await company.fill('x'.repeat(260))
    const max = Number(await company.getAttribute('maxlength'))
    r.tooLong = { maxlength: max, typed: (await company.inputValue()).length }
    expect.soft((await company.inputValue()).length, 'Company capped at maxlength').toBeLessThanOrEqual(max)
    await company.fill('')
    await h.page.keyboard.press('Escape')

    // job-link import: invalid link → inline error
    await h.page.getByRole('button', { name: 'Paste a job link' }).click()
    const link = h.page.getByLabel('Job post link')
    await link.fill('not a link')
    await h.page.getByRole('button', { name: 'Import' }).click()
    await expect(h.page.getByText('Paste a full link starting with https://')).toBeVisible()
    // 404 → error, Import still reachable for another try
    await link.fill(`${base}/missing`)
    await h.page.getByRole('button', { name: 'Import' }).click()
    await expect(h.page.getByText(/returned an error \(404\)/)).toBeVisible({ timeout: 15_000 })
    r.importBtn = await reachable(h.page.getByRole('button', { name: 'Import' }))
    expect.soft(ok(r.importBtn as any), 'Import reachable in the half-width form').toBe(true)
    // page with no job post → error
    await link.fill(`${base}/empty`)
    await h.page.getByRole('button', { name: 'Import' }).click()
    await expect(h.page.getByText(/couldn't find a job post/)).toBeVisible({ timeout: 15_000 })
    // slow page → loading state (busy label, input and Cancel disabled), then fills Company + Role
    await link.fill(`${base}/slow`)
    await h.page.getByRole('button', { name: 'Import' }).click()
    await expect(h.page.getByText('Reading…')).toBeVisible({ timeout: 2000 })
    await expect(link).toBeDisabled()
    await expect(h.page.getByRole('button', { name: 'Cancel', exact: true }).first()).toBeDisabled()
    r.loading = 'ok'
    await expect(h.page.getByRole('status').filter({ hasText: /Imported from 127\.0\.0\.1/ })).toBeVisible({ timeout: 15_000 })
    await expect(company).toHaveValue('Northwind Traders')
    await expect(role).toHaveValue('Senior Backend Engineer')
    const jd = await h.page.getByLabel('Job description').inputValue()
    r.imported = { company: 'Northwind Traders', role: 'Senior Backend Engineer', jdChars: jd.length }
    expect(jd).toContain('distributed services')
    // a second import doesn't overwrite what the user already has in Company / Role
    await h.page.getByRole('button', { name: 'Import from another link' }).click()
    await company.fill('Contoso')
    await link.fill(`${base}/job`)
    await h.page.getByRole('button', { name: 'Import' }).click().catch(() => {})
    await expect(h.page.getByRole('button', { name: 'Import from another link' })).toBeVisible({ timeout: 15_000 })
    r.reimportKeepsCompany = await company.inputValue()
    // the form is still usable: Next goes to step 2
    await h.page.getByRole('button', { name: 'Next' }).click()
    await expect(h.page.getByRole('heading', { name: /Step 2/ })).toBeAttached({ timeout: 5000 })
    r.providerRequests = h.requests().length
    expect(h.requests().length, 'JSON-LD import needs no model call').toBe(0)
    expect(h.errors, 'no console errors').toEqual([])
  } finally {
    await h.close()
  }
})
