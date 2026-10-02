import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, SCENARIOS, simulate, type Aggregate } from './sim/engine';

/**
 * Whole-round simulation of the shooting pipeline against a synthetic detector (tests/sim/world.ts).
 * These are the gameplay properties a real round depends on. Wrong hits are the worst outcome, so
 * they are bounded tightly everywhere; hit rates are bounded loosely enough to survive model noise.
 */
const SEEDS = [1, 2, 3];
const results = new Map<string, Aggregate>();
const run = async (name: string): Promise<Aggregate> => {
  const scenario = SCENARIOS.find((s) => s.name === name);
  if (!scenario) throw new Error('no scenario ' + name);
  if (!results.has(name)) results.set(name, await aggregate(scenario, SEEDS));
  return results.get(name)!;
};
/** Hits per shot that could have hit: the target was the visible person under the dot at the tap. */
const hitRate = (a: Aggregate) => a.correct / Math.max(1, a.possible);
const describe = (a: Aggregate) => `${a.name}: ${JSON.stringify(a)}`;

test('face-on at close range nearly every shot lands and the target keeps one track', async () => {
  const a = await run('duel-close');
  assert.ok(hitRate(a) >= 0.9, describe(a));
  assert.equal(a.wrong, 0, describe(a));
  assert.ok(a.trackChurn <= 2, describe(a));
  assert.ok(a.firstLockMs !== null && a.firstLockMs < 1500, describe(a));
});

test('a player facing away is hit through the outfit, without guessing between players', async () => {
  const a = await run('back-shot');
  assert.ok(hitRate(a) >= 0.75, describe(a));
  assert.equal(a.wrong, 0, describe(a));
});

test('at 8 m the outfit still carries most shots', async () => {
  const a = await run('range-8m');
  assert.ok(hitRate(a) >= 0.6, describe(a));
  assert.equal(a.wrong, 0, describe(a));
});

test('an approaching target locks before they are close', async () => {
  const a = await run('approach');
  assert.ok(hitRate(a) >= 0.85, describe(a));
  assert.equal(a.wrong, 0, describe(a));
});

test('crossing players never swap identities', async () => {
  const a = await run('crossing');
  assert.equal(a.wrong, 0, describe(a));
  assert.equal(a.wrongLockFrames, 0, describe(a));
  assert.ok(hitRate(a) >= 0.5, describe(a));
});

test('a crossing during a camera pan never swaps identities', async () => {
  const a = await run('pan-crossing');
  assert.equal(a.wrong, 0, describe(a));
  assert.equal(a.wrongLockFrames, 0, describe(a));
  // Measured 55% over 100 seeds on 2026-09-14 (84% without the pan, 3.2 track ids per run against
  // 1.5): the pan costs continuity, not safety. The bound is loose on purpose; the continuity work
  // in the tracking plan is measured against this scenario.
  assert.ok(hitRate(a) >= 0.35, describe(a));
});

test('aiming at the visible sliver of a half-hidden player never hits or locks the player in front', async () => {
  // 1000 seeds on 2026-10-01: crossing-sliver 0 wrong, 0 wrong-lock frames, 88% of shots land;
  // pan-crossing-far-sliver 24 wrong hits before the burst rule for a target with somebody maybe
  // hidden behind them, none after, 70% land.
  for (const name of ['crossing-sliver', 'pan-crossing-far-sliver']) {
    const a = await run(name);
    assert.equal(a.wrong, 0, describe(a));
    assert.equal(a.wrongLockFrames, 0, describe(a));
    assert.ok(hitRate(a) >= 0.4, describe(a));
  }
});

test('same-hue tops of a different shade are still told apart from behind', async () => {
  const a = await run('lookalike-tops');
  assert.equal(a.wrong, 0, describe(a));
  assert.ok(hitRate(a) >= 0.5, describe(a));
});

test('identical tops from behind refuse rather than guess', async () => {
  const a = await run('identical-tops');
  assert.equal(a.wrong, 0, describe(a));
  assert.equal(a.wrongLockFrames, 0, describe(a));
});

test('strangers and mirrors are never hit, and never wear a player\'s name even hedged', async () => {
  for (const name of ['stranger', 'mirror']) {
    const a = await run(name);
    assert.equal(a.correct + a.wrong, 0, describe(a));
    assert.equal(a.wrongLockFrames, 0, describe(a));
    // Measured 0 over 100 seeds (2026-09-14): the real player's track claims the id, so a stranger's
    // partial face match never reaches the label. A nonzero here is the first sign of a wrong lock.
    assert.equal(a.maybeOnNonPlayer, 0, describe(a));
  }
});

test('a phone that needs 400 ms per frame still fires and hits', async () => {
  const a = await run('slow-phone');
  assert.equal(a.stale, 0, describe(a));
  assert.ok(hitRate(a) >= 0.85, describe(a));
  assert.equal(a.wrong, 0, describe(a));
});

test('a pose model dropping a quarter of frames does not lose the target', async () => {
  const a = await run('flaky-pose');
  assert.ok(hitRate(a) >= 0.8, describe(a));
  assert.equal(a.wrong, 0, describe(a));
  assert.ok(a.trackChurn <= 4, describe(a));
});

test('dim light lowers confidence, not correctness', async () => {
  const a = await run('dim-light');
  assert.ok(hitRate(a) >= 0.8, describe(a));
  assert.equal(a.wrong, 0, describe(a));
});

test('a crossing with both players facing away never swaps their identities', async () => {
  const a = await run('crossing-backs');
  assert.equal(a.wrong, 0, describe(a));
  assert.equal(a.wrongLockFrames, 0, describe(a));
  assert.ok(hitRate(a) >= 0.75, describe(a));
});

test('a player walking in front of the target does not become the target', async () => {
  const a = await run('occlusion');
  assert.equal(a.wrong, 0, describe(a));
  assert.equal(a.wrongLockFrames, 0, describe(a));
  // 1000 seeds: 96.3% before 2026-10-01.8, 96.0% after. These three seeds sat at 26 of 32 and lost
  // one burst to frames whose pose had no nose while a partner entry from 3 s earlier still held, so
  // the face could not be shown to be the body's own (tracker.ts faceOnOwnHead).
  assert.ok(hitRate(a) >= 0.75, describe(a));
});

test('a target who turns their back and then faces the shooter again stays hittable throughout', async () => {
  const a = await run('turn-around');
  assert.equal(a.wrong, 0, describe(a));
  assert.ok(hitRate(a) >= 0.85, describe(a));
  assert.ok(a.trackChurn <= 2, describe(a));
});

test('a phone with occasional slow frames still fires and hits instead of refusing shots as stale', async () => {
  const a = await run('hiccups');
  // About 1.4% of shots land on a slow frame (100 seeds: 29-32 of 2200); 2 in these 3 seeds' 67 is noise.
  assert.ok(a.stale <= 2, describe(a));
  assert.ok(hitRate(a) >= 0.85, describe(a));
  assert.equal(a.wrong, 0, describe(a));
});

test('players with look-alike faces are never confused with each other', async () => {
  const a = await run('lookalike-faces');
  assert.equal(a.wrong, 0, describe(a));
  assert.equal(a.wrongLockFrames, 0, describe(a));
});

/**
 * Seeds that once produced a wrong hit or a wrong lock in a 100-seed sweep (2026-09-13 review). The
 * occlusion ones were instant hits from a frame whose geometry predated the nearer player moving out
 * from under the dot; the stranger ones were single false player-lock frames. crossing-lookalike-faces
 * 63 (2026-10-01): her track hopped onto his body during the crossing with no jump to notice, and a
 * burst opened on her settled on him 1.1 s later (pipeline.ts outfitReversals and transitionAt).
 */
const REGRESSION_SEEDS: [string, number][] = [
  ['occlusion', 60],
  ['stranger', 23],
  ['occlusion', 39],
  ['stranger', 45],
  ['stranger', 61],
  // 2026-10-01: Bob hidden behind Alice for 2.4 s during a pan; a frame found only his body, her track
  // took it and showed LOCK alice with the dot on him (tracker.ts Track.partners, HIDDEN_PARTNER_MS).
  ['pan-crossing-far', 85],
  ['crossing-lookalike-faces', 63],
  // 2026-10-01, seeds beyond the 100-seed gate: a track slid onto the body of somebody hidden behind
  // it with nothing geometric to notice, and carried the identity across. 716: Bob vanished beside
  // Alice before their boxes reached the crossing overlap, so he was forgotten once his lost track
  // retired (tracker.ts, a lost neighbour is a partner too); his look-alike face then read as her
  // on her own earlier outfit read. 643: the same with a look-alike stranger. 748 and 740: the
  // running face mean confirmed the believed player on a frame whose own face named nobody
  // (pipeline.ts, while a partner may be hidden each frame stands on its own reads). 690: a body
  // without head landmarks took the face of the person behind it and its hit region stretched over
  // her (tracker.ts, a face goes with a headless body only above and between its shoulders).
  // 2146: the detector skipped Alice during a pan; her last box ended short of the dot but she had
  // moved over it, in front of Bob (pipeline.ts coveredByOther, where the motion carried her).
  ['crossing-lookalike-faces', 716],
  ['crossing-lookalike-stranger', 643],
  ['pan-crossing', 748],
  ['pan-crossing-far', 740],
  ['occlusion', 690],
  ['pan-crossing-far', 2146],
  // 2026-10-01, aiming at the sliver of the farther player beside the nearer one: a tap on Bob's sliver
  // nominated Alice's track from its motion; the next frame saw her with the dot off her torso, on
  // him; the burst waited until he had gone behind her and the dot with him onto her, and landed on
  // her 670 ms after the tap (pipeline.ts, with somebody maybe hidden behind the target, a frame
  // showing the dot off their torso ends the burst).
  ['pan-crossing-far-sliver', 28],
  // The same scenario with the clothing sampler reading whoever fills the torso (world.ts frontPixels):
  // a frame found only Bob's body, the sliver beside Alice, and her track took it; the crop over his
  // body found her face beside his head, faceOwner gave it to him, his torso read her clothes, and the
  // two together showed LOCK alice with the dot on him (tracker.ts faceOnOwnHead).
  ['pan-crossing-far-sliver', 844],
];
for (const [name, seed] of REGRESSION_SEEDS) {
  test(`regression: ${name} seed ${seed} has no wrong hit and no wrong lock`, async () => {
    const scenario = SCENARIOS.find((s) => s.name === name)!;
    const r = await simulate(scenario, { seed });
    assert.equal(r.counts.wrong, 0, r.wrongTraces.map((t) => t.join('\n')).join('\n\n'));
    assert.equal(r.wrongLockFrames, 0, r.wrongTraces.map((t) => t.join('\n')).join('\n\n'));
  });
}

test('ambiguous verdicts are counted: zero where people stand apart, a small share where they overlap', async () => {
  // Measured 2026-09-14 at 3 seeds: 0 everywhere except occlusion 4/45, range-8m 3/66, back-shot,
  // turn-around and lookalike-faces 1 each. A growing count here is where a wrong hit would hide.
  for (const name of ['duel-close', 'stranger', 'mirror', 'same-shirt-stranger', 'identical-tops', 'slow-phone']) {
    const a = await run(name);
    assert.equal(a.ambiguous, 0, describe(a));
  }
  // Crossings can land a hit within jitter of the other player's edge; that is ambiguous by the
  // oracle, never wrong. dim-light: 1 of 66 shots at the torso edge after the GhostNet switch
  // (2026-09-26), no wrong hits over 100 seeds.
  for (const [name, ceiling] of [['occlusion', 0.2], ['range-8m', 0.12], ['crossing', 0.08], ['pan-crossing', 0.08], ['back-shot', 0.08], ['turn-around', 0.08], ['lookalike-faces', 0.08], ['dim-light', 0.03]] as const) {
    const a = await run(name);
    assert.ok(a.ambiguous / Math.max(1, a.shots) <= ceiling, describe(a));
  }
});

test('a stranger whose face reads like a player\'s but wears other clothes is never hit', async () => {
  // Real faces of different people reach 0.66 centred similarity (npm run realcheck, 2026-09-26).
  // Before the outfit veto: 34 wrong hits and 53 wrong-lock frames over 30 seeds.
  const a = await run('lookalike-stranger');
  assert.equal(a.correct + a.wrong, 0, describe(a));
  assert.equal(a.wrongLockFrames, 0, describe(a));
  assert.equal(a.maybeOnNonPlayer, 0, describe(a));
});

test('a face-only target (no outfit on file) is never confused with a look-alike stranger, and still takes clear hits', async () => {
  // Review of 2026-10-01: without an outfit the veto cannot protect a face-only target; FACE_ONLY_CALIB
  // took the look-alike from 35 wrong hits in 30 seeds to none over 100.
  const a = await run('lookalike-stranger-faceonly');
  assert.equal(a.correct + a.wrong, 0, describe(a));
  assert.equal(a.wrongLockFrames, 0, describe(a));
  const d = await run('duel-faceonly');
  assert.equal(d.wrong, 0, describe(d));
});

test('identity does not ride across a crossing, and a wrongly vetoed player costs refusals, never a wrong hit', async () => {
  // Review of 2026-10-01: markUncertain resets the face mean and vetoes, and reacquired() needs fresh
  // evidence; crossing look-alikes (faces 0.66 alike) and a player whose outfit is misread a quarter
  // of the time measured 0 wrong hits and 0 wrong-lock frames over 100 seeds.
  for (const name of ['crossing-lookalike-faces', 'vetoed-player', 'lookalike-stranger-slow']) {
    const a = await run(name);
    assert.equal(a.wrong, 0, describe(a));
    assert.equal(a.wrongLockFrames, 0, describe(a));
  }
  // Fairness: a misread outfit costs refusals, never the player for good (100 seeds: 77% land; 80%
  // before 2026-10-01, when a misread veto lifted by a clean read became a reason to withhold a burst
  // that had no accepted name at the tap, since the game cannot tell it from a hop onto another body).
  assert.ok(hitRate(await run('vetoed-player')) >= 0.6, 'a wrongly vetoed player is still hit most of the time');
  const { OUTFIT_VETO, CLOTHING_AUDIT_MS } = await import('../src/vision/calibration');
  assert.ok(OUTFIT_VETO.holdMs >= 2 * CLOTHING_AUDIT_MS, 'a veto must outlast the clothing audit, or it lapses between samples');
});

test('a crowd past the detector body cap never produces a wrong hit or lock', async () => {
  // MoveNet returns six bodies at most; with seven people in view who is left out changes frame to
  // frame (world.ts detect). 100 seeds on 2026-10-01: 0 wrong, 0 wrong-lock frames, 40% of shots land.
  // crowd-seven-slow (400 ms per frame, decided more than 400 ms after capture), 100 seeds: 0 wrong,
  // 0 wrong-lock frames, 39% land; bursts settled in crowded frames hit 15 of 45 with the crowd rule's
  // read aged in capture time, 1 of 31 when it was aged against the decision clock.
  for (const name of ['crowd-seven', 'crowd-seven-slow']) {
    const a = await run(name);
    assert.equal(a.wrong, 0, describe(a));
    assert.equal(a.wrongLockFrames, 0, describe(a));
    assert.ok(a.possible > 0, 'the target is under the dot sometimes');
  }
});

test('a stranger wearing the same top as a player is never hit, and never wears their name even hedged', async () => {
  const a = await run('same-shirt-stranger');
  assert.equal(a.correct + a.wrong, 0, describe(a));
  assert.equal(a.wrongLockFrames, 0, describe(a));
  // Measured 0 over 100 seeds (2026-09-14) with the stranger's belief peaking at 0.40 on 13 frames.
  assert.equal(a.maybeOnNonPlayer, 0, describe(a));
});
