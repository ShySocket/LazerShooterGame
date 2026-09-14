import assert from 'node:assert/strict';
import test from 'node:test';
import type { BodyResult } from '@vladmandic/human';
import { bodyProportions, FrameSampler, outfitRegions, outfitSignature, profileOutfitSim } from '../src/vision/clothing.ts';

function body(width = 600, height = 1000, scale = 1): BodyResult {
  const points: [string, number, number][] = [
    ['leftShoulder', -60, 120], ['rightShoulder', 60, 120],
    ['leftHip', -45, 270], ['rightHip', 45, 270],
    ['leftKnee', -40, 390], ['rightKnee', 40, 390],
    ['leftAnkle', -40, 510], ['rightAnkle', 40, 510],
    ['leftEar', -25, 80], ['rightEar', 25, 80],
  ];
  return {
    id: 0, score: 0.95, box: [0, 0, width, height], boxRaw: [0, 0, 1, 1], annotations: {},
    keypoints: points.map(([part, x, y]) => ({
      part, score: 0.95,
      position: [width / 2 + x * scale, y * scale],
      positionRaw: [(width / 2 + x * scale) / width, y * scale / height],
    })),
  } as unknown as BodyResult;
}

function frame(width: number, height: number, rgb = [255, 0, 0]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let k = 0; k < data.length; k += 4) data.set([...rgb, 255], k);
  return { width, height, data, colorSpace: 'srgb' } as ImageData;
}

test('body ratios are invariant to frame aspect and distance from the camera', () => {
  const portrait = bodyProportions(body(600, 1000));
  assert.ok(portrait);
  assert.equal(portrait.shoulderTorso, 0.8);
  assert.equal(portrait.hipShoulder, 0.75);
  assert.deepEqual(bodyProportions(body(1000, 600)), portrait);
  assert.deepEqual(bodyProportions(body(1000, 600, 0.5)), portrait);
});

test('limb and hair regions preserve physical shape between portrait and landscape frames', () => {
  const a = outfitRegions(body(600, 1000), 0.4, 600 / 1000);
  const b = outfitRegions(body(1000, 600), 0.4, 1000 / 600);
  for (const region of ['top', 'thighs', 'shins', 'hair'] as const) {
    assert.ok(a[region]);
    assert.ok(b[region]);
    a[region]!.forEach((quad, i) => quad.forEach(([x, y], j) => {
      const [otherX, otherY] = b[region]![i][j];
      assert.ok(Math.abs((x * 600 - 300) - (otherX * 1000 - 500)) < 1e-8, region);
      assert.ok(Math.abs(y * 1000 - otherY * 600) < 1e-8, region);
    }));
  }
});

test('a visible outfit yields a normalized color signature that matches itself', () => {
  const sig = outfitSignature(frame(600, 1000), body());
  assert.ok(sig);
  assert.ok(Math.abs(sig.top.reduce((sum, v) => sum + v, 0) - 1) < 0.001);
  assert.ok(profileOutfitSim(sig, { front: sig, back: sig }) > 0.999);
});

test('tiny distant clothing patches abstain instead of repeating a few pixels', () => {
  assert.equal(outfitSignature(frame(192, 320), body(192, 320, 0.025)), null);
});

test('unreliable, out-of-frame and invalid torso joints cannot provide identity evidence', () => {
  for (const fault of ['weak', 'offscreen', 'invalid'] as const) {
    const b = body();
    const shoulder = b.keypoints.find((kp) => kp.part === 'leftShoulder')!;
    if (fault === 'weak') shoulder.score = 0.25;
    if (fault === 'offscreen') shoulder.positionRaw[0] = -0.1;
    if (fault === 'invalid') shoulder.positionRaw[0] = NaN;
    assert.equal(outfitSignature(frame(192, 320), b), null, fault);
    assert.equal(bodyProportions(b), null, fault);
  }
});

test('crossed and collapsed torso landmarks are rejected', () => {
  for (const collapsed of [false, true]) {
    const b = body();
    const left = b.keypoints.find((kp) => kp.part === 'leftHip')!;
    const right = b.keypoints.find((kp) => kp.part === 'rightHip')!;
    if (collapsed) {
      left.position = [...right.position];
      left.positionRaw = [...right.positionRaw];
    } else {
      [left.position, right.position] = [right.position, left.position];
      [left.positionRaw, right.positionRaw] = [right.positionRaw, left.positionRaw];
    }
    assert.equal(outfitSignature(frame(192, 320), b), null);
    assert.equal(bodyProportions(b), null);
  }
});

test('invisible optional patches are omitted instead of creating zero histograms', () => {
  const b = body();
  for (const ear of b.keypoints.filter((kp) => kp.part.endsWith('Ear'))) {
    ear.position[1] = 5;
    ear.positionRaw[1] = 5 / 1000;
  }
  const sig = outfitSignature(frame(600, 1000), b);
  assert.ok(sig);
  assert.equal(sig.hair, undefined);
  assert.ok(sig.thighs);
});

test('frame sampler reads the dimensions of a frozen canvas as well as video', () => {
  const original = globalThis.document;
  const drawn: unknown[] = [];
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({
      drawImage: (source: unknown) => drawn.push(source),
      getImageData: (_x: number, _y: number, width: number, height: number) => ({ width, height }),
    }),
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => canvas } });
  try {
    const sampler = new FrameSampler();
    const still = { width: 640, height: 480 } as HTMLCanvasElement;
    const video = { videoWidth: 480, videoHeight: 640 } as HTMLVideoElement;
    assert.deepEqual(sampler.grab(still), { width: 384, height: 288 });
    assert.deepEqual(sampler.grab(video), { width: 384, height: 512 });
    assert.equal(sampler.grab({ width: 0, height: 0 } as HTMLCanvasElement), null);
    assert.deepEqual(drawn, [still, video]);
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'document');
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: original });
  }
});


test('a clearly different top or trousers caps the whole outfit match, a mild hair mismatch does not', async () => {
  const { profileOutfitMatch } = await import('../src/vision/clothing');
  const hist = (bin: number) => { const h = new Array(51).fill(0); h[bin] = 0.7; h[bin + 1] = 0.3; return h; };
  const mine = { top: hist(0), thighs: hist(24), shins: hist(24), hair: hist(48) };
  const profile = { front: mine, back: mine };
  const same = profileOutfitMatch(mine, profile);
  assert.ok(same.sim > 0.99 && same.thighs && same.coverage > 0.99, JSON.stringify(same));
  const otherTrousers = profileOutfitMatch({ ...mine, thighs: hist(8), shins: hist(8) }, profile);
  assert.ok(otherTrousers.sim <= 0.4, `different trousers: ${otherTrousers.sim}`);
  const topOnly = profileOutfitMatch({ top: hist(0) }, profile);
  assert.ok(!topOnly.thighs && topOnly.coverage < 0.5 && topOnly.sim > 0.99, JSON.stringify(topOnly));
});
