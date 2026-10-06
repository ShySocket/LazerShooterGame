import { test, expect, type Page } from '@playwright/test';
import { closeAll, createRoom, deleteRoom, enroll, hit, joinRoom, sleep, waitForRoom, type Phone } from '../e2e/helpers';

/** Screenshot tour of every screen: `UI_SHOTS_DIR=out UI_DPR=1 npx playwright test -c playwright.ui.config.ts`. */
const DIR = process.env.UI_SHOTS_DIR ?? 'artifacts/ui-shots';
const DPR = Number(process.env.UI_DPR ?? 2);
const shot = (page: Page, name: string, fullPage = false) => page.screenshot({ path: `${DIR}/${name}@${DPR}x.png`, fullPage, animations: 'disabled' });

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
  phones = [host, guest];

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
  await sleep(500);
  await shot(host.page, '07-lobby-host-ready', true);
  await shot(guest.page, '08-lobby-guest', true);

  await host.page.getByRole('button', { name: 'Start game' }).click();
  await sleep(1200);
  await shot(host.page, '09-countdown');
  await waitForRoom(host, (r) => r.status === 'playing', 'play');
  await sleep(600);
  await shot(host.page, '10-game-hud');
  await hit(host, guest);
  await sleep(300);
  await shot(guest.page, '11-game-hit-taken');
  await shot(host.page, '12-game-hit-scored');
  await sleep(3300);
  await hit(host, guest);
  await sleep(3300);
  await hit(host, guest);
  await sleep(400);
  await shot(guest.page, '13-spectator');
  await waitForRoom(host, (r) => r.status === 'ended', 'end', 10_000).catch(() => undefined);
  await sleep(800);
  await shot(host.page, '14-results-winner', true);
  await shot(guest.page, '15-results-guest', true);
});
