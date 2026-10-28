// Crops the app window out of each reference photo (replica/screens/*.jpeg) into
// replica/diffs/ref/<id>.png for imgdiff.py. Chromium applies the EXIF rotation.
// Boxes live in replica/diffs/refcrops.json. Reads the references, never writes them.
import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const R = resolve(import.meta.dirname, '../../replica')
const crops = JSON.parse(readFileSync(`${R}/diffs/refcrops.json`, 'utf8'))
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage()
for (const [id, c] of Object.entries(crops)) {
  if (id.startsWith('_')) continue
  const b64 = readFileSync(`${R}/screens/${c.src}`).toString('base64')
  const out = await page.evaluate(async ([src, box]) => {
    const img = new Image()
    img.src = src
    await img.decode()
    const [x0, y0, x1, y1] = box
    const cv = document.createElement('canvas')
    cv.width = x1 - x0
    cv.height = y1 - y0
    cv.getContext('2d').drawImage(img, x0, y0, cv.width, cv.height, 0, 0, cv.width, cv.height)
    return { w: img.naturalWidth, h: img.naturalHeight, png: cv.toDataURL('image/png').split(',')[1] }
  }, [`data:image/jpeg;base64,${b64}`, c.box])
  writeFileSync(`${R}/diffs/ref/${id}.png`, Buffer.from(out.png, 'base64'))
  console.log(id, c.src, `${out.w}x${out.h}`, '->', `${c.box[2] - c.box[0]}x${c.box[3] - c.box[1]}`)
}
await browser.close()
