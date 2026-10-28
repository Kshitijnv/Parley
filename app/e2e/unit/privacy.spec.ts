// Private mode service (architecture.md revision 3 P4, P6-10, P6-11) against a fake
// BrowserWindow. This proves call order and timer handling only: whether a real
// capture shows the window, a black box or the backdrop is a pixel question (P6).
import { expect, test } from '@playwright/test'
import { EventEmitter } from 'node:events'
import { applyProtection, capability, hold, privacyCapability, release, reveal, REVEAL_MS, setPrivateFlag } from '../../src/main/privacy'

class FakeWin extends EventEmitter {
  log: string[] = []
  visible = false
  destroyed = false
  opacity = 1
  isDestroyed = () => this.destroyed
  isVisible = () => this.visible
  show = () => (this.log.push('show'), (this.visible = true))
  showInactive = () => (this.log.push('showInactive'), (this.visible = true))
  hide = () => {
    this.log.push('hide')
    this.visible = false
    this.emit('hide')
  }
  focus = () => this.log.push('focus')
  setOpacity = (o: number) => {
    if (this.destroyed) throw new Error('Object has been destroyed')
    this.opacity = o
    this.log.push(`opacity:${o}`)
  }
  setContentProtection = (on: boolean) => {
    if (this.destroyed) throw new Error('Object has been destroyed')
    this.log.push(`protect:${on}`)
  }
}
const fake = () => new FakeWin() as unknown as Electron.BrowserWindow & FakeWin
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test.describe.configure({ mode: 'serial' })
test.afterEach(() => setPrivateFlag(true))

test('P6-11 capability per platform and build', () => {
  for (const b of ['10.0.19041', '10.0.19045', '10.0.22631']) expect(privacyCapability('win32', b).mode).toBe('exclude')
  expect(privacyCapability('win32', '10.0.18363').mode).toBe('blackbox')
  expect(privacyCapability('win32', '10.0.18363').reason).toContain('black box')
  expect(privacyCapability('win32', 'garbage').mode).toBe('exclude')
  expect(privacyCapability('darwin', '24.0.0').mode).toBe('best_effort')
  const linux = privacyCapability('linux', '6.8.0')
  expect(linux.mode).toBe('unsupported')
  expect(linux.reason).toBeTruthy()
})

test('this PC is in exclude mode', () => {
  test.skip(process.platform !== 'win32')
  expect(capability.mode).toBe('exclude')
})

test('applyProtection follows the setting both ways', () => {
  const w = fake()
  setPrivateFlag(true)
  applyProtection(w)
  setPrivateFlag(false)
  applyProtection(w)
  expect(w.log).toEqual(['protect:true', 'protect:false'])
})

test('reveal with Private on: opacity 0, show, reset affinity, fade in after REVEAL_MS', async () => {
  test.skip(capability.mode === 'unsupported')
  const w = fake()
  setPrivateFlag(true)
  reveal(w, true)
  expect(w.log).toEqual(['opacity:0', 'show', 'protect:false', 'protect:true'])
  expect(w.opacity).toBe(0)
  await wait(REVEAL_MS + 50)
  expect(w.opacity).toBe(1)
  reveal(w, false)
  reveal(w, true)
  expect(w.log.slice(-1)).toEqual(['focus']) // already visible: no second reset
})

test('reveal with Private off never turns protection on', async () => {
  const w = fake()
  setPrivateFlag(false)
  reveal(w, false)
  w.hide()
  reveal(w, true)
  await wait(REVEAL_MS + 50)
  expect(w.log.filter((l) => l.startsWith('protect'))).toEqual([])
  expect(w.log.filter((l) => l.startsWith('show'))).toEqual(['showInactive', 'show'])
})

test('P6-10 hide during a pending reveal, then reveal again: ends visible at opacity 1', async () => {
  test.skip(capability.mode === 'unsupported')
  const w = fake()
  reveal(w, true)
  w.hide()
  reveal(w, true)
  await wait(REVEAL_MS / 2)
  expect(w.opacity).toBe(0) // the first timer was cancelled and doesn't cut the second fade short
  await wait(REVEAL_MS)
  expect(w.opacity).toBe(1)
  expect(w.visible).toBe(true)
})

test('P6-10 a screenshot hold outlives a reveal, and a reveal does not end a screenshot', async () => {
  test.skip(capability.mode === 'unsupported')
  const w = fake()
  reveal(w, true)
  hold(w, 'screenshot')
  await wait(REVEAL_MS + 50)
  expect(w.opacity).toBe(0)
  release(w, 'screenshot')
  expect(w.opacity).toBe(1)
  release(w, 'screenshot') // double release is a no-op
  expect(w.log.filter((l) => l === 'opacity:1')).toHaveLength(1)
})

test('P6-10 a window destroyed during a reveal never gets touched', async () => {
  test.skip(capability.mode === 'unsupported')
  const w = fake()
  reveal(w, true)
  w.destroyed = true
  w.emit('closed')
  await wait(REVEAL_MS + 50) // setOpacity would throw on a destroyed window
  expect(() => {
    reveal(w, true)
    applyProtection(w)
    hold(w, 'x')
    release(w, 'x')
  }).not.toThrow()
})
