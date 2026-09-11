import assert from 'node:assert/strict';
import test from 'node:test';
import { rangeTest, summarizeRangeShots, type RangeShot } from '../src/debug/rangeTest.ts';
import { UNKNOWN_ID } from '../src/types.ts';

const shot = (change: Partial<RangeShot> = {}): RangeShot => ({
  t: 1, distance: 3, locked: false, resolveMs: 200, zoom: false, ...change,
});

test('a correct opponent lock, wrong player, and missed target are distinct outcomes', () => {
  const [result] = summarizeRangeShots([
    shot({ expectedId: 'alice', locked: true, targetId: 'alice' }),
    shot({ expectedId: 'alice', locked: true, targetId: 'bob' }),
    shot({ expectedId: 'alice', locked: false }),
  ]);
  assert.equal(result.evaluated, 3);
  assert.equal(result.correct, 1);
  assert.equal(result.wrongPlayer, 1);
  assert.equal(result.missed, 1);
  assert.equal(result.falseLocks, 0);
  assert.equal(result.lockRate, 2 / 3);
});

test('non-player trials reward rejection and count any player lock as a false lock', () => {
  const [result] = summarizeRangeShots([
    shot({ expectedId: UNKNOWN_ID, locked: false }),
    shot({ expectedId: UNKNOWN_ID, locked: true, targetId: 'alice' }),
  ]);
  assert.equal(result.evaluated, 2);
  assert.equal(result.correct, 1);
  assert.equal(result.falseLocks, 1);
  assert.equal(result.wrongPlayer, 0);
  assert.equal(result.missed, 0);
});

test('unlabelled historical records affect performance metrics but not correctness', () => {
  const [result] = summarizeRangeShots([
    shot({ locked: true, targetId: 'alice', resolveMs: 100, zoom: true }),
    shot({ expectedId: 'alice', locked: true, targetId: 'alice', resolveMs: 300 }),
  ]);
  assert.deepEqual(result, {
    distance: 3, shots: 2, lockRate: 1, meanResolveMs: 200, zoomRate: 0.5,
    evaluated: 1, correct: 1, wrongPlayer: 0, missed: 0, falseLocks: 0,
  });
});

test('a lock without the selected player ID cannot be credited as correct', () => {
  const [result] = summarizeRangeShots([
    shot({ expectedId: 'alice', locked: true, targetName: 'Alice' }),
  ]);
  assert.equal(result.correct, 0);
  assert.equal(result.wrongPlayer, 1);
});

test('distance groups stay independent and sorted, including a fully unlabelled group', () => {
  const results = summarizeRangeShots([
    shot({ distance: 8, expectedId: 'bob', locked: false }),
    shot({ distance: 1, locked: true }),
    shot({ distance: 4, expectedId: UNKNOWN_ID, locked: false }),
  ]);
  assert.deepEqual(results.map((r) => r.distance), [1, 4, 8]);
  assert.equal(results[0].evaluated, 0);
  assert.equal(results[0].correct, 0);
  assert.equal(results[1].correct, 1);
  assert.equal(results[2].missed, 1);
  for (const result of results) {
    assert.equal(result.evaluated, result.correct + result.wrongPlayer + result.missed + result.falseLocks);
  }
  assert.deepEqual(summarizeRangeShots([]), []);
});

test('the range-test recorder returns the same accuracy summary and clears cleanly', () => {
  rangeTest.clear();
  try {
    const record = shot({ expectedId: 'alice', locked: true, targetId: 'alice' });
    rangeTest.add(record);
    assert.deepEqual(rangeTest.summary(), summarizeRangeShots([record]));
    const copy = rangeTest.all();
    copy.pop();
    assert.equal(rangeTest.all().length, 1);
    rangeTest.clear();
    assert.deepEqual(rangeTest.all(), []);
    assert.deepEqual(rangeTest.summary(), []);
  } finally {
    rangeTest.clear();
  }
});
