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


test('mean-centring removes the direction every face shares', async () => {
  const { FACE_MEAN } = await import('../src/vision/faceMean');
  const { centredSimilarity, unitSimilarity, unitEmbedding, centreUnit } = await import('../src/vision/embedding');
  assert.equal(centredSimilarity(FACE_MEAN, FACE_MEAN), 0, 'the mean itself has no centred direction');
  // Two faces the way this model produces them: the shared direction (the mean, length 0.43 for
  // GhostNet) plus an independent part orthogonal to it, so each is a unit vector.
  const meanDot = FACE_MEAN.reduce((a, v) => a + v * v, 0);
  const own = Math.sqrt(1 - meanDot);
  const face = (s: number) => {
    const raw = FACE_MEAN.map((_, i) => Math.sin(i * s));
    const proj = raw.reduce((a, v, i) => a + v * FACE_MEAN[i], 0) / meanDot;
    const perp = unitEmbedding(raw.map((v, i) => v - proj * FACE_MEAN[i]));
    return unitEmbedding(FACE_MEAN.map((v, i) => v + own * perp[i]));
  };
  // Raw cosine of two such strangers is the mean's squared length plus whatever their own parts share.
  assert.ok(unitSimilarity(face(0.3), face(0.7)) > meanDot * 0.8, 'raw cosine says two strangers are alike');
  assert.ok(centredSimilarity(face(0.3), face(0.7)) < 0.2, 'centred cosine says they are not');
  const short = [0.6, 0.8];
  assert.equal(centreUnit(short), short, 'a vector of another length passes through untouched');
});
