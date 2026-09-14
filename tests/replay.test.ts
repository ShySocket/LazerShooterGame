import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Recorder, recordDetection, restoreDetection, type Recording } from '../src/debug/recorder';
import { replayRecording } from '../src/debug/replay';
import { buildDetections } from '../src/vision/tracker';
import type { BodyResult, FaceResult } from '@vladmandic/human';

const fixture = (): Recording => JSON.parse(readFileSync(new URL('./replay/fixtures/duel-close-4s.json', import.meta.url), 'utf8')) as Recording;

test('a detection survives the round trip through the recording format', () => {
  const body = { boxRaw: [0.3, 0.2, 0.3, 0.6], score: 0.91, keypoints: [{ part: 'nose', positionRaw: [0.45, 0.25], score: 0.8 }, { part: 'leftShoulder', positionRaw: [0.36, 0.33], score: 0.7 }] } as unknown as BodyResult;
  const face = { boxRaw: [0.41, 0.21, 0.08, 0.1], boxScore: 0.88 } as unknown as FaceResult;
  const [d] = buildDetections([body], [face]);
  const back = restoreDetection(recordDetection(d));
  const near = (a?: number[], b?: number[]) => assert.deepEqual(a?.map((v) => +v.toFixed(3)), b?.map((v) => +v.toFixed(3)));
  near(back.box, d.box);
  near(back.hit, d.hit);
  assert.equal(back.body?.keypoints.length, 2);
  assert.deepEqual(back.body?.keypoints[1].positionRaw, [0.36, 0.33]);
  assert.deepEqual(back.face?.boxRaw, [0.41, 0.21, 0.08, 0.1]);
  // And the pipeline's own hit region from the restored body agrees with what was recorded.
  const [again] = buildDetections([back.body!], [back.face!]);
  assert.deepEqual(again.hit?.map((v) => +v.toFixed(3)), d.hit?.map((v) => +v.toFixed(3)));
});

test('the synthetic fixture replays through the pipeline and lands on the target only', async () => {
  const rec = fixture();
  assert.equal(rec.version, 1);
  assert.ok(rec.frames.length >= 12 && rec.fires.length >= 2, `frames ${rec.frames.length}, fires ${rec.fires.length}`);
  assert.ok(rec.frames.every((f) => f.dets.every((d) => !('embedding' in d))), 'detections carry no pixels or embeddings');
  const r = await replayRecording(rec);
  assert.equal(r.frames, rec.frames.length);
  assert.ok((r.hitsBy.alice ?? 0) >= 1, `expected hits on alice: ${JSON.stringify(r)}`);
  assert.deepEqual(Object.keys(r.hitsBy), ['alice'], 'nobody else is hit');
  assert.ok((r.locksBy.alice ?? 0) > 0);
  assert.equal(r.locksBy.bob, undefined);
});

test('a stricter threshold on replay turns hits into unclear reads, never into hits on somebody else', async () => {
  const rec = fixture();
  const loose = await replayRecording(rec, { hitThreshold: 0.5 });
  const strict = await replayRecording(rec, { hitThreshold: 0.99, hitMargin: 0.9 });
  assert.ok((strict.hitsBy.alice ?? 0) <= (loose.hitsBy.alice ?? 0));
  assert.deepEqual(Object.keys(strict.hitsBy).filter((id) => id !== 'alice'), []);
});

test('the recorder captures frames, crops, outfits and fires as numbers only', async () => {
  const rec = new Recorder({ width: 720, height: 1280, candidates: [], selfId: 'me', hitThreshold: 0.5, hitMargin: 0.2 });
  const dets = buildDetections([{ boxRaw: [0.3, 0.2, 0.3, 0.6], score: 0.9, keypoints: [] } as unknown as BodyResult], []);
  const ops = rec.frame(100, [0.29, 0.35, 0.42, 0.3], dets, {
    sampleOutfit: () => ({ sig: { top: [0.5, 0.5] }, props: null }),
    cropFaces: async () => [{ box: [0.4, 0.2, 0.1, 0.1], embedding: [0.6, 0.8], quality: 1 }],
    isCurrent: () => true,
  });
  ops.sampleOutfit!(dets[0]);
  await ops.cropFaces(dets[0].box, dets[0]);
  rec.fire(150, [0.29, 0.35, 0.42, 0.3]);
  const out = rec.recording();
  assert.equal(out.frames.length, 1);
  assert.deepEqual(out.frames[0].outfits[0], { sig: { top: [0.5, 0.5] }, props: null });
  assert.deepEqual(out.frames[0].crops[0][0].embedding, [0.6, 0.8]);
  assert.deepEqual(out.fires, [{ t: 150, crosshair: [0.29, 0.35, 0.42, 0.3] }]);
  assert.match(out.calibration, /^\d{4}-\d{2}-\d{2}\.\d+$/);
});
