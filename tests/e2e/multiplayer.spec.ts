import { test, expect } from '@playwright/test';
import { banner, closeAll, createRoom, deleteRoom, enroll, heartsOn, hit, joinRoom, openPhone, room, shots, sleep, startGame, tapFire, waitForRoom, type Phone } from './helpers';

/**
 * One free-for-all round with eight simulated phones against the real Firebase database, played in
 * order. Titles start with the rubric's e2e evidence name (docs/tracking-rubric.md); the reporter
 * writes them to .rubric/e2e.json.
 */
test.describe.configure({ mode: 'serial' });

const phones: Phone[] = [];
let code = '';
const P = (i: number) => phones[i];

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
  for (const p of phones) await expect(p.page.getByRole('button', { name: 'FIRE' })).toBeEnabled({ timeout: 15_000 });
});

test('[hit-propagates] a hit registered by one phone reaches the target phone within a second', async () => {
  const [host, p1] = phones;
  expect(await heartsOn(p1).count()).toBe(3);
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

test('[shield] a second shooter hitting a just-hit target inside the shield is refused and the target keeps their lives', async () => {
  const [host, , p2, p3] = phones;
  expect(await hit(host, p2)).toBe('hit');
  expect(await hit(p3, p2)).toBe('invulnerable');
  await expect(heartsOn(p2)).toHaveCount(2);
  await sleep(300);
  expect((await room(host)).players[p2.pid].lives).toBe(2);
});

test('[concurrent-hits] four shooters hitting four different targets in the same instant all land once', async () => {
  const pairs: [Phone, Phone][] = [[P(0), P(4)], [P(1), P(5)], [P(2), P(6)], [P(3), P(7)]];
  const outcomes = await Promise.all(pairs.map(([s, t]) => hit(s, t)));
  expect(outcomes).toEqual(['hit', 'hit', 'hit', 'hit']);
  for (const [, t] of pairs) await expect(heartsOn(t)).toHaveCount(2);
  const r = await room(P(0));
  for (const [s, t] of pairs) {
    expect(r.players[t.pid].lives).toBe(2);
    expect(r.players[s.pid].tags).toBeGreaterThanOrEqual(1);
  }
});

test('[cooldown] mashing FIRE fires once per cooldown', async () => {
  const host = P(0);
  // A phone in play is in the foreground; Chrome throttles timers in background pages to 1 Hz, which
  // would make every synthetic frame stale.
  await host.page.bringToFront();
  await expect(host.page.locator('button.fire')).toBeEnabled();
  // With nobody in the fake camera a fresh frame gives MISS; the synthetic loop runs at 20 Hz.
  await sleep(500);
  const before = (await shots(host)).length;
  await tapFire(host);
  await expect(banner(host)).toHaveText('MISS');
  await tapFire(host);
  await sleep(100);
  await tapFire(host);
  const after = await shots(host);
  expect(after.slice(before), 'one shot in the cooldown').toEqual(['miss']);
  await sleep(1100);
  await tapFire(host);
  await expect(banner(host)).toHaveText('MISS');
  expect((await shots(host)).slice(before)).toEqual(['miss', 'miss']);
});

test('[background-resume] after the page was hidden and shown again, the first FIRE finds no fresh frame and never lands', async () => {
  const host = P(1);
  await host.page.bringToFront();
  await sleep(1200);
  const tagsBefore = (await room(host)).players[host.pid].tags;
  const outcome = await host.page.evaluate(async () => {
    const setHidden = (hidden: boolean) => {
      Object.defineProperty(document, 'hidden', { get: () => hidden, configurable: true });
      Object.defineProperty(document, 'visibilityState', { get: () => (hidden ? 'hidden' : 'visible'), configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    const fire = () => document.querySelector('button.fire')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    // The verdict is decided at the tap; React paints the banner a moment later.
    const text = async () => {
      await new Promise((r) => setTimeout(r, 40));
      return document.querySelector('.banner')?.textContent ?? '';
    };
    setHidden(true);
    fire();
    const whileHidden = await text();
    setHidden(false);
    fire();
    const rightAfter = await text();
    await new Promise((r) => setTimeout(r, 1500));
    fire();
    return { whileHidden, rightAfter, later: await text(), shots: window.__lzE2E.shots().slice(-3) };
  });
  expect(outcome.whileHidden).toBe('NO CAMERA LOCK');
  expect(outcome.rightAfter).toBe('NO CAMERA LOCK');
  expect(outcome.later).toBe('MISS');
  expect(outcome.shots.some((s) => /hit/i.test(s))).toBe(false);
  expect((await room(host)).players[host.pid].tags).toBe(tagsBefore);
});

test('[eliminated-out] a player on their last life who is hit is out: no FIRE button, "You are out", and further hits are refused', async () => {
  test.setTimeout(60_000);
  const [host, , , , , , , p7] = phones;
  expect((await room(host)).players[p7.pid].lives).toBe(2);
  await sleep(3300);
  expect(await hit(host, p7)).toBe('hit');
  await sleep(3300);
  expect(await hit(host, p7)).toBe('eliminated');
  await expect(p7.page.locator('.spectator h2')).toHaveText('You are out');
  await expect(p7.page.locator('button.fire')).toHaveCount(0);
  expect(await hit(host, p7)).toBe('dead');
});

test('[winner-consistent] when the last opponent falls, every phone shows the same winner within two seconds', async () => {
  test.setTimeout(90_000);
  const host = P(0);
  for (let round = 0; round < 3; round++) {
    await sleep(3300);
    const r = await room(host);
    const alive = phones.slice(1).filter((p) => r.players[p.pid].status === 'alive');
    if (!alive.length) break;
    await Promise.all(alive.map((t) => hit(host, t)));
  }
  const ended = await waitForRoom(host, (r) => r.status === 'ended', 'the round to end', 5000).catch(async (e) => {
    const direct = await host.page.evaluate(() => window.__lzE2E.endRound());
    throw new Error(`${e.message}\nendRound() called directly from the host page says: ${direct}\nhost console errors: ${host.errors.join(' | ')}`);
  });
  expect(ended.winnerId).toBe(host.pid);
  for (const p of phones) await expect(p.page.locator('.title')).toHaveText('Host wins', { timeout: 2000 });
});

test('[leaderboard] the results list every player in order with their tags', async () => {
  const host = P(0);
  const rows = host.page.locator('.standings li');
  await expect(rows).toHaveCount(8);
  await expect(rows.first()).toContainText('Host');
  const r = await room(host);
  await expect(rows.first()).toContainText(`${r.players[host.pid].tags} tags`);
  for (const p of phones) await expect(p.page.locator('.standings li')).toHaveCount(8);
});

test('[second-round] Back to lobby then Start gives everybody fresh lives, status and tags', async () => {
  test.setTimeout(60_000);
  const host = P(0);
  await host.page.getByRole('button', { name: 'Back to lobby' }).click();
  for (const p of phones) await expect(p.page.getByText(/Start game|Waiting for .* to start/)).toBeVisible();
  const lobby = await room(host);
  for (const p of Object.values(lobby.players)) {
    expect(p.lives).toBe(3);
    expect(p.status).toBe('alive');
    expect(p.tags).toBe(0);
  }
  await startGame(host);
  for (const p of phones) await expect(heartsOn(p)).toHaveCount(3);
});

test('[no-console-errors] no console errors or uncaught exceptions on any phone through join, lobby, play and results', async () => {
  expect(phones.flatMap((p) => p.errors)).toEqual([]);
});
