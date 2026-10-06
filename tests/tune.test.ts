import test from 'node:test';
import assert from 'node:assert/strict';
import { exportFeedback } from './sim/feedbackExport';
import { collectSamples, evaluate } from '../src/feedback/replay';
import type { ShotSample } from '../src/feedback/sample';
import { contradicts, currentParams, isHoldout, KNOBS, tune } from '../src/feedback/tune';

let cache: ShotSample[] | null = null;
/** Two seeds of every scenario, labelled from ground truth: about 1300 shots in 74 rounds. */
const clean = async () => (cache ??= collectSamples(await exportFeedback({ seeds: [1, 2] })));
const oneStep = (key: string, from: number, to: number) => {
  const k = KNOBS.find((x) => x.key === key)!;
  assert.ok(Math.abs(Math.abs(to - from) - k.step) < 1e-9, `${key} moved ${from} -> ${to}, not one step`);
  assert.ok(to >= k.min - 1e-9 && to <= k.max + 1e-9, `${key} out of bounds`);
};

test('too little data: no loosening, whatever the misses', async () => {
  const all = await clean();
  const fiveRounds = new Set([...new Set(all.map((s) => s.round.key))].slice(0, 5));
  const fewRounds = all.filter((s) => fiveRounds.has(s.round.key));
  const fewShots = all.slice(0, 60);
  for (const d of [fewRounds, fewShots]) {
    const r = tune(d);
    assert.equal(r.decision, 'none');
    assert.deepEqual(r.params, r.current);
    assert.ok(r.reasons.some((x) => /fewer than|no labelled/.test(x)), r.reasons.join('; '));
  }
});

test('poisoned labels stop every proposal', async () => {
  const r = tune(collectSamples(await exportFeedback({ seeds: [1, 2], poison: 0.25 })));
  assert.equal(r.decision, 'none');
  assert.ok(r.evidence.contradictions > 0);
  assert.ok(r.reasons.some((x) => x.startsWith('labels unreliable')), r.reasons.join('; '));
});

test('clean data at the default guards keeps the calibration when the gain is below the bar', async () => {
  const r = tune(await clean());
  assert.equal(r.evidence.current.all.wrong, 0);
  assert.equal(r.evidence.contradictions, 0);
  assert.ok(r.evidence.agreement >= 0.9);
  assert.equal(r.decision, 'none');
});

test('a proposal moves each knob at most one step, never loosens the face-only bar, and keeps zero wrong hits', async () => {
  const data = await clean();
  const r = tune(data, { guards: { minMissGain: 1, minMissGainShare: 0 } });
  assert.equal(r.decision, 'propose', r.reasons.join('; '));
  assert.ok(r.changes.length > 0);
  for (const c of r.changes) {
    oneStep(c.key, c.from, c.to);
    if (c.key === 'faceOnlyReject' || c.key === 'faceOnlyAccept') assert.ok(c.to > c.from, 'face-only bar only tightens');
  }
  assert.equal(r.evidence.candidate!.all.wrong, 0);
  assert.equal(r.evidence.candidate!.holdout.wrong, 0);
  assert.ok(r.evidence.candidate!.all.miss < r.evidence.current.all.miss);
  assert.equal(evaluate(data, r.params).wrong, 0);
  // Deterministic: the same data proposes the same thing.
  assert.deepEqual(tune(data, { guards: { minMissGain: 1, minMissGainShare: 0 } }).params, r.params);
});

test('a replayed wrong hit under the current calibration earns a tightening even below the data minimum', async () => {
  const data = await clean();
  // The four weakest correct hits relabelled "should not count": real wrong hits look like this, not confident.
  const weak = data
    .filter((s) => s.shot.resolvedTo && s.label?.kind === 'player')
    .map((s) => {
      const b = Object.values(s.shot.decisionBelief ?? {}).sort((x, y) => y - x);
      return { s, m: b[0] - (b[1] ?? 0) };
    })
    .sort((a, b) => a.m - b.m)
    .slice(0, 4)
    .map((w) => w.s);
  const relabelled = data.map((s) => (weak.includes(s) ? { ...s, label: { kind: 'none' as const, answeredAt: 0, reviewMs: 1 } } : s));
  assert.ok(weak.every((s) => !contradicts({ ...s, label: { kind: 'none', answeredAt: 0, reviewMs: 1 } })));
  const r = tune(relabelled, { guards: { minSamples: 1e9 } });
  assert.ok(r.evidence.current.all.wrong > 0);
  assert.equal(r.decision, 'tighten', r.reasons.join('; '));
  assert.ok(r.evidence.candidate!.all.wrong < r.evidence.current.all.wrong);
  for (const c of r.changes) {
    oneStep(c.key, c.from, c.to);
    const k = KNOBS.find((x) => x.key === c.key)!;
    assert.equal(Math.sign(c.to - c.from), k.tighten, `${c.key} moved the loosening way`);
  }
  // The cost cap: a tightening that would cost more misses than allowed goes to a person instead.
  const capped = tune(relabelled, { guards: { maxTightenCostShare: 0 } });
  assert.equal(capped.decision, 'none');
});

test('the hold-out split is by round and stable', () => {
  assert.equal(isHoldout('ABCD-1700000000000', 0.25), isHoldout('ABCD-1700000000000', 0.25));
  const keys = Array.from({ length: 400 }, (_, i) => `R${i}-1700000000000`);
  const share = keys.filter((k) => isHoldout(k, 0.25)).length / keys.length;
  assert.ok(share > 0.15 && share < 0.35, `share ${share}`);
  assert.deepEqual(Object.keys(currentParams()).sort(), KNOBS.map((k) => k.key).sort());
});
