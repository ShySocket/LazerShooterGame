import test from 'node:test';
import assert from 'node:assert/strict';
import { farEnough, faceStageDone, faceStageStep, initialFaceStage, initialLap2Stage, LAP2_PROMPTS, medianWidth, SCAN_CALIB, skipFaceAngle, type FaceObs, type FaceStage } from '../src/vision/scan';
import { arrowFor, dotPosition, SCREEN_YAW_SIGN, zoneStates, zoneTarget } from '../src/vision/scanRing';
import { FACE_MIN_SAMPLES, FACE_SAMPLES } from '../src/vision/embedding';

const obs = (t: number, yaw: number, pitch = 0, w = 0.3): FaceObs => ({ t, faces: 1, box: [0.35, 0.3, w, w], blocked: '', yaw, pitch, embedding: [Math.sin(t), Math.cos(t)], w });

/** Hold a pose until the stage takes it. */
function take(st: FaceStage, t: number, yaw: number, pitch = 0, w = 0.3): { st: FaceStage; t: number } {
  for (let i = 0; i < 50; i++, t += 100) {
    const r = faceStageStep(st, obs(t, yaw, pitch, w));
    st = r.stage;
    if (r.accepted) return { st, t: t + 100 };
  }
  throw new Error(`pose yaw ${yaw} pitch ${pitch} never taken`);
}

/** A whole lap 1, the player turning screen-left first (model yaw +20 is side a). */
function lap1(): { st: FaceStage; t: number } {
  let r = { st: initialFaceStage(0), t: 0 };
  for (const [yaw, pitch] of [[0, 0], [20, 0], [-20, 0], [35, 0], [-35, 0], [0, 15], [0, -15], [5, 0]]) r = take(r.st, r.t, yaw, pitch);
  assert.ok(faceStageDone(r.st, FACE_SAMPLES, FACE_MIN_SAMPLES));
  return r;
}

test('ring: after the latch, side a is screen left and chin up is the top, whatever sign the phone reports', () => {
  const { st } = lap1();
  assert.equal(st.scan.yawSign, 1);
  assert.ok(dotPosition(20, 0, st.scan)[0] < 0, 'the turn the player made for "left" moves the dot left');
  assert.ok(dotPosition(0, 15, st.scan)[1] < 0, 'chin up moves the dot up');
  // A phone that reports both the other way round: same picture.
  const inverted = { yawSign: -1, pitchSign: -1 };
  assert.ok(dotPosition(-20, 0, inverted)[0] < 0);
  assert.ok(dotPosition(0, -15, inverted)[1] < 0);
  // Before the latch the screen sign is the default.
  assert.equal(Math.sign(dotPosition(20, 0, { yawSign: 0, pitchSign: 0 })[0]), SCREEN_YAW_SIGN);
  assert.deepEqual(dotPosition(500, -500, st.scan).map(Math.abs), [1, 1], 'the dot stays on the ring');
});

test('ring: the zones follow the prompts, lock as samples land, and a skipped angle shows as skipped', () => {
  let st = initialFaceStage(0);
  let z = zoneStates(st);
  assert.deepEqual(z.map((x) => x.key), ['centre', 'slight-a', 'slight-b', 'further-a', 'further-b', 'up', 'down', 'expression']);
  assert.equal(z[0].state, 'target');
  ({ st } = take(st, 0, 0));
  z = zoneStates(st);
  assert.equal(z[0].state, 'locked');
  assert.equal(z[1].state, 'target');
  st = skipFaceAngle(st, 5000)!.stage;
  z = zoneStates(st);
  assert.equal(z[1].state, 'skipped');
  assert.equal(z[2].state, 'target');
  assert.ok(zoneTarget('slight-a')[0] < 0 && zoneTarget('slight-b')[0] > 0 && zoneTarget('up')[1] < 0 && zoneTarget('down')[1] > 0);
  assert.ok(Math.abs(zoneTarget('further-a')[0]) > Math.abs(zoneTarget('slight-a')[0]), 'further sits further out');
});

test('ring: the arrow is double-headed before the first turn, points to the zone after, and flips on the wrong way', () => {
  let { st, t } = take(initialFaceStage(0), 0, 0);
  // First side prompt: either side counts, so the arrow says so.
  t += SCAN_CALIB.settleMs;
  let r = faceStageStep(st, obs(t, 3));
  assert.equal(r.reason, 'turn-more');
  assert.equal(arrowFor(r.stage, r.reason, dotPosition(3, 0, r.stage.scan)).kind, 'either-x');
  ({ st, t } = take(r.stage, t + 100, 20));
  t += SCAN_CALIB.settleMs;
  // Side b now has a known side: screen right.
  r = faceStageStep(st, obs(t, -3));
  let a = arrowFor(r.stage, r.reason, dotPosition(-3, 0, r.stage.scan));
  assert.equal(a.kind, 'to');
  assert.ok(a.to[0] > a.from[0], 'points right');
  r = faceStageStep(r.stage, obs(t + 100, 20));
  assert.equal(r.reason, 'other-way');
  a = arrowFor(r.stage, r.reason, dotPosition(20, 0, r.stage.scan));
  assert.equal(a.kind, 'flip');
  assert.ok(a.from[0] < 0 && a.to[0] > 0, 'from the wrong side across to the right one');
  assert.equal(arrowFor(r.stage, 'blocked', null).kind, 'none', 'no face, no arrow');
});

test('lap 2: same conventions, five zones, only at arm\'s length, and tagged apart from lap 1', () => {
  const one = lap1();
  assert.equal(medianWidth(one.st), 0.3);
  let st = initialLap2Stage(one.st, one.t);
  assert.equal(st.lap, 2);
  assert.equal(st.scan.yawSign, one.st.scan.yawSign, 'left stays left');
  assert.deepEqual(zoneStates(st).map((z) => z.key), ['centre', 'slight-a', 'slight-b', 'up', 'down']);
  // As close as lap 1: never taken, not even by patience, and the arrow says further.
  let t = one.t + 1000;
  for (let i = 0; i < 80; i++, t += 100) {
    const r = faceStageStep(st, obs(t, 0, 0, 0.3));
    assert.equal(r.accepted, false);
    assert.equal(r.reason, 'further');
    assert.equal(arrowFor(r.stage, r.reason, [0, 0]).kind, 'further');
    st = r.stage;
  }
  assert.ok(farEnough(0.3 * SCAN_CALIB.lap2MaxScale, 0.3) && !farEnough(0.3 * SCAN_CALIB.lap2MaxScale + 0.01, 0.3));
  let r2 = { st, t };
  for (const [yaw, pitch] of [[0, 0], [20, 0], [-20, 0], [0, 15], [0, -15]]) r2 = take(r2.st, r2.t, yaw, pitch, 0.18);
  assert.ok(faceStageDone(r2.st, FACE_SAMPLES, FACE_MIN_SAMPLES), 'lap 2 is done after its five zones');
  assert.equal(r2.st.samples.length, LAP2_PROMPTS.length);
  assert.ok(r2.st.samples.every((s) => s.w === 0.18));
  assert.equal(faceStageDone(one.st, FACE_SAMPLES, FACE_MIN_SAMPLES), true, 'lap 1 is untouched');
});

test('lap 2 can always be finished: an angle the player cannot reach is skipped like in lap 1', () => {
  const one = lap1();
  let st = initialLap2Stage(one.st, one.t);
  let t = one.t;
  let skips = 0;
  for (; t < one.t + 120_000 && !faceStageDone(st, FACE_SAMPLES, FACE_MIN_SAMPLES); t += 100) {
    // Never turns, never tilts.
    let r = faceStageStep(st, obs(t, 1, 1, 0.15));
    if (!r.accepted && r.skippable) {
      const k = skipFaceAngle(r.stage, t);
      if (k) {
        r = k;
        skips++;
      }
    }
    st = r.stage;
  }
  assert.ok(faceStageDone(st, FACE_SAMPLES, FACE_MIN_SAMPLES));
  assert.ok(st.samples.length >= 1 && skips <= 4);
});
