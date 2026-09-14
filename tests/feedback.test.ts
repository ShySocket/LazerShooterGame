import test from 'node:test';
import assert from 'node:assert/strict';
import { VisionPipeline, type FrameOps } from '../src/vision/pipeline';
import type { Detection } from '../src/vision/tracker';
import type { Candidate } from '../src/vision/scoring';
import type { NBox } from '../src/vision/geometry';
import { ShotRecorder } from '../src/feedback/recorder';
import { IdMap, pickReviewShot, roundKey, trimSample, type ShotSample } from '../src/feedback/sample';
import { agreement, asPlayed, collectSamples, evaluate, judge, normaliseSample, replayShot, sweep } from '../src/feedback/replay';
import { FeedbackStore, MAX_SHOTS_PER_ROUND, MAX_UPLOAD_ATTEMPTS, MemoryBacking } from '../src/feedback/store';
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
const BOB_HIT: NBox = [0.44, 0.26, 0.19, 0.35];
const CROSSHAIR: NBox = [0.29, 0.35, 0.42, 0.3];
const OFF_TARGET: NBox = [0.0, 0.0, 0.2, 0.2];
const PERIOD = 220;
const body = (box: NBox, hit: NBox): Detection => ({ box, hit, body: { keypoints: [] } as unknown as Detection['body'] });

/** A round of Bob alone, recorded: `frames` drives the pipeline through recorder-wrapped ops. */
function harness() {
  const clock = { now: 0 };
  const eligible = new Set(['alice', 'bob']);
  const pipeline = new VisionPipeline<{ shotId: string }>(
    { candidates: CANDIDATES, exclusiveIds: new Set(CANDIDATES.map((c) => c.id)), eligible, hitThreshold: 0.5, hitMargin: 0.2 },
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
    recorder.frameDone(out, dets, capturedAt, CANDIDATES);
    t = capturedAt + PERIOD;
    return out;
  };
  const tap = (id: string, crosshair = CROSSHAIR) => {
    clock.now = t - PERIOD + 30;
    const L = pipeline.getLatest()!;
    const result = pipeline.fire({ shotId: id }, crosshair);
    const track = result.kind === 'instant' ? result.settlement.track : L.tracks.find((x) => x.hit[0] <= 0.5 && x.hit[0] + x.hit[2] >= 0.5) ?? null;
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
      liveFaces: pipeline.liveFaceCounts(),
      eligible,
    });
    return result;
  };
  return { pipeline, recorder, key, frame, tap, clock };
}

test('a recorded instant hit names nobody and carries the raw similarities behind the belief', async () => {
  const h = harness();
  let last;
  for (let i = 0; i < 7; i++) last = await h.frame([body(BOB_BOX, BOB_HIT)]);
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
  assert.ok(faceFrames.length >= 6, 'face similarities recorded per frame');
  assert.ok(faceFrames[0].tracks[0].face!.sims[bob] > 0.9, 'Bob\'s own face reads as Bob');
  assert.ok(faceFrames[0].tracks[0].face!.sims[ids.pid('alice')] < 0.5);
  assert.ok(sample.frames[6].tracks[0].belief[bob] > 0.9);
  assert.equal(sample.target?.trackId, sample.shot.trackId);
  assert.equal(sample.target?.faceMean?.length, 64);
  assert.deepEqual(sample.target?.outfit, { top: [1], thighs: [1] });
  assert.ok(sample.frames.some((f) => f.tracks[0].outfit?.match[bob]), 'outfit matches recorded');
});

test('a tap at empty space is recorded as a miss with no target, and only failed shots with a body are preferred for review', async () => {
  const h = harness();
  for (let i = 0; i < 4; i++) await h.frame([body(BOB_BOX, BOB_HIT)], OFF_TARGET);
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
  for (let i = 0; i < 6; i++) await h.frame([body(BOB_BOX, BOB_HIT)]);
  h.clock.now += 400; // older than the geometry budget: the tap opens a burst
  const L = h.pipeline.getLatest()!;
  const result = h.pipeline.fire({ shotId: 's3' }, CROSSHAIR);
  assert.equal(result.kind, 'pending');
  h.recorder.beginShot({ id: 's3', tapAt: h.clock.now, roundNow: 1_000_000 + h.clock.now, kind: 'pending', crosshair: CROSSHAIR, frameT: L.t, frameAgeMs: Math.round(h.clock.now - L.t), allowanceMs: h.pipeline.staleMs(), trackId: L.tracks[0].id, track: L.tracks[0], width: 1280, height: 720, periodMs: h.pipeline.periodMs(), staleMs: h.pipeline.staleMs(), burstMs: h.pipeline.burstMs(), liveFaces: {}, eligible: ['alice', 'bob'] });
  const out = await h.frame([body(BOB_BOX, BOB_HIT)], CROSSHAIR, h.clock.now + 20);
  assert.ok(out.settled, 'the post-tap frame settles the burst');
  const sample = h.recorder.endShot('s3', { outcome: 'hit', resolvedTo: out.settled!.resolution!.id, via: 'face', resolveMs: 240, zoom: true, track: out.settled!.track, settledBy: 'frame' })!;
  assert.equal(sample.frames.length, 7);
  assert.ok(sample.frames[5].t < 0 && sample.frames[6].t > 0, 'frames are timed relative to the tap');
  assert.equal(sample.shot.decidedAtFrame, 6);
  assert.equal(sample.shot.settledBy, 'frame');

  const ids = new IdMap(['me', 'alice', 'bob']);
  const bob = ids.pid('bob');
  const labelled: ShotSample = { ...sample, label: { kind: 'player', target: bob, answeredAt: 1, reviewMs: 1 } };
  assert.equal(replayShot(labelled).resolved, bob, 'replay with the defaults lands where the game did');
  assert.equal(agreement([labelled]), 1);
  assert.equal(judge(labelled.label!, replayShot(labelled).resolved), 'correct');
  assert.equal(replayShot(labelled, { hitThreshold: 0.99 }).resolved, null, 'an impossible threshold turns it into a miss');
  assert.equal(replayShot(labelled, { faceReject: 1, faceAccept: 1.5 }).resolved, null, 'a face calibration nothing reaches gives no evidence');
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
  assert.equal(back.frames.length, 8);
  assert.deepEqual(back.frames[0], { t: -900, tracks: [], lock: null });
  assert.equal(back.shot.resolvedTo, bob);
  assert.equal(replayShot({ ...back, shot: { ...back.shot, decidedAtFrame: 7 } }).resolved, bob);
  assert.equal(agreement([{ ...back, shot: { ...back.shot, decidedAtFrame: 7 } }]), 1);
  const missNone = normaliseSample(JSON.parse(JSON.stringify({ ...none, shot: { ...none.shot, resolvedTo: null } }, (_k, v) => (v === null ? undefined : v))));
  assert.equal(asPlayed(missNone), null);
  assert.equal(replayShot({ ...labelled, frames: labelled.frames.map((f, i) => (i === 6 ? { ...f, tracks: f.tracks.map((t) => ({ ...t, conflict: true })) } : f)) }).resolved, null, 'an identity conflict at decision time refuses the hit');
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
