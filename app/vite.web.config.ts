// Browser preview of the renderer (no Electron): the overlay runs inside a simulated
// desktop and the library opens at #/library. Used by /replica-test and screenshots.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { csp } from './csp-plugin'

export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  base: './',
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@renderer': resolve(import.meta.dirname, 'src/renderer'),
    },
  },
  plugins: [react(), tailwindcss(), csp()],
  server: { port: 5199, strictPort: true, fs: { allow: [resolve(import.meta.dirname, '..')] } },
  build: { outDir: resolve(import.meta.dirname, 'out/web'), emptyOutDir: true },
})
