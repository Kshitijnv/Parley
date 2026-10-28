import type { Plugin } from 'vite'

// Production builds only: the dev server needs an inline React refresh preamble.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: app-file:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "frame-src 'self' blob: app-file:",
  "object-src 'self' blob: app-file:",
  "connect-src 'self' blob:",
].join('; ')

export function csp(): Plugin {
  return {
    name: 'parley-csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
  }
}
