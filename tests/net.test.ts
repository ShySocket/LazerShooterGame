import test from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from 'firebase/database';
import { FirebaseBackend } from '../src/net/firebase';
import { applyHit, claimHostPatch, closeRoundPlayers, decideRoundEnd, endRoundPatch, evaluateHit, evaluatePlayersHit, isPresent, isShotId, ROUND_START_SKEW_MS, newPlayer, pickColor, pickNextHost, randomCode, roundOpenFor, shieldMs, type HitRecord, type HitRequest } from '../src/net/backend';
import { LocalBackend } from '../src/net/local';
import { NET_CALIB } from '../src/vision/calibration';
import { DEFAULT_SETTINGS, MIN_INVULN_MS, PLAYER_COLORS, type Player, type Room } from '../src/types';
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
  assert.ok(PLAYER_COLORS.length >= 12, 'twelve players get twelve colours');
  assert.equal(new Set(PLAYER_COLORS).size, PLAYER_COLORS.length);
});

const NOW = 1000;
const strip = (e: ReturnType<typeof decideRoundEnd>) => ({ decided: e.decided, winnerId: e.winnerId, forfeit: e.forfeit, absent: e.absent.map((p) => p.id) });

test('decideRoundEnd: outright when one player is left alive, by forfeit when the others have dropped off, never with fewer than two contenders', () => {
  assert.deepEqual(strip(decideRoundEnd(map(seed('a'), seed('b')), NOW)), { decided: false, winnerId: null, forfeit: false, absent: [] });
  assert.deepEqual(strip(decideRoundEnd(map(seed('a'), seed('b', { status: 'out' })), NOW)), { decided: true, winnerId: 'a', forfeit: false, absent: [] });
  assert.deepEqual(strip(decideRoundEnd(map(seed('a', { status: 'out' }), seed('b', { status: 'out' })), NOW)), { decided: true, winnerId: null, forfeit: false, absent: [] });
  assert.deepEqual(strip(decideRoundEnd(map(seed('a'), seed('b', { connected: false }), seed('c', { connected: false })), NOW)), { decided: true, winnerId: 'a', forfeit: true, absent: ['b', 'c'] });
  assert.deepEqual(strip(decideRoundEnd(map(seed('a'), seed('b', { enrolled: false, status: 'out' })), NOW)), { decided: false, winnerId: null, forfeit: false, absent: [] });
  assert.deepEqual(strip(decideRoundEnd(null, NOW)), { decided: false, winnerId: null, forfeit: false, absent: [] });
  const meta = { status: 'playing' as const };
  assert.equal(endRoundPatch(meta, map(seed('a'), seed('b')), 7), null);
  assert.deepEqual(endRoundPatch(meta, map(seed('a'), seed('b')), 7, true), { status: 'ended', endedAt: 7, winnerId: null });
  assert.deepEqual(endRoundPatch(meta, map(seed('a'), seed('b', { status: 'out' })), 7), { status: 'ended', endedAt: 7, winnerId: 'a' });
  assert.equal(endRoundPatch({ status: 'ended' }, map(seed('a'), seed('b', { status: 'out' })), 7, true), null);
});

test('heartbeat presence: a player whose heartbeat is stale counts as gone within a minute, whatever Firebase says', () => {
  assert.equal(isPresent(seed('a'), NOW), true, 'a fresh player');
  assert.equal(isPresent({ connected: true }, NOW), true, 'an old record without a heartbeat is trusted');
  assert.equal(isPresent({ connected: true, seenAt: NOW - NET_CALIB.presenceStaleMs + 1 }, NOW), true);
  assert.equal(isPresent({ connected: true, seenAt: NOW - NET_CALIB.presenceStaleMs - 1 }, NOW), false, 'stale heartbeat');
  assert.equal(isPresent({ connected: false, seenAt: NOW }, NOW), false, 'Firebase says gone');
  // A stale survivor forfeits like a disconnected one, and is named as the one being waited for.
  const later = NOW + NET_CALIB.presenceStaleMs + 5000;
  const e = decideRoundEnd(map(seed('a', { seenAt: later }), seed('b', { seenAt: NOW })), later);
  assert.deepEqual(strip(e), { decided: true, winnerId: 'a', forfeit: true, absent: ['b'] });
  assert.ok(NET_CALIB.presenceStaleMs <= 60000 && NET_CALIB.heartbeatMs * 2 < NET_CALIB.presenceStaleMs, 'two missed beats mean gone');
});

test('pickNextHost prefers the earliest-joined present enrolled player; claimHostPatch leaves a present host alone', () => {
  const players = map(seed('h', { connected: false, joinedAt: 1 }), seed('late', { joinedAt: 30 }), seed('early', { joinedAt: 10 }), seed('guest', { joinedAt: 5, enrolled: false }));
  assert.equal(pickNextHost(players, NOW), 'early');
  assert.equal(pickNextHost(map(seed('x', { connected: false })), NOW), null);
  assert.equal(claimHostPatch({ hostId: 'h' }, players, NOW), 'early');
  assert.equal(claimHostPatch({ hostId: 'early' }, players, NOW), null, 'the host is present');
  assert.equal(claimHostPatch({ hostId: 'h' }, map(seed('h', { connected: false })), NOW), null, 'nobody to take over');
  // A host whose heartbeat went stale is replaced even though Firebase still says connected.
  const stale = map(seed('h', { joinedAt: 1, seenAt: NOW - NET_CALIB.presenceStaleMs - 1 }), seed('early', { joinedAt: 10, seenAt: NOW }));
  assert.equal(claimHostPatch({ hostId: 'h' }, stale, NOW), 'early');
});

test('the round end is written once: several phones ending the same round agree on one winner', async () => {
  const { backend, code, current, hit } = await makeRoom(1, 'lobby');
  await backend.startRound(code, { ...DEFAULT_SETTINGS, lives: 1, invulnMs: 0 }, backend.now());
  await backend.beginPlay(code, current().startAt!);
  assert.equal(await backend.endRound(code), 'not-decided');
  assert.equal(current().status, 'playing');
  assert.equal(await hit('p0', 'p1'), 'eliminated');
  const results = await Promise.all([backend.endRound(code), backend.endRound(code), backend.endRound(code)]);
  assert.deepEqual(results.sort(), ['already', 'already', 'ended']);
  assert.equal(current().status, 'ended');
  assert.equal(current().winnerId, 'p0');
  assert.ok((current().endedAt ?? 0) > 0);
  assert.equal(await backend.endRound(code, true), 'already', 'a forced end after the fact changes nothing');
});

test('the host can force an end; the winner is only named when exactly one player is alive', async () => {
  const { backend, code, current } = await makeRoom(2);
  assert.equal(await backend.endRound(code, true), 'ended');
  assert.equal(current().winnerId ?? null, null);
});

test('host migration: after the host drops, the earliest-joined connected player becomes host, decided once for every phone that asks', async () => {
  const { backend, code, current } = await makeRoom(3, 'lobby');
  assert.equal(await backend.claimHost(code), null, 'a connected host keeps the room');
  await backend.leaveRoom(code, 'p0');
  assert.equal(current().players.p0.connected, false);
  const results = await Promise.all([backend.claimHost(code), backend.claimHost(code), backend.claimHost(code)]);
  assert.deepEqual(results.sort(), [null, null, 'p1']);
  assert.equal(current().hostId, 'p1');
  // The old host coming back does not take the room away from the new one.
  assert.equal(await backend.joinRoom(code, { id: 'p0', name: 'Host' }), 'ok');
  assert.equal(await backend.claimHost(code), null);
  assert.equal(current().hostId, 'p1');
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
  if (status === 'playing') {
    const startAt = backend.now();
    await backend.startRound(code, DEFAULT_SETTINGS, startAt);
    await backend.beginPlay(code, startAt);
  }
  const current = (): Room => {
    assert.ok(room, 'room subscribed');
    return room;
  };
  /** A hit as FIRE sends it: a fresh shot id (unless given) in the round this phone sees playing now. */
  const hit = (shooter: string, target: string, shotId = nextShotId(), roundStartAt: number | null = current().startAt ?? null) =>
    backend.registerHit(code, shooter, target, 0.9, 'face', shotId, roundStartAt);
  return { db, backend, code, current, unsubscribe, hit };
}

let shotCount = 0;
const nextShotId = () => `shot-${++shotCount}`;

/** Every player's shot ledger in the room, merged: shot id -> record. */
function ledgers(db: FakeDb, code: string): Record<string, HitRecord> {
  const players = (db.readAt(['rooms', code, 'players']) ?? {}) as Record<string, Player>;
  return Object.assign({}, ...Object.values(players).map((p) => p.shots ?? {}));
}

/** What another phone's startRound writes, seen by this phone (`heard`) or not yet. */
function serverStartsRound(db: FakeDb, code: string, startAt: number, heard: boolean): void {
  const write = (path: string[], v: unknown) => (heard ? db.writeAt(path, v) : db.writeUnheard(path, v));
  const players = (db.readAt(['rooms', code, 'players']) ?? {}) as Record<string, Player>;
  write(['rooms', code, 'meta', 'startAt'], startAt);
  for (const id of Object.keys(players)) write(['rooms', code, 'players', id, 'round'], startAt);
}

/** A players map whose every player is in the round that started at `startAt`. */
const inRoundOf = (startAt: number, ...ps: Player[]): Record<string, Player> => map(...ps.map((p) => ({ ...p, round: startAt })));

test('joinRoom: a newcomer is admitted in the lobby, refused mid-round, and a returning player rejoins any time', async () => {
  const { db, backend, code, current } = await makeRoom(1, 'lobby');
  assert.equal(await backend.joinRoom('ZZZZ', { id: 'x', name: 'X' }), 'missing');
  assert.equal(await backend.joinRoom(code, { id: 'p2', name: 'P2' }), 'ok');
  assert.equal(Object.keys(current().players).length, 3);
  assert.ok(current().players.p2.connected);
  await backend.startRound(code, DEFAULT_SETTINGS, backend.now());
  await backend.beginPlay(code, current().startAt!);
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
  const { db, current, hit } = await makeRoom(2);
  const outcomes = await Promise.all([hit('p1', 'p0'), hit('p2', 'p0')]);
  assert.deepEqual(outcomes.sort(), ['hit', 'invulnerable']);
  assert.equal(current().players.p0.lives, 2);
  assert.equal(db.retries >= 1, true, 'the second transaction was retried on the fresh map');
  const tags = current().players.p1.tags + current().players.p2.tags;
  assert.equal(tags, 1);
});

test('concurrent hits on four different targets in the same tick all land once', async () => {
  const { db, code, current, hit } = await makeRoom(7);
  const pairs: [string, string][] = [['p0', 'p4'], ['p1', 'p5'], ['p2', 'p6'], ['p3', 'p7']];
  const outcomes = await Promise.all(pairs.map(([s, t], i) => hit(s, t, `four-${i}`)));
  assert.deepEqual(outcomes, ['hit', 'hit', 'hit', 'hit']);
  for (const [s, t] of pairs) {
    assert.equal(current().players[t].lives, 2, `${t} lost one life`);
    assert.equal(current().players[s].tags, 1, `${s} got the tag`);
  }
  const hits = ledgers(db, code);
  assert.deepEqual(Object.keys(hits).sort(), ['four-0', 'four-1', 'four-2', 'four-3'], 'each shot recorded once, in the same write');
  assert.deepEqual(pairs.map((_, i) => [hits[`four-${i}`].shooter, hits[`four-${i}`].target, hits[`four-${i}`].round]), pairs.map(([s, t]) => [s, t, current().startAt]));
  assert.ok(db.transactions.filter((p) => p.endsWith('/players')).length >= 4, 'hits transact on the players map, never the whole room');
  assert.equal(db.transactions.filter((p) => p === `rooms/${code}`).length, 1, 'only startRound took the whole room');
});

test('registerHit refuses outside a playing round and eliminates on the last life', async () => {
  const { backend, code, current, hit } = await makeRoom(1, 'lobby');
  assert.equal(await hit('p1', 'p0', nextShotId(), 0), 'invalid');
  await backend.startRound(code, { ...DEFAULT_SETTINGS, lives: 1, invulnMs: 0 }, backend.now());
  assert.equal(await hit('p1', 'p0'), 'invalid', 'the countdown is not play');
  await backend.beginPlay(code, current().startAt!);
  assert.equal(await hit('p1', 'p0'), 'eliminated');
  assert.equal(current().players.p0.status, 'out');
  assert.equal(await hit('p0', 'p1'), 'invalid', 'the round is decided');
});

test('startRound and resetForNewRound give every player fresh lives, status and tags', async () => {
  const { db, backend, code, current, hit } = await makeRoom(2);
  assert.equal(await hit('p1', 'p2'), 'hit');
  assert.equal(current().players.p2.lives, 2);
  assert.equal(Object.keys(ledgers(db, code)).length, 1);
  assert.equal(await backend.endRound(code, true), 'ended');
  await backend.resetForNewRound(code, current().startAt ?? null);
  assert.deepEqual(ledgers(db, code), {}, 'the round\'s hit records go with it');
  assert.ok(Object.values(current().players).every((p) => (p.round ?? null) === null), 'nobody carries a round in the lobby');
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

// ---- Hit integrity: one shot, one round, one atomic write --------------------------------------

const PLAYING = { status: 'playing' as const, startAt: 7000, settings: DEFAULT_SETTINGS };
const req = (over: Partial<HitRequest> = {}): HitRequest => ({ shooter: 'a', target: 'b', score: 0.9, via: 'face', shotId: 'tap-1', roundStartAt: 7000, ...over });

test('evaluatePlayersHit applies a hit only while both players carry its round, records it in the target\'s ledger, and never applies a recorded shot again', () => {
  const players = inRoundOf(7000, seed('a'), seed('b'), seed('c'));
  const first = evaluatePlayersHit(players, req(), 9000, 3000);
  assert.equal(first.outcome, 'hit');
  assert.equal(first.players?.b.lives, 2);
  assert.deepEqual(first.record, { shooter: 'a', target: 'b', t: 9000, score: 0.9, via: 'face', outcome: 'hit', round: 7000 });
  assert.deepEqual(first.players?.b.shots, { 'tap-1': first.record });
  // The same shot again, long after the shield: answered as it landed, nothing applied.
  const again = evaluatePlayersHit(first.players, req(), 60000, 3000);
  assert.deepEqual(again, { outcome: 'hit' }, 'a recorded shot is never applied twice');
  // Another shooter's or another round's record under the same id is an id collision, not this shot.
  assert.deepEqual(evaluatePlayersHit(first.players, req({ shooter: 'c' }), 60000, 3000), { outcome: 'invalid' });
  assert.deepEqual(evaluatePlayersHit(first.players, req({ roundStartAt: 8000 }), 60000, 3000), { outcome: 'invalid' });
  // A new shot id in the same round lands.
  assert.equal(evaluatePlayersHit(first.players, req({ shotId: 'tap-2' }), 60000, 3000).outcome, 'hit');
});

test('evaluatePlayersHit refuses a hit outside its round: ended, another round, no round, or before it began', () => {
  const players = inRoundOf(7000, seed('a'), seed('b'));
  assert.deepEqual(evaluatePlayersHit(closeRoundPlayers(players), req(), 9000, 3000), { outcome: 'invalid' }, 'the round ended');
  assert.deepEqual(evaluatePlayersHit(inRoundOf(8000, seed('a'), seed('b')), req(), 9000, 3000), { outcome: 'invalid' }, 'a shot from the previous round');
  assert.deepEqual(evaluatePlayersHit({ ...players, b: { ...players.b, round: null } }, req(), 9000, 3000), { outcome: 'invalid' }, 'a target not in the round');
  assert.deepEqual(evaluatePlayersHit(players, req({ roundStartAt: null }), 9000, 3000), { outcome: 'invalid' }, 'a shot that knows no round');
  assert.deepEqual(evaluatePlayersHit(map(seed('a'), seed('b')), req(), 9000, 3000), { outcome: 'invalid' }, 'players from before the round stamp');
  assert.deepEqual(evaluatePlayersHit(null, req(), 9000, 3000), { outcome: 'invalid' });
  assert.deepEqual(evaluatePlayersHit(players, req(), 7000 - ROUND_START_SKEW_MS - 1, 3000), { outcome: 'invalid' }, 'the countdown');
  assert.equal(evaluatePlayersHit(players, req(), 7000 - ROUND_START_SKEW_MS, 3000).outcome, 'hit', 'within clock skew of the start');
  assert.equal(roundOpenFor(PLAYING, 7000), true);
  assert.equal(roundOpenFor(PLAYING, Number.NaN), false);
  for (const status of ['lobby', 'countdown', 'ended'] as const) assert.equal(roundOpenFor({ ...PLAYING, status }, 7000), false, status);
  // Refusals inside the round keep their own outcome and write nothing.
  assert.deepEqual(evaluatePlayersHit(inRoundOf(7000, seed('a'), seed('b', { status: 'out', lives: 0 }), seed('c')), req(), 9000, 3000), { outcome: 'dead' });
  // A shot id must be a plain key; '/' would address another path.
  for (const shotId of ['', 'a/b', 'a.b', '$x', 'x'.repeat(65)]) assert.equal(isShotId(shotId), false, shotId);
  assert.deepEqual(evaluatePlayersHit(players, req({ shotId: 'shots/../x' }), 9000, 3000), { outcome: 'invalid' });
  assert.equal(isShotId('mg2x1k-a9f3'), true, "the game's own ids");
  // The database refuses NaN; a malformed score must not cost the hit.
  assert.equal(evaluatePlayersHit(players, req({ score: Number.NaN }), 9000, 3000).record?.score, 0);
});

test("a hit survives the phone's own write landing while its transaction is pending, and still applies once", async () => {
  // The live database (npm run e2e, 2026-10-01) failed hits with Error('set'): the SDK aborts a pending
  // transaction when the same client writes at, above or below its path, as the heartbeat does.
  const { db, backend, code, current, hit } = await makeRoom(2);
  const pending = hit('p1', 'p0', 'abort-1');
  await backend.updatePlayer(code, 'p1', { seenAt: backend.now() });
  assert.equal(await pending, 'hit');
  assert.ok(db.aborts >= 1, "the first attempt was aborted by the phone's own write");
  assert.equal(current().players.p0.lives, 2, 'applied once');
  assert.equal(current().players.p1.tags, 1);
  // The whole-room transactions retry the same way.
  const ending = backend.endRound(code, true);
  await backend.updatePlayer(code, 'p0', { seenAt: backend.now() });
  assert.equal(await ending, 'ended');
  assert.ok(Object.values(current().players).every((p) => p.round === null), 'the ended round is no longer carried by anyone');
});

test('invulnMs below 500 is clamped: a shield of 0 still costs one life per instant, not two', () => {
  assert.equal(MIN_INVULN_MS, 500);
  assert.equal(shieldMs(0), MIN_INVULN_MS);
  assert.equal(shieldMs(-100), MIN_INVULN_MS);
  assert.equal(shieldMs(Number.NaN), MIN_INVULN_MS);
  assert.equal(shieldMs(undefined), MIN_INVULN_MS, 'a room saved without the field');
  assert.equal(shieldMs(3000), 3000);
  const first = evaluateHit(map(seed('a'), seed('b'), seed('c')), 'a', 'b', 10000, 0);
  assert.equal(first.outcome, 'hit');
  assert.equal(evaluateHit(first.players!, 'c', 'b', 10000 + MIN_INVULN_MS - 1, 0).outcome, 'invulnerable');
  assert.equal(evaluateHit(first.players!, 'c', 'b', 10000 + MIN_INVULN_MS, 0).outcome, 'hit');
});

test('a shield set to 0 in a live room: two shooters hitting one target in the same instant cost one life', async () => {
  const { backend, code, current, hit } = await makeRoom(2, 'lobby');
  await backend.startRound(code, { ...DEFAULT_SETTINGS, invulnMs: 0 }, backend.now());
  await backend.beginPlay(code, current().startAt!);
  const outcomes = await Promise.all([hit('p1', 'p0'), hit('p2', 'p0')]);
  assert.deepEqual(outcomes.sort(), ['hit', 'invulnerable']);
  assert.equal(current().players.p0.lives, 2);
});

test('duplicate shot id applies once: a resent or doubled shot costs one life and one tag', async () => {
  const { db, backend, code, current, hit } = await makeRoom(2);
  assert.equal(await hit('p1', 'p0', 'tap-A'), 'hit');
  assert.equal(current().players.p0.lives, 2);
  // Take the shield away so only the shot record can refuse the resend.
  await backend.updatePlayer(code, 'p0', { lastHitAt: 0 });
  assert.equal(await hit('p1', 'p0', 'tap-A'), 'hit', 'answered as it landed');
  assert.equal(current().players.p0.lives, 2, 'not applied again');
  assert.equal(current().players.p1.tags, 1);
  // The same shot sent twice at once (a retry racing the original): one commits, the other finds its record.
  const twice = await Promise.all([hit('p2', 'p1', 'tap-B'), hit('p2', 'p1', 'tap-B')]);
  assert.deepEqual(twice, ['hit', 'hit']);
  assert.equal(current().players.p1.lives, 2);
  assert.equal(current().players.p2.tags, 1);
  assert.deepEqual(Object.keys(ledgers(db, code)).sort(), ['tap-A', 'tap-B']);
  // A new shot is a new hit.
  await backend.updatePlayer(code, 'p0', { lastHitAt: 0 });
  assert.equal(await hit('p1', 'p0', 'tap-C'), 'hit');
  assert.equal(current().players.p0.lives, 1);
});

test("a hit carrying an old round's startAt is refused after a new round starts, even one still queued when it began", async () => {
  const { db, backend, code, current, hit } = await makeRoom(2);
  const oldRound = current().startAt!;
  assert.equal(await backend.endRound(code, true), 'ended');
  await backend.resetForNewRound(code, oldRound);
  await backend.startRound(code, DEFAULT_SETTINGS, oldRound + 60000);
  await backend.beginPlay(code, oldRound + 60000);
  assert.equal(await hit('p1', 'p0', 'late-1', oldRound), 'invalid');
  assert.equal(current().players.p0.lives, 3);
  assert.equal(current().players.p1.tags, 0);
  assert.deepEqual(ledgers(db, code), {}, 'nothing recorded');
  // Queued: the write is on its way when another phone starts the next round; it reaches the server
  // after, and is refused there. (Rounds change only through startRound, which stamps the players.)
  const newRound = current().startAt!;
  const queued = hit('p1', 'p0', 'late-2', newRound);
  serverStartsRound(db, code, newRound + 60000, true);
  assert.equal(await queued, 'invalid');
  assert.equal(current().players.p0.lives, 3);
  // Unheard: this phone still believes the old round is on (its cache passes the shot); the server does not.
  serverStartsRound(db, code, newRound + 120000, false);
  assert.equal(current().startAt, newRound + 60000, 'the phone has not heard');
  assert.equal(await hit('p1', 'p0', 'late-3'), 'invalid');
  assert.equal(db.readAt(['rooms', code, 'players', 'p0', 'lives']), 3);
});

test('a hit after the round ended is refused inside the transaction, whatever the phone last heard', async () => {
  const { db, code, current, hit } = await makeRoom(2);
  // Another phone has ended the round (endRound: meta and the players' round stamps in one write);
  // this phone's subscription has not heard yet, so only the transaction can tell.
  const other = new FirebaseBackend(db.sdk(), {} as Database);
  db.writeUnheard(['rooms', code, 'meta', 'status'], 'ended');
  for (const id of Object.keys(current().players)) db.writeUnheard(['rooms', code, 'players', id, 'round'], null);
  assert.equal(current().status, 'playing', 'the phone still sees the round playing');
  assert.equal(await hit('p1', 'p0'), 'invalid');
  assert.equal(db.readAt(['rooms', code, 'players', 'p0', 'lives']), 3);
  assert.equal(db.readAt(['rooms', code, 'players', 'p1', 'tags']), 0);
  assert.deepEqual(ledgers(db, code), {});
  assert.equal(await other.endRound(code, true), 'already', 'the real endRound agrees the round is over');
  // And a phone that has heard the round is over refuses at once, without a transaction.
  db.writeAt(['rooms', code, 'meta', 'status'], 'ended');
  const version = db.version;
  assert.equal(await hit('p1', 'p0'), 'invalid');
  assert.equal(db.version, version);
});

test('the local backend keeps the same hit rules: its own round only, once per shot, never below the minimum shield', async () => {
  const local = new LocalBackend();
  const code = await local.createRoom({ id: 'a', name: 'A' });
  await local.joinRoom(code, { id: 'b', name: 'B' });
  await local.joinRoom(code, { id: 'c', name: 'C' });
  for (const id of ['a', 'b', 'c']) await local.updatePlayer(code, id, { enrolled: true });
  let room: Room | null = null;
  local.subscribe(code, (r) => (room = r));
  const startAt = local.now();
  await local.startRound(code, { ...DEFAULT_SETTINGS, invulnMs: 0 }, startAt);
  assert.equal(await local.registerHit(code, 'a', 'b', 0.9, 'face', 's1', startAt), 'invalid', 'countdown');
  await local.beginPlay(code, startAt);
  assert.equal(await local.registerHit(code, 'a', 'b', 0.9, 'face', 's1', startAt - 1), 'invalid', 'another round');
  assert.equal(await local.registerHit(code, 'a', 'b', 0.9, 'face', 's1', startAt), 'hit');
  assert.equal(await local.registerHit(code, 'c', 'b', 0.9, 'face', 's2', startAt), 'invulnerable', 'a shield of 0 is 500 ms');
  await local.updatePlayer(code, 'b', { lastHitAt: 0 });
  assert.equal(await local.registerHit(code, 'a', 'b', 0.9, 'face', 's1', startAt), 'hit', 'a resent shot is answered as it landed');
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(room, 'room subscribed');
  assert.equal((room as Room).players.b.lives, 2);
  assert.equal((room as Room).players.a.tags, 1);
  // A new round forgets the old shots; its startAt refuses them anyway.
  await local.endRound(code, true);
  await local.resetForNewRound(code, startAt);
  await local.startRound(code, DEFAULT_SETTINGS, startAt + 1000);
  await local.beginPlay(code, startAt + 1000);
  assert.equal(await local.registerHit(code, 'a', 'b', 0.9, 'face', 's1', startAt), 'invalid');
  assert.equal(await local.registerHit(code, 'a', 'b', 0.9, 'face', 's1', startAt + 1000), 'hit', 'a fresh round, a fresh record');
});

// ---- Round status steps: each applies only from the state the phone saw --------------------------

test('the countdown becomes play once, only from its own countdown: a flip replayed by a phone that was away cannot reopen an ended round or start a reset lobby', async () => {
  const { db, backend, code, current } = await makeRoom(2, 'lobby');
  const startAt = backend.now();
  assert.equal(await backend.startRound(code, DEFAULT_SETTINGS, startAt), true);
  assert.equal(await backend.beginPlay(code, startAt + 1), false, "another round's countdown");
  assert.equal(current().status, 'countdown');
  assert.equal(await backend.beginPlay(code, startAt), true);
  assert.equal(current().status, 'playing');
  assert.equal(await backend.beginPlay(code, startAt), false, 'every phone may ask; one flips it');
  // Phone X slept through the end of the countdown. Its flip, buffered until it reconnects, reaches
  // the server after the round was ended (a forfeit or the host's end): the round stays over.
  const x = new FirebaseBackend(db.sdk(), {} as Database);
  assert.equal(await backend.endRound(code, true), 'ended');
  assert.equal(await x.beginPlay(code, startAt), false);
  assert.equal(current().status, 'ended', 'the ended round is not reopened');
  assert.ok(Object.values(current().players).every((p) => (p.round ?? null) === null));
  // Or after the host already went back to the lobby: no round with no start.
  assert.equal(await backend.resetForNewRound(code, startAt), true);
  assert.equal(await x.beginPlay(code, startAt), false);
  assert.equal(current().status, 'lobby');
  assert.equal(current().startAt ?? null, null);
});

test('a Start or Back to lobby replayed after the room moved on changes nothing: a round starts only from the lobby and resets only from its own end', async () => {
  const { db, backend, code, current, hit } = await makeRoom(2);
  const round = current().startAt!;
  assert.equal(await hit('p1', 'p0', 'mid-1'), 'hit');
  // The old host's taps, buffered while it was offline, arrive mid-round (a new host started it).
  const oldHost = new FirebaseBackend(db.sdk(), {} as Database);
  assert.equal(await oldHost.resetForNewRound(code, round), false, 'the round has not ended');
  assert.equal(await oldHost.startRound(code, DEFAULT_SETTINGS, round - 60000), false, 'not in the lobby');
  assert.equal(current().status, 'playing');
  assert.equal(current().startAt, round);
  assert.equal(current().players.p0.lives, 2, 'the round keeps its lives');
  assert.ok(Object.values(current().players).every((p) => p.round === round), 'and its round stamps');
  assert.deepEqual(Object.keys(ledgers(db, code)), ['mid-1'], 'and its shot records');
  // Ended: Back to lobby from another round's results is stale too; this round's applies, once.
  assert.equal(await backend.endRound(code, true), 'ended');
  assert.equal(await oldHost.resetForNewRound(code, round - 60000), false, "another round's results");
  assert.equal(current().status, 'ended');
  assert.equal(await backend.resetForNewRound(code, round), true);
  assert.equal(current().status, 'lobby');
  assert.equal(await backend.resetForNewRound(code, round), false, 'a second tap is a no-op');
  // From the lobby a Start applies once: a double tap does not restart the countdown.
  assert.equal(await backend.startRound(code, DEFAULT_SETTINGS, round + 60000), true);
  assert.equal(await backend.startRound(code, DEFAULT_SETTINGS, round + 61000), false);
  assert.equal(current().status, 'countdown');
  assert.equal(current().startAt, round + 60000);
});

test('the local backend keeps the same status steps: start from the lobby, play from its own countdown, reset from its own end', async () => {
  const local = new LocalBackend();
  const code = await local.createRoom({ id: 'a', name: 'A' });
  await local.joinRoom(code, { id: 'b', name: 'B' });
  for (const id of ['a', 'b']) await local.updatePlayer(code, id, { enrolled: true });
  let room: Room | null = null;
  local.subscribe(code, (r) => (room = r));
  assert.equal(await local.beginPlay(code, 5), false, 'no countdown');
  assert.equal(await local.startRound(code, DEFAULT_SETTINGS, 5), true);
  assert.equal(await local.startRound(code, DEFAULT_SETTINGS, 6), false);
  assert.equal(await local.resetForNewRound(code, 5), false, 'not ended');
  assert.equal(await local.beginPlay(code, 6), false);
  assert.equal(await local.beginPlay(code, 5), true);
  assert.equal(await local.beginPlay(code, 5), false);
  assert.equal(await local.endRound(code, true), 'ended');
  assert.equal(await local.beginPlay(code, 5), false, 'an ended round is not reopened');
  assert.equal(await local.resetForNewRound(code, 4), false);
  assert.equal(await local.resetForNewRound(code, 5), true);
  assert.equal(await local.beginPlay(code, 5), false, 'nor a lobby started');
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(room, 'room subscribed');
  assert.equal((room as Room).status, 'lobby');
  assert.equal((room as Room).startAt, null);
});

test("a hit that reaches the server late is judged at the shot: two shooters tagging one target in the same instant cost one life, however slow the second phone's network", async () => {
  const { db, backend, code, current } = await makeRoom(2, 'lobby');
  // The shortest shield (500 ms); the second phone's write takes longer than that to reach the server.
  await backend.startRound(code, { ...DEFAULT_SETTINGS, invulnMs: 0 }, backend.now());
  const round = current().startAt!;
  await backend.beginPlay(code, round);
  const slow = new FirebaseBackend(db.sdk({ latencyMs: MIN_INVULN_MS + 100 }), {} as Database);
  const outcomes = await Promise.all([
    slow.registerHit(code, 'p2', 'p0', 0.9, 'face', 'slow-1', round),
    backend.registerHit(code, 'p1', 'p0', 0.9, 'face', 'fast-1', round),
  ]);
  assert.deepEqual(outcomes, ['invulnerable', 'hit']);
  assert.ok(db.retries >= 1, "the slow write was re-run after the fast one's commit");
  assert.equal(db.readAt(['rooms', code, 'players', 'p0', 'lives']), 2, 'one life for one instant');
  assert.deepEqual(Object.keys(ledgers(db, code)), ['fast-1']);
});

test("a hit whose answer is lost to a dropped connection is sent again and answered from the target's ledger: its real outcome, one life", async () => {
  // The SDK rejects a sent transaction with Error('disconnect') when the socket drops before the
  // answer, whether or not the server applied it, and never sends it again by itself.
  const { db, code, current, hit } = await makeRoom(2);
  db.dropNextAnswer = 'applied';
  assert.equal(await hit('p1', 'p0', 'drop-1'), 'hit', 'it had landed: answered as it landed');
  assert.equal(current().players.p0.lives, 2, 'applied once');
  assert.equal(current().players.p1.tags, 1);
  db.dropNextAnswer = 'lost';
  assert.equal(await hit('p1', 'p2', 'drop-2'), 'hit', 'it never arrived: sent again, it lands');
  assert.equal(current().players.p2.lives, 2);
  assert.deepEqual(Object.keys(ledgers(db, code)).sort(), ['drop-1', 'drop-2']);
});
