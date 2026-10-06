import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * The UI screenshot tour (`npm run ui:shots`): every screen and state at phone size, at the DPR in
 * UI_DPR (default 2), into UI_SHOTS_DIR. Same Chrome, fake camera and dev server as the e2e suite.
 */
export default defineConfig({
  ...base,
  testDir: 'tests/ui',
  reporter: [['list']],
  use: { ...base.use, viewport: { width: 390, height: 844 }, deviceScaleFactor: Number(process.env.UI_DPR ?? 2), isMobile: true, hasTouch: true },
});
