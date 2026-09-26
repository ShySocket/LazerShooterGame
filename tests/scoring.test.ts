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
  // A second frame only 100 ms later is less than a frame period of new evidence: still no lock.
  updateBelief(t, { alice: 1, [UNKNOWN_ID]: 0 }, 0.35, 200);
  assert.equal(resolveHit(t, eligible, 0.5, 0.2, 200), null);
  // Two frames a full period apart are enough.
  const u = track();
  updateBelief(u, { alice: 1, [UNKNOWN_ID]: 0 }, 0.35, 100);
  updateBelief(u, { alice: 1, [UNKNOWN_ID]: 0 }, 0.35, 320);
  assert.equal(resolveHit(u, eligible, 0.5, 0.2, 320)?.id, 'alice');
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

test('a 512-d running face mean compares up to date after every update (no stale centred cache)', async () => {
  const { centredSimilarity } = await import('../src/vision/embedding');
  const { Tracker } = await import('../src/vision/tracker');
  const { updateFaceMean } = await import('../src/vision/scoring');
  const unit = (v: number[]) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
  const a = unit(Array.from({ length: 512 }, (_, i) => Math.sin(i * 0.37) + 0.3));
  const b = unit(Array.from({ length: 512 }, (_, i) => Math.cos(i * 0.11) + 0.3));
  const [track] = new Tracker().update([{ box: [0.3, 0.1, 0.2, 0.7] }], 100);
  updateFaceMean(track, a);
  for (let k = 0; k < 6; k++) {
    const mean = updateFaceMean(track, b);
    assert.equal(centredSimilarity(mean, b), centredSimilarity(mean.slice(), b));
  }
  assert.ok(centredSimilarity(track.faceMean!, b) > 0.95);
});

test('belief smoothing follows elapsed time: two frames 200 ms apart equal one frame 400 ms later', async () => {
  const { elapsedAlpha } = await import('../src/vision/scoring');
  const ev = { alice: 1, [UNKNOWN_ID]: 0 };
  const twoSteps = track({ alice: 0.2 });
  twoSteps.lastEvidenceAt = 1000;
  updateBelief(twoSteps, ev, 0.45, 1200);
  updateBelief(twoSteps, ev, 0.45, 1400);
  const oneStep = track({ alice: 0.2 });
  oneStep.lastEvidenceAt = 1000;
  updateBelief(oneStep, ev, 0.45, 1400);
  assert.ok(Math.abs(twoSteps.belief.alice - oneStep.belief.alice) < 0.02, `${twoSteps.belief.alice} vs ${oneStep.belief.alice}`);
  // Near-duplicate frames 20 ms apart barely move the belief; a first observation takes the full step.
  const dup = track({ alice: 0.2 });
  dup.lastEvidenceAt = 1000;
  updateBelief(dup, ev, 0.45, 1020);
  assert.ok(dup.belief.alice < 0.26, `20 ms step moved to ${dup.belief.alice}`);
  const first = track({});
  first.lastEvidenceAt = 0;
  updateBelief(first, ev, 0.45, 5000);
  assert.ok(Math.abs(first.belief.alice - 0.45) < 1e-9);
  // A long silence is capped, and alpha 1 stays a full replacement.
  assert.ok(elapsedAlpha(0.45, 60000) < 0.8);
  assert.equal(elapsedAlpha(1, 5), 1);
});

test('face frames closer than the spacing refine the mean but count as one sample', () => {
  const unit = (v: number[]) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
  const a = unit([1, 0.1]);
  const t = track({});
  updateFaceMean(t, a, 1000);
  updateFaceMean(t, unit([1, 0.12]), 1050);
  updateFaceMean(t, unit([1, 0.08]), 1100);
  assert.equal(t.faceSamples, 1, 'three frames within 100 ms are one sample');
  updateFaceMean(t, unit([1, 0.11]), 1200);
  updateFaceMean(t, unit([1, 0.09]), 1400);
  assert.equal(t.faceSamples, 3, 'frames 150 ms or more apart each count');
  const legacy = track({});
  updateFaceMean(legacy, a);
  updateFaceMean(legacy, unit([1, 0.12]));
  assert.equal(legacy.faceSamples, 2, 'without a clock every frame counts, as before');
});


test('clothing evidence: a top alone cannot reach the hit threshold, but does not erode an established identity', async () => {
  const { clothingEvidence } = await import('../src/vision/scoring');
  const hist = (bin: number) => { const h = new Array(51).fill(0); h[bin] = 0.7; h[bin + 1] = 0.3; return h; };
  const full = { top: hist(0), thighs: hist(24), shins: hist(24), hair: hist(48) };
  const cands = [{ id: 'alice', profile: { outfit: { front: full, back: full } } as Profile }];
  const topOnly = clothingEvidence({ top: hist(0) }, cands);
  // A shirt alone reaches about 0.55 (README): under the 0.5 + 0.2 margin against the stranger vote.
  assert.ok(topOnly.alice <= 0.56, `top alone: ${topOnly.alice}`);
  assert.ok(topOnly[UNKNOWN_ID] > topOnly.alice - 0.2, 'the stranger vote stays within the hit margin of a shirt-only match');
  const whole = clothingEvidence(full, cands);
  assert.ok(whole.alice > 0.95, `whole outfit: ${whole.alice}`);
  const kept = clothingEvidence({ top: hist(0) }, cands, { alice: 0.9 });
  assert.ok(kept.alice >= 0.9, 'partial coverage keeps an identity the face already established');
  const contradicted = clothingEvidence({ top: hist(0), thighs: hist(10) }, cands);
  assert.ok(contradicted.alice < 0.1, `matching top with different trousers: ${contradicted.alice}`);
});

test('a contradicting outfit rules a player out on that body whatever the face says, and a matching one lifts it', async () => {
  const { outfitVetoed, updateOutfitVeto } = await import('../src/vision/scoring');
  const hist = (bin: number) => { const h = new Array(51).fill(0); h[bin] = 0.7; h[bin + 1] = 0.3; return h; };
  const full = { top: hist(0), thighs: hist(24), shins: hist(24), hair: hist(48) };
  const cands = [{ id: 'alice', profile: { outfit: { front: full, back: full } } as Profile }];
  const t = track({ alice: 0.9, [UNKNOWN_ID]: 0.1 });
  updateOutfitVeto(t, { top: hist(12), thighs: hist(36), shins: hist(24), hair: hist(48) }, cands, 1000);
  assert.ok(outfitVetoed(t, 'alice', 1500));
  assert.equal(resolveHit(t, eligible, 0.5, 0.2, 1000), null, 'a face-strong belief cannot hit a body whose outfit is not theirs');
  assert.ok(!outfitVetoed(t, 'alice', 1000 + 4001), 'the veto expires');
  // Her own shirt seen alone is no contradiction.
  const u = track({ alice: 0.9 });
  updateOutfitVeto(u, { top: hist(0) }, cands, 1000);
  assert.ok(!outfitVetoed(u, 'alice', 1000));
  updateOutfitVeto(t, full, cands, 2000);
  assert.ok(!outfitVetoed(t, 'alice', 2000), 'a matching outfit lifts it');
});

test('an empty signal map is absent, not a zero vote', () => {
  const faceOnly = combineEvidence({ face: { alice: 1, [UNKNOWN_ID]: 0 }, cloth: null, body: null })!;
  const withEmptyCloth = combineEvidence({ face: { alice: 1, [UNKNOWN_ID]: 0 }, cloth: {}, body: {} })!;
  assert.equal(withEmptyCloth.alice, faceOnly.alice);
  assert.equal(combineEvidence({ face: {}, cloth: {}, body: null }), null);
});

test('a suspended identity is confirmed only by evidence that agrees with it', () => {
  const t = track({ alice: 0.9, bob: 0.05 });
  t.unconfirmed = true;
  updateBelief(t, { bob: 1, alice: 0, [UNKNOWN_ID]: 0 }, 0.45, 320);
  assert.equal(t.unconfirmed, true, 'evidence for somebody else does not confirm alice');
  assert.equal(resolveHit(t, eligible, 0.5, 0.2, 330), null);
  const u = track({ alice: 0.9, bob: 0.05 });
  u.unconfirmed = true;
  updateBelief(u, { alice: 1, bob: 0, [UNKNOWN_ID]: 0 }, 0.45, 320);
  assert.equal(u.unconfirmed, false);
  assert.equal(resolveHit(u, eligible, 0.5, 0.2, 330)?.id, 'alice');
});
