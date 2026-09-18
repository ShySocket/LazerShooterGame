import { test, expect } from '@playwright/test';
import { closeAll, openPhone, type Phone } from './helpers';

/**
 * The enrolment scanner with the real vision models in Chrome (no ?e2e hook) and the fake camera,
 * which shows a test pattern rather than a person: the models must load, the camera must start, and
 * the face stage must run its loop and say so. The head-angle prompts themselves are covered by the
 * unit tests in tests/scan.test.ts; a real face needs a real phone (docs/phone-session.md).
 */
const phones: Phone[] = [];
let code = '';

test.afterAll(async () => {
  const phone = phones[0];
  if (phone && code) {
    // The delete hook lives on the ?e2e route; the room's own page can load it once the test is done.
    await phone.page.goto('/?e2e').catch(() => undefined);
    await phone.page.evaluate((c) => window.__lzE2E.deleteRoom(c), code).catch(() => undefined);
  }
  await closeAll(phones);
});

test('[scan-smoke] the models load, the camera starts, and the face stage runs on a real browser', async ({ browser }) => {
  test.setTimeout(180_000);
  const phone = await openPhone(browser, 'Scan');
  phones.push(phone);
  await phone.page.goto('/');
  await phone.page.getByPlaceholder('e.g. Sam').fill('Scan');
  await phone.page.getByRole('button', { name: 'Create a room' }).click();
  await phone.page.waitForURL(/room=[A-Z]{4}/);
  code = new URL(phone.page.url()).searchParams.get('room')!;
  await expect(phone.page.getByText('Face 1 of 8')).toBeVisible();
  // Models: about 24 MB from the dev server, then a warm-up. Headless Chrome may take a while.
  const t0 = Date.now();
  const loaded = await phone.page.evaluate(() => (window as unknown as { __lzHuman: { loadHuman: () => Promise<unknown> } }).__lzHuman.loadHuman().then(() => true, (e) => String(e)));
  expect(loaded, 'vision models loaded').toBe(true);
  test.info().annotations.push({ type: 'models', description: `loaded in ${Date.now() - t0} ms` });
  // The loop runs on the fake camera's test pattern: no face, and the scanner says so.
  await expect(phone.page.locator('.hint')).toHaveText(/No face found/, { timeout: 60_000 });
  await expect(phone.page.getByRole('button', { name: 'Restart scan' })).toBeVisible();
  expect(phone.errors).toEqual([]);
});
