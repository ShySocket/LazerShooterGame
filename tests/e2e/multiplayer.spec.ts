import { test, expect } from '@playwright/test';
import { closeAll, createRoom, deleteRoom, enroll, heartsOn, hit, joinRoom, openPhone, startGame, waitForRoom, type Phone } from './helpers';

/**
 * A free-for-all round with eight simulated phones against the real Firebase database. Titles start
 * with the rubric's e2e evidence name (docs/tracking-rubric.md), which the reporter writes to
 * .rubric/e2e.json.
 */
test.describe.configure({ mode: 'serial' });

const phones: Phone[] = [];
let code = '';

test.afterAll(async () => {
  if (phones[0] && code) await deleteRoom(phones[0], code);
  await closeAll(phones);
});

test('[eight-players-start] eight players create or join through the share link, enrol, and the host starts one round', async ({ browser }) => {
  test.setTimeout(240_000);
  const host = await openPhone(browser, 'Host');
  phones.push(host);
  code = await createRoom(host);
  expect(code).toMatch(/^[A-Z]{4}$/);
  await enroll(host, 0);
  for (let i = 1; i < 8; i++) {
    const p = await openPhone(browser, `P${i}`);
    phones.push(p);
    await joinRoom(p, code);
    await enroll(p, i);
  }
  const lobby = await waitForRoom(host, (r) => Object.values(r.players).filter((p) => p.enrolled).length === 8, 'eight enrolled players');
  expect(new Set(Object.values(lobby.players).map((p) => p.color)).size).toBe(8);
  await startGame(host);
  for (const p of phones) await expect(p.page.getByRole('button', { name: 'FIRE' })).toBeVisible({ timeout: 15_000 });
});

test('[hit-propagates] a hit registered by one phone reaches the target phone within a second', async () => {
  const [host, p1] = phones;
  const before = await heartsOn(p1).count();
  expect(before).toBe(3);
  const tapped = Date.now();
  expect(await hit(host, p1)).toBe('hit');
  // The rubric's second runs from the moment the hit is registered to the target phone showing it.
  const registered = Date.now();
  await expect(heartsOn(p1)).toHaveCount(2, { timeout: 1000 });
  const shown = Date.now();
  test.info().annotations.push({ type: 'latency', description: `register ${registered - tapped} ms, propagate ${shown - registered} ms` });
  expect(shown - registered).toBeLessThan(1000);
  await expect(p1.page.getByText(/HIT! 2 lives left/)).toBeVisible({ timeout: 2000 });
  const r = await waitForRoom(host, (r) => r.players[p1.pid].lives === 2, 'the target to lose a life');
  expect(r.players[host.pid].tags).toBe(1);
});

test('[no-console-errors] no console errors or uncaught exceptions on any phone through join, lobby and play', async () => {
  const errors = phones.flatMap((p) => p.errors);
  expect(errors).toEqual([]);
});
