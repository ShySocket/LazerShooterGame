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

test('at the detector body cap a hit needs this body\'s own fresh face read naming the same player', () => {
  const t = track({ alice: 0.95, [UNKNOWN_ID]: 0.01 });
  assert.equal(resolveHit(t, eligible, 0.5, 0.2, 150)?.id, 'alice', 'an uncrowded frame resolves on the belief');
  t.crowded = true;
  assert.equal(resolveHit(t, eligible, 0.5, 0.2, 150), null, 'a crowded frame refuses a carried belief');
  // Reads come from the frame the body was last seen in (pipeline.ts applyFace stamps the capture time).
  t.lastSeen = 140;
  t.lastRead = { at: 140, id: 'bob', margin: 0.5 };
  assert.equal(resolveHit(t, eligible, 0.5, 0.2, 150), null, 'a fresh read naming somebody else refuses');
  t.lastRead = { at: 140, id: 'alice', margin: 0.1 };
  assert.equal(resolveHit(t, eligible, 0.5, 0.2, 150), null, 'a fresh read without the margin refuses');
  t.lastRead = { at: 140, id: 'alice', margin: 0.5 };
  assert.equal(resolveHit(t, eligible, 0.5, 0.2, 150)?.id, 'alice', 'a fresh clear read on this body resolves');
  // Freshness is capture time against capture time: a slow phone decides 450 ms after the frame the
  // read came from, and that read is still this frame's own.
  assert.equal(resolveHit(t, eligible, 0.5, 0.2, 140 + 450)?.id, 'alice', 'a slow decision on the read\'s own frame resolves');
  t.lastSeen = 140 + 401;
  assert.equal(resolveHit(t, eligible, 0.5, 0.2, 140 + 450), null, 'a read from a frame more than OVERLAP_FACE_FRESH_MS before the body\'s latest frame refuses');
  t.lastSeen = 140 + 400;
  assert.equal(resolveHit(t, eligible, 0.5, 0.2, 140 + 450)?.id, 'alice', 'a read from a frame within OVERLAP_FACE_FRESH_MS of it resolves');
  t.lastSeen = 130;
  assert.equal(resolveHit(t, eligible, 0.5, 0.2, 150), null, 'a read stamped after the body\'s latest frame is not this body\'s');
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
  assert.ok(outfitVetoed(t, 'alice', 1000 + 60_000), 'without a readable sample since, time alone never lifts it');
  // A readable sample in between (neither a contradiction nor a clear match) lets it lapse after the hold.
  // Every region about half like hers: no region contradicts (top and thighs >= 0.4), overall ~0.47.
  const half = (bin: number, other: number) => { const h = new Array(51).fill(0); h[bin] = 0.5; h[other] = 0.5; return h; };
  const between = { top: half(0, 30), thighs: half(24, 40), shins: half(24, 40), hair: half(48, 10) };
  const eased = track({ alice: 0.9 });
  updateOutfitVeto(eased, { top: hist(12), thighs: hist(36), shins: hist(24), hair: hist(48) }, cands, 1000);
  updateOutfitVeto(eased, between, cands, 1500);
  assert.ok(outfitVetoed(eased, 'alice', 1500 + 3000), 'still within the hold after the easing sample');
  assert.ok(!outfitVetoed(eased, 'alice', 1500 + 4001), 'eased and past the hold');
  // A new contradiction re-arms it; a matching shirt alone cannot lift a veto the trousers caused.
  updateOutfitVeto(eased, { top: hist(12), thighs: hist(36), shins: hist(24), hair: hist(48) }, cands, 6000);
  assert.ok(outfitVetoed(eased, 'alice', 6000 + 60_000), 're-armed: time alone never lifts it again');
  updateOutfitVeto(eased, { top: hist(0) }, cands, 70_000);
  assert.ok(outfitVetoed(eased, 'alice', 70_000), 'her shirt alone (coverage 0.45) does not clear it');
  // Her own shirt seen alone is no contradiction.
  const u = track({ alice: 0.9 });
  updateOutfitVeto(u, { top: hist(0) }, cands, 1000);
  assert.ok(!outfitVetoed(u, 'alice', 1000));
  updateOutfitVeto(t, full, cands, 2000);
  assert.ok(!outfitVetoed(t, 'alice', 2000), 'a matching outfit lifts it');
});

test('an outfit backs a face only when it is that player\'s, not a rival suit it merely resembles (realcheck antony-blinken/08, 2026-10-02)', async () => {
  const { outfitSupports, outfitVetoed, updateOutfitVeto } = await import('../src/vision/scoring');
  // Two dark suits sharing two thirds of every region: each matches the other's scan at 0.65, above
  // OUTFIT_VETO.clearSim, as P1's and P2's did on the bench (0.61 to 0.69, own 0.91 to 0.95).
  const suit = (own: number) => {
    const region = (shared: number) => { const h = new Array(51).fill(0); h[shared] = 0.65; h[shared + own] = 0.35; return h; };
    return { top: region(0), thighs: region(4), shins: region(4), hair: region(8) };
  };
  const p1 = suit(20);
  const p2 = suit(30);
  const profile = (o: ReturnType<typeof suit>) => ({ outfit: { front: o, back: o } }) as Profile;
  const cands = [{ id: 'p1', profile: profile(p1) }, { id: 'p2', profile: profile(p2) }];
  const onP2 = track();
  updateOutfitVeto(onP2, p2, cands, 1000);
  assert.ok(outfitSupports(onP2, 'p2', 1000), 'his own suit backs his face');
  assert.ok(!outfitSupports(onP2, 'p1', 1000), 'a suit that only resembles P1\'s, and is P2\'s, backs nobody else\'s face');
  assert.ok(!outfitVetoed(onP2, 'p1', 1000), 'nor does it rule P1 out: it does not contradict him');
  assert.deepEqual(onP2.outfitAgrees?.ids, ['p2'], 'on a hiding body\'s frame it agrees with its owner only');
  // Twins in one outfit: nothing tells them apart by clothes, so both stay backed and the face must.
  const twins = [{ id: 'p1', profile: profile(p2) }, { id: 'p2', profile: profile(p2) }];
  const onTwin = track();
  updateOutfitVeto(onTwin, p2, twins, 1000);
  assert.ok(outfitSupports(onTwin, 'p1', 1000) && outfitSupports(onTwin, 'p2', 1000));
  // A veto on P1 is still lifted by a sample that clearly matches him, even if P2's scan matches it better.
  const vetoed = track();
  vetoed.outfitVeto = { p1: { at: 900, eased: false } };
  updateOutfitVeto(vetoed, p2, cands, 1000);
  assert.ok(!outfitVetoed(vetoed, 'p1', 1000), 'a clear match is no contradiction');
  // One sample within the noise of the two suits (his own read at 0.86, P1's at 0.78: within
  // OUTFIT_RIVAL_LEAD) backs both on a body nothing else is known about...
  const blur = (shared: number) => { const h = new Array(51).fill(0); h[shared] = 0.65; h[shared + 30] = 0.21; h[shared + 20] = 0.13; h[50] = 0.01; return h; };
  const near = { top: blur(0), thighs: blur(4), shins: blur(4), hair: blur(8) };
  const fresh = track();
  updateOutfitVeto(fresh, near, cands, 1000);
  assert.ok(outfitSupports(fresh, 'p1', 1000) && outfitSupports(fresh, 'p2', 1000), 'one sample this close cannot tell the suits apart');
  // ...but not once this body's samples have shown whose suit it is (dark-suits seeds 167 and 207: one
  // such sample backed the other player for 3 s while every other read said otherwise)...
  const known = track();
  for (let i = 0; i < 3; i++) updateOutfitVeto(known, p2, cands, 1000 + i * 200);
  updateOutfitVeto(known, near, cands, 1600);
  assert.ok(!outfitSupports(known, 'p1', 1600) && outfitSupports(known, 'p2', 1600), 'his samples so far are his suit, not P1\'s');
  // ...and the next sample that is plainly his own takes back what that one sample gave P1.
  updateOutfitVeto(fresh, p2, cands, 1200);
  assert.ok(!outfitSupports(fresh, 'p1', 1200) && outfitSupports(fresh, 'p2', 1200), 'the freshest read of his suit decides');
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

test('a wrongly vetoed real player still claims her name, so a look-alike elsewhere cannot take it unopposed', async () => {
  // Review of 2026-10-01: letting a vetoed name skip its claim handed it to the look-alike (318 wrong
  // hits over 40 seeds in the reviewer's sim); the one-body-per-player conflict must stand.
  const { updateOutfitVeto } = await import('../src/vision/scoring');
  const hist = (bin: number) => { const h = new Array(51).fill(0); h[bin] = 0.7; h[bin + 1] = 0.3; return h; };
  const full = { top: hist(0), thighs: hist(24), shins: hist(24), hair: hist(48) };
  const realAlice = track({ alice: 0.95, [UNKNOWN_ID]: 0.05 });
  const lookalike = track({ alice: 0.8, [UNKNOWN_ID]: 0.2 });
  updateOutfitVeto(realAlice, { top: hist(12), thighs: hist(36), shins: hist(24), hair: hist(48) }, [{ id: 'alice', profile: { outfit: { front: full, back: full } } as Profile }], 1000);
  assignIdentities([realAlice, lookalike], eligible);
  assert.equal(lookalike.identityConflict, true, 'the weaker claim on her name is a conflict');
  assert.equal(resolveHit(lookalike, eligible, 0.5, 0.2, 1000), null);
  assert.equal(resolveHit(realAlice, eligible, 0.5, 0.2, 1000), null, 'the misread veto only costs her a refusal');
});

test('explainHit names the rule behind every refusal, in resolveHit\'s order, and agrees with resolveHit', async () => {
  const { explainHit } = await import('../src/vision/scoring');
  const eligible2 = new Set(['alice', 'bob']);
  const why = (t: ReturnType<typeof track>, now = 150) => {
    const e = explainHit(t, eligible2, 0.5, 0.2, now);
    assert.deepEqual(e.hit, resolveHit(t, eligible2, 0.5, 0.2, now), 'explainHit.hit is resolveHit');
    return e.refusal;
  };
  // A clear, backed belief is a hit.
  const clear = track({ alice: 0.95, [UNKNOWN_ID]: 0.02 });
  clear.outfitSupport = { alice: 140 };
  assert.equal(why(clear), null);
  assert.equal(why(clear, 100 + 5000), 'no-evidence', 'evidence older than IDENTITY_TTL_MS');
  assert.equal(why({ ...clear, unconfirmed: true }), 'unconfirmed');
  assert.equal(why({ ...clear, unconfirmed: true, hiding: true }), 'hidden-partner');
  assert.equal(why({ ...clear, reacquireAt: 120, faceSamples: 0, clothingSince: 0 }), 'reacquiring');
  assert.equal(why({ ...clear, identityConflict: true }), 'conflict');
  assert.equal(why({ ...clear, belief: { me: 0.95, alice: 0.02 } }), 'not-a-player');
  assert.equal(why({ ...clear, outfitVeto: { alice: { at: 120, eased: false } } }), 'vetoed');
  assert.equal(why({ ...clear, belief: { alice: 0.45, [UNKNOWN_ID]: 0.1 } }), 'low-confidence', 'backed by the outfit, just not confident');
  assert.equal(why({ ...clear, outfitSupport: undefined, belief: { alice: 0.45, [UNKNOWN_ID]: 0.1 } }), 'no-outfit-backing', 'no outfit backing: the face met the strict bar');
  assert.equal(why({ ...clear, belief: { alice: 0.62, bob: 0.5 } }), 'margin');
  assert.equal(why({ ...clear, overlapping: true }), 'no-fresh-read', 'an overlap without a read of this body');
  assert.equal(why({ ...clear, crowded: true, lastSeen: 140, lastRead: { at: 140, id: 'alice', margin: 0.5 } }), null, 'a crowd with this frame\'s own clear read');
});
