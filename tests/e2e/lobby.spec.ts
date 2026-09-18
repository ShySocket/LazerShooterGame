import { test, expect } from '@playwright/test';
import { closeAll, createRoom, deleteRoom, enroll, heartsOn, hit, joinRoom, openPhone, room, sleep, startGame, waitForRoom, type Phone } from './helpers';

/** Lobby rules, host migration, joining mid-round and rejoining, with three to four phones. */
test.describe.configure({ mode: 'serial' });

const phones: Phone[] = [];
let code = '';

test.afterAll(async () => {
  if (phones[1] && code) await deleteRoom(phones[1], code);
  await closeAll(phones);
});

test('[lobby-gating] Start waits for every player to enrol and refuses two outfits that look alike, naming the pair', async ({ browser }) => {
  const host = await openPhone(browser, 'Host');
  const p1 = await openPhone(browser, 'Pia');
  phones.push(host, p1);
  code = await createRoom(host);
  await enroll(host, 0);
  await joinRoom(p1, code);
  const start = host.page.getByRole('button', { name: 'Start game' });
  await expect(start).toBeDisabled();
  await expect(host.page.locator('.hint')).toContainText(/Need at least 2 enrolled players|Waiting for Pia to enroll/);
  // The same outfit as the host: the lobby names both and keeps Start disabled.
  await enroll(p1, 1, 0);
  await expect(host.page.locator('.note.bad')).toContainText('Host and Pia are dressed too alike');
  await expect(start).toBeDisabled();
  // A distinct outfit clears it.
  await p1.page.evaluate(() => window.__lzE2E.enroll(1));
  await expect(host.page.locator('.note.bad')).toHaveCount(0);
  await expect(start).toBeEnabled();
});

test('[host-migration] when the host phone disappears, the earliest-joined connected player becomes host', async ({ browser }) => {
  test.setTimeout(60_000);
  const [host, p1] = phones;
  const p2 = await openPhone(browser, 'Quinn');
  phones.push(p2);
  await joinRoom(p2, code);
  await enroll(p2, 2);
  await expect(p1.page.getByText('Waiting for Host to start')).toBeVisible();
  await host.ctx.close();
  const r = await waitForRoom(p1, (r) => r.hostId === p1.pid, 'the host to change', 30_000);
  expect(r.players[host.pid].connected).toBe(false);
  await expect(p1.page.getByRole('button', { name: 'Start game' })).toBeEnabled();
  await expect(p2.page.getByText('Waiting for Pia to start')).toBeVisible();
});

test('[join-in-progress] a newcomer opening the link mid-round is told to wait, and can join once the host is back in the lobby', async ({ browser }) => {
  test.setTimeout(60_000);
  const [, p1, p2] = phones;
  await startGame(p1);
  const p3 = await openPhone(browser, 'Rae');
  phones.push(p3);
  await p3.page.goto(`/?e2e&room=${code}`);
  await p3.page.getByPlaceholder('e.g. Sam').fill('Rae');
  await p3.page.getByRole('button', { name: 'Join' }).click();
  await expect(p3.page.locator('.note.bad')).toContainText(`Room ${code} is mid-game`);
  expect((await room(p1)).players[p3.pid ?? '_']).toBeUndefined();
  // The host ends the round by hand and goes back to the lobby; now the newcomer gets in.
  await p1.page.getByRole('button', { name: 'end round' }).click();
  await expect(p1.page.getByRole('button', { name: 'Back to lobby' })).toBeVisible();
  await expect(p2.page.locator('.title')).toBeVisible();
  await p1.page.getByRole('button', { name: 'Back to lobby' }).click();
  await joinRoom(p3, code);
  await enroll(p3, 3);
  await expect(p1.page.getByRole('button', { name: 'Start game' })).toBeEnabled();
});

test('[rejoin] a phone that reloads mid-round is back in the same round with the same lives and identity', async () => {
  test.setTimeout(60_000);
  const [, p1, p2, p3] = phones;
  await startGame(p1);
  expect(await hit(p1, p2)).toBe('hit');
  await expect(heartsOn(p2)).toHaveCount(2);
  const pidBefore = p2.pid;
  await p2.page.reload();
  const t0 = Date.now();
  while ((await p2.page.locator('button.fire').count()) === 0) {
    if (Date.now() - t0 > 20_000) throw new Error(`no game screen after reload; url ${p2.page.url()}; page says: ${(await p2.page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 400)}`);
    await sleep(250);
  }
  await expect(heartsOn(p2)).toHaveCount(2);
  expect(await p2.page.evaluate(() => localStorage.getItem('lz:pid'))).toBe(pidBefore);
  await sleep(500);
  const r = await room(p1);
  expect(r.players[pidBefore].connected).toBe(true);
  expect(r.players[pidBefore].lives).toBe(2);
  expect(r.status).toBe('playing');
  expect(Object.keys(r.players).length).toBe(4);
  expect(r.players[p3.pid].enrolled).toBe(true);
});
