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
function harness(candidates: Candidate[] = CANDIDATES) {
  const clock = { now: 0 };
  const pipeline = new VisionPipeline<{ tap: number }>(
    { candidates, exclusiveIds: new Set(candidates.map((c) => c.id)), eligible: new Set(['alice', 'bob']), hitThreshold: 0.5, hitMargin: 0.2 },
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

test('an outfit sample whose torso cannot be read is not a sample: the audit stays due and nothing counts as checked', async () => {
  const h = harness();
  h.ops.sampleOutfit = () => ({ sig: null, props: null });
  await h.frame([body(BOB_BOX, BOB_HIT)]);
  await h.frame([body(BOB_BOX, BOB_HIT)]);
  const out = await h.frame([body(BOB_BOX, BOB_HIT)]);
  const t = out.tracks[0];
  assert.equal(t.lastClothingAt, 0);
  assert.equal(t.lastOutfitReadAt ?? 0, 0);
});

// ---- Review of 2026-10-01: a face must be corroborated, and nobody may be refused for good ----------

/** A unit vector with cosine `cos` to `u` (64-d, so the 512-d mean-centring does not apply). */
const withCosine = (u: number[], cos: number, seed: number): number[] => {
  const n = embedding(seed);
  const d = n.reduce((s, x, i) => s + x * u[i], 0);
  const perp = unit(n.map((x, i) => x - d * u[i]));
  return u.map((x, i) => cos * x + Math.sqrt(1 - cos * cos) * perp[i]);
};

test('a look-alike stranger whose torso cannot be read is never named: without a readable outfit the face needs the strict bar', async () => {
  const h = harness();
  const LOOKALIKE = withCosine(ALICE_FACE, 0.66, 9);
  h.ops.sampleOutfit = () => ({ sig: null, props: null });
  h.ops.cropFaces = async (region) => (region[2] > 0.3 ? [{ box: [region[0] + 0.12, 0.26, 0.08, 0.1], embedding: LOOKALIKE, quality: 1 }] : []);
  for (let i = 0; i < 30; i++) {
    const out = await h.frame([body(BOB_BOX, BOB_HIT)]);
    assert.notEqual(out.lock?.kind === 'lock' ? out.lock.id : null, 'alice', `frame ${i}: a face at 0.66 must not name alice uncorroborated`);
  }
});

test('a player whose torso cannot be read is still hit once the face clears the strict bar, even after a dropout', async () => {
  const h = harness();
  h.ops.sampleOutfit = () => ({ sig: null, props: null });
  let locked = 0;
  for (let i = 0; i < 8; i++) if ((await h.frame([body(BOB_BOX, BOB_HIT)])).lock?.kind === 'lock') locked++;
  assert.ok(locked > 0, 'Bob, face clear, torso hidden, locks');
  for (let i = 0; i < 4; i++) await h.frame([]);
  let after = 0;
  for (let i = 0; i < 15; i++) if ((await h.frame([body(BOB_BOX, BOB_HIT)])).lock?.kind === 'lock') after++;
  assert.ok(after >= 10, `after a reclaim Bob is locked again within a few frames (${after}/15)`);
});

test('a player standing half behind someone is re-earned, not refused for as long as the overlap lasts', async () => {
  const h = harness();
  h.ops.sampleOutfit = () => ({ sig: { top: [1] }, props: null });
  // The other person stands to Bob's right and a little behind (IoU about 0.3); the dot stays on Bob's torso.
  const OTHER: NBox = [0.55, 0.3, 0.3, 0.55];
  // Bob's face sits clearly on his own box, left of where the other person's box starts.
  h.ops.cropFaces = async (region) => (region[0] < 0.5 && region[2] > 0.3 ? [{ box: [0.4, 0.26, 0.06, 0.08], embedding: BOB_FACE, quality: 1 }] : []);
  let locked = 0;
  for (let i = 0; i < 25; i++) {
    const out = await h.frame([body(BOB_BOX, BOB_HIT), body(OTHER, [0.6, 0.32, 0.18, 0.3])]);
    if (out.lock?.kind === 'lock' && out.lock.id === 'bob') locked++;
  }
  assert.ok(locked >= 15, `Bob locked in ${locked}/25 frames of a lasting overlap`);
});

test('while someone may be hidden behind the target, a lock or hit needs evidence read on that frame (pan-crossing-far seed 85)', async () => {
  // 2026-10-01: Bob went behind Alice and stayed hidden 2.4 s while the phone panned; a frame then
  // found only his body, her track took it, and with no face or outfit read on that frame her old
  // belief showed LOCK alice with the dot on him. Here Bob is the target and someone else hides.
  const h = harness();
  let faceOn = true;
  // Bob's face sits on the left of his own box, clear of the other person's box to his right.
  h.ops.cropFaces = async (region) => (faceOn && region[0] < 0.5 && region[2] > 0.3 ? [{ box: [region[0] + 0.04, 0.26, 0.06, 0.08], embedding: BOB_FACE, quality: 1 }] : []);
  await h.establishBob(6);
  const OTHER: NBox = [0.55, 0.3, 0.3, 0.55];
  for (let i = 0; i < 3; i++) await h.frame([body(BOB_BOX, BOB_HIT), body(OTHER, [0.6, 0.32, 0.18, 0.3])]);
  // The other person goes behind Bob and is not detected again; the phone pans 1% of the frame a step.
  const panned = (k: number) => body([BOB_BOX[0] - 0.01 * k, BOB_BOX[1], BOB_BOX[2], BOB_BOX[3]], [BOB_HIT[0] - 0.01 * k, BOB_HIT[1], BOB_HIT[2], BOB_HIT[3]]);
  let locked = 0;
  for (let k = 1; k <= 8; k++) {
    const out = await h.frame([panned(k)]);
    if (out.lock?.kind === 'lock' && out.lock.id === 'bob') locked++;
  }
  assert.ok(locked >= 5, `Bob's face read on each frame keeps him locked (${locked}/8)`);
  // By now the other person's track has retired and the pan has carried Bob off its last box. A frame
  // that reads no face cannot say whose body this is.
  faceOn = false;
  const out = await h.frame([panned(8)]);
  assert.notEqual(out.lock?.kind, 'lock', `no LOCK without evidence of the frame's own (got ${JSON.stringify(out.lock)})`);
  h.clock.now = h.t + 5;
  const shot = h.pipeline.fire({ tap: h.clock.now }, CROSSHAIR);
  assert.notEqual(shot.kind, 'instant', 'nor an instant hit from that frame');
});

// ---- crossing-lookalike-faces seed 63 (2026-10-01): a track that hops onto the crossing partner ----

test('a track whose body\'s outfit flips from ruling a player out to clearly matching them has hopped: a burst opened before cannot land on them', async () => {
  // Outfits as separate colours: her top and trousers, his top and trousers, the shooter's.
  const hist = (i: number) => Array.from({ length: 6 }, (_, k) => (k === i ? 1 : 0));
  const outfit = (top: number, thighs: number) => ({ front: { top: hist(top), thighs: hist(thighs) }, back: { top: hist(top), thighs: hist(thighs) } });
  const candidates: Candidate[] = [
    { id: 'me', profile: { faceModel: 'test', face: [ME_FACE], outfit: outfit(4, 5) } },
    { id: 'alice', profile: { faceModel: 'test', face: [ALICE_FACE], outfit: outfit(0, 2) } },
    { id: 'bob', profile: { faceModel: 'test', face: [BOB_FACE], outfit: outfit(1, 3) } },
  ];
  const h = harness(candidates);
  // Phase 1, her body under the dot: only her top is readable, 0.65 like hers and 0.35 like his. That
  // rules him out on this body (OUTFIT_VETO) but names nobody: the belief stays "unknown", so neither
  // the face hop check nor the burst's expected identity can protect the shot.
  h.ops.sampleOutfit = () => ({ sig: { top: [0.65, 0.35, 0, 0, 0, 0] }, props: null });
  h.ops.cropFaces = async () => [];
  let last;
  for (let i = 0; i < 6; i++) last = await h.frame([body(BOB_BOX, BOB_HIT)]);
  const her = last!.tracks[0];
  assert.equal(Object.entries(her.belief).sort((a, b) => b[1] - a[1])[0][0], '_unknown', `the tap-time belief names nobody: ${JSON.stringify(her.belief)}`);
  assert.ok(her.outfitVeto?.bob, 'his outfit is ruled out on her body');
  const { tap } = h.tapStale();
  // Phase 2: her body is skipped and her track takes his body a third of a box to the left (no jump
  // to notice). His full outfit and his face are read on it from now on.
  const HIS_BOX: NBox = [0.26, 0.24, 0.35, 0.61];
  const HIS_HIT: NBox = [0.34, 0.26, 0.19, 0.35];
  h.ops.sampleOutfit = () => ({ sig: { top: hist(1), thighs: hist(3) }, props: null });
  h.ops.cropFaces = async (region) => (region[2] > 0.3 ? [{ box: [region[0] + 0.12, 0.26, 0.08, 0.1], embedding: BOB_FACE, quality: 1 }] : []);
  let settled: { resolution: { id: string } | null } | null = null;
  let capturedAt = h.clock.now + 20;
  for (let i = 0; i < 8 && !settled && h.pipeline.hasPending(); i++) {
    const out = await h.frame([body(HIS_BOX, HIS_HIT)], capturedAt);
    assert.equal(out.tracks[0].id, her.id, 'the same track continues onto his body');
    if (i === 0) assert.ok((out.tracks[0].reacquireAt ?? 0) > tap, 'the outfit flip is an uncertain transition');
    settled = out.settled;
    capturedAt = h.t;
  }
  assert.equal(settled?.resolution?.id ?? null, null, `a tap on her must not register on him: ${JSON.stringify(settled?.resolution)}`);
  // Fairness: the hop costs a re-acquisition, not the player. Once re-earned on his own body, a fresh
  // tap on him lands.
  let lock;
  for (let i = 0; i < 4; i++) lock = (await h.frame([body(HIS_BOX, HIS_HIT)])).lock;
  assert.deepEqual(lock, { kind: 'lock', id: 'bob' }, 'his identity is re-earned on his own body');
  h.clock.now = h.t - PERIOD + 50;
  const shot = h.pipeline.fire({ tap: h.clock.now }, CROSSHAIR);
  assert.equal(shot.kind === 'instant' ? shot.settlement.resolution?.id : shot.kind, 'bob');
});

test('a crowded frame on a slow phone hits on the face read in that very frame, however long the frame took to decide', async () => {
  // Six bodies (BODY_CAP) make every frame crowded. Frames come 450 ms apart and each is decided
  // 420 ms after its capture, more than OVERLAP_FACE_FRESH_MS: the read's age is capture time
  // against capture time, so Bob's face read in the deciding frame still counts (review of
  // 2026-10-01: measured against the decision clock, a slow phone refused every shot in a crowd).
  const h = harness();
  const bystanders = [0.0, 0.08, 0.16, 0.78, 0.88].map((x) => body([x, 0.3, 0.07, 0.4], [x + 0.01, 0.32, 0.05, 0.15]));
  const scene = () => [body(BOB_BOX, BOB_HIT), ...bystanders];
  const slow = 450;
  const latency = 420;
  let t = 0;
  let locked = 0;
  for (let i = 0; i < 8; i++) {
    h.clock.now = t + latency;
    const out = await h.pipeline.processFrame(scene(), t, 1280, 720, CROSSHAIR, h.ops);
    assert.ok(out?.crowded, 'six bodies: the crowd rule applies');
    if (out.lock?.kind === 'lock' && out.lock.id === 'bob') locked++;
    t += slow;
  }
  assert.ok(locked >= 5, `Bob, his face read every frame, is locked in a crowd on a slow phone (${locked}/8)`);
  // A tap one period after the last capture is too old to decide alone: the burst needs a post-tap frame.
  h.clock.now = t;
  const r = h.pipeline.fire({ tap: t }, CROSSHAIR);
  assert.equal(r.kind, 'pending');
  h.clock.now = t + 20 + latency;
  const settledOn = await h.pipeline.processFrame(scene(), t + 20, 1280, 720, CROSSHAIR, h.ops);
  assert.equal(settledOn?.settled?.resolution?.id, 'bob', 'the burst settles on the crowded frame\'s own read');
  // Without a read in that frame, nor within OVERLAP_FACE_FRESH_MS of it, the crowd rule still refuses.
  h.ops.cropFaces = async () => [];
  let lockedBlind = 0;
  for (let i = 0, u = t + 20 + slow; i < 3; i++, u += slow) {
    h.clock.now = u + latency;
    const blind = await h.pipeline.processFrame(scene(), u, 1280, 720, CROSSHAIR, h.ops);
    if (blind?.lock?.kind === 'lock') lockedBlind++;
  }
  assert.equal(lockedBlind, 0, 'a carried belief does not lock in a crowded frame');
});

/**
 * Silent hops while a partner may be hidden (review of 2026-10-01, seeds beyond the 100-seed gate):
 * Bob and somebody else overlap, the other person is then hidden behind Bob, and the detector may
 * hand Bob's track their body in any frame with nothing geometric to notice. Each frame's identity
 * must then stand on evidence read on that frame's own body.
 *
 *   Bob [0.30,0.24,0.30,0.61]   partner [0.40,0.25,0.28,0.58] (IoU 0.5)   dot (0.50, 0.50) on both torsos
 */
const hot = (i: number): number[] => Array.from({ length: 8 }, (_, k) => (k === i ? 1 : 0));
type Wardrobe = { top: number[]; thighs: number[] };
const WARDROBE: Record<'alice' | 'bob' | 'stranger', Wardrobe> = {
  alice: { top: hot(0), thighs: hot(1) },
  bob: { top: hot(2), thighs: hot(3) },
  stranger: { top: hot(4), thighs: hot(5) },
};
const dressed = (face: number[], w: Wardrobe) => ({ faceModel: 'test', face: [face], outfit: { front: w, back: w } });
const DRESSED: Candidate[] = [
  { id: 'me', profile: dressed(ME_FACE, { top: hot(6), thighs: hot(7) }) },
  { id: 'alice', profile: dressed(ALICE_FACE, WARDROBE.alice) },
  { id: 'bob', profile: dressed(BOB_FACE, WARDROBE.bob) },
];
const HOP_BOB: NBox = [0.30, 0.24, 0.30, 0.61];
const HOP_BOB_HIT: NBox = [0.36, 0.25, 0.18, 0.35];
const HOP_PARTNER: NBox = [0.40, 0.25, 0.28, 0.58];
const HOP_PARTNER_HIT: NBox = [0.45, 0.26, 0.17, 0.33];

/** Where the face of a person standing in `box` is, in full-frame coordinates. */
const faceOf = (box: NBox): NBox => [box[0] + box[2] * 0.35, box[1] + 0.02, box[2] * 0.3, 0.08];
/** Who stands in a detection: their face (when a crop finds one) and their outfit (null: the torso cannot be read). */
interface Person { face: number[] | null; quality?: number; outfit: Wardrobe | null }
function hopHarness(period = PERIOD) {
  const clock = { now: 0 };
  const pipeline = new VisionPipeline<{ tap: number }>(
    { candidates: DRESSED, exclusiveIds: new Set(DRESSED.map((c) => c.id)), eligible: new Set(['alice', 'bob']), hitThreshold: 0.5, hitMargin: 0.2 },
    () => clock.now,
  );
  const who = new WeakMap<Detection, Person>();
  const outfitReads: number[] = [];
  const ops: FrameOps = {
    sampleOutfit: (d) => {
      outfitReads.push(clock.now);
      const p = who.get(d);
      return p ? { sig: p.outfit ? { ...p.outfit } : null, props: null } : null;
    },
    cropFaces: async (_region, d) => {
      const p = who.get(d);
      return p?.face ? [{ box: faceOf(d.box), embedding: p.face, quality: p.quality ?? 1 }] : [];
    },
    isCurrent: () => true,
  };
  let t = 0;
  /** One frame: each entry is a box, its hit region, who it is, and whether only their face was found. */
  const frame = async (people: [NBox, NBox, Person, boolean?][]) => {
    const dets = people.map(([box, hit, p, faceOnly]) => {
      const d: Detection = faceOnly ? { box, hit, face: { boxRaw: faceOf(box), boxScore: 0.9 } as unknown as Detection['face'] } : body(box, hit);
      who.set(d, p);
      return d;
    });
    clock.now = t + period;
    const out = await pipeline.processFrame(dets, t, 1280, 720, CROSSHAIR, ops);
    assert.ok(out, 'frame abandoned');
    const capturedAt = t;
    t += period;
    return { ...out, capturedAt };
  };
  return { pipeline, clock, frame, outfitReads, get t() { return t; } };
}

/**
 * Bob alone and recognised; a partner overlaps him for a frame; then Bob alone again until the
 * partner's lost track has retired (LOST_TRACK_MS): no overlap with anybody any more, but the partner
 * is presumed hidden behind him, and his lock is re-earned on reads of his own body.
 */
async function bobWithHiddenPartner(h: ReturnType<typeof hopHarness>, partner: Person) {
  const bob: Person = { face: BOB_FACE, outfit: WARDROBE.bob };
  for (let i = 0; i < 6; i++) await h.frame([[HOP_BOB, HOP_BOB_HIT, bob]]);
  const met = await h.frame([[HOP_BOB, HOP_BOB_HIT, bob], [HOP_PARTNER, HOP_PARTNER_HIT, partner]]);
  assert.ok(met.tracks.every((tr) => tr.overlapping), 'the two overlap: a crossing');
  let last;
  for (let i = 0; i < 8; i++) last = await h.frame([[HOP_BOB, HOP_BOB_HIT, bob]]);
  const tr = last!.tracks[0];
  assert.ok(!tr.overlapping && tr.hiding, 'overlapping nobody, but the partner may be hidden behind Bob');
  assert.deepEqual(last!.lock, { kind: 'lock', id: 'bob' }, 'Bob re-earns his lock on evidence read on his own body each frame');
  return tr.id;
}

test('while a partner may be hidden, the running face mean cannot confirm a frame whose own face names nobody (pan-crossing seed 748)', async () => {
  // The hop frame: the detector hands Bob's track the hidden stranger's body, the crop reads the
  // stranger's blurred face (0.4 like Bob's: it names nobody), and the torso cannot be read. Bob's
  // running mean, built on his earlier frames, still named him and showed LOCK bob on the stranger.
  const h = hopHarness();
  const strangerFace = withCosine(BOB_FACE, 0.4, 11);
  const bobTrack = await bobWithHiddenPartner(h, { face: strangerFace, outfit: WARDROBE.stranger });
  const hop = await h.frame([[HOP_BOB, HOP_BOB_HIT, { face: strangerFace, quality: 0.3, outfit: null }]]);
  assert.equal(hop.tracks[0].id, bobTrack, 'the same track: nothing geometric marks the hop');
  assert.equal(hop.tracks[0].unconfirmed, true, 'this frame\'s own read did not name Bob');
  assert.notDeepEqual(hop.lock, { kind: 'lock', id: 'bob' });
});

test('while a partner may be hidden, an outfit read on an earlier frame does not let a look-alike face name the player (crossing-lookalike-faces seed 716)', async () => {
  // The hop frame finds only a face, so no outfit can be read on it. Alice, a look-alike (0.75 like
  // Bob: above FACE_CALIB.accept, below FACE_ONLY_CALIB.accept), read as Bob at the normal bar while
  // the outfit corroboration from Bob's own earlier frame still counted.
  const h = hopHarness();
  const lookalike: Person = { face: withCosine(BOB_FACE, 0.75, 12), outfit: WARDROBE.alice };
  const bobTrack = await bobWithHiddenPartner(h, lookalike);
  const hop = await h.frame([[HOP_BOB, HOP_BOB_HIT, lookalike, true]]);
  assert.equal(hop.tracks[0].id, bobTrack);
  assert.notDeepEqual(hop.lock, { kind: 'lock', id: 'bob' }, 'no LOCK bob on a face-only body that nothing else could check');
});

test('while a partner may be hidden, the outfit is read on every frame, so a hop onto a body in other clothes is flagged at once (crossing-lookalike-faces seed 716)', async () => {
  // Bob's face was fresh, so his outfit was audited only once a second; the frame that handed his
  // track Alice's body (no face found on it) went unchecked. Read, her outfit is one Bob's own reads
  // had ruled out on this track, and a body does not change clothes: a hop (outfitReversals).
  const h = hopHarness();
  await bobWithHiddenPartner(h, { face: withCosine(BOB_FACE, 0.75, 12), outfit: WARDROBE.alice });
  const bob: Person = { face: BOB_FACE, outfit: WARDROBE.bob };
  for (let i = 0; i < 2; i++) {
    const reads = h.outfitReads.length;
    await h.frame([[HOP_BOB, HOP_BOB_HIT, bob]]);
    assert.equal(h.outfitReads.length, reads + 1, 'his outfit is read on every frame, fresh face or not');
  }
  const hop = await h.frame([[HOP_BOB, HOP_BOB_HIT, { face: null, outfit: WARDROBE.alice }]]);
  assert.equal(hop.tracks[0].transitionAt, hop.capturedAt, 'the hop is an uncertain transition: a burst opened before it cannot land after it');
  assert.notDeepEqual(hop.lock, { kind: 'lock', id: 'bob' });
});

test('a person the detector skipped still covers the dot where the pan carried them, not only where they were last seen (pan-crossing-far seed 2146)', async () => {
  // Alice walks in front of Bob while the phone pans: everybody shifts 0.04 of the frame a frame. In
  // the last frame the detector skips her; her last box ends left of the dot, but her motion has
  // carried her over it, in front of Bob. The stale box let LOCK bob show with the dot on her.
  const h = hopHarness();
  const alice: Person = { face: ALICE_FACE, outfit: WARDROBE.alice };
  const bob: Person = { face: BOB_FACE, outfit: WARDROBE.bob };
  const aliceAt = (x: number): [NBox, NBox, Person] => [[x, 0.24, 0.25, 0.61], [x + 0.05, 0.25, 0.15, 0.35], alice];
  const bobAt = (x: number): [NBox, NBox, Person] => [[x, 0.27, 0.22, 0.55], [x + 0.01, 0.28, 0.18, 0.30], bob];
  let last;
  for (let i = 0; i < 7; i++) last = await h.frame([aliceAt(0.04 * i), bobAt(0.20 + 0.04 * i)]);
  const her = last!.tracks[0];
  assert.ok(her.vx > 0, 'her track carries the pan');
  assert.ok(her.box[0] + her.box[2] < 0.5, 'her last box ends left of the dot');
  assert.ok(last!.tracks[1].belief.bob > 0.9, 'Bob is recognised');
  const skipped = await h.frame([bobAt(0.48)]);
  assert.equal(skipped.inSight, null, 'the dot may be on her: nobody is selected');
  assert.equal(skipped.lock, null);
  h.pipeline.fire({ tap: 0 }, CROSSHAIR);
  assert.equal(h.pipeline.hasPending(), false, 'and a tap on that frame nominates nobody');
});

test('a burst never lands across an uncertain transition, even with a name accepted at the tap (slow-phone pan crossing, seed 858)', async () => {
  // On a 400 ms phone a stale tap gets a burst of almost 2 s. Seed 858: at the tap Alice's track sat
  // on Bob's body (the pan had swapped them), so the burst expected "alice"; 550 ms later the track
  // went through a transition back onto Alice's body, re-earned her there, and the burst landed on
  // her 1.8 s after a tap on him. Holding the burst to the name is not holding it to the body.
  const slow = 400;
  const h = hopHarness(slow);
  const bob: Person = { face: BOB_FACE, outfit: WARDROBE.bob };
  let last;
  for (let i = 0; i < 8; i++) last = await h.frame([[HOP_BOB, HOP_BOB_HIT, bob]]);
  assert.deepEqual(last!.lock, { kind: 'lock', id: 'bob' });
  h.clock.now = h.t - slow + 300;
  const tap = h.pipeline.fire({ tap: h.clock.now }, CROSSHAIR);
  assert.equal(tap.kind, 'pending', 'a tap on a 300 ms old frame opens a burst');
  // Somebody crosses behind Bob's left side (IoU 0.31, clear of the dot): an uncertain transition on
  // his track, after the tap, while he stays under the dot.
  const crossed = await h.frame([[HOP_BOB, HOP_BOB_HIT, bob], [[0.16, 0.25, 0.28, 0.58], [0.21, 0.26, 0.17, 0.33], { face: ALICE_FACE, outfit: WARDROBE.alice }]]);
  assert.equal(crossed.settled, null, 'the burst keeps waiting');
  assert.ok((crossed.tracks[0].transitionAt ?? 0) > crossed.capturedAt - slow);
  const reads: number[] = [];
  let settled = null;
  let relocked = false;
  while (h.pipeline.hasPending()) {
    const before = h.outfitReads.length;
    const out = await h.frame([[HOP_BOB, HOP_BOB_HIT, bob]]);
    reads.push(h.outfitReads.length - before);
    relocked ||= out.lock?.kind === 'lock';
    settled = out.settled ?? settled;
  }
  assert.ok(relocked, 'the identity is re-earned on his body while the burst is still open');
  assert.equal(settled?.resolution ?? null, null, `the burst must not land after the transition: ${JSON.stringify(settled?.resolution)}`);
  // Work shedding reads clothing every other frame on a slow phone; a body somebody may be hidden
  // behind keeps its outfit read on every frame, because that read is what each frame stands on.
  assert.ok(reads.every((n) => n === 1), `outfit reads per frame while the partner may be hidden: ${reads}`);
});

test('while someone may be hidden behind the target, a frame with the dot off the target\'s torso ends the burst (pan-crossing-far-sliver seed 28)', async () => {
  // Seed 28: a tap on the sliver of Bob showing beside Alice, who walked in front of him, nominated
  // her track from its motion. The next frame saw her with the dot off her torso, on him; the burst
  // waited, he went fully behind her, the shooter's dot followed him onto her, and the burst landed
  // on her 670 ms after a tap on him. Here Bob is the one in front and somebody is hidden behind him.
  const h = hopHarness();
  const bob: Person = { face: BOB_FACE, outfit: WARDROBE.bob };
  const bobTrack = await bobWithHiddenPartner(h, { face: ALICE_FACE, outfit: WARDROBE.alice });
  // The newest frame was captured a period ago: 260 ms is past the geometry budget, so a burst opens.
  h.clock.now = h.t + 40;
  const tap = h.pipeline.fire({ tap: h.clock.now }, CROSSHAIR);
  assert.equal(tap.kind, 'pending', 'a stale tap on Bob opens a burst');
  // The frame in flight at the tap was captured before it and cannot decide.
  const inFlight = await h.frame([[HOP_BOB, HOP_BOB_HIT, bob]]);
  assert.equal(inFlight.settled, null);
  // Captured after the tap: Bob is seen, the partner may still be hidden behind him, and his torso
  // ends left of the dot. What is under the dot may be the hidden partner.
  const offTorso: NBox = [0.33, 0.25, 0.14, 0.35];
  const off = await h.frame([[HOP_BOB, offTorso, bob]]);
  assert.equal(off.tracks[0].id, bobTrack);
  assert.ok(off.tracks[0].hiding, 'the partner may still be hidden behind Bob');
  assert.ok(off.settled, 'the burst ends on that frame rather than waiting for the dot to drift onto Bob');
  assert.equal(off.settled.resolution, null);
  // Bob under the dot again later: the burst is over and lands on nobody.
  const back = await h.frame([[HOP_BOB, HOP_BOB_HIT, bob]]);
  assert.equal(back.settled, null);
  assert.equal(h.pipeline.hasPending(), false);
});

test('a settled shot says which rule refused it: the burst rules and the decision rules alike', async () => {
  // A burst that the timer ends before any post-tap frame confirmed it: no frame.
  const a = harness();
  await a.establishBob(6);
  const { result } = a.tapStale();
  assert.equal(result.kind, 'pending');
  const expired = a.pipeline.expirePending(result.kind === 'pending' ? result.token : {});
  assert.equal(expired?.resolution, null);
  assert.equal(expired?.refusal, 'no-frame', 'nothing confirmed it before the deadline');
  // A burst whose post-tap frames read Alice's face on Bob's body: the track may have hopped, so the
  // identity is re-earned and the burst cannot land; it ends naming that rule, Bob still under the dot.
  const b = harness();
  await b.establishBob(6);
  b.ops.cropFaces = async (region) => (region[2] > 0.3 ? [{ box: [0.48, 0.26, 0.08, 0.1], embedding: ALICE_FACE, quality: 1 }] : []);
  b.tapStale();
  let settled = null;
  for (let i = 0, at = b.clock.now + 20; i < 8 && !settled; i++, at = b.t) settled = (await b.frame([body(BOB_BOX, BOB_HIT)], at)).settled;
  if (!settled && b.pipeline.hasPending()) settled = null;
  assert.ok(settled, 'the burst ends within its frames');
  assert.equal(settled.resolution, null);
  assert.ok(settled.track, 'a body was under the dot: an unclear shot, not a miss');
  assert.ok(settled.refusal && ['unconfirmed', 'reacquiring', 'transition', 'other-player'].includes(settled.refusal), `a hop names a transition rule: ${settled.refusal}`);
  // A hit refuses nothing.
  const c = harness();
  await c.establishBob(6);
  c.clock.now = c.t - PERIOD + 30;
  const shot = c.pipeline.fire({ tap: c.clock.now }, CROSSHAIR);
  assert.equal(shot.kind, 'instant');
  assert.equal(shot.kind === 'instant' ? shot.settlement.refusal : 'x', null);
});
