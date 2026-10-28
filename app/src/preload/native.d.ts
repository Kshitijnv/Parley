import type { Api } from '../shared/api'

export interface NativeBridge {
  isElectron: true
  invoke(channel: string, input?: unknown): Promise<any>
  broadcast(event: string, payload: unknown): void
  on(cb: (event: string, payload: unknown) => void): () => void
  onNav(cb: (route: string) => void): () => void
  pathForFile(file: File): string
  setZoom(factor: number): void
}

declare global {
  interface Window {
    native?: NativeBridge
    /** Set by /replica-backend's preload; until then the mock is used. */
    api?: Api
  }
}
