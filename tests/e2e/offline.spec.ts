import { test, expect } from '@playwright/test';
import { closeAll, createRoom, deleteRoom, enroll, joinRoom, openPhone, startGame, type Phone } from './helpers';

/** A phone that loses the network mid-round says so, and recovers when it is back. */
const phones: Phone[] = [];
let code = '';

test.afterAll(async () => {
  if (phones[0] && code) await deleteRoom(phones[0], code);
  await closeAll(phones);
});

test('[offline-pill] a phone that goes offline shows OFFLINE in the game until the link is back', async ({ browser }) => {
  test.setTimeout(120_000);
  const host = await openPhone(browser, 'Host');
  const p1 = await openPhone(browser, 'Pia');
  phones.push(host, p1);
  code = await createRoom(host);
  await enroll(host, 0);
  await joinRoom(p1, code);
  await enroll(p1, 1);
  await startGame(host);
  await expect(p1.page.locator('.status-pill.offline')).toHaveCount(0);
  await p1.ctx.setOffline(true);
  await expect(p1.page.locator('.status-pill.offline')).toContainText('OFFLINE', { timeout: 20_000 });
  await expect(host.page.locator('.status-pill.offline')).toHaveCount(0);
  await p1.ctx.setOffline(false);
  await expect(p1.page.locator('.status-pill.offline')).toHaveCount(0, { timeout: 30_000 });
  expect(p1.errors.filter((e) => !/WebSocket|net::ERR|Failed to fetch|firebase/i.test(e))).toEqual([]);
});
