import test from 'node:test';
import assert from 'node:assert/strict';
import { VisionPipeline, type FrameOps } from '../src/vision/pipeline';
import type { Detection } from '../src/vision/tracker';
import type { Candidate } from '../src/vision/scoring';
import type { NBox } from '../src/vision/geometry';
import { ShotRecorder } from '../src/feedback/recorder';
import { IdMap, pickReviewShot, roundKey, trimSample, type ShotSample } from '../src/feedback/sample';
import { agreement, asPlayed, collectSamples, evaluate, judge, normaliseSample, replayShot, sweep } from '../src/feedback/replay';
import { FeedbackStore, MAX_SHOTS_PER_ROUND, MAX_UPLOAD_ATTEMPTS, MemoryBacking, ROUND_TTL_MS } from '../src/feedback/store';
import { DEFAULT_SETTINGS } from '../src/types';

/**
 * Shot feedback: the recorder watches a round through the ops the game hands the pipeline, the
 * sample it produces names nobody, and the offline replay reproduces the game's verdict from the raw
 * similarities so a calibration change can be judged against the labels.
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
const CROSSHAIR: NBox = [0.29, 0.35, 0.42, 0.3];
const OFF_TARGET: NBox = [0.0, 0.0, 0.2, 0.2];
const PERIOD = 220;
const body = (box: NBox): Detection => ({ box, body: { keypoints: [] } as unknown as Detection['body'] });

/** A round of Bob alone, recorded: `frames` drives the pipeline through recorder-wrapped ops. */
function harness(candidates = CANDIDATES) {
  const clock = { now: 0 };
  const eligible = new Set(['alice', 'bob']);
  const pipeline = new VisionPipeline<{ shotId: string }>(
    { candidates, exclusiveIds: new Set(candidates.map((c) => c.id)), eligible, hitThreshold: 0.5, hitMargin: 0.2 },
    () => clock.now,
  );
  const recorder = new ShotRecorder();
  const key = recorder.startRound({ code: 'ABCD', startAt: 1_000_000, settings: DEFAULT_SETTINGS, playerIds: ['me', 'alice', 'bob'], shooter: 'me' });
  const raw: FrameOps = {
    sampleOutfit: () => ({ sig: { top: [1], thighs: [1] }, props: null }),
    cropFaces: async (region) => (region[2] > 0.3 ? [{ box: [0.48, 0.26, 0.08, 0.1], embedding: BOB_FACE, quality: 1 }] : []),
    isCurrent: () => true,
  };
  let t = 0;
  const frame = async (dets: Detection[], crosshair = CROSSHAIR, capturedAt = t) => {
    clock.now = capturedAt + PERIOD;
    const ops = recorder.wrapOps(raw, dets);
    const out = await pipeline.processFrame(dets, capturedAt, 1280, 720, crosshair, ops);
    assert.ok(out, 'frame abandoned');
    recorder.frameDone(out, dets, capturedAt, candidates);
    t = capturedAt + PERIOD;
    return out;
  };
  const tap = (id: string, crosshair = CROSSHAIR) => {
    clock.now = t - PERIOD + 30;
    const L = pipeline.getLatest()!;
    const result = pipeline.fire({ shotId: id }, crosshair);
    const track = result.kind === 'instant' ? result.settlement.track : L.tracks.find((x) => x.box[0] <= 0.5 && x.box[0] + x.box[2] >= 0.5) ?? null;
    recorder.beginShot({
      id,
      tapAt: clock.now,
      roundNow: 1_000_000 + clock.now,
      kind: result.kind,
      crosshair,
      frameT: L.t,
      frameAgeMs: Math.round(clock.now - L.t),
      allowanceMs: pipeline.staleMs(),
      trackId: result.kind === 'miss' ? null : (track?.id ?? null),
      track: result.kind === 'miss' ? null : track,
      width: 1280,
      height: 720,
      periodMs: pipeline.periodMs(),
      staleMs: pipeline.staleMs(),
      burstMs: pipeline.burstMs(),
      liveFaces: {},
      eligible,
    });
    return result;
  };
  return { pipeline, recorder, key, frame, tap, clock, get t() { return t; } };
}

test('a recorded instant hit names nobody and carries the raw similarities behind the belief', async () => {
  const h = harness();
  let last;
  for (let i = 0; i < 7; i++) last = await h.frame([body(BOB_BOX)]);
  assert.equal(last!.lock?.kind, 'lock');
  const result = h.tap('s1');
  assert.equal(result.kind, 'instant');
  const settlement = result.kind === 'instant' ? result.settlement : null;
  const sample = h.recorder.endShot('s1', { outcome: 'hit', resolvedTo: settlement!.resolution!.id, via: 'face', resolveMs: 0, zoom: false, track: settlement!.track, settledBy: 'tap' });
  assert.ok(sample);
  const ids = new IdMap(['me', 'alice', 'bob']);
  assert.equal(sample.round.key, roundKey('ABCD', 1_000_000));
  assert.equal(sample.round.shooter, ids.pid('me'));
  assert.equal(sample.shot.resolvedTo, ids.pid('bob'));
  assert.deepEqual(sample.round.eligible.sort(), [ids.pid('alice'), ids.pid('bob')].sort());
  const text = JSON.stringify(sample);
  for (const real of ['"me"', '"alice"', '"bob"']) assert.ok(!text.includes(real), `real id ${real} leaked into the sample`);
  assert.ok(!('photo' in sample), 'no image data in a sample');
  assert.equal(sample.frames.length, 7);
  const bob = ids.pid('bob');
  const faceFrames = sample.frames.filter((f) => f.tracks[0].face);
  // The crosshair target is cropped every frame until its identity resolves, then refreshed every
  // FACE_REFRESH_MS (calibration.ts): the sample carries face similarities for exactly the frames the
  // game had a crop for, which is fewer than every frame once Bob is confident.
  assert.ok(faceFrames.length >= 3, `face similarities recorded on cropped frames (${faceFrames.length})`);
  assert.ok(faceFrames[0].tracks[0].face!.sims[bob] > 0.9, 'Bob\'s own face reads as Bob');
  assert.ok(faceFrames[0].tracks[0].face!.sims[ids.pid('alice')] < 0.5);
  assert.ok(sample.frames[6].tracks[0].belief[bob] > 0.9);
  assert.equal(sample.target?.trackId, sample.shot.trackId);
  assert.equal(sample.target?.faceMean?.length, 64);
  assert.deepEqual(sample.target?.outfit, { top: [1], thighs: [1] });
  assert.ok(sample.frames.some((f) => f.tracks[0].outfit?.match[bob]), 'outfit matches recorded');
  // v2 trace (Astra review): every decision can be explained from the sample alone.
  const { CALIBRATION_VERSION } = await import('../src/vision/calibration');
  assert.equal(sample.v, 3);
  // v3: a hit carries no refusal; the frames before the lock name the rule that held it back.
  assert.equal(sample.shot.refusal, null);
  assert.equal(sample.frames.at(-1)?.refusal, null, 'the locked frame refuses nothing');
  assert.ok(sample.frames.some((f) => typeof f.refusal === 'string'), `a frame before the lock says why: ${sample.frames.map((f) => f.refusal).join(',')}`);
  assert.equal(sample.app.calibration, CALIBRATION_VERSION);
  const final = sample.frames[6];
  assert.equal(final.bodies, 1);
  const tr = final.tracks[0];
  assert.deepEqual(tr.vetoed, [], 'Bob\'s own outfit vetoes nobody');
  assert.equal(typeof tr.clothingAgeMs, 'number', 'the age of the last outfit read is recorded');
  assert.equal(tr.unconfirmed, false);
  assert.equal(tr.reacquiring, false);
  assert.equal(tr.overlapping, false);
  assert.equal(tr.crowded, false);
  assert.equal(faceFrames.every((f) => f.tracks[0].freshFace), true, 'a frame with a face read is marked fresh');
  assert.ok(sample.frames.some((f) => !f.tracks[0].face && f.tracks[0].freshFace === false), 'a frame without a read is marked as carried');
  assert.deepEqual(tr.hit, tr.hit.map((v) => Math.round(v * 1000) / 1000), 'the observed hit region is recorded');
});

test('a tap at empty space is recorded as a miss with no target, and only failed shots with a body are preferred for review', async () => {
  const h = harness();
  for (let i = 0; i < 4; i++) await h.frame([body(BOB_BOX)], OFF_TARGET);
  const result = h.tap('s2', OFF_TARGET);
  assert.equal(result.kind, 'miss');
  const sample = h.recorder.endShot('s2', { outcome: 'miss', resolvedTo: null, via: null, resolveMs: 0, zoom: false, track: null, settledBy: 'tap' })!;
  assert.equal(sample.shot.trackId, null);
  assert.equal(sample.target, null);
  assert.equal(h.recorder.endShot('s2', { outcome: 'miss', resolvedTo: null, via: null, resolveMs: 0, zoom: false, track: null, settledBy: 'tap' }), null, 'a shot ends once');

  const shots = [
    { id: 'h', outcome: 'hit', hadTrack: true },
    { id: 'm', outcome: 'miss', hadTrack: false },
    { id: 'u', outcome: 'unclear', hadTrack: true },
    { id: 'n', outcome: 'no camera', hadTrack: false },
  ];
  assert.equal(pickReviewShot(shots, () => 0.99)?.id, 'u');
  assert.equal(pickReviewShot(shots.filter((s) => s.id !== 'u'), () => 0)?.id, 'm');
  assert.equal(pickReviewShot(shots.filter((s) => s.id === 'h' || s.id === 'n')), null);
});

test('a burst records the frames after the tap and the replay reproduces the verdict', async () => {
  const h = harness();
  // One face frame leaves Bob at belief 0.45, under the 0.5 threshold: the tap opens a burst.
  await h.frame([body(BOB_BOX)]);
  h.clock.now = h.t - PERIOD + 30;
  const L = h.pipeline.getLatest()!;
  const result = h.pipeline.fire({ shotId: 's3' }, CROSSHAIR);
  assert.equal(result.kind, 'pending');
  h.recorder.beginShot({ id: 's3', tapAt: h.clock.now, roundNow: 1_000_000 + h.clock.now, kind: 'pending', crosshair: CROSSHAIR, frameT: L.t, frameAgeMs: Math.round(h.clock.now - L.t), allowanceMs: h.pipeline.staleMs(), trackId: L.tracks[0].id, track: L.tracks[0], width: 1280, height: 720, periodMs: h.pipeline.periodMs(), staleMs: h.pipeline.staleMs(), burstMs: h.pipeline.burstMs(), liveFaces: {}, eligible: ['alice', 'bob'] });
  const out = await h.frame([body(BOB_BOX)], CROSSHAIR, h.clock.now + 20);
  assert.ok(out.settled, 'the post-tap frame settles the burst');
  assert.equal(out.settled!.resolution?.id, 'bob');
  const sample = h.recorder.endShot('s3', { outcome: 'hit', resolvedTo: out.settled!.resolution!.id, via: 'face', resolveMs: 240, zoom: true, track: out.settled!.track, settledBy: 'frame' })!;
  assert.equal(sample.frames.length, 2);
  assert.ok(sample.frames[0].t < 0 && sample.frames[1].t > 0, 'frames are timed relative to the tap');
  assert.equal(sample.shot.decidedAtFrame, 1);
  assert.equal(sample.shot.settledBy, 'frame');

  const ids = new IdMap(['me', 'alice', 'bob']);
  const bob = ids.pid('bob');
  const labelled: ShotSample = { ...sample, label: { kind: 'player', target: bob, answeredAt: 1, reviewMs: 1 } };
  assert.equal(replayShot(labelled).resolved, bob, 'replay with the defaults lands where the game did');
  assert.equal(agreement([labelled]), 1);
  assert.equal(judge(labelled.label!, replayShot(labelled).resolved), 'correct');
  assert.equal(replayShot(labelled, { hitThreshold: 0.99 }).resolved, null, 'an impossible threshold turns it into a miss');
  // Both bars: a face its outfit did not back was judged at the face-only bar (corroborated, v2).
  assert.equal(replayShot(labelled, { faceReject: 1, faceAccept: 1.5, faceOnlyReject: 1, faceOnlyAccept: 1.5 }).resolved, null, 'a face calibration nothing reaches gives no evidence');
  const none: ShotSample = { ...sample, label: { kind: 'none', answeredAt: 1, reviewMs: 1 } };
  const e = evaluate([labelled, none]);
  assert.deepEqual({ n: e.n, correct: e.correct, wrong: e.wrong, miss: e.miss }, { n: 2, correct: 1, wrong: 1, miss: 0 });
  assert.equal(e.score, 5);
  assert.equal(evaluate([labelled, none], {}, asPlayed).wrong, 1);
  const rows = sweep([labelled]);
  assert.ok(rows.length > 5 && rows[0].result.score <= rows[rows.length - 1].result.score, 'sweep is sorted by score');
  assert.equal(collectSamples({ rounds: { [sample.round.key]: { profiles: {}, samples: { a: labelled, b: none } } } }).length, 2);
  assert.equal(collectSamples({ feedback: { rounds: { x: { samples: { a: labelled } } } } }).length, 1);

  // The database drops nulls and empty arrays/objects; an export must replay like the original.
  const exported = JSON.parse(JSON.stringify({ ...labelled, frames: [{ t: -900, tracks: [], lock: null }, ...labelled.frames] }, (_k, v) => {
    if (v === null) return undefined;
    if (Array.isArray(v) && v.length === 0) return undefined;
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0) return undefined;
    return v;
  }));
  const back = collectSamples({ samples: { a: exported } })[0];
  assert.equal(back.frames.length, 3);
  assert.deepEqual(back.frames[0], { t: -900, tracks: [], lock: null });
  assert.equal(back.shot.resolvedTo, bob);
  assert.equal(replayShot({ ...back, shot: { ...back.shot, decidedAtFrame: 2 } }).resolved, bob);
  assert.equal(agreement([{ ...back, shot: { ...back.shot, decidedAtFrame: 2 } }]), 1);
  const missNone = normaliseSample(JSON.parse(JSON.stringify({ ...none, shot: { ...none.shot, resolvedTo: null } }, (_k, v) => (v === null ? undefined : v))));
  assert.equal(asPlayed(missNone), null);
  assert.equal(replayShot({ ...labelled, frames: labelled.frames.map((f, i) => (i === 1 ? { ...f, tracks: f.tracks.map((t) => ({ ...t, conflict: true })) } : f)) }).resolved, null, 'an identity conflict at decision time refuses the hit');
  const withGate = (g: Record<string, unknown>) => replayShot({ ...back, shot: { ...back.shot, decidedAtFrame: 2 }, frames: back.frames.map((f, i) => (i === 2 ? { ...f, tracks: f.tracks.map((t) => ({ ...t, ...g })) } : f)) }).resolved;
  assert.equal(withGate({}), bob, 'the v2 fields absent: judged on belief alone');
  // Without the v3 hiding field the recorded flag is the unconfirmed state; with it the replay keeps
  // the state itself, so a transition (reacquiring turning on) sets it and a recorded flag that nothing
  // on the replayed frames sets is the game's calibration's verdict, not a fact the replay inherits.
  assert.equal(withGate({ unconfirmed: true, hiding: undefined }), null, 'an identity not yet confirmed refuses the hit (recorded flag, no hiding field)');
  assert.equal(withGate({ unconfirmed: true, reacquiring: true }), null, 'an identity not yet re-earned after a transition refuses the hit');
  assert.equal(withGate({ unconfirmed: true }), bob, 'with the hiding field, the replay decides the flag from the frames itself');
  assert.equal(withGate({ vetoed: [bob] }), null, 'a player the outfit rules out is refused');
  assert.equal(withGate({ crowded: true }), bob, 'a crowded frame whose own read names the player by the margin may hit');
  assert.equal(withGate({ overlapping: true }), bob, 'so may an overlap');
});

test('the replay applies the game\'s overlap/crowd rule: the body\'s latest read, from within 400 ms of the deciding frame, naming the player by the margin', async () => {
  // Six bodies (BODY_CAP): every frame is crowded. Bob, confident, is cropped every other frame, so a
  // tap after an uncropped frame hits at once on the read from the frame before (review of 2026-10-01:
  // the replay refused those because the deciding frame had no read of its own).
  const bystanders = [0.0, 0.08, 0.16, 0.78, 0.88].map((x) => body([x, 0.3, 0.07, 0.4]));
  const scene = [body(BOB_BOX), ...bystanders];
  const h = harness();
  let carried = false;
  for (let i = 0; i < 16 && !carried; i++) {
    const out = await h.frame(scene);
    assert.ok(out.crowded, 'six bodies: the crowd rule applies');
    const L = h.pipeline.getLatest()!;
    carried = out.lock?.kind === 'lock' && L.tracks[0].lastFaceAt < L.t;
  }
  assert.ok(carried, 'Bob locked on a crowded frame without a crop of his own');
  const result = h.tap('c1');
  assert.equal(result.kind, 'instant');
  const settlement = result.kind === 'instant' ? result.settlement : null;
  assert.equal(settlement?.resolution?.id, 'bob');
  const sample = h.recorder.endShot('c1', { outcome: 'hit', resolvedTo: 'bob', via: 'face', resolveMs: 0, zoom: false, track: settlement!.track, settledBy: 'tap' })!;
  const ids = new IdMap(['me', 'alice', 'bob']);
  const bob = ids.pid('bob');
  const last = sample.frames.length - 1;
  const decision = sample.frames[last].tracks[0];
  assert.equal(decision.crowded, true);
  assert.equal(decision.freshFace, false, 'the deciding frame carried the read from the frame before');
  assert.ok(sample.frames[last - 1].tracks[0].face, 'the frame before read Bob\'s face');
  assert.equal(replayShot(sample).resolved, bob, 'the replay lands where the game did');
  assert.equal(agreement([sample]), 1);

  // The same sample with the read frame edited: the rule's every part refuses on its own.
  const readFrame = last - 1;
  const edit = (f: (t: ShotSample['frames'][number]['tracks'][number]) => ShotSample['frames'][number]['tracks'][number], frameAt = readFrame, dt = 0) =>
    replayShot({ ...sample, frames: sample.frames.map((fr, i) => (i === frameAt ? { ...fr, t: fr.t + dt, tracks: fr.tracks.map((t, j) => (j === 0 ? f(t) : t)) } : fr)) }).resolved;
  assert.equal(edit((t) => t, last, 200), null, 'a read from more than 400 ms before the deciding frame refuses');
  assert.equal(edit((t) => t, last, 150), bob, 'one from within 400 ms of it does not');
  assert.equal(sample.frames[readFrame].tracks[0].face?.corroborated, undefined, 'Bob\'s scan has no trousers: his outfit never backs his face');
  const withSims = (sims: Record<string, number>, corroborated?: string[]) => (t: ShotSample['frames'][number]['tracks'][number]) => ({ ...t, face: { sims, meanSims: t.face!.meanSims, quality: t.face!.quality, ...(corroborated ? { corroborated } : {}) } });
  assert.equal(edit(withSims({ [bob]: 0.5, [ids.pid('alice')]: 0.1, [ids.pid('me')]: 0.1 })), null, 'a read that names the stranger refuses');
  assert.equal(edit(withSims({ [bob]: 0.9, [ids.pid('alice')]: 0.85, [ids.pid('me')]: 0.1 })), null, 'a read without the margin over the runner-up refuses');
  // The bar each face was judged at is part of the read: 0.8 is a clear read at the normal bar and a
  // thin one at the face-only bar (FACE_ONLY_CALIB) a face without its outfit's backing gets.
  const corroboratedRead = withSims({ [bob]: 0.8, [ids.pid('alice')]: 0.1, [ids.pid('me')]: 0.1 }, [bob]);
  assert.equal(edit(withSims({ [bob]: 0.8, [ids.pid('alice')]: 0.1, [ids.pid('me')]: 0.1 })), null, 'an uncorroborated face at 0.8 does not clear the face-only bar by the margin');
  assert.equal(edit(corroboratedRead), bob, 'the same face backed by Bob\'s own outfit does');
  const uncrowded = (t: ShotSample['frames'][number]['tracks'][number]) => ({ ...t, crowded: false });
  assert.equal(replayShot({ ...sample, frames: sample.frames.map((fr, i) => (i === readFrame ? { ...fr, tracks: fr.tracks.map((t, j) => (j === 0 ? withSims({ [bob]: 0.9, [ids.pid('alice')]: 0.85 })(t) : t)) } : i === last ? { ...fr, tracks: fr.tracks.map((t, j) => (j === 0 ? uncrowded(t) : t)) } : fr)) }).resolved, bob, 'outside a crowd or an overlap the read is not consulted');
  // A database export drops an empty corroboration list and keeps a full one.
  const exported = collectSamples({ s: JSON.parse(JSON.stringify({ ...sample, frames: sample.frames.map((fr, i) => (i === readFrame ? { ...fr, tracks: fr.tracks.map((t, j) => (j === 0 ? corroboratedRead(t) : t)) } : fr)) })) })[0];
  assert.deepEqual(exported.frames[readFrame].tracks[0].face?.corroborated, [bob]);

  // A scan with top and trousers that the body matches: the recorder marks Bob's face as backed.
  const full = { faceModel: 'test', outfit: { front: { top: [1], thighs: [1] }, back: { top: [1], thighs: [1] } } };
  const q = harness(CANDIDATES.map((c) => ({ id: c.id, profile: { ...full, face: c.profile.face } })));
  for (let i = 0; i < 3; i++) await q.frame([body(BOB_BOX)]);
  q.tap('c2');
  const backed = q.recorder.endShot('c2', { outcome: 'miss', resolvedTo: null, via: null, resolveMs: 0, zoom: false, track: null, settledBy: 'tap' })!;
  assert.ok(
    backed.frames.some((f) => f.tracks[0].face?.corroborated?.includes(bob)),
    'a face read while the outfit backs it records who it was backed for',
  );
});

/**
 * Replay parity on a body somebody may be hidden behind (review of 2026-10-01). Bob, his genuine face
 * reading 0.72 like his scan (above FACE_CALIB.accept, below FACE_ONLY_CALIB.accept), is alone and
 * recognised; Alice overlaps him for two frames (8 and 9) and is then presumed hidden behind him
 * (frames 10-15 over her lost track's box, 16-33 hiding only). A face is judged at the normal bar only
 * on frames where his own outfit is read and backs it, otherwise at the face-only bar. The game,
 * recorder and replay are wired as Game.tsx wires them: the galleries taken from the pipeline before
 * each frame.
 */
const hot = (i: number): number[] => Array.from({ length: 8 }, (_, k) => (k === i ? 1 : 0));
const wardrobe = (top: number, thighs: number) => ({ top: hot(top), thighs: hot(thighs) });
const DRESSED: Candidate[] = [
  { id: 'me', profile: { faceModel: 'test', face: [ME_FACE], outfit: { front: wardrobe(6, 7), back: wardrobe(6, 7) } } },
  { id: 'alice', profile: { faceModel: 'test', face: [ALICE_FACE], outfit: { front: wardrobe(0, 1), back: wardrobe(0, 1) } } },
  { id: 'bob', profile: { faceModel: 'test', face: [BOB_FACE], outfit: { front: wardrobe(2, 3), back: wardrobe(2, 3) } } },
];
const withCosine = (u: number[], cos: number, seed: number): number[] => {
  const n = embedding(seed);
  const d = n.reduce((s, x, i) => s + x * u[i], 0);
  const perp = unit(n.map((x, i) => x - d * u[i]));
  return u.map((x, i) => cos * x + Math.sqrt(1 - cos * cos) * perp[i]);
};
const HIDE_BOB: NBox = [0.30, 0.24, 0.30, 0.61];
const HIDE_ALICE: NBox = [0.40, 0.25, 0.28, 0.58];

interface HidingScene {
  /** Face quality of every read; under LIVE_FACE_MIN_QUALITY nothing is learned live. */
  quality: number;
  /** Frames on which Bob's torso cannot be read. */
  unreadable: (frame: number) => boolean;
  /** Frames on which the crop on Bob's body reads a face that names nobody (0.4 to his scan, like a hidden partner's blurred face). */
  blurred?: (frame: number) => boolean;
  /** How a burst settles: by the frames after the tap, or by its timer before any arrives (a stalled camera). */
  settle: 'frames' | 'timer';
  /** Test-only: hand the recorder the configured candidates instead of the pipeline's galleries. */
  galleries?: 'pipeline' | 'configured';
}

/** Plays the scene up to a tap on frame `tapFrame` and settles it; returns the game's verdict and the recorded sample. */
async function hidingShot(tapFrame: number, scene: HidingScene) {
  const clock = { now: 0 };
  const eligible = new Set(['alice', 'bob']);
  const pipeline = new VisionPipeline<{ shotId: string }>({ candidates: DRESSED, exclusiveIds: new Set(DRESSED.map((c) => c.id)), eligible, hitThreshold: 0.5, hitMargin: 0.2 }, () => clock.now);
  const recorder = new ShotRecorder();
  recorder.startRound({ code: 'ABCD', startAt: 1_000_000, settings: DEFAULT_SETTINGS, playerIds: ['me', 'alice', 'bob'], shooter: 'me' });
  const bobRead = withCosine(BOB_FACE, 0.72, 21);
  const blurredRead = withCosine(BOB_FACE, 0.4, 22);
  const isBob = (d: Detection) => d.box[0] === HIDE_BOB[0];
  let frameNo = 0;
  const raw: FrameOps = {
    sampleOutfit: (d) => ({ sig: !isBob(d) ? wardrobe(0, 1) : scene.unreadable(frameNo) ? null : wardrobe(2, 3), props: null }),
    cropFaces: async (_r, d) => [{ box: [d.box[0] + d.box[2] * 0.35, d.box[1] + 0.02, d.box[2] * 0.3, 0.08], embedding: !isBob(d) ? ALICE_FACE : scene.blurred?.(frameNo) ? blurredRead : bobRead, quality: scene.quality }],
    isCurrent: () => true,
  };
  const people = (i: number): Detection[] => (i === 8 || i === 9 ? [HIDE_BOB, HIDE_ALICE] : [HIDE_BOB]).map((box) => ({ box, body: { keypoints: [] } as unknown as Detection['body'] }));
  let t = 0;
  const frame = async () => {
    const dets = people(frameNo);
    clock.now = t + PERIOD;
    const galleries = scene.galleries === 'configured' ? DRESSED : pipeline.galleries();
    const out = await pipeline.processFrame(dets, t, 1280, 720, CROSSHAIR, recorder.wrapOps(raw, dets));
    assert.ok(out);
    recorder.frameDone(out, dets, t, galleries);
    frameNo++;
    t += PERIOD;
    return out;
  };
  let last;
  while (frameNo <= tapFrame) last = await frame();
  clock.now = t - PERIOD + 30;
  const L = pipeline.getLatest()!;
  const fire = pipeline.fire({ shotId: 's' }, CROSSHAIR);
  const track = fire.kind === 'instant' ? fire.settlement.track : L.tracks[0];
  recorder.beginShot({ id: 's', tapAt: clock.now, roundNow: 1_000_000 + clock.now, kind: fire.kind, crosshair: CROSSHAIR, frameT: L.t, frameAgeMs: Math.round(clock.now - L.t), allowanceMs: pipeline.staleMs(), trackId: track?.id ?? null, track, width: 1280, height: 720, periodMs: pipeline.periodMs(), staleMs: pipeline.staleMs(), burstMs: pipeline.burstMs(), liveFaces: pipeline.liveFaceCounts(), eligible });
  let game: string | null = null;
  let settledBy: 'tap' | 'frame' | 'timer' = 'tap';
  let settledTrack = track;
  if (fire.kind === 'instant') game = fire.settlement.resolution?.id ?? null;
  else if (fire.kind === 'pending' && scene.settle === 'timer') {
    settledTrack = pipeline.expirePending(fire.token)!.track;
    settledBy = 'timer';
  } else {
    assert.equal(fire.kind, 'pending');
    for (let k = 0; k < 6; k++) {
      const out = await frame();
      if (out.settled) {
        game = out.settled.resolution?.id ?? null;
        settledBy = 'frame';
        settledTrack = out.settled.track;
        break;
      }
    }
  }
  const sample = recorder.endShot('s', { outcome: game ? 'hit' : 'unclear', resolvedTo: game, via: 'face', resolveMs: 0, zoom: true, track: settledTrack, settledBy })!;
  const decided = sample.frames[sample.shot.decidedAtFrame].tracks.find((x) => x.id === (sample.shot.decisionTrackId ?? sample.shot.trackId));
  return { game: game ? new IdMap(['me', 'alice', 'bob']).pid(game) : null, sample, decided, hiding: Boolean(last?.tracks[0].hiding && !last.tracks[0].overlapping), learned: pipeline.liveFaceCounts().bob ?? 0 };
}

test('the replay follows the game on a body somebody may be hidden behind, under the game\'s face bar and a looser one', async () => {
  const bob = new IdMap(['me', 'alice', 'bob']).pid('bob');
  // A tap while Alice is presumed hidden behind Bob, on the one frame whose torso cannot be read: that
  // frame's own face read is judged at the face-only bar, names nobody and cannot confirm him. The
  // camera stalls, so the burst's timer settles the shot on that frame: the game refuses.
  const hiding: HidingScene = { quality: 0.75, unreadable: (f) => f === 20, settle: 'timer' };
  const hidden = await hidingShot(20, hiding);
  assert.ok(hidden.hiding, 'the tap frame is a hiding frame, overlapping nobody');
  assert.equal(hidden.learned, 0, 'a face under LIVE_FACE_MIN_QUALITY is never learned live');
  assert.equal(hidden.game, null, 'the game refuses');
  assert.equal(hidden.decided?.hiding, true, 'the sample records that a partner was presumed hidden');
  assert.equal(hidden.decided?.unconfirmed, true, 'and that the frame\'s own read did not confirm him');
  assert.equal(hidden.decided?.outfit, undefined, 'an unreadable torso is not a sample: nothing is recorded for the replay to fuse');
  assert.equal(replayShot(hidden.sample).resolved, hidden.game, 'the replay refuses with it');
  // The same scene under a looser face-only bar (accept 0.75): the game itself, with the bar changed for
  // this run only, confirms Bob on that frame's own read and hits at once. A replay of the sample
  // recorded under the game's bar, with the looser bar as its override, must say the same; trusting the
  // recorded flag (the game's bar's verdict) it kept refusing, under-counting what a looser bar hits.
  const { FACE_ONLY_CALIB } = await import('../src/vision/calibration');
  const accept = FACE_ONLY_CALIB.accept;
  let loose;
  try {
    FACE_ONLY_CALIB.accept = 0.75;
    loose = await hidingShot(20, hiding);
  } finally {
    FACE_ONLY_CALIB.accept = accept;
  }
  assert.equal(loose.game, bob, 'under the looser bar the game hits');
  assert.equal(loose.sample.frames.length, hidden.sample.frames.length, 'on the same frame');
  assert.equal(replayShot(hidden.sample, { faceOnlyAccept: 0.75 }).resolved, loose.game, 'and so does the replay of the sample recorded under the game\'s bar');

  // A hiding frame whose torso reads as Bob but whose crop reads a face that names nobody (the hidden
  // partner's, blurred): his running face mean still names him, but only the frame's own read may
  // confirm him there (pipeline.ts applyFace, pan-crossing seed 748). The game refuses; so must the
  // replay, which confirming on the recorded mean similarities would turn into a hit.
  const blurred = await hidingShot(20, { quality: 0.75, unreadable: () => false, blurred: (f) => f === 20, settle: 'timer' });
  assert.ok(blurred.hiding);
  assert.ok(blurred.decided?.outfit && blurred.decided.face, 'his outfit and the blurred face were both read on that frame');
  assert.equal(blurred.game, null, 'the game refuses on the frame\'s own read');
  assert.equal(replayShot(blurred.sample).resolved, blurred.game, 'and so does the replay');

  // Later, Alice no longer presumed hidden and Bob's outfit unread for longer than OUTFIT_RECENT_MS: the
  // game judges his running face mean at the face-only bar too, and refuses. The replay must judge the
  // recorded mean similarities at the bar the game used for them (the recorded corroboration), not at
  // the normal bar, which names him.
  const unbacked = await hidingShot(40, { quality: 0.75, unreadable: (f) => f >= 8, settle: 'frames' });
  assert.ok(!unbacked.hiding);
  assert.equal(unbacked.game, null, 'the game refuses an unbacked 0.72 face');
  assert.equal(replayShot(unbacked.sample).resolved, unbacked.game, 'the replay judges the running mean at the same bar');

  // With a sharp face Bob's own read is learned live while his outfit backs it (pipeline.ts learnFace);
  // the game then scores later reads against that sample too, and hits. The sample's similarities are
  // taken against the pipeline's galleries, so the replay sees the read the game decided on.
  const learned = await hidingShot(40, { quality: 1, unreadable: (f) => f >= 8, settle: 'frames' });
  assert.ok(learned.learned > 0, 'Bob\'s face was learned live');
  assert.equal(learned.game, bob, 'the game hits on the learned face');
  assert.equal(replayShot(learned.sample).resolved, learned.game, 'the replay lands where the game did');
  // Recorded against the configured candidates (Game.tsx before 2026-10-01.8), the same shot's
  // similarities leave the learned face out and the replay refuses what the game hit.
  const configured = await hidingShot(40, { quality: 1, unreadable: (f) => f >= 8, settle: 'frames', galleries: 'configured' });
  assert.equal(configured.game, bob);
  assert.equal(replayShot(configured.sample).resolved, null, 'without the learned face the replay misses the game\'s hit');
});

test('a sample that grows past the upload budget loses its oldest frames first', () => {
  const big: ShotSample = {
    v: 1,
    app: { commit: 'x', faceModel: 'x', bodyModel: 'x', ua: 'x' },
    round: { key: 'K', code: 'ABCD', startAt: 0, settings: DEFAULT_SETTINGS, players: 2, shooter: 'p0', eligible: ['p1'] },
    device: { periodMs: 200, staleMs: 520, burstMs: 500, width: 1280, height: 720 },
    shot: { id: 's', roundMs: 0, outcome: 'miss', kind: 'miss', resolvedTo: null, via: null, resolveMs: 0, zoom: false, frameAgeMs: 0, allowanceMs: 0, crosshair: [0, 0, 1, 1], trackId: null, decidedAtFrame: 11, settledBy: 'tap', decisionTrackId: null, decisionBelief: null },
    frames: Array.from({ length: 12 }, (_, i) => ({ t: i, tracks: [{ id: 1, box: [0, 0, 1, 1], hit: [0, 0, 1, 1], belief: {}, via: 'none', conflict: false, ambiguous: false, faceSamples: 0, faceAgeMs: null, evidenceAgeMs: null, inSight: false }], lock: null })),
    target: null,
  };
  const trimmed = trimSample(big, 2000);
  assert.ok(trimmed.frames.length < 12 && trimmed.frames.length >= 2);
  assert.equal(trimmed.frames[trimmed.frames.length - 1].t, 11, 'the newest frame survives');
  assert.equal(trimmed.shot.decidedAtFrame, trimmed.frames.length - 1);
  assert.equal(trimSample(big).frames.length, 12, 'a small sample is untouched');
});

test('practice shots keep their photos for the practice review, apart from the review card', async () => {
  const store = new FeedbackStore(new MemoryBacking());
  const now = Date.now();
  const sample = (id: string): ShotSample => ({
    v: 2,
    app: { commit: 'x', faceModel: 'x', bodyModel: 'x', ua: 'x' },
    round: { key: 'P1', code: 'ABCD', startAt: 1, settings: DEFAULT_SETTINGS, players: 2, shooter: 'p0', eligible: ['p1'] },
    device: { periodMs: 200, staleMs: 520, burstMs: 500, width: 1280, height: 720 },
    shot: { id, roundMs: 0, outcome: 'unclear', kind: 'pending', resolvedTo: null, via: null, resolveMs: 0, zoom: false, frameAgeMs: 0, allowanceMs: 0, crosshair: [0, 0, 1, 1], trackId: 1, decidedAtFrame: -1, settledBy: 'frame', decisionTrackId: null, decisionBelief: null },
    frames: [],
    target: null,
    label: { kind: 'player', target: 'p1', answeredAt: now, reviewMs: 0, distance: 3, view: 'back', lighting: 'dim', scenario: 'crossing' },
  });
  const photo = new Blob(['jpeg'], { type: 'image/jpeg' });
  await store.beginRound({ key: 'P1', code: 'ABCD', startAt: now, ids: ['a', 'b'], profiles: {} });
  for (let i = 0; i < 3; i++) {
    await store.saveShot({ id: `p${i}`, round: 'P1', outcome: 'unclear', hadTrack: true, roundMs: i, sample: sample(`p${i}`), photo, practice: { verdict: 'NO LOCK on Target 1', kind: 'warn', aimed: 'Target 1', resolved: null, resolveMs: 400 } });
  }
  assert.equal((await store.pendingReview())?.shots.length, 0, 'the review card never asks about a practice shot');
  await store.finishReview('P1');
  const kept = await store.practiceShots();
  assert.equal(kept?.shots.length, 3, 'closing the review card keeps the practice photos');
  assert.equal(kept?.shots[0].photo, photo);
  assert.equal(kept?.shots[0].sample.label?.view, 'back');
  await store.clearPractice('P1');
  assert.equal(await store.practiceShots(), null, 'clearing the practice review deletes its photos');
});

test('the on-phone store caps failed shots per round, keeps only the newest round, and retries queued uploads', async () => {
  const store = new FeedbackStore(new MemoryBacking());
  const now = Date.now();
  const sample = (id: string): ShotSample => ({
    v: 1,
    app: { commit: 'x', faceModel: 'x', bodyModel: 'x', ua: 'x' },
    round: { key: 'R1', code: 'ABCD', startAt: 1, settings: DEFAULT_SETTINGS, players: 2, shooter: 'p0', eligible: ['p1'] },
    device: { periodMs: 200, staleMs: 520, burstMs: 500, width: 1280, height: 720 },
    shot: { id, roundMs: 0, outcome: 'miss', kind: 'miss', resolvedTo: null, via: null, resolveMs: 0, zoom: false, frameAgeMs: 0, allowanceMs: 0, crosshair: [0, 0, 1, 1], trackId: null, decidedAtFrame: -1, settledBy: 'tap', decisionTrackId: null, decisionBelief: null },
    frames: [],
    target: null,
  });
  await store.beginRound({ key: 'R1', code: 'ABCD', startAt: now - 60_000, ids: ['a', 'b'], profiles: {} });
  for (let i = 0; i < MAX_SHOTS_PER_ROUND + 5; i++) await store.saveShot({ id: `s${i}`, round: 'R1', outcome: 'miss', hadTrack: false, roundMs: i * 1000, sample: sample(`s${i}`), photo: null });
  let pending = await store.pendingReview();
  assert.equal(pending?.round.key, 'R1');
  assert.equal(pending?.shots.length, MAX_SHOTS_PER_ROUND);
  assert.equal(pending?.shots[0].id, 's5', 'the oldest shots were evicted');

  await store.beginRound({ key: 'R2', code: 'ABCD', startAt: now, ids: ['a', 'b'], profiles: {} });
  await store.saveShot({ id: 'x', round: 'R2', outcome: 'unclear', hadTrack: true, roundMs: 10, sample: sample('x'), photo: null });
  pending = await store.pendingReview();
  assert.equal(pending?.round.key, 'R2', 'the newest round is asked about');
  assert.equal(pending?.shots.length, 1);
  await store.finishReview('R2');
  assert.equal(await store.pendingReview(), null, 'the earlier round and its photos went when the new round began');
  await store.beginRound({ key: 'R3', code: 'ABCD', startAt: now - 7 * 3600 * 1000, ids: ['a', 'b'], profiles: {} });
  assert.equal(await store.pendingReview(), null, 'a round left unreviewed for hours is dropped');

  await store.enqueue({ id: 'u1', round: 'R1', sample: sample('u1'), profiles: null });
  let calls = 0;
  assert.equal(await store.flush(async () => { calls++; throw new Error('offline'); }), 0);
  assert.equal((await store.queued())[0].attempts, 1);
  assert.equal(await store.flush(async () => { calls++; }), 1);
  assert.equal(calls, 2);
  assert.deepEqual(await store.queued(), []);

  await store.enqueue({ id: 'u2', round: 'R1', sample: sample('u2'), profiles: null });
  for (let i = 0; i < MAX_UPLOAD_ATTEMPTS; i++) await store.flush(async () => { throw new Error('refused'); });
  assert.deepEqual(await store.queued(), [], 'an upload refused every time is not kept forever');
});

test('range-test photos never outlive ROUND_TTL_MS: the store drops expired rounds, reviewed or not, when the app starts', async () => {
  const backing = new MemoryBacking();
  const store = new FeedbackStore(backing);
  const now = Date.now();
  const startAt = now - ROUND_TTL_MS + 60_000;
  const sample = { v: 2, round: { key: 'OLD', startAt }, shot: { id: 'x', roundMs: 0 }, frames: [] } as unknown as ShotSample;
  const photo = new Blob(['jpeg'], { type: 'image/jpeg' });
  // A real room's range test: other players' crosshair frames, then the review card answered.
  await store.beginRound({ key: 'OLD', code: 'ABCD', startAt, ids: ['a', 'b'], profiles: {} });
  for (let i = 0; i < 3; i++) await store.saveShot({ id: `r${i}`, round: 'OLD', outcome: 'hit', hadTrack: true, roundMs: i, sample, photo, practice: { verdict: 'HIT Sam (right)', kind: 'good', aimed: 'Sam', resolved: 'Sam', resolveMs: 0 } });
  await store.finishReview('OLD');
  await store.enqueue({ id: 'q1', round: 'OLD', sample, profiles: null });
  assert.equal((await backing.all('shots')).length, 3, 'the practice photos outlast the review card');

  // Two minutes later the round has passed the TTL; the phone never starts another one, so only
  // the app starting again (a new store over the same IndexedDB) can find it.
  const realNow = Date.now;
  Date.now = () => now + 120_000;
  try {
    assert.equal(await store.pendingReview(), null, 'a reviewed round is never asked about again');
    const reopened = new FeedbackStore(backing);
    assert.equal((await reopened.queued()).length, 1, 'queued labelled samples are not photos: they stay for the next upload');
    assert.deepEqual(await backing.all('shots'), [], 'every photo of the expired round is gone');
    assert.deepEqual(await backing.all('rounds'), [], 'and so is the round');
    // A round within the TTL survives the start-up prune.
    await reopened.beginRound({ key: 'NEW', code: 'ABCD', startAt: now, ids: ['a', 'b'], profiles: {} });
    await reopened.saveShot({ id: 'n0', round: 'NEW', outcome: 'hit', hadTrack: true, roundMs: 0, sample, photo, practice: { verdict: 'HIT Sam (right)', kind: 'good', aimed: 'Sam', resolved: 'Sam', resolveMs: 0 } });
    const again = new FeedbackStore(backing);
    assert.equal((await again.practiceShots())?.shots.length, 1, 'a fresh round keeps its practice photos');
  } finally {
    Date.now = realNow;
  }
});
