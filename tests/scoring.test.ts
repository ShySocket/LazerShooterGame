import test from 'node:test';
import assert from 'node:assert/strict';
import { assignIdentities, bodyEvidence, combineEvidence, faceEvidence, resolveHit, topBelief, updateBelief, updateFaceMean } from '../src/vision/scoring';
import { Tracker } from '../src/vision/tracker';
import { BODY_MODEL, UNKNOWN_ID, type Profile } from '../src/types';
import { FACE_CALIB, unitSimilarity } from '../src/vision/embedding';

const eligible = new Set(['alice', 'bob']);
const track = (belief: Record<string, number> = {}) => {
  const t = new Tracker().update([{ box: [0.3, 0.2, 0.3, 0.6] }], 100)[0];
  t.belief = belief;
  t.lastEvidenceAt = 100;
  return t;
};

test('a duplicate identity cannot promote its runner-up into a hit', () => {
  const a = track({ alice: 0.95, bob: 0.03, [UNKNOWN_ID]: 0.02 });
  const b = track({ alice: 0.72, bob: 0.65, [UNKNOWN_ID]: 0.02 });
  assignIdentities([a, b], eligible);
  assert.equal(resolveHit(a, eligible, 0.5, 0.2, 150)?.id, 'alice');
  assert.equal(resolveHit(b, eligible, 0.5, 0.2, 150), null);
  assert.equal(topBelief(b)?.id, 'alice');
  assert.ok(Math.abs(topBelief(b)!.margin - 0.07) < 1e-9);
});

test('claiming another friend never removes them from the confidence margin', () => {
  const a = track({ alice: 0.75, bob: 0.7, [UNKNOWN_ID]: 0.05 });
  const b = track({ alice: 0.05, bob: 0.99, [UNKNOWN_ID]: 0.01 });
  assignIdentities([a, b], eligible);
  assert.equal(resolveHit(a, eligible, 0.5, 0.2, 150), null);
  assert.equal(resolveHit(b, eligible, 0.5, 0.2, 150)?.id, 'bob');
});

test('near equal duplicate claims block both people regardless of detection order', () => {
  for (const reverse of [false, true]) {
    const tracks = [track({ alice: 0.9, [UNKNOWN_ID]: 0.1 }), track({ alice: 0.88, [UNKNOWN_ID]: 0.1 })];
    assignIdentities(reverse ? tracks.reverse() : tracks, eligible);
    assert.ok(tracks.every((t) => resolveHit(t, eligible, 0.5, 0.2, 150) === null));
  }
});

test('strangers, the shooter and eliminated players cannot resolve as another live player', () => {
  for (const decoy of ['me', 'out', UNKNOWN_ID]) {
    const t = track({ [decoy]: 0.95, alice: 0.7 });
    assignIdentities([t], new Set([...eligible, 'me', 'out']));
    assert.equal(resolveHit(t, eligible, 0.5, 0.2, 150), null);
  }
});

test('identity evidence expires even while the body remains visible', () => {
  const t = track({ alice: 0.95, [UNKNOWN_ID]: 0.01 });
  assert.equal(resolveHit(t, eligible, 0.5, 0.2, 1601), null);
  assert.equal(resolveHit(t, eligible, 0.5, 0.2, 99), null);
  updateBelief(t, { alice: 1, [UNKNOWN_ID]: 0 }, 0.35, 1700);
  assert.equal(resolveHit(t, eligible, 0.5, 0.2, 1750)?.id, 'alice');
});

test('a discontinuous face resets the old person instead of lending them confidence', () => {
  const t = track({ alice: 0.95, bob: 0.01 });
  t.faceMean = [1, 0];
  t.faceSamples = 8;
  t.via = 'face';
  t.lastFaceAt = 100;
  updateFaceMean(t, [0, 1]);
  updateBelief(t, { alice: 0, bob: 1, [UNKNOWN_ID]: 0 }, 0.35, 150);
  assert.equal(t.faceSamples, 1);
  assert.equal(t.belief.alice, 0);
  assert.equal(resolveHit(t, eligible, 0.5, 0.2, 150), null);
});

test('several observations are required for a new face lock', () => {
  const t = track();
  updateBelief(t, { alice: 1, [UNKNOWN_ID]: 0 }, 0.35, 100);
  assert.equal(resolveHit(t, eligible, 0.5, 0.2, 100), null);
  updateBelief(t, { alice: 1, [UNKNOWN_ID]: 0 }, 0.35, 200);
  assert.equal(resolveHit(t, eligible, 0.5, 0.2, 200)?.id, 'alice');
});

test('body proportions alone abstain and legacy ratios are excluded', () => {
  const body = { shoulderTorso: 0.5, hipShoulder: 0.8, legTorso: 2, headShoulder: 0.3 };
  const cands = [{ id: 'alice', profile: { body, bodyModel: BODY_MODEL } as Profile }, { id: 'bob', profile: { body } as Profile }];
  const ev = bodyEvidence(body, cands);
  assert.deepEqual(ev, { alice: 1 });
  assert.equal(combineEvidence({ face: null, cloth: null, body: ev }), null);
  assert.equal(combineEvidence({ face: null, cloth: { alice: 1, [UNKNOWN_ID]: 0 }, body: null })!.alice, 0.85);
});

test('poor face matches leave the stranger candidate ahead', () => {
  const ev = faceEvidence([0, 1], [{ id: 'alice', profile: { face: [[1, 0]] } as Profile }], unitSimilarity, FACE_CALIB);
  assert.equal(ev.alice, 0);
  assert.equal(ev[UNKNOWN_ID], 1);
});
