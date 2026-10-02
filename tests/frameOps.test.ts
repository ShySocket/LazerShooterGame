import test from 'node:test';
import assert from 'node:assert/strict';
import { reembedFaces, type FoundFace } from '../src/vision/reembed';
import { FACE_EMBEDDING_SIZE } from '../src/vision/embedding';
import type { NBox } from '../src/vision/geometry';

const spike = (k: number) => Array.from({ length: FACE_EMBEDDING_SIZE }, (_, i) => (i === k ? 1 : 0.01));
const found = (box: NBox, embedding: number[], score = 0.9): FoundFace => ({ box, face: { embedding, score } });
const FACE: NBox = [0.45, 0.25, 0.05, 0.09];
const REGION: NBox = [0.4, 0.1, 0.15, 0.5];

test('a face found by a head crop is embedded again from a crop of the template geometry around it', async () => {
  const regions: NBox[] = [];
  const crop = async (r: NBox) => (regions.push(r), [found([0.452, 0.251, 0.05, 0.09], spike(2))]);
  const out = await reembedFaces([found(FACE, spike(1))], crop, (b) => (b === FACE ? REGION : [0, 0, 1, 1]));
  assert.deepEqual(regions, [REGION], 'one re-crop, of the geometry the templates were measured on, around the face found');
  assert.equal(out.length, 1);
  assert.ok(out[0].face.embedding![2] > 0.9, 'the embedding is the re-crop\'s, not the head crop\'s');
});

test('a face the re-crop does not find again near the same spot is dropped, and an unusable find is not re-cropped', async () => {
  let calls = 0;
  const far = async () => (calls++, [found([0.7, 0.25, 0.05, 0.09], spike(2))]);
  assert.deepEqual(await reembedFaces([found(FACE, spike(1))], far, () => REGION), [], 'never embedded at the head crop\'s scale');
  assert.equal(calls, 1);
  calls = 0;
  assert.deepEqual(await reembedFaces([found(FACE, spike(1), 0.5), found(FACE, [1, 2, 3])], far, () => REGION), []);
  assert.equal(calls, 0, 'a low-score or invalid find costs no extra crop');
});
