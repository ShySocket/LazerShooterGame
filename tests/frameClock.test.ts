import test from 'node:test';
import assert from 'node:assert/strict';
import { VisionProfile, waitForVideoFrame } from '../src/vision/frameClock';

type Cb = (now: number, metadata: { presentationTime: number; captureTime?: number; expectedDisplayTime: number; width: number; height: number; mediaTime: number; presentedFrames: number }) => void;

test('waitForVideoFrame uses the camera capture time from requestVideoFrameCallback when the browser gives one', async () => {
  let cb = null as Cb | null;
  const video = { paused: false, ended: false, readyState: 4, requestVideoFrameCallback: (c: Cb) => { cb = c; return 1; } } as unknown as HTMLVideoElement;
  const p = waitForVideoFrame(video, 40, () => 5000);
  assert.ok(cb, 'the callback is registered');
  cb!(5010, { presentationTime: 5008, captureTime: 4990, expectedDisplayTime: 5016, width: 1280, height: 720, mediaTime: 1, presentedFrames: 3 });
  const f = await p;
  assert.deepEqual(f, { capturedAt: 4990, source: 'capture' });
});

test('waitForVideoFrame falls back to the presentation time, and to sampling when the callback never fires', async () => {
  let cb = null as Cb | null;
  const video = { paused: false, ended: false, readyState: 4, requestVideoFrameCallback: (c: Cb) => { cb = c; return 1; } } as unknown as HTMLVideoElement;
  const p = waitForVideoFrame(video, 40, () => 5000);
  cb!(5010, { presentationTime: 5008, expectedDisplayTime: 5016, width: 1280, height: 720, mediaTime: 1, presentedFrames: 3 });
  assert.deepEqual(await p, { capturedAt: 5008, source: 'presented' });
  const silent = { paused: false, ended: false, readyState: 4, requestVideoFrameCallback: () => 1 } as unknown as HTMLVideoElement;
  const t0 = Date.now();
  const s = await waitForVideoFrame(silent, 10, () => 7000);
  assert.deepEqual(s, { capturedAt: 7000, source: 'sampled' });
  assert.ok(Date.now() - t0 >= 350, 'the safety timeout waited');
});

test('waitForVideoFrame without requestVideoFrameCallback yields within the fallback and stamps the sampling time', async () => {
  const plain = { paused: false, ended: false, readyState: 4 } as unknown as HTMLVideoElement;
  const f = await waitForVideoFrame(plain, 30, () => 123);
  assert.deepEqual(f, { capturedAt: 123, source: 'sampled' });
  assert.equal((await waitForVideoFrame(null, 5, () => 9)).source, 'sampled');
});

test('the profile keeps a rolling window and reports median, p95 and max per stage', () => {
  const p = new VisionProfile(100);
  for (let i = 1; i <= 200; i++) p.record('detect', i);
  p.record('age', NaN);
  p.record('age', -1);
  const s = p.summary();
  assert.equal(s.detect!.n, 100);
  assert.equal(s.detect!.median, 151);
  assert.equal(s.detect!.p95, 196);
  assert.equal(s.detect!.max, 200);
  assert.equal(s.age, undefined, 'invalid samples are dropped');
  assert.match(p.line(), /^detect 151\/196 ms \(p50\/p95\)$/);
  p.reset();
  assert.equal(p.line(), 'no frames yet');
});
