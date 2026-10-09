import { defineConfig } from 'vitest/config'

/**
 * End-to-end tests (pnpm test:e2e): the bot and the hub as real processes
 * against a fake Slack and a fake claude on this computer. The desktop app's UI
 * tests (app.e2e.ts) run only with E2E_APP=1 (pnpm test:e2e:app), after a
 * build.
 */
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.ts'],
    testTimeout: 90_000,
    hookTimeout: 60_000,
    // Each test starts its own processes; a few at a time keeps startup times
    // steady.
    maxWorkers: 4,
  },
})
