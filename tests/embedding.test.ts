import assert from 'node:assert/strict';
import test from 'node:test';
import { compactEmbedding, FACE_MODEL, FACE_SAMPLES, faceSimilarity, faceYawDeg, isCurrentFaceScan, isValidEmbedding, unitEmbedding, unitSimilarity } from '../src/vision/embedding';

test('face matching rejects missing, corrupt, and incompatible descriptors', () => {
  assert.equal(faceSimilarity([1, 0], [1, 0, 0]), 0);
  assert.equal(faceSimilarity([NaN, 0], [1, 0]), 0);
  assert.equal(faceSimilarity([0, 0], [1, 0]), 0);
  assert.equal(unitSimilarity([1, 0], [Infinity, 0]), 0);
  assert.deepEqual(unitEmbedding([Infinity]), []);
  assert.equal(isValidEmbedding(new Array(512).fill(0)), false);
  assert.equal(isValidEmbedding(new Array(511).fill(1)), false);
  assert.equal(isValidEmbedding(new Array(512).fill(1)), true);
});

test('normalization is scale invariant and compact vectors remain bounded', () => {
  assert.equal(faceSimilarity([3, 4], [6, 8]), 1);
  assert.equal(faceSimilarity([1, 0], [0, 1]), 0);
  assert.equal(faceSimilarity([1, 0], [-1, 0]), 0);
  const vector = compactEmbedding([1, 1, 1]);
  assert.equal(unitSimilarity(vector, vector), 1);
});

test('faces with missing or invalid yaw are not treated as frontal faces', () => {
  assert.equal(faceYawDeg({}), Infinity);
  assert.equal(faceYawDeg({ rotation: { angle: { yaw: NaN } } }), Infinity);
  assert.equal(faceYawDeg({ rotation: { angle: { yaw: -Math.PI / 4 } } }), 45);
});

test('a stored scan stands in for a face scan only when complete, current, and intact', () => {
  const sample = new Array(512).fill(1);
  const full = new Array(FACE_SAMPLES).fill(sample);
  assert.equal(isCurrentFaceScan({ faceModel: FACE_MODEL, face: full }), true);
  assert.equal(isCurrentFaceScan(null), false);
  assert.equal(isCurrentFaceScan(undefined), false);
  assert.equal(isCurrentFaceScan({ faceModel: 'facer-es', face: full }), false);
  assert.equal(isCurrentFaceScan({ faceModel: FACE_MODEL, face: full.slice(1) }), false);
  assert.equal(isCurrentFaceScan({ faceModel: FACE_MODEL, face: [...full.slice(1), new Array(512).fill(0)] }), false);
  assert.equal(isCurrentFaceScan({ faceModel: FACE_MODEL, face: 'corrupt' }), false);
});
