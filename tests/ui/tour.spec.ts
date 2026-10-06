import { test, expect, type Page } from '@playwright/test';
import { closeAll, createRoom, deleteRoom, enroll, hit, joinRoom, sleep, waitForRoom, type Phone } from '../e2e/helpers';

/** Screenshot tour of every screen: `UI_SHOTS_DIR=out UI_DPR=1 npx playwright test -c playwright.ui.config.ts`. */
const DIR = process.env.UI_SHOTS_DIR ?? 'artifacts/ui-shots';
const DPR = Number(process.env.UI_DPR ?? 2);
const shot = (page: Page, name: string, fullPage = false, live = false) =>
  page.screenshot({ path: `${DIR}/${name}@${DPR}x.png`, fullPage, animations: live ? 'allow' : 'disabled' });

test.describe.configure({ mode: 'serial' });
let phones: Phone[] = [];
let code = '';

test.afterAll(async () => {
  if (code && phones[0]) await deleteRoom(phones[0], code);
  await closeAll(phones);
});

test('tour', async ({ browser }) => {
  test.setTimeout(180_000);
  const opts = { viewport: { width: 390, height: 844 }, deviceScaleFactor: DPR, isMobile: true, hasTouch: true };
  const mk = async (name: string): Promise<Phone> => {
    const ctx = await browser.newContext({ ...opts, permissions: ['camera'] });
    return { ctx, page: await ctx.newPage(), name, pid: '', errors: [] };
  };
  const host = await mk('Host');
  const guest = await mk('Riley');
  const third = await mk('Jun');
  phones = [host, guest, third];

  // Screens a round cannot reach (dev-only ?gallery, src/gallery/Gallery.tsx).
  for (const g of ['notice', 'notice-slow', 'crash', 'profile', 'profile-saved', 'body']) {
    await host.page.goto(`/?e2e&gallery=${g}`);
    await sleep(500);
    await shot(host.page, `00-gallery-${g}`);
  }
  await host.page.getByRole('button', { name: 'A friend is holding it' }).click();
  await sleep(1200);
  await shot(host.page, '00-gallery-body-front');

  await host.page.goto('/?e2e');
  await host.page.waitForSelector('.title');
  await shot(host.page, '01-home');
  await host.page.getByPlaceholder('e.g. Sam').fill('Host');
  await shot(host.page, '02-home-filled');
  await host.page.goto('/?e2e&practice');
  await host.page.waitForSelector('.title');
  await shot(host.page, '03-home-practice');

  code = await createRoom(host);
  await expect(host.page.getByText('Face 1 of 8')).toBeVisible();
  await sleep(800);
  await shot(host.page, '04-enroll-face');
  await enroll(host, 1);
  await shot(host.page, '05-lobby-host-alone', true);

  await guest.page.goto(`/?e2e&room=${code}`);
  await guest.page.waitForSelector('.title');
  await shot(guest.page, '06-home-join-link');
  await joinRoom(guest, code);
  await enroll(guest, 2);
  await joinRoom(third, code);
  await enroll(third, 3);
  await sleep(500);
  await shot(host.page, '07-lobby-host-ready', true);
  await shot(guest.page, '08-lobby-guest', true);

  await host.page.getByRole('button', { name: 'Start game' }).click();
  await sleep(1200);
  await shot(host.page, '09-countdown');
  await waitForRoom(host, (r) => r.status === 'playing', 'play');
  await sleep(600);
  await shot(host.page, '10-game-hud');
  // A real shot lands through the pipeline only with a person on camera; mark the hit the way a landed shot does.
  await host.page.evaluate(() => (window as unknown as { __lzMarkHit?: (n: string, c: string) => void }).__lzMarkHit?.('Riley', '#3bd5ff'));
  await sleep(160);
  await shot(host.page, '12-game-hit-scored', false, true);
  // Filmstrip of the marker's life (enter, hold, exit) for the motion review.
  await host.page.evaluate(() => (window as unknown as { __lzMarkHit?: (n: string, c: string) => void }).__lzMarkHit?.('Riley', '#3bd5ff'));
  for (const ms of [30, 120, 450, 820]) {
    await sleep(ms === 30 ? 30 : ms - [30, 120, 450, 820][[30, 120, 450, 820].indexOf(ms) - 1]);
    await host.page.locator('.crosshair').screenshot({ path: `${DIR}/12-marker-${ms}ms@${DPR}x.png`, animations: 'allow' });
  }
  await hit(host, guest);
  await sleep(140);
  await shot(guest.page, '11-game-hit-taken', false, true);
  await sleep(3300);
  await hit(host, guest);
  await sleep(3300);
  await hit(host, guest);
  await sleep(400);
  await shot(guest.page, '13-spectator');
  // Jun is still in: finish the round the way a host would.
  await host.page.getByRole('button', { name: 'end round' }).click();
  await waitForRoom(host, (r) => r.status === 'ended', 'end', 10_000).catch(() => undefined);
  await sleep(800);
  await shot(host.page, '14-results-winner', true);
  await shot(guest.page, '15-results-guest', true);
});
