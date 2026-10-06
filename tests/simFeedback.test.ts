import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, simulate } from './sim/engine';
import { exportFeedback, poisonLabel } from './sim/feedbackExport';
import { Rng } from './sim/rng';
import { agreement, collectSamples, evaluate } from '../src/feedback/replay';
import { SAMPLE_VERSION } from '../src/feedback/sample';

const scenario = (name: string) => SCENARIOS.find((s) => s.name === name)!;

test('recording feedback does not change a simulated round', async () => {
  for (const name of ['duel-close', 'crossing']) {
    const plain = await simulate(scenario(name), { seed: 3 });
    const recorded = await simulate(scenario(name), { seed: 3, feedback: { code: 'SIMA', startAt: 1_700_000_000_000, samples: [] } });
    assert.deepEqual(recorded.counts, plain.counts, name);
    assert.equal(recorded.wrongLockFrames, plain.wrongLockFrames, name);
  }
});

test('a simulated export is a /feedback node of labelled v3 samples the replay agrees with', async () => {
  const data = await exportFeedback({ seeds: [1], filter: ['duel-close', 'crossing', 'lookalike-stranger'] });
  const keys = Object.keys(data.rounds);
  assert.ok(keys.length >= 3);
  for (const k of keys) {
    assert.match(k, /^[A-Z]{4}-[0-9]{9,16}$/, 'round key passes the database rule');
    assert.ok(Object.keys(data.rounds[k].profiles).every((p) => /^p\d+$/.test(p)), 'profiles are anonymised');
  }
  const samples = collectSamples({ feedback: data });
  assert.ok(samples.length > 30);
  assert.ok(samples.every((s) => s.v === SAMPLE_VERSION && s.label && s.round.key && s.frames.length > 0));
  assert.ok(samples.some((s) => s.label!.kind === 'player') && samples.some((s) => s.shot.outcome !== 'hit'));
  // Honest labels: the game never hits the wrong person in these scenarios, and the replay mirrors it.
  assert.equal(evaluate(samples, {}, (s) => s.shot.resolvedTo).wrong, 0);
  assert.equal(evaluate(samples).wrong, 0);
  assert.ok(agreement(samples) > 0.9, `agreement ${agreement(samples)}`);
});

test('poisoned labels turn into replayed wrong hits and misses', async () => {
  const clean = collectSamples(await exportFeedback({ seeds: [1], filter: ['duel-close'] }));
  const poisoned = collectSamples(await exportFeedback({ seeds: [1], filter: ['duel-close'], poison: 0.5 }));
  assert.equal(poisoned.length, clean.length);
  assert.ok(evaluate(poisoned).score > evaluate(clean).score);
  const rng = new Rng(1);
  const label = { kind: 'player' as const, target: 'p1', answeredAt: 0, reviewMs: 1 };
  for (let i = 0; i < 20; i++) assert.notDeepEqual(poisonLabel(label, ['p1', 'p2'], rng), label);
});
