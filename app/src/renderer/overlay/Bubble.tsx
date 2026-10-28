import { useEffect } from 'react'
import { api } from '@renderer/api'
import { BubbleButton } from './DesktopSim'

/** S06: the bubble window shown while the overlay is hidden (Electron). */
export function Bubble() {
  useEffect(() => {
    document.body.style.background = 'transparent'
  }, [])
  return (
    <main className="drag flex h-screen w-screen items-center justify-center">
      <h1 className="sr-only">Assistant hidden</h1>
      <BubbleButton onRestore={() => void api.window.restore()} />
    </main>
  )
}
