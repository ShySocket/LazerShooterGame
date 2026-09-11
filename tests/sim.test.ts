import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, SCENARIOS, type Aggregate } from './sim/engine';

/**
 * Whole-round simulation of the shooting pipeline against a synthetic detector (tests/sim/world.ts).
 * These are the gameplay properties a real round depends on. Wrong hits are the worst outcome, so
 * they are bounded tightly everywhere; hit rates are bounded loosely enough to survive model noise.
 */
const SEEDS = [1, 2, 3];
const results = new Map<string, Aggregate>();
const run = async (name: string): Promise<Aggregate> => {
  const scenario = SCENARIOS.find((s) => s.name === name);
  if (!scenario) throw new Error('no scenario ' + name);
  if (!results.has(name)) results.set(name, await aggregate(scenario, SEEDS));
  return results.get(name)!;
};
const hitRate = (a: Aggregate) => a.correct / Math.max(1, a.shots);
const describe = (a: Aggregate) => `${a.name}: ${JSON.stringify(a)}`;

test('face-on at close range nearly every shot lands and the target keeps one track', async () => {
  const a = await run('duel-close');
  assert.ok(hitRate(a) >= 0.9, describe(a));
  assert.equal(a.wrong, 0, describe(a));
  assert.ok(a.trackChurn <= 2, describe(a));
  assert.ok(a.firstLockMs !== null && a.firstLockMs < 1500, describe(a));
});

test('a player facing away is hit through the outfit, without guessing between players', async () => {
  const a = await run('back-shot');
  assert.ok(hitRate(a) >= 0.75, describe(a));
  assert.equal(a.wrong, 0, describe(a));
});

test('at 8 m the outfit still carries most shots', async () => {
  const a = await run('range-8m');
  assert.ok(hitRate(a) >= 0.6, describe(a));
  assert.equal(a.wrong, 0, describe(a));
});

test('an approaching target locks before they are close', async () => {
  const a = await run('approach');
  assert.ok(hitRate(a) >= 0.85, describe(a));
  assert.equal(a.wrong, 0, describe(a));
});

test('crossing players never swap identities', async () => {
  const a = await run('crossing');
  assert.equal(a.wrong, 0, describe(a));
  assert.equal(a.wrongLockFrames, 0, describe(a));
  assert.ok(hitRate(a) >= 0.5, describe(a));
});

test('same-hue tops of a different shade are still told apart from behind', async () => {
  const a = await run('lookalike-tops');
  assert.equal(a.wrong, 0, describe(a));
  assert.ok(hitRate(a) >= 0.5, describe(a));
});

test('identical tops from behind refuse rather than guess', async () => {
  const a = await run('identical-tops');
  assert.equal(a.wrong, 0, describe(a));
  assert.equal(a.wrongLockFrames, 0, describe(a));
});

test('strangers and mirrors are never hit', async () => {
  for (const name of ['stranger', 'mirror']) {
    const a = await run(name);
    assert.equal(a.correct + a.wrong, 0, describe(a));
    assert.equal(a.wrongLockFrames, 0, describe(a));
  }
});

test('a phone that needs 400 ms per frame still fires and hits', async () => {
  const a = await run('slow-phone');
  assert.equal(a.stale, 0, describe(a));
  assert.ok(hitRate(a) >= 0.85, describe(a));
  assert.equal(a.wrong, 0, describe(a));
});

test('a pose model dropping a quarter of frames does not lose the target', async () => {
  const a = await run('flaky-pose');
  assert.ok(hitRate(a) >= 0.8, describe(a));
  assert.equal(a.wrong, 0, describe(a));
  assert.ok(a.trackChurn <= 4, describe(a));
});

test('dim light lowers confidence, not correctness', async () => {
  const a = await run('dim-light');
  assert.ok(hitRate(a) >= 0.8, describe(a));
  assert.equal(a.wrong, 0, describe(a));
});
