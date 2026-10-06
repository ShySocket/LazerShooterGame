import { test, expect } from '@playwright/test';

/** Motion contract: screens rise in, and under reduced motion everything only fades. */
const DIR = process.env.UI_SHOTS_DIR ?? 'artifacts/ui-shots';

test('screens animate with a rise, and reduced motion swaps every move for a fade', async ({ page }) => {
  await page.goto('/?e2e');
  await page.waitForSelector('.home .title');
  const screen = page.locator('.screen.home');
  expect(await screen.evaluate((el) => getComputedStyle(el).animationName)).toBe('screen-in');
  expect(await screen.evaluate((el) => parseFloat(getComputedStyle(el).animationDuration))).toBeLessThanOrEqual(0.3);
  const btn = page.locator('.btn.primary');
  expect(await btn.evaluate((el) => getComputedStyle(el).transitionProperty)).toContain('transform');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await page.waitForSelector('.home .title');
  expect(await screen.evaluate((el) => getComputedStyle(el).animationName)).toBe('fade-in');
  expect(await btn.evaluate((el) => getComputedStyle(el).transitionProperty)).not.toContain('transform');
  await page.screenshot({ path: `${DIR}/motion-reduced-home.png` });
});
