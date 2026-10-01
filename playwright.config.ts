import { defineConfig } from '@playwright/test';

/** E2E_PORT lets two checkouts (worktrees) run the suite at once without one reusing the other's dev server. */
const PORT = Number(process.env.E2E_PORT ?? 5199);

/**
 * Browser end-to-end tests against the real Firebase database (rooms are open by decision; every
 * test deletes the rooms it made). Uses the installed Google Chrome (no browser download) with a
 * fake camera device, and a plain-HTTP Vite dev server on a fixed port. Run with `npm run e2e`;
 * results land in .rubric/e2e.json for `npm run rubric`.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['./tests/e2e/rubricReporter.ts']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: 'chrome',
    headless: true,
    launchOptions: { args: ['--use-fake-device-for-media-stream'] },
    permissions: ['camera'],
  },
  webServer: {
    command: `npm run dev:http -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
