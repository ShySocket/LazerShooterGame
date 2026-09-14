import test from 'node:test';
import assert from 'node:assert/strict';
import { VisionPipeline, type FrameOps } from '../src/vision/pipeline';
import { Tracker, type Detection } from '../src/vision/tracker';
import type { Candidate } from '../src/vision/scoring';
import type { NBox } from '../src/vision/geometry';

/**
 * Deterministic, RNG-free reproductions of the two mechanisms behind the 2026-09-13 sweep failures
 * (occlusion seed 60, stranger seed 23), scripted straight through VisionPipeline. Seeds drift as the
 * simulation changes; these do not. See TRACKING_IMPROVEMENT_PLAN.md, Investigation findings 2 and 4.
 *
 *   near player Bob, box [0.36,0.24,0.35,0.61]      far player Alice, box [0.40,0.37,0.20,0.29]
 *   ┌──────────────────┐                             concentric with Bob's, half his height
 *   │      ┌──────┐    │
 *   │      │alice │    │   dot at (0.50, 0.50) sits inside both boxes and inside both hit regions
 *   │      └──────┘    │
 *   └──────────────────┘
 */

const unit = (v: number[]): number[] => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};
const lcg = (seed: number) => {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
};
const embedding = (seed: number): number[] => unit(Array.from({ length: 64 }, lcg(seed)));
const BOB_FACE = embedding(1);
const ALICE_FACE = embedding(2);
const ME_FACE = embedding(3);
const profile = (face: number[]) => ({ faceModel: 'test', face: [face], outfit: { front: { top: [1] }, back: { top: [1] } } });
const CANDIDATES: Candidate[] = [
  { id: 'me', profile: profile(ME_FACE) },
  { id: 'alice', profile: profile(ALICE_FACE) },
  { id: 'bob', profile: profile(BOB_FACE) },
];

const BOB_BOX: NBox = [0.36, 0.24, 0.35, 0.61];
const BOB_HIT: NBox = [0.44, 0.26, 0.19, 0.35];
const ALICE_BOX: NBox = [0.40, 0.37, 0.20, 0.29];
const ALICE_HIT: NBox = [0.44, 0.38, 0.12, 0.17];
/** Crosshair whose centre dot is (0.50, 0.50). */
const CROSSHAIR: NBox = [0.29, 0.35, 0.42, 0.3];
const PERIOD = 220;

const body = (box: NBox, hit: NBox, extra: Partial<Detection> = {}): Detection => ({ box, hit, body: { keypoints: [] } as unknown as Detection['body'], ...extra });

/** A pipeline with a scripted clock, plus the ops that hand Bob's face to any crop of a Bob-sized box. */
function harness() {
  const clock = { now: 0 };
  const pipeline = new VisionPipeline<{ tap: number }>(
    { candidates: CANDIDATES, exclusiveIds: new Set(CANDIDATES.map((c) => c.id)), eligible: new Set(['alice', 'bob']), hitThreshold: 0.5, hitMargin: 0.2 },
    () => clock.now,
  );
  const ops: FrameOps = {
    sampleOutfit: () => null,
    cropFaces: async (region) => (region[2] > 0.3 ? [{ box: [0.48, 0.26, 0.08, 0.1], embedding: BOB_FACE, quality: 1 }] : []),
    isCurrent: () => true,
  };
  let t = 0;
  /** One frame captured at `t`, finished one inference period later. */
  const frame = async (dets: Detection[], capturedAt = t) => {
    clock.now = capturedAt + PERIOD;
    const out = await pipeline.processFrame(dets, capturedAt, 1280, 720, CROSSHAIR, ops);
    assert.ok(out, 'frame abandoned');
    t = capturedAt + PERIOD;
    return out;
  };
  /** Bob alone, recognised, for `n` frames. */
  const establishBob = async (n = 7) => {
    let last;
    for (let i = 0; i < n; i++) last = await frame([body(BOB_BOX, BOB_HIT)]);
    assert.ok(last!.tracks[0].belief.bob > 0.9, 'Bob should be recognised');
    assert.equal(last!.lock?.kind, 'lock');
    return last!;
  };
  /** Tap `afterMs` after the last capture: older than the geometry budget, so a burst opens. */
  const tapStale = (afterMs = 400) => {
    clock.now = t - PERIOD + afterMs;
    const r = pipeline.fire({ tap: clock.now }, CROSSHAIR);
    assert.equal(r.kind, 'pending', 'a stale tap on a recognised player opens a burst');
    return { tap: clock.now, result: r };
  };
  return { pipeline, clock, frame, establishBob, tapStale, get t() { return t; } };
}

test('(a) a near player\'s identity does not transfer to a concentric far player when the near detection drops for a frame', async () => {
  const h = harness();
  const before = await h.establishBob();
  const bobId = before.tracks[0].id;
  // Bob's detection drops; only Alice's smaller, concentric box is found where he stood.
  const after = await h.frame([body(ALICE_BOX, ALICE_HIT)]);
  assert.notEqual(after.tracks[0].id, bobId, 'Alice\'s body must start a new track, not inherit Bob\'s');
  assert.notEqual(after.lock?.kind, 'lock', `no LOCK may be shown on the unrecognised body (got ${JSON.stringify(after.lock)})`);
  h.clock.now = h.t + 10;
  const shot = h.pipeline.fire({ tap: h.clock.now }, CROSSHAIR);
  assert.notEqual(shot.kind, 'instant', `FIRE on Alice's box must not land instantly on Bob (got ${JSON.stringify(shot.kind === 'instant' ? shot.settlement.resolution : shot.kind)})`);
});

test('(a, tracker level) mutual-best matching refuses a concentric box under 60% of the track\'s height', () => {
  const tracker = new Tracker();
  let t = 0;
  let bobId = -1;
  for (let i = 0; i < 7; i++) {
    bobId = tracker.update([body(BOB_BOX, BOB_HIT)], t)[0].id;
    t += PERIOD;
  }
  const out = tracker.update([body(ALICE_BOX, ALICE_HIT)], t);
  assert.notEqual(out[0].id, bobId);
});

test('(b) a burst keeps waiting through a same-track frame whose association is ambiguous', async () => {
  const h = harness();
  await h.establishBob(6);
  const { result } = h.tapStale();
  const capturedAt = h.clock.now + 20;
  const out = await h.frame([body(BOB_BOX, BOB_HIT, { associationAmbiguous: true })], capturedAt);
  assert.equal(out.settled, null, `burst settled early: ${JSON.stringify(out.settled && { id: out.settled.resolution?.id ?? null, elapsedMs: out.settled.elapsedMs })}, deadline ${result.kind === 'pending' ? result.deadline : '?'} vs now ${h.clock.now}`);
  assert.equal(h.pipeline.hasPending(), true);
});

test('(c) a burst keeps waiting through a same-track frame where the dot is outside the observed torso', async () => {
  const h = harness();
  await h.establishBob(6);
  h.tapStale();
  const capturedAt = h.clock.now + 20;
  // Same body, but this frame's torso ends above the dot (a raised arm, a different pose estimate).
  const shortHit: NBox = [0.44, 0.26, 0.19, 0.20];
  const out = await h.frame([body(BOB_BOX, shortHit)], capturedAt);
  assert.equal(out.settled, null, 'burst must not settle as a miss on its own target\'s off-torso frame');
  assert.equal(h.pipeline.hasPending(), true);
});

test('(a2) a burst does not land on the near player after their track jumped onto the far player\'s concentric box', async () => {
  const h = harness();
  await h.establishBob(6);
  h.tapStale();
  const capturedAt = h.clock.now + 20;
  // Bob has stepped so far left that his own box no longer matches his track; Alice's concentric box does.
  const bobFarLeft: NBox = [0.02, 0.24, 0.35, 0.61];
  const bobFarLeftHit: NBox = [0.10, 0.26, 0.19, 0.35];
  const out = await h.frame([body(bobFarLeft, bobFarLeftHit), body(ALICE_BOX, ALICE_HIT)], capturedAt);
  assert.notEqual(out.settled?.resolution?.id, 'bob', 'the burst must not register a hit on Bob with Alice under the dot');
});

test('(d) a burst settles as a miss when a different track\'s body is under the dot', async () => {
  const h = harness();
  await h.establishBob(6);
  h.tapStale();
  const capturedAt = h.clock.now + 20;
  // Bob has stepped left but still matches his track; a much smaller newcomer stands under the dot.
  const bobLeft: NBox = [0.20, 0.24, 0.35, 0.61];
  const bobLeftHit: NBox = [0.28, 0.26, 0.19, 0.35];
  const newcomer: NBox = [0.42, 0.40, 0.16, 0.20];
  const newcomerHit: NBox = [0.45, 0.41, 0.10, 0.12];
  const out = await h.frame([body(bobLeft, bobLeftHit), body(newcomer, newcomerHit)], capturedAt);
  assert.ok(out.settled, 'the burst must settle');
  assert.equal(out.settled!.resolution, null, 'and it must be a miss, not a hit on anybody');
  assert.equal(h.pipeline.hasPending(), false);
});
