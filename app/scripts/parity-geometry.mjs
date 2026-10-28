// Geometry checks behind replica/parity.md (V-01..V-03): things that would be cut off by the
// Electron window, which main sizes to the overlay frame. Exits 1 if any check fails.
// Usage: npm run dev:web, then node scripts/parity-geometry.mjs
import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://localhost:5199/'
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
const results = []
const check = (id, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'pass' : 'FAIL'}  ${id}  ${JSON.stringify(detail)}`)
}
async function fresh(empty = false) {
  await page.goto(`${BASE}#/overlay`)
  await page.evaluate((e) => {
    localStorage.clear()
    if (e) localStorage.setItem('parley:mock', 'empty')
  }, empty)
  await page.reload()
  await page.waitForTimeout(300)
}
const overflow = (loc) => loc.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, scrollH: el.scrollHeight, clientH: el.clientHeight }))

// V-01 live bar: every control inside the bar, at the default width and squeezed to 700px
await fresh()
await page.getByRole('button', { name: 'Rejoin Fabrikam Labs' }).click()
await page.getByRole('button', { name: 'Rejoin' }).last().click().catch(() => {})
const bar = page.getByRole('toolbar', { name: 'Call controls' })
await bar.waitFor({ timeout: 15000 })
await page.waitForTimeout(2000)
const end = async () => bar.evaluate((el) => Math.round(el.lastElementChild.getBoundingClientRect().right - el.getBoundingClientRect().right))
let o = await overflow(bar)
check('V-01 bar fits (760)', o.scroll <= o.client && (await end()) <= 0, { ...o, endPastBar: await end(), keyHints: await bar.locator('kbd').count() })
await page.evaluate(() => document.documentElement.style.setProperty('--tk-layout-livebar-w', '700px'))
await page.waitForTimeout(1500)
o = await overflow(bar)
check('V-01 bar fits (700, hints dropped)', o.scroll <= o.client && (await end()) <= 0, { ...o, endPastBar: await end(), keyHints: await bar.locator('kbd').count() })
await page.evaluate(() => document.documentElement.style.removeProperty('--tk-layout-livebar-w'))

// V-02 answer preferences sub-panes need no scrolling (setup wizard)
await fresh()
await page.getByRole('button', { name: 'Create session' }).click()
await page.getByLabel('Company').fill('Microsoft')
await page.getByRole('option', { name: /Microsoft/ }).first().click()
await page.getByRole('button', { name: 'Next' }).click()
await page.getByRole('button', { name: 'Configure' }).click()
await page.getByRole('region', { name: 'Answer preview' }).waitFor()
for (const p of ['Format', 'Length', 'Tone']) {
  await page.getByRole('button', { name: new RegExp(`^${p}`) }).click()
  await page.waitForTimeout(300)
  o = await overflow(page.locator('section[aria-label="Preferences"] .overflow-y-auto'))
  check(`V-02 ${p} pane fits`, o.scrollH <= o.clientH, { scrollH: o.scrollH, clientH: o.clientH })
  await page.getByRole('button', { name: p, exact: true }).click()
  await page.waitForTimeout(200)
}

// V-03 create session step 1: the Context row is visible without scrolling (one resume on file)
await fresh()
await page.getByRole('button', { name: 'Create session' }).click()
await page.getByRole('heading', { name: 'Create session' }).waitFor()
await page.waitForTimeout(400)
const form = page.locator('form .overflow-y-auto').first()
const fb = await form.boundingBox()
const docs = await page.getByRole('combobox', { name: /^Documents/ }).boundingBox()
check('V-03 Context row above the fold', docs.y + docs.height <= fb.y + fb.height, { docsBottom: Math.round(docs.y + docs.height), formBottom: Math.round(fb.y + fb.height) })

await browser.close()
process.exit(results.every(Boolean) ? 0 : 1)
