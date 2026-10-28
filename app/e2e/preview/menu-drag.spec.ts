// Browser preview (npm run dev:web, mock data): the live bar's ⋮ menu by mouse, and the
// simulated window drag on the same toolbar. Electron doesn't use useSimDrag (app-region), so
// this only guards the preview, which build-log keeps on purpose for demos and ?mock= scenarios.
import { expect, test } from '@playwright/test'

const BASE = process.env.BASE ?? 'http://localhost:5199/'

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${BASE}#/overlay`)
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Rejoin Fabrikam Labs' }).click()
  await page.getByRole('button', { name: 'Rejoin' }).last().click({ timeout: 3000 }).catch(() => {})
  await page.getByRole('toolbar', { name: 'Call controls' }).waitFor({ timeout: 15_000 })
})

for (const [item, heading] of [['Answer preferences', /Answer preferences/], ['AI instructions', /instructions/i]] as const) {
  test(`⋮ › ${item} opens by mouse`, async ({ page }) => {
    await page.getByRole('button', { name: 'More options' }).click()
    await page.getByRole('menuitem', { name: item }).click()
    await expect(page.getByRole('dialog').filter({ hasText: heading })).toBeVisible({ timeout: 3000 })
  })
}

test('⋮ menu by keyboard still works', async ({ page }) => {
  await page.getByRole('button', { name: 'More options' }).focus()
  await page.keyboard.press('Enter')
  await page.getByRole('menuitem', { name: 'Answer preferences' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog').filter({ hasText: /Answer preferences/ })).toBeVisible({ timeout: 3000 })
})

test('dragging the toolbar background still moves the simulated window', async ({ page }) => {
  const bar = page.getByRole('toolbar', { name: 'Call controls' })
  const before = (await bar.boundingBox())!
  // a spot where the toolbar itself (not a control) is the topmost element
  const spot = await bar.evaluate((el) => {
    const r = el.getBoundingClientRect()
    for (let x = r.left + 1; x < r.right; x += 2) if (document.elementFromPoint(x, r.top + r.height / 2) === el) return x
    return null
  })
  expect(spot, 'toolbar has a draggable background spot').not.toBeNull()
  const x = spot!, y = before.y + before.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - 60, y + 40, { steps: 6 }) // left: the window starts against the right edge
  await page.mouse.up()
  await page.waitForTimeout(300)
  const after = (await bar.boundingBox())!
  expect(Math.round(before.x - after.x)).toBeGreaterThan(30)
  expect(Math.round(after.y - before.y)).toBeGreaterThan(20)
})

test('S03 header ⋮ › Private toggles by mouse (same drag hook on the panel header)', async ({ page }) => {
  await page.goto(`${BASE}#/overlay`)
  await page.getByRole('heading', { level: 1 }).first().waitFor()
  const header = page.locator('header').first()
  await header.getByRole('button', { name: 'More options' }).click()
  const item = page.getByRole('menuitemcheckbox', { name: /Private/ })
  const was = await item.getAttribute('aria-checked')
  await item.click() // checkbox items keep the menu open
  await expect(page.getByRole('menuitemcheckbox', { name: /Private/ })).toHaveAttribute('aria-checked', was === 'true' ? 'false' : 'true', { timeout: 3000 })
})
