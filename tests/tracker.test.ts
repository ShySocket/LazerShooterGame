import assert from 'node:assert/strict';
import test from 'node:test';
import type { BodyResult, FaceResult } from '@vladmandic/human';
import { buildDetections, faceBodyBox, faceOwner, hitRegion, resetIdentity, Tracker, trackState, type Detection } from '../src/vision/tracker.ts';
import type { NBox } from '../src/vision/geometry.ts';
import { resolveHit, updateBelief, updateFaceMean } from '../src/vision/scoring.ts';

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

test('reappearance after a long gap in place keeps the track but requires fresh evidence; away from it starts over', () => {
  // Lost longer than the gap, back where expected: same track, identity kept, but unconfirmed.
  const tracker = new Tracker();
  const [old] = tracker.update([detection(0.3)], 100);
  updateBelief(old, { alice: 1 }, 1, 100);
  tracker.update([], 200);
  const [current] = tracker.update([detection(0.3)], 700);
  assert.equal(current.id, old.id);
  assert.ok(current.belief.alice > 0.9);
  assert.equal(current.unconfirmed, true);
  assert.equal(resolveHit(current, new Set(['alice']), 0.5, 0.2, 710), null, 'no hit from a reclaimed identity until fresh evidence');
  assert.equal(trackState(current, 700), 'confirmed');
  // Away from the expected place: a new person.
  const other = new Tracker();
  const [o] = other.update([detection(0.3)], 100);
  o.belief.alice = 0.99;
  other.update([], 200);
  const [n] = other.update([detection(0.45)], 400);
  assert.notEqual(n.id, o.id);
  assert.deepEqual(n.belief, {});
  // Retired after the time-to-live: a new person even in place.
  const late = new Tracker();
  const [l] = late.update([detection(0.3)], 100);
  l.belief.alice = 0.99;
  assert.notEqual(late.update([detection(0.3)], 1700)[0].id, l.id);
});

test('a confirmed track outranks a tentative neighbour for a body it explains', () => {
  // The pan-crossing seed-1 replay: Alice tracked for six frames; Bob reappears beside her as a new
  // track; next frame only Alice's body is found. Her confirmed track must keep it.
  const tracker = new Tracker();
  const box = (x: number, w = 0.25, h = 0.36): Detection => ({ box: [x, 0.34, w, h] });
  const frames: [number, Detection[]][] = [
    [4700, [box(0.20), box(0.44, 0.20, 0.34)]], [4936, [box(0.15, 0.23, 0.39), box(0.38, 0.22, 0.33)]],
    [5172, [box(0.13, 0.26, 0.40), box(0.33, 0.23, 0.33)]], [5408, [box(0.15, 0.28, 0.37), box(0.34, 0.23, 0.35)]],
    [5644, [box(0.19, 0.26, 0.36)]], [5860, [box(0.26, 0.25, 0.35), box(0.40, 0.24, 0.32)]],
  ];
  let aliceId = -1;
  for (const [t, dets] of frames) aliceId = tracker.update(dets, t, 1500, 691)[0].id;
  const [alice] = tracker.update([box(0.35, 0.25, 0.37)], 6096, 1500, 691);
  assert.equal(alice.id, aliceId);
  assert.equal(trackState(alice, 6096), 'confirmed');
});

test('a lost confirmed track reclaims its body from a tentative track born in its place', () => {
  const tracker = new Tracker();
  const [old] = tracker.update([detection(0.3)], 100);
  tracker.update([detection(0.3)], 320);
  updateBelief(old, { alice: 1 }, 1, 320);
  // Two frames without a match, then two overlapping detections the lost track cannot choose between:
  // both start tentative tracks.
  tracker.update([], 540);
  const pair = tracker.update([detection(0.28), detection(0.32)], 1300);
  assert.ok(pair.every((p) => p.id !== old.id && trackState(p, 1300) === 'tentative'));
  // One body again, where the confirmed track expects it: the confirmed identity wins it back.
  const [back] = tracker.update([detection(0.3)], 1400);
  assert.equal(back.id, old.id, 'the confirmed identity wins the body back');
  assert.equal(back.unconfirmed, true);
});

test('continuity holds at 100, 200 and 400 ms periods for predictable motion; a long pause comes back unconfirmed', () => {
  const W = 0.2;
  const b = (x: number, w = W, h = 0.7): Detection => ({ box: [x, 0.15, w, h] });
  for (const period of [100, 200, 400]) {
    const gap = Math.max(450, Math.min(1100, period * 3.2));
    const run = (label: string, seq: (i: number) => Detection | null, n: number, expectSame = true) => {
      const tracker = new Tracker();
      let id = -1;
      let t = 0;
      for (let i = 0; i < n; i++, t += period) {
        const d = seq(i);
        const out = tracker.update(d ? [d] : [], t, 1500, gap);
        if (!d) continue;
        if (id >= 0 && expectSame) assert.equal(out[0].id, id, `${label} at ${period} ms, frame ${i}`);
        id = out[0].id;
      }
      return tracker;
    };
    // Constant motion of a third of a box width per frame.
    run('constant motion', (i) => b(0.1 + i * W * 0.33), 8);
    // One-frame dropout in the middle of the same motion.
    run('dropout', (i) => (i === 4 ? null : b(0.1 + i * W * 0.33)), 8);
    // Reversal: three frames right, then left at the same speed.
    run('reversal', (i) => b(0.3 + (i < 3 ? i : 6 - i) * W * 0.3), 7);
    // Approach: the box grows 8% per frame and stays centred.
    run('approach', (i) => { const w = W * 1.08 ** i; const h = 0.5 * 1.08 ** i; return { box: [0.5 - w / 2, 0.5 - h * 0.45, w, h] }; }, 8);
    // Camera pan: everybody shifts sinusoidally, 15% each way every 3 s.
    run('pan', (i) => b(0.4 + 0.15 * Math.sin((2 * Math.PI * i * period) / 3000)), Math.round(3000 / period) + 1);
    // A 1.2 s pause in place: same track, but unconfirmed until fresh evidence.
    const tracker = new Tracker();
    const [first] = tracker.update([b(0.3)], 0);
    tracker.update([b(0.3)], period);
    updateBelief(first, { alice: 1 }, 1, period);
    const [resumed] = tracker.update([b(0.3)], period + 1200, 1500, gap);
    assert.equal(resumed.id, first.id, `pause at ${period} ms`);
    assert.equal(resumed.unconfirmed, true, `pause at ${period} ms`);
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
  // The next frame's association is clear again (while it stays ambiguous, only a fresh read may decide).
  tracker.update([detection(0.3)], 300);
  updateBelief(current, { alice: 1 }, 0.3, 400);
  assert.equal(current.unconfirmed, false);
  // Review of 2026-10-01: one agreeing frame is not fresh evidence. The running face mean started over
  // at the transition, and the identity needs REACQUIRE.faceSamples independent samples after it.
  assert.equal(resolveHit(current, new Set(['alice']), 0.5, 0.2, 410), null, 'one frame does not restore it');
  assert.equal(current.faceMean, null, 'the old running mean is gone');
  updateFaceMean(current, [1, 0], 420);
  updateFaceMean(current, [1, 0], 700);
  updateBelief(current, { alice: 1 }, 0.3, 730);
  assert.ok(resolveHit(current, new Set(['alice']), 0.5, 0.2, 740), 'two fresh face samples after the transition restore it');
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

test('a track seen last update but a long pause ago comes back unconfirmed: no hit until fresh evidence', () => {
  const tracker = new Tracker();
  const [old] = tracker.update([detection(0.3)], 100);
  updateBelief(old, { alice: 1 }, 1, 100);
  const [current] = tracker.update([detection(0.3)], 1400);
  assert.equal(current.id, old.id, 'in place and within the lost window, it is the same person');
  assert.equal(current.unconfirmed, true);
  assert.equal(resolveHit(current, new Set(['alice']), 0.5, 0.2, 1410), null);
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


test('a face-identified track follows the body that still shows a face when a faceless body fits its prediction better', () => {
  // The pan-crossing seed-2 replay: Alice moves left with the pan, Bob emerges from behind her at the
  // reversal. Without the cue her track takes Bob's box (0.88 against 0.75) and carries her identity onto him.
  const gap = 691;
  const faced = (b: NBox): Detection => ({ box: b, face: face([b[0] + b[2] * 0.4, b[1] + 0.02, b[2] * 0.2, b[3] * 0.15], 1) });
  const frames: [number, NBox][] = [[6568, [0.48, 0.33, 0.27, 0.37]], [6784, [0.49, 0.32, 0.24, 0.36]], [7000, [0.48, 0.33, 0.24, 0.38]], [7216, [0.44, 0.33, 0.26, 0.36]], [7432, [0.40, 0.33, 0.25, 0.36]], [7648, [0.34, 0.34, 0.22, 0.37]], [7864, [0.29, 0.34, 0.23, 0.36]]];
  for (const cue of [false, true]) {
    const tracker = new Tracker();
    let alice!: ReturnType<Tracker['update']>[number];
    for (const [t, b] of frames) {
      [alice] = tracker.update([faced(b)], t, 1500, gap);
      if (cue) alice.lastFaceAt = t;
    }
    const out = tracker.update([faced([0.26, 0.33, 0.26, 0.37]), { box: [0.22, 0.35, 0.24, 0.35] }], 8080, 1500, gap);
    if (cue) {
      assert.equal(out[0].id, alice.id, 'with a fresh face identity, the faced body keeps her track');
      assert.notEqual(out[1].id, alice.id);
    } else {
      assert.notEqual(out[0].id, alice.id, 'without the cue the prediction wins: this is the swap the cue exists for');
    }
    assert.ok(out.every((t) => t.unconfirmed), 'overlapping bodies are a crossing: nobody may lock or hit until fresh evidence');
  }
});

test('a body moving over a briefly skipped neighbour\'s place comes out unconfirmed', () => {
  const tracker = new Tracker();
  const [a, b] = tracker.update([detection(0.3, 0.24), detection(0.46, 0.22)], 100);
  updateBelief(a, { alice: 1 }, 1, 100);
  updateBelief(b, { bob: 1 }, 1, 100);
  tracker.update([detection(0.32, 0.24), detection(0.46, 0.22)], 320);
  // Bob is skipped; Alice's box now reaches over where he stood.
  const [onlyA] = tracker.update([detection(0.35, 0.24)], 540);
  assert.equal(onlyA.id, a.id);
  assert.equal(onlyA.unconfirmed, true);
  assert.equal(resolveHit(onlyA, new Set(['alice', 'bob']), 0.5, 0.2, 550), null);
});


test('a box whose centre jumped more than half its width in one step keeps its identity unconfirmed', () => {
  const tracker = new Tracker();
  const [old] = tracker.update([detection(0.3, 0.2)], 100);
  tracker.update([detection(0.31, 0.2)], 320);
  updateBelief(old, { alice: 1 }, 1, 320);
  const [jumped] = tracker.update([detection(0.43, 0.2)], 540);
  assert.equal(jumped.id, old.id, 'still the best match');
  assert.equal(jumped.unconfirmed, true);
  assert.equal(resolveHit(jumped, new Set(['alice']), 0.5, 0.2, 550), null);
  const steady = new Tracker();
  const [a] = steady.update([detection(0.3, 0.2)], 100);
  steady.update([detection(0.31, 0.2)], 320);
  const [b] = steady.update([detection(0.36, 0.2)], 540);
  assert.equal(b.id, a.id);
  assert.equal(b.unconfirmed, false, 'a quarter of a box width is ordinary motion');
});


test('a track anticipates a turning pan: constant acceleration keeps continuity and the trusted acceleration is exposed', () => {
  const W = 0.2;
  const b = (x: number): Detection => ({ box: [x, 0.15, W, 0.7] });
  // A sinusoidal pan of 15% amplitude every 3 s at 220 ms frames; the box reverses around 750 ms.
  const tracker = new Tracker();
  let id = -1;
  let last!: ReturnType<Tracker['update']>[number];
  for (let i = 0; i < 12; i++) {
    const t = i * 220;
    [last] = tracker.update([b(0.4 + 0.15 * Math.sin((2 * Math.PI * t) / 3000))], t, 1500, 700);
    if (id >= 0) assert.equal(last.id, id, `frame ${i}`);
    id = last.id;
  }
  assert.notEqual(last.ax, 0, 'acceleration is trusted after several samples');
  // The sign of the acceleration follows the pan: past the peak it points back towards the centre.
  assert.ok(last.ax * last.vx <= 0 || Math.abs(last.vx) < 1e-5, `ax ${last.ax} vx ${last.vx}`);
  // With only two samples the acceleration is not trusted.
  const young = new Tracker();
  young.update([b(0.3)], 0);
  const [y] = young.update([b(0.32)], 220);
  assert.equal(y.ax, 0);
});

test('an uncertain transition throws away the old running face mean and keeps outfit vetoes', async () => {
  const { markUncertain } = await import('../src/vision/tracker.ts');
  const { faceEvidence } = await import('../src/vision/scoring.ts');
  const { unitSimilarity } = await import('../src/vision/embedding.ts');
  const [t] = new Tracker().update([detection(0.3)], 100);
  const ALICE = [1, 0, 0];
  const BOB = [0, 1, 0];
  for (let i = 0; i < 6; i++) updateFaceMean(t, ALICE, 100 + i * 200);
  t.outfitVeto = { carol: { at: 900, eased: false } };
  markUncertain(t, 1500);
  assert.equal(t.faceMean, null, 'nothing of the previous face survives');
  assert.ok(t.outfitVeto?.carol, 'a veto only ever refuses, and is re-read by the next outfit sample');
  assert.equal(t.reacquireAt, 1500);
  // One frame of a different face now reads as that face alone, not as a blend dominated by the old one.
  const mean = updateFaceMean(t, BOB, 1600);
  const ev = faceEvidence(mean, [{ id: 'alice', profile: { faceModel: 'x', face: [ALICE], outfit: { front: { top: [1] }, back: { top: [1] } } } }], unitSimilarity, { reject: 0.3, accept: 0.62 });
  assert.equal(ev.alice, 0, 'the old person no longer speaks through the mean');
});

test('after a transition the identity needs two fresh face samples taken after it', async () => {
  const { markUncertain } = await import('../src/vision/tracker.ts');
  const { reacquired } = await import('../src/vision/scoring.ts');
  const [t] = new Tracker().update([detection(0.3)], 100);
  markUncertain(t, 1500);
  updateFaceMean(t, [1, 0], 1500);
  assert.equal(reacquired(t), false, 'a sample in the transition frame itself is not after it');
  updateFaceMean(t, [1, 0], 1600);
  assert.equal(reacquired(t), false, 'one fresh face sample is not enough');
  updateFaceMean(t, [1, 0], 1900);
  assert.equal(reacquired(t), true);
});

test('a persistent overlap starts the identity over once, not every frame, so the player can be re-earned', () => {
  const tracker = new Tracker();
  const front: Detection = { box: [0.3, 0.2, 0.2, 0.7] };
  const behind: Detection = { box: [0.4, 0.25, 0.18, 0.62] };
  let [a] = tracker.update([front, behind], 100);
  updateFaceMean(a, [1, 0], 100);
  for (let t = 300; t <= 1500; t += 200) {
    [a] = tracker.update([front, behind], t);
    updateFaceMean(a, [1, 0], t);
  }
  assert.equal(a.reacquireAt, 100, 'the overlap started the identity over at its onset only');
  assert.ok(a.faceSamples >= 2, 'fresh samples accumulate while the overlap lasts');
});
