import test from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from 'firebase/database';
import { FirebaseBackend } from '../src/net/firebase';
import { applyHit, evaluateHit, newPlayer, pickColor, randomCode } from '../src/net/backend';
import { DEFAULT_SETTINGS, PLAYER_COLORS, type Player, type Room } from '../src/types';
import { FakeDb } from './net/fakeDb';

const seed = (id: string, over: Partial<Player> = {}): Player => ({ ...newPlayer({ id, name: id }, '#fff', 3, 1000), enrolled: true, ...over });
const map = (...ps: Player[]): Record<string, Player> => Object.fromEntries(ps.map((p) => [p.id, p]));

test('applyHit: a hit costs one life, the last life eliminates, a shielded or dead target is refused', () => {
  const t = seed('t');
  const first = applyHit(t, 5000, 3000);
  assert.equal(first.outcome, 'hit');
  assert.equal(first.next?.lives, 2);
  assert.equal(first.next?.lastHitAt, 5000);
  assert.equal(applyHit(first.next!, 6000, 3000).outcome, 'invulnerable');
  const second = applyHit(first.next!, 9000, 3000);
  assert.equal(second.outcome, 'hit');
  const third = applyHit(second.next!, 13000, 3000);
  assert.equal(third.outcome, 'eliminated');
  assert.equal(third.next?.status, 'out');
  assert.equal(third.next?.eliminatedAt, 13000);
  assert.equal(applyHit(third.next!, 20000, 3000).outcome, 'dead');
  assert.equal(applyHit(null, 20000, 3000).outcome, 'invalid');
});

test('evaluateHit credits the shooter with a tag and leaves everyone else untouched', () => {
  const r = evaluateHit(map(seed('a'), seed('b'), seed('c')), 'a', 'b', 5000, 3000);
  assert.equal(r.outcome, 'hit');
  assert.equal(r.players?.a.tags, 1);
  assert.equal(r.players?.b.lives, 2);
  assert.deepEqual(r.players?.c, seed('c'));
});

test('a hit after the last elimination is refused: once at most one enrolled player is alive nothing lands', () => {
  const players = map(seed('a'), seed('b', { status: 'out', lives: 0 }), seed('c', { enrolled: false }));
  assert.equal(evaluateHit(players, 'c', 'a', 5000, 3000).outcome, 'invalid');
  assert.equal(evaluateHit(null, 'a', 'b', 5000, 3000).outcome, 'invalid');
  // Two alive contenders: the shot that eliminates the second-to-last player still counts.
  const live = map(seed('a', { lives: 1 }), seed('b'));
  const r = evaluateHit(live, 'b', 'a', 5000, 3000);
  assert.equal(r.outcome, 'eliminated');
});

test('room codes use four letters without I and O, and colours stay distinct for the first players', () => {
  for (let i = 0; i < 200; i++) assert.match(randomCode(), /^[ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
  const used: Record<string, Player> = {};
  const seen = new Set<string>();
  for (let i = 0; i < PLAYER_COLORS.length; i++) {
    const c = pickColor(used);
    assert.ok(!seen.has(c), `colour ${c} reused at player ${i + 1}`);
    seen.add(c);
    used[`p${i}`] = seed(`p${i}`, { color: c });
  }
  assert.ok(PLAYER_COLORS.includes(pickColor(used)), 'past the palette a colour is still picked');
});

/** A room in the fake database with a host and `n` more players, every one enrolled. */
async function makeRoom(n: number, status: 'lobby' | 'playing' = 'playing') {
  const db = new FakeDb();
  const backend = new FirebaseBackend(db.sdk(), {} as Database);
  const code = await backend.createRoom({ id: 'p0', name: 'Host' });
  for (let i = 1; i <= n; i++) assert.equal(await backend.joinRoom(code, { id: `p${i}`, name: `P${i}` }), 'ok');
  for (let i = 0; i <= n; i++) await backend.updatePlayer(code, `p${i}`, { enrolled: true });
  let room: Room | null = null;
  const unsubscribe = backend.subscribe(code, (r) => (room = r));
  if (status === 'playing') await backend.startRound(code, DEFAULT_SETTINGS, backend.now());
  if (status === 'playing') await backend.updateMeta(code, { status: 'playing' });
  const current = (): Room => {
    assert.ok(room, 'room subscribed');
    return room;
  };
  return { db, backend, code, current, unsubscribe };
}

test('joinRoom: a newcomer is admitted in the lobby, refused mid-round, and a returning player rejoins any time', async () => {
  const { db, backend, code, current } = await makeRoom(1, 'lobby');
  assert.equal(await backend.joinRoom('ZZZZ', { id: 'x', name: 'X' }), 'missing');
  assert.equal(await backend.joinRoom(code, { id: 'p2', name: 'P2' }), 'ok');
  assert.equal(Object.keys(current().players).length, 3);
  assert.ok(current().players.p2.connected);
  await backend.startRound(code, DEFAULT_SETTINGS, backend.now());
  await backend.updateMeta(code, { status: 'playing' });
  assert.equal(await backend.joinRoom(code, { id: 'p3', name: 'P3' }), 'in-progress');
  assert.equal(current().players.p3, undefined, 'a refused newcomer is not written');
  await backend.leaveRoom(code, 'p1');
  assert.equal(current().players.p1.connected, false);
  assert.equal(await backend.joinRoom(code, { id: 'p1', name: 'P1 again' }), 'ok');
  assert.equal(current().players.p1.connected, true);
  assert.equal(current().players.p1.name, 'P1 again');
  assert.equal(current().players.p1.lives, 3, 'rejoining keeps the lives');
  assert.ok(db.disconnects.some((d) => d.path === `rooms/${code}/players/p1/connected` && d.action === 'set' && d.value === false), 'presence re-armed');
});

test('one life per hit inside the shield: two concurrent hits on one target cost one life and the second is refused', async () => {
  const { db, backend, code, current } = await makeRoom(2);
  const outcomes = await Promise.all([backend.registerHit(code, 'p1', 'p0', 0.9, 'face'), backend.registerHit(code, 'p2', 'p0', 0.9, 'face')]);
  assert.deepEqual(outcomes.sort(), ['hit', 'invulnerable']);
  assert.equal(current().players.p0.lives, 2);
  assert.equal(db.retries >= 1, true, 'the second transaction was retried on the fresh map');
  const tags = current().players.p1.tags + current().players.p2.tags;
  assert.equal(tags, 1);
});

test('concurrent hits on four different targets in the same tick all land once', async () => {
  const { backend, code, current } = await makeRoom(7);
  const pairs: [string, string][] = [['p0', 'p4'], ['p1', 'p5'], ['p2', 'p6'], ['p3', 'p7']];
  const outcomes = await Promise.all(pairs.map(([s, t]) => backend.registerHit(code, s, t, 0.8, 'cloth')));
  assert.deepEqual(outcomes, ['hit', 'hit', 'hit', 'hit']);
  for (const [s, t] of pairs) {
    assert.equal(current().players[t].lives, 2, `${t} lost one life`);
    assert.equal(current().players[s].tags, 1, `${s} got the tag`);
  }
  assert.equal(Object.keys((current() as unknown as { events?: Record<string, unknown> }).events ?? {}).length, 0, 'events are not part of the room view');
});

test('registerHit refuses outside a playing round and eliminates on the last life', async () => {
  const { backend, code, current } = await makeRoom(1, 'lobby');
  assert.equal(await backend.registerHit(code, 'p1', 'p0', 0.9, 'face'), 'invalid');
  await backend.startRound(code, { ...DEFAULT_SETTINGS, lives: 1, invulnMs: 0 }, backend.now());
  await backend.updateMeta(code, { status: 'playing' });
  assert.equal(await backend.registerHit(code, 'p1', 'p0', 0.9, 'face'), 'eliminated');
  assert.equal(current().players.p0.status, 'out');
  assert.equal(await backend.registerHit(code, 'p0', 'p1', 0.9, 'face'), 'invalid', 'the round is decided');
});

test('startRound and resetForNewRound give every player fresh lives, status and tags', async () => {
  const { backend, code, current } = await makeRoom(2);
  assert.equal(await backend.registerHit(code, 'p1', 'p2', 0.9, 'face'), 'hit');
  assert.equal(current().players.p2.lives, 2);
  await backend.resetForNewRound(code);
  assert.equal(current().status, 'lobby');
  assert.equal(current().winnerId ?? null, null);
  for (const p of Object.values(current().players)) {
    assert.equal(p.lives, 3);
    assert.equal(p.status, 'alive');
    assert.equal(p.tags, 0);
    assert.equal(p.lastHitAt, 0);
  }
  await backend.startRound(code, { ...DEFAULT_SETTINGS, lives: 5 }, 42);
  assert.equal(current().status, 'countdown');
  assert.equal(current().startAt, 42);
  assert.equal(current().settings.lives, 5);
  for (const p of Object.values(current().players)) assert.equal(p.lives, 5);
});

test('now() follows the server time offset', async () => {
  const db = new FakeDb();
  db.info.serverTimeOffset = 5000;
  const backend = new FirebaseBackend(db.sdk(), {} as Database);
  assert.ok(backend.now() - Date.now() >= 4990);
});
