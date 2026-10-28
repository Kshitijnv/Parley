// Accessibility scan (axe-core, WCAG 2 A/AA rules) of the main screens in the real app,
// fake provider. Serious and critical violations fail; the full list goes to the report.
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Harness, WORK } from './harness'

test('axe scan: S03, S07, S08, S12, S13/S14, library screens', async () => {
  const h = await new Harness('a11y').launch()
  const report: Record<string, unknown> = {}
  try {
    await h.page.getByText('No calls yet').waitFor({ timeout: 20_000 })
    const scan = async (name: string) => {
      await h.page.waitForTimeout(600)
      const r = await new AxeBuilder({ page: h.page }).setLegacyMode(true).withTags(['wcag2a', 'wcag2aa']).analyze()
      report[name] = { passes: r.passes.length, heading: await h.page.locator('h1, h2').first().textContent().catch(() => null), violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target.join(' ') })) }
      return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    }
    const bad: Record<string, string[]> = {}
    const go = async (name: string, hash: string) => {
      await h.page.evaluate((x) => (location.hash = x), hash)
      const v = await scan(name)
      if (v.length) bad[name] = v.map((x) => `${x.id} (${x.nodes.length})`)
    }
    await go('S03 session list', '#/overlay')
    await go('S07 create step 1', '#/overlay/create')
    await h.page.getByLabel('Company').fill('Contoso').catch(() => {})
    await h.page.getByRole('option', { name: /Use "Contoso"/ }).click().catch(() => {})
    await h.page.getByRole('button', { name: 'Next' }).click().catch(() => {})
    const v8 = await scan('S08 create step 2')
    if (v8.length) bad['S08 create step 2'] = v8.map((x) => `${x.id} (${x.nodes.length})`)
    h.setScript({ default: { firstTokenMs: 100, chunkMs: 20 } })
    const s = await h.createSession({ autoGenerate: false })
    await go('S12 connect', `#/overlay/connect/${s.id}`)
    await h.goLive(s.id)
    const a = await h.gen(s.id, 'chat', { text: 'What is a closure?' })
    await h.waitEnd(a.value?.answerId)
    const v13 = await scan('S13/S14 live bar + answer')
    if (v13.length) bad['S13/S14 live bar + answer'] = v13.map((x) => `${x.id} (${x.nodes.length})`)
    await h.call('sessions.end', { id: s.id, mode: 'leave' })
    for (const [name, hash] of [['S16 resumes', '#/library/resumes'], ['S21 documents', '#/library/documents'], ['S22 calls', '#/library/calls'], ['Settings', '#/library/settings']]) await go(name!, hash!)
    report.seriousOrCritical = bad
    expect.soft(bad, 'no serious or critical axe violations').toEqual({})
  } finally {
    writeFileSync(join(WORK, 'report-a11y.json'), JSON.stringify(report, null, 2))
    await h.close()
  }
})
