import { defineConfig } from '@playwright/test';

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
    baseURL: 'http://localhost:5199',
    channel: 'chrome',
    headless: true,
    launchOptions: { args: ['--use-fake-device-for-media-stream'] },
    permissions: ['camera'],
  },
  webServer: {
    command: 'npm run dev:http -- --port 5199 --strictPort',
    url: 'http://localhost:5199',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
