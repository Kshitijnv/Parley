// Quick runtime check of the browser preview: walks F01 end to end on demo data and
// prints console errors. Usage: npm run dev:web (in another shell), then
//   node scripts/smoke.mjs [outDir]
import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://localhost:5199/'
const out = process.argv[2]
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(String(e)))
const shot = async (name) => out && (await page.screenshot({ path: `${out}/${name}.png` }))
const step = (s) => console.log('·', s)

await page.goto(`${BASE}?mock=#/overlay`)
await page.evaluate(() => localStorage.clear())
await page.goto(`${BASE}#/overlay`)
await page.getByRole('heading', { name: 'Northwind Systems' }).waitFor()
step('S03 list with seed sessions')
await shot('S03')

await page.getByRole('button', { name: 'Create session' }).click()
await page.getByLabel('Company').fill('Contoso')
await page.getByRole('option', { name: /Use "Contoso"/ }).click()
await page.getByLabel('Job description').fill('Backend engineer on .NET and SQL Server.')
await shot('S07')
await page.getByRole('button', { name: 'Next' }).click()
await page.getByText('Answer preferences').first().waitFor()
step('S08 preferences')
await shot('S08')
await page.getByRole('button', { name: 'Create interview session' }).click()
await page.getByRole('heading', { name: 'Connect to your call' }).waitFor()
step('S12 connect')
await shot('S12')
await page.getByRole('button', { name: 'Connect' }).click()
await page.getByRole('toolbar', { name: 'Call controls' }).waitFor({ timeout: 15000 })
step('S13 live')
await page.waitForTimeout(6000)
await shot('S13')
await page.keyboard.press('Control+Enter')
await page.getByText('Question:').first().waitFor()
await page.waitForTimeout(4000)
step('S14 answer')
await shot('S14')
await page.getByRole('button', { name: 'End call' }).click()
await page.getByRole('button', { name: 'End call' }).last().click()
await page.getByRole('heading', { name: 'Contoso' }).waitFor()
step('back on S03 with the new call')
await page.waitForTimeout(6000)
await shot('S15')

console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors')
await browser.close()
