import test from 'node:test';
import assert from 'node:assert/strict';
import { crosshairRect, indexInSight } from '../src/vision/geometry';
import { burstAllowanceMs, canConfirmShot, FramePeriod, freshFrame, MAX_STALE_FRAME_MS, snapshotTrack, STALE_FRAME_MS, staleAllowanceMs } from '../src/vision/shot';
import { Tracker } from '../src/vision/tracker';

test('the centre dot selects one person, never a larger neighbour touching the reticle edge', () => {
  assert.equal(indexInSight([[0, 0, 0.49, 1], [0.49, 0.4, 0.1, 0.2]], [0.29, 0.35, 0.42, 0.3]), 1);
  assert.equal(indexInSight([[0, 0, 0.49, 1]], [0.29, 0.35, 0.42, 0.3]), -1);
});

test('overlapping bodies under the dot produce no target', () => {
  assert.equal(indexInSight([[0.2, 0.1, 0.5, 0.8], [0.4, 0.2, 0.4, 0.7]], [0.29, 0.35, 0.42, 0.3]), -1);
});

test('portrait cover cropping keeps the aim point aligned with the video centre', () => {
  const ch = crosshairRect(1280, 720, 390, 844);
  assert.ok(Math.abs(ch[0] + ch[2] / 2 - 0.5) < 1e-10);
  assert.ok(Math.abs(ch[1] + ch[3] / 2 - 0.5) < 1e-10);
  assert.equal(indexInSight([[0.48, 0.45, 0.04, 0.1]], ch), 0);
});

test('frame age includes slow inference and rejects future/invalid timestamps', () => {
  assert.equal(freshFrame(100, 449), true);
  assert.equal(freshFrame(100, 451), false);
  assert.equal(freshFrame(100, 99), false);
  assert.equal(freshFrame(NaN, 100), false);
});

test('pending shots cannot follow a vanished player or use a pre-tap or late frame', () => {
  const t = new Tracker().update([{ box: [0.3, 0.2, 0.3, 0.6] }], 100)[0];
  const p = { trackId: t.id, startedAt: 100, deadline: 400 };
  assert.equal(canConfirmShot(p, t, 150, 200), true);
  assert.equal(canConfirmShot(p, null, 150, 200), false);
  assert.equal(canConfirmShot(p, { ...t, id: t.id + 1 }, 150, 200), false);
  assert.equal(canConfirmShot(p, t, 99, 200), false);
  assert.equal(canConfirmShot(p, t, 300, 401), false);
});

test('published shots cannot observe an unfinished frame mutating tracking state', () => {
  const t = new Tracker().update([{ box: [0.3, 0.2, 0.3, 0.6] }], 100)[0];
  t.belief = { alice: 0.9 };
  t.claimed = { alice: 0.9 };
  t.faceMean = [1, 0];
  const frozen = snapshotTrack(t);
  t.box[0] = 0.8;
  t.belief.alice = 0;
  t.claimed.alice = 0;
  t.faceMean[0] = 0;
  assert.equal(frozen.box[0], 0.3);
  assert.equal(frozen.belief.alice, 0.9);
  assert.equal(frozen.claimed?.alice, 0.9);
  assert.equal(frozen.faceMean?.[0], 1);
});

test('the stale allowance follows the measured frame period between fixed bounds', () => {
  assert.equal(staleAllowanceMs(NaN), STALE_FRAME_MS);
  assert.equal(staleAllowanceMs(60), STALE_FRAME_MS);
  // A phone finishing a frame every 300 ms has its newest frame 300-600 ms old at any tap.
  assert.ok(staleAllowanceMs(300) >= 650);
  assert.equal(staleAllowanceMs(2000), MAX_STALE_FRAME_MS);
  assert.ok(burstAllowanceMs(300) >= 700 && burstAllowanceMs(60) === 300 && burstAllowanceMs(5000) === 900);
  assert.equal(freshFrame(100, 700, staleAllowanceMs(300)), true);
  assert.equal(canConfirmShot({ trackId: 1, startedAt: 100, deadline: 900 }, { id: 1 } as never, 150, 700, staleAllowanceMs(300)), true);
});

test('the frame period is a median that ignores one hiccup and resets with the camera', () => {
  const p = new FramePeriod();
  assert.ok(Number.isNaN(p.ms()));
  for (const t of [0, 200, 400, 600, 1900, 2100, 2300]) p.push(t);
  assert.equal(p.ms(), 200);
  p.reset();
  assert.ok(Number.isNaN(p.ms()));
});
