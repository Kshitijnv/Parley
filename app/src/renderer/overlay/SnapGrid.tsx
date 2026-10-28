import { useEffect, useState } from 'react'
import { onRaw } from '@renderer/api'
import { SnapZones } from './DesktopSim'

/** S05: full-screen click-through window shown while the Move button is held (Electron). */
export function SnapGrid() {
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => onRaw('snap:hover', (p: { zone: number }) => setHover(p.zone)), [])
  return (
    <div className="relative h-screen w-screen">
      <SnapZones hover={hover} />
    </div>
  )
}
