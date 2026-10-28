import { useEffect } from 'react'
import { isElectron } from './api'
import { TooltipProvider } from './components/ui/overlays'
import { useAppearance } from './lib/hooks'
import { navigate, useNativeNav, useRoute } from './lib/router'
import { OverlayApp } from './overlay/OverlayApp'
import { Bubble } from './overlay/Bubble'
import { SnapGrid } from './overlay/SnapGrid'
import { DesktopSim } from './overlay/DesktopSim'
import { LibraryApp } from './library/LibraryApp'

export function App() {
  const route = useRoute()
  useNativeNav()
  useAppearance()

  useEffect(() => {
    if (!location.hash) navigate('/overlay', { replace: true })
  }, [])

  const solid = route.startsWith('/library')
  useEffect(() => {
    document.body.classList.toggle('solid-page', solid)
    document.title = solid ? 'Parley Library' : 'Parley'
  }, [solid])

  let screen
  if (route.startsWith('/library')) screen = <LibraryApp route={route} />
  else if (route.startsWith('/bubble')) screen = <Bubble />
  else if (route.startsWith('/snap')) screen = <SnapGrid />
  else if (isElectron) screen = <OverlayApp route={route} />
  else
    screen = (
      <DesktopSim>
        <OverlayApp route={route} />
      </DesktopSim>
    )

  return <TooltipProvider>{screen}</TooltipProvider>
}
