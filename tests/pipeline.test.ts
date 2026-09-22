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
  const cropCalls: number[] = [];
  const ops: FrameOps = {
    sampleOutfit: () => null,
    cropFaces: async (region) => {
      cropCalls.push(clock.now);
      return region[2] > 0.3 ? [{ box: [region[0] + 0.12, 0.26, 0.08, 0.1], embedding: BOB_FACE, quality: 1 }] : [];
    },
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
  return { pipeline, clock, frame, establishBob, tapStale, cropCalls, ops, get t() { return t; } };
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


test('(e) a tap while the target walks into the dot opens a burst on them from their motion, confirmed only by a post-tap sighting', async () => {
  const h = harness();
  // Bob walks left at 0.06 of the frame per frame: after seven frames his box starts at 0.44 and his
  // torso spans 0.52 .. 0.71, so the dot at 0.50 is not on him in the stale frame. 200 ms later his
  // motion puts the torso at 0.465 .. 0.655: under the dot.
  const at = (x: number) => body([x, 0.24, 0.35, 0.61], [x + 0.08, 0.26, 0.19, 0.35]);
  let last;
  for (let i = 0; i < 7; i++) last = await h.frame([at(0.80 - i * 0.06)]);
  assert.ok(last!.tracks[0].belief.bob > 0.9);
  assert.ok(last!.tracks[0].vx < 0, 'the track carries his leftward velocity');
  h.clock.now = h.t - PERIOD + 200;
  const r = h.pipeline.fire({ tap: h.clock.now }, CROSSHAIR);
  assert.equal(r.kind, 'pending', `expected a burst on the moving target, got ${r.kind}`);
  const out = await h.frame([at(0.38)], h.clock.now + 20);
  assert.equal(out.settled?.resolution?.id, 'bob', 'the post-tap frame shows him under the dot: hit');
  assert.equal(out.settled?.elapsedMs, 240);
});

test('every fire gets a verdict: a burst abandoned by invalidate() hands back its context so the game can say SHOT LOST', async () => {
  const h = harness();
  await h.establishBob(7);
  h.clock.now = h.t - PERIOD + 200;
  // A stale-ish tap on Bob opens a burst (geometry older than GEOMETRY_FRESH_MS).
  h.clock.now = h.t + 300;
  const r = h.pipeline.fire({ tap: 77 }, CROSSHAIR);
  assert.equal(r.kind, 'pending');
  assert.ok(h.pipeline.hasPending());
  const dropped = h.pipeline.invalidate();
  assert.deepEqual(dropped, { tap: 77 }, 'the abandoned burst returns the tap it belonged to');
  assert.equal(h.pipeline.hasPending(), false);
  assert.equal(h.pipeline.invalidate(), null, 'nothing to report the second time');
  assert.equal(h.pipeline.expirePending(r.kind === 'pending' ? r.token : {}), null, 'the timer finds no burst to settle');
  // The next tap is not refused as busy.
  assert.notEqual(h.pipeline.fire({ tap: 78 }, CROSSHAIR).kind, 'busy');
});

test('work shedding: a slow phone keeps the crosshair target\'s crop and drops the extra crop', async () => {
  const slowPeriod = 400;
  // A harness whose frames arrive 400 ms apart: the pipeline measures that period itself.
  const h = harness();
  const far = body([0.02, 0.3, 0.12, 0.3], [0.05, 0.31, 0.06, 0.1]);
  let t = 0;
  for (let i = 0; i < 8; i++) {
    h.clock.now = t + slowPeriod;
    await h.pipeline.processFrame([body(BOB_BOX, BOB_HIT), far], t, 1280, 720, CROSSHAIR, h.ops);
    t += slowPeriod;
  }
  // Four more slow frames: at most one crop each (the target, refreshed on its interval), never the extra body.
  for (let i = 0; i < 4; i++) {
    const before = h.cropCalls.length;
    h.clock.now = t + slowPeriod;
    await h.pipeline.processFrame([body(BOB_BOX, BOB_HIT), far], t, 1280, 720, CROSSHAIR, h.ops);
    assert.ok(h.cropCalls.length - before <= 1, `frame ${i}: ${h.cropCalls.length - before} crops on a slow phone`);
    t += slowPeriod;
  }
  // The same scene at a normal period crops the target and one other body.
  const q = harness();
  let u = 0;
  for (let i = 0; i < 8; i++) {
    q.clock.now = u + PERIOD;
    await q.pipeline.processFrame([body(BOB_BOX, BOB_HIT), far], u, 1280, 720, CROSSHAIR, q.ops);
    u += PERIOD;
  }
  let twoCropFrames = 0;
  for (let i = 0; i < 4; i++) {
    const b2 = q.cropCalls.length;
    q.clock.now = u + PERIOD;
    await q.pipeline.processFrame([body(BOB_BOX, BOB_HIT), far], u, 1280, 720, CROSSHAIR, q.ops);
    if (q.cropCalls.length - b2 === 2) twoCropFrames++;
    u += PERIOD;
  }
  assert.ok(twoCropFrames >= 1, 'at a normal period the extra body gets its crop');
});

test('crop priority: a body with no face sample yet is cropped before one that already has a face', async () => {
  const h = harness();
  // Two bystanders well away from the dot; the crop ops give a face only to the one on the right,
  // so after the first look the left one is still without a sample and must be preferred.
  const left = body([0.02, 0.3, 0.14, 0.3], [0.05, 0.31, 0.06, 0.1]);
  const right = body([0.84, 0.3, 0.14, 0.3], [0.87, 0.31, 0.06, 0.1]);
  const looks: number[] = [];
  const ops: FrameOps = {
    sampleOutfit: () => null,
    cropFaces: async (region) => {
      looks.push(region[0]);
      if (region[2] > 0.3) return [{ box: [region[0] + 0.12, 0.26, 0.08, 0.1], embedding: BOB_FACE, quality: 1 }];
      return region[0] > 0.5 ? [{ box: [region[0] + 0.04, 0.32, 0.05, 0.07], embedding: ALICE_FACE, quality: 1 }] : [];
    },
    isCurrent: () => true,
  };
  let t = 0;
  for (let i = 0; i < 8; i++) {
    h.clock.now = t + PERIOD;
    await h.pipeline.processFrame([body(BOB_BOX, BOB_HIT), left, right], t, 1280, 720, CROSSHAIR, ops);
    t += PERIOD;
  }
  const bystanderLooks = looks.filter((x) => x < 0.3 || x > 0.5);
  const leftLooks = bystanderLooks.filter((x) => x < 0.3).length;
  const rightLooks = bystanderLooks.length - leftLooks;
  assert.ok(leftLooks > rightLooks, `the sampleless body gets most looks: left ${leftLooks}, right ${rightLooks}`);
});

test('(f) a stationary target is not nominated by prediction: nobody under the dot is a miss', async () => {
  const h = harness();
  await h.establishBob(6);
  h.clock.now = h.t - PERIOD + 200;
  // Dot well to the right of Bob's box while he stands still.
  const r = h.pipeline.fire({ tap: h.clock.now }, [0.9 - 0.21, 0.35, 0.42, 0.3]);
  assert.equal(r.kind, 'miss');
});


test('(g) a confident crosshair target is re-cropped every 600 ms, not every frame; anything less than confident every frame', async () => {
  const h = harness();
  await h.establishBob(7);
  const before = h.cropCalls.length;
  // Seven frames at 220 ms: the first three establish him (young track), then a lock; cropped every
  // frame until then, and at the bounded refresh afterwards.
  assert.ok(before >= 3 && before < 7, `crops while establishing: ${before}`);
  for (let i = 0; i < 6; i++) await h.frame([body(BOB_BOX, BOB_HIT)]);
  const steady = h.cropCalls.length - before;
  // 6 frames = 1320 ms: refreshes at 600 ms spacing give 2 or 3 crops, never 6.
  assert.ok(steady >= 2 && steady <= 3, `crops while confident over 6 frames: ${steady}`);
  // A pending shot brings back a crop every frame.
  h.tapStale();
  const at = h.cropCalls.length;
  await h.frame([body(BOB_BOX, BOB_HIT)], h.clock.now + 20);
  assert.equal(h.cropCalls.length, at + 1);
});


test('(i) a moving target the detector skipped for a frame is nominated from their motion, confirmed only by a post-tap sighting', async () => {
  const h = harness();
  const at = (x: number) => body([x, 0.24, 0.35, 0.61], [x + 0.08, 0.26, 0.19, 0.35]);
  let last;
  for (let i = 0; i < 7; i++) last = await h.frame([at(0.80 - i * 0.06)]);
  assert.ok(last!.tracks[0].belief.bob > 0.9 && last!.tracks[0].vx < 0);
  // The detector skips Bob for one frame: he coasts. His last torso spanned 0.52 .. 0.71.
  await h.frame([]);
  // 200 ms after that empty capture his motion has carried the torso under the dot at 0.50.
  h.clock.now = h.t - PERIOD + 200;
  const r = h.pipeline.fire({ tap: h.clock.now }, CROSSHAIR);
  assert.equal(r.kind, 'pending', `expected a burst on the coasting target, got ${r.kind}`);
  const out = await h.frame([at(0.32)], h.clock.now + 20);
  assert.equal(out.settled?.resolution?.id, 'bob');
});


test('(j) a nomination from motion needs the dot on the moved torso, not merely inside the moved outer box', async () => {
  // Tried the other way on 2026-09-14: nine points more in the pan crossing and one hit on a player
  // nobody was aiming at when the tap happened. The tap-time rule stands.
  const h = harness();
  const at = (x: number) => body([x, 0.24, 0.35, 0.61], [x + 0.08, 0.26, 0.19, 0.35]);
  for (let i = 0; i < 7; i++) await h.frame([at(0.80 - i * 0.06)]);
  // Bob's box is at 0.44 .. 0.79 moving left; 100 ms later the moved torso (0.49 .. 0.68) does not
  // reach a dot at 0.48, although the moved outer box does.
  h.clock.now = h.t - PERIOD + 100;
  assert.equal(h.pipeline.fire({ tap: h.clock.now }, [0.29 - 0.02, 0.35, 0.42, 0.3]).kind, 'miss');
});
