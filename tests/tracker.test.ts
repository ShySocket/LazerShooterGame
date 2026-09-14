import assert from 'node:assert/strict';
import test from 'node:test';
import type { BodyResult, FaceResult } from '@vladmandic/human';
import { buildDetections, faceBodyBox, faceOwner, hitRegion, resetIdentity, Tracker, type Detection } from '../src/vision/tracker.ts';
import type { NBox } from '../src/vision/geometry.ts';
import { resolveHit, updateBelief } from '../src/vision/scoring.ts';

const detection = (x: number, width = 0.2): Detection => ({ box: [x, 0.1, width, 0.7] });
const body = (box: NBox, nose?: [number, number]): BodyResult => ({
  boxRaw: box,
  score: 0.95,
  keypoints: nose ? [{ part: 'nose', positionRaw: nose, score: 0.95 }] : [],
} as unknown as BodyResult);
const face = (box: NBox, id: number): FaceResult => ({ boxRaw: box, boxScore: 0.95, id } as FaceResult);

test('association uses head landmarks when friends overlap, regardless of face detection order', () => {
  const left = face([0.3, 0.15, 0.1, 0.1], 1);
  const right = face([0.6, 0.15, 0.1, 0.1], 2);
  const dets = buildDetections([
    body([0.1, 0.15, 0.7, 0.75], [0.35, 0.2]),
    body([0.2, 0.15, 0.7, 0.75], [0.65, 0.2]),
  ], [right, left]);
  assert.equal(dets.length, 2);
  assert.equal(dets[0].face?.id, 1);
  assert.equal(dets[1].face?.id, 2);
  assert.equal(faceOwner([0.6, 0.15, 0.1, 0.1], dets), 1);
});

test('ambiguous face ownership disables both bodies instead of duplicating a target', () => {
  const dets = buildDetections([
    body([0.2, 0.1, 0.5, 0.8]),
    body([0.22, 0.1, 0.5, 0.8]),
  ], [face([0.4, 0.15, 0.1, 0.1], 1)]);
  assert.equal(dets.length, 2);
  assert.ok(dets.every((d) => d.associationAmbiguous && !d.face));
  assert.equal(faceOwner([0.4, 0.15, 0.1, 0.1], dets), -1);
});

test('a face inside somebody else\'s torso is not attached to their head', () => {
  const dets = buildDetections([body([0.1, 0.1, 0.8, 0.85], [0.4, 0.2])], [face([0.35, 0.15, 0.1, 0.1], 1)]);
  assert.equal(faceOwner([0.35, 0.65, 0.1, 0.1], dets), -1);
});

test('two faces claiming a headless body make the body ambiguous', () => {
  const dets = buildDetections([body([0.1, 0.1, 0.8, 0.85])], [
    face([0.25, 0.15, 0.1, 0.1], 1), face([0.6, 0.15, 0.1, 0.1], 2),
  ]);
  assert.equal(dets.length, 1);
  assert.equal(dets[0].associationAmbiguous, true);
  assert.equal(dets[0].face, undefined);
});

test('a face without a pose remains usable and duplicate face detections collapse', () => {
  const dets = buildDetections([], [face([0.4, 0.2, 0.1, 0.1], 1), face([0.401, 0.201, 0.1, 0.1], 2)]);
  assert.equal(dets.length, 1);
  assert.equal(faceOwner([0.4, 0.2, 0.1, 0.1], dets), 0);
});

test('malformed or low-confidence detections cannot become targets', () => {
  const lowFace = { ...face([0.4, 0.2, 0.1, 0.1], 1), boxScore: 0.2 };
  const dets = buildDetections([body([NaN, 0, 1, 1]), { ...body([0, 0, 1, 1]), score: 0.1 }], [lowFace]);
  assert.deepEqual(dets, []);
});

test('track matching is independent of detector output ordering', () => {
  const tracker = new Tracker();
  const [a, b] = tracker.update([detection(0.1), detection(0.6)], 100);
  a.belief.alice = 0.95;
  b.belief.bob = 0.95;
  const next = tracker.update([detection(0.61), detection(0.11)], 200);
  assert.deepEqual(next.map((t) => t.id), [b.id, a.id]);
  assert.equal(next[1].belief.alice, 0.95);
});

test('motion prediction keeps distinguishable crossing trajectories attached to their players', () => {
  const tracker = new Tracker();
  const initial = tracker.update([detection(0.15), detection(0.65)], 100);
  initial[0].belief.alice = 0.95;
  initial[1].belief.bob = 0.95;
  for (const [time, left, right] of [[200, 0.25, 0.55], [300, 0.35, 0.45], [400, 0.45, 0.35]]) {
    const tracks = tracker.update([detection(left), detection(right)], time);
    assert.deepEqual(tracks.map((t) => t.id), initial.map((t) => t.id));
    assert.equal(tracks[0].belief.alice, 0.95);
    assert.equal(tracks[1].belief.bob, 0.95);
  }
});

test('an expired track cannot lend its identity to a person entering the same box', () => {
  const tracker = new Tracker();
  const [old] = tracker.update([detection(0.3)], 100);
  old.belief.alice = 0.99;
  const [current] = tracker.update([detection(0.3)], 1700);
  assert.notEqual(current.id, old.id);
  assert.deepEqual(current.belief, {});
  assert.equal(tracker.get(old.id), undefined);
});

test('a person the detector skipped for a frame keeps their identity when they reappear in place', () => {
  const tracker = new Tracker();
  const [old] = tracker.update([detection(0.3)], 100);
  old.belief.alice = 0.99;
  tracker.update([], 300);
  const [current] = tracker.update([detection(0.31)], 500);
  assert.equal(current.id, old.id);
  assert.equal(current.belief.alice, 0.99);
});

test('reappearance after a long gap, or away from the expected place, requires fresh identity evidence', () => {
  for (const [gapEnd, x] of [[700, 0.3], [400, 0.45]] as const) {
    const tracker = new Tracker();
    const [old] = tracker.update([detection(0.3)], 100);
    old.belief.alice = 0.99;
    tracker.update([], 200);
    const [current] = tracker.update([detection(x)], gapEnd);
    assert.notEqual(current.id, old.id);
    assert.deepEqual(current.belief, {});
  }
});

test('a short gap never lets one person inherit the identity of two candidates', () => {
  const tracker = new Tracker();
  const [a, b] = tracker.update([detection(0.3), detection(0.42)], 100);
  a.belief.alice = 0.99;
  b.belief.bob = 0.99;
  tracker.update([], 250);
  const [current] = tracker.update([detection(0.36)], 400);
  assert.ok(current.id !== a.id && current.id !== b.id);
  assert.deepEqual(current.belief, {});
});

test('indistinguishable crossing boxes do not inherit either old identity', () => {
  const tracker = new Tracker();
  const initial = tracker.update([detection(0.3), detection(0.4)], 100);
  initial[0].belief.alice = 0.99;
  initial[1].belief.bob = 0.99;
  const current = tracker.update([detection(0.35), detection(0.35)], 200);
  assert.ok(current.every((t) => !initial.some((old) => t.id === old.id)));
  assert.ok(current.every((t) => Object.keys(t.belief).length === 0));
});

test('ambiguous association keeps the track and its identity but suspends locks and hits until fresh evidence', () => {
  const tracker = new Tracker();
  const [old] = tracker.update([detection(0.3)], 100);
  updateBelief(old, { alice: 1 }, 1, 100);
  updateBelief(old, { alice: 1 }, 1, 150);
  assert.ok(resolveHit(old, new Set(['alice']), 0.5, 0.2, 160));
  const [current] = tracker.update([{ ...detection(0.3), associationAmbiguous: true }], 200);
  assert.equal(current.id, old.id, 'the body continues its track');
  assert.ok(current.belief.alice > 0.9, 'the identity is kept');
  assert.equal(current.unconfirmed, true);
  assert.equal(resolveHit(current, new Set(['alice']), 0.5, 0.2, 210), null, 'but it cannot take a hit yet');
  updateBelief(current, { alice: 1 }, 0.3, 400);
  assert.equal(current.unconfirmed, false);
  assert.ok(resolveHit(current, new Set(['alice']), 0.5, 0.2, 410), 'fresh evidence restores it');
});

test('identity reset clears evidence freshness, conflict and face history together', () => {
  const [track] = new Tracker().update([detection(0.3)], 100);
  Object.assign(track, { belief: { alice: 0.99 }, claimed: { alice: 0.99 }, identityConflict: true, faceMean: [1, 0], faceSamples: 10, lastFaceAt: 100, lastEvidenceAt: 100, via: 'face' });
  resetIdentity(track);
  assert.deepEqual(track.belief, {});
  assert.equal(track.claimed, null);
  assert.equal(track.identityConflict, false);
  assert.equal(track.lastEvidenceAt, 0);
  assert.equal(track.lastFaceAt, 0);
  assert.equal(track.faceMean, null);
  assert.equal(track.faceSamples, 0);
  assert.equal(track.via, 'none');
});

test('a reset never reuses IDs that an earlier pending shot could reference', () => {
  const tracker = new Tracker();
  const [old] = tracker.update([detection(0.3)], 100);
  tracker.reset();
  const [current] = tracker.update([detection(0.3)], 200);
  assert.notEqual(current.id, old.id);
});

test('when only one of two neighbours is detected, the skipped neighbour reclaims its own body instead of the live track swallowing it', () => {
  const tracker = new Tracker();
  const [a, b] = tracker.update([detection(0.3, 0.24), detection(0.46, 0.22)], 100);
  a.belief.alice = 0.9;
  b.belief.bob = 0.9;
  // Bob's body is skipped for one frame while Alice drifts a little.
  const [onlyA] = tracker.update([detection(0.31, 0.24)], 300);
  assert.equal(onlyA.id, a.id);
  // Now only Bob's body is found, half a box away from Alice. It must go back to Bob's track.
  const [onlyB] = tracker.update([detection(0.45, 0.22)], 500);
  assert.equal(onlyB.id, b.id);
  assert.equal(onlyB.belief.bob, 0.9);
  // And Alice reappearing reclaims her own track.
  const both = tracker.update([detection(0.32, 0.25), detection(0.44, 0.22)], 700);
  assert.deepEqual(both.map((t) => t.id), [a.id, b.id]);
});


test('constant motion survives one dropped detection at a 400 ms frame period', () => {
  const tracker = new Tracker();
  const gap = 1100;
  const [a] = tracker.update([detection(0.1)], 0, undefined, gap);
  const [b] = tracker.update([detection(0.2)], 400, undefined, gap);
  assert.equal(b.id, a.id);
  tracker.update([], 800, undefined, gap);
  const [c] = tracker.update([detection(0.4)], 1200, undefined, gap);
  assert.equal(c.id, a.id);
});

test('a track seen last update but a long pause ago must not keep its identity across the pause', () => {
  const tracker = new Tracker();
  const [old] = tracker.update([detection(0.3)], 100);
  old.belief.alice = 0.99;
  const [current] = tracker.update([detection(0.3)], 1400);
  assert.notEqual(current.id, old.id);
  assert.deepEqual(current.belief, {});
});

test('a box under 60% of the track\'s height starts a new track; a jump between 60% and 75% keeps it unconfirmed', () => {
  const box = (h: number): Detection => ({ box: [0.3, 0.2, 0.3, h] });
  const cases: [number, 'same' | 'unconfirmed' | 'new'][] = [[0.8, 'same'], [0.7, 'unconfirmed'], [0.5, 'new']];
  for (const [h, expected] of cases) {
    const tracker = new Tracker();
    const [old] = tracker.update([box(1)], 100);
    updateBelief(old, { alice: 1 }, 1, 100);
    const [current] = tracker.update([box(h)], 320);
    if (expected === 'new') assert.notEqual(current.id, old.id, `height ${h}`);
    else {
      assert.equal(current.id, old.id, `height ${h}`);
      assert.equal(current.unconfirmed, expected === 'unconfirmed', `height ${h}`);
    }
  }
});

/*
 * hitRegion branches (tracker.ts):
 *   torso landmarks (>= 3 of shoulders/hips) + face box   -> torso box widened to the face, padded
 *   torso landmarks + head landmarks, no face             -> torso box raised to the head landmarks
 *   face only, no body                                    -> the face box, slightly enlarged
 *   body without a usable torso                           -> the middle 60% x 75% of the outer box
 */
const kp = (part: string, x: number, y: number, score = 0.9) => ({ part, positionRaw: [x, y], score });
const pose = (box: NBox, keypoints: ReturnType<typeof kp>[]): BodyResult => ({ boxRaw: box, score: 0.9, keypoints } as unknown as BodyResult);
const torso = [kp('leftShoulder', 0.35, 0.30), kp('rightShoulder', 0.55, 0.30), kp('leftHip', 0.38, 0.55), kp('rightHip', 0.52, 0.55)];
const OUTER: NBox = [0.25, 0.1, 0.4, 0.8];
const inside = (inner: NBox, outer: NBox) => inner[0] >= outer[0] && inner[1] >= outer[1] && inner[0] + inner[2] <= outer[0] + outer[2] && inner[1] + inner[3] <= outer[1] + outer[3];

test('hitRegion: torso landmarks plus a face box give the padded torso reaching up over the face', () => {
  const faceBox: NBox = [0.41, 0.12, 0.08, 0.1];
  const [x, y, w, h] = hitRegion(OUTER, pose(OUTER, torso), face(faceBox, 1));
  const px = 0.2 * 0.12; // shoulder width 0.2, padded by 12%
  assert.ok(Math.abs(x - (0.35 - px)) < 1e-9 && Math.abs(x + w - (0.55 + px)) < 1e-9, `x range ${x}..${x + w}`);
  assert.ok(y < faceBox[1] && y + h > 0.55, `y range ${y}..${y + h} must cover the face top and the hips`);
  assert.ok(y + h < OUTER[1] + OUTER[3] * 0.7, 'the legs are not part of it');
});

test('hitRegion: torso landmarks with head landmarks and no face box reach up to the head', () => {
  const head = [kp('nose', 0.45, 0.2), kp('leftEye', 0.43, 0.18), kp('rightEye', 0.47, 0.18)];
  const noHead = hitRegion(OUTER, pose(OUTER, torso));
  const withHead = hitRegion(OUTER, pose(OUTER, [...torso, ...head]));
  assert.ok(withHead[1] < noHead[1], 'the head raises the top edge');
  assert.ok(withHead[1] < 0.2 && withHead[1] > 0.05, `top ${withHead[1]} sits just above the eyes`);
  // The bottom pad is 6% of the region height, so it grows by a few thousandths with the head; the hips stay the anchor.
  assert.ok(Math.abs(withHead[1] + withHead[3] - (noHead[1] + noHead[3])) < 0.02, 'the bottom edge stays at the hips');
});

test('hitRegion: a face without a body offers only the head', () => {
  const faceBox: NBox = [0.4, 0.2, 0.1, 0.12];
  const r = hitRegion(faceBodyBox(faceBox), undefined, face(faceBox, 1));
  assert.ok(inside(faceBox, r), 'covers the face');
  assert.ok(r[3] < faceBox[3] * 1.4 && r[2] < faceBox[2] * 1.5, `only slightly larger than the face: ${r}`);
  assert.ok(r[1] + r[3] < 0.4, 'nothing below the chin');
});

test('hitRegion: a body without a usable torso falls back to the middle of its box', () => {
  const cases: BodyResult[] = [
    pose(OUTER, []),
    pose(OUTER, torso.slice(0, 2)),
    pose(OUTER, torso.map((k) => ({ ...k, score: 0.2 }))),
  ];
  for (const body of cases) {
    const [x, y, w, h] = hitRegion(OUTER, body);
    assert.deepEqual([x, y, w, h].map((v) => +v.toFixed(6)), [OUTER[0] + OUTER[2] * 0.2, OUTER[1], OUTER[2] * 0.6, OUTER[3] * 0.75].map((v) => +v.toFixed(6)));
  }
});

test('hitRegion: the observed region is the one Detection.hit carries and a lone face keeps a head-only region', () => {
  const dets = buildDetections([pose(OUTER, torso)], [face([0.41, 0.12, 0.08, 0.1], 1)]);
  assert.deepEqual(dets[0].hit, hitRegion(OUTER, dets[0].body, dets[0].face));
  const lone = buildDetections([], [face([0.4, 0.2, 0.1, 0.12], 2)]);
  assert.ok(lone[0].hit && lone[0].hit[3] < 0.2, 'a face-only detection is not shootable below the head');
});
