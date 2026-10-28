import { defineConfig } from '@playwright/test'

// unit: pure logic (TurnDetector, 429 classifier) with an injected clock, no Electron.
// electron: the built app (npm run build first) with the scripted fake provider; zero
// Gemini calls unless a spec says otherwise. Electron specs share one model folder and
// feed audio in real time, so they run one at a time.
export default defineConfig({
  testDir: 'e2e',
  outputDir: '.smoke/test-results',
  reporter: [['list']],
  projects: [
    { name: 'unit', testMatch: /unit\/.*\.spec\.ts/, timeout: 30_000 },
    { name: 'electron', testMatch: /electron\/.*\.spec\.ts/, timeout: 15 * 60_000, fullyParallel: false },
    // the browser preview (npm run dev:web on :5199 must be running): layout/interaction checks
    // that only apply there. Not part of test:e2e.
    { name: 'preview', testMatch: /preview\/.*\.spec\.ts/, timeout: 60_000, use: { browserName: 'chromium', channel: 'msedge', headless: true } },
    // real WASAPI loopback: plays synthetic speech through this PC's speakers. Run on purpose only.
    { name: 'hardware', testMatch: /hardware\/.*\.spec\.ts/, timeout: 5 * 60_000, fullyParallel: false },
    { name: 'real', testMatch: /real\/.*\.spec\.ts/, timeout: 15 * 60_000, fullyParallel: false },
  ],
  workers: 1,
})
