import test from 'node:test';
import assert from 'node:assert/strict';
import { summarise, triage } from '../src/feedback/triage';
import type { ShotSample } from '../src/feedback/sample';

const shot = (outcome: string, resolvedTo: string | null, label: ShotSample['label'], trackId: number | null = 1): ShotSample =>
  ({ round: { key: 'ABCD-1234567890' }, shot: { id: `s-${Math.random()}`, outcome, resolvedTo, trackId, decisionTrackId: trackId, decisionBelief: null }, label }) as unknown as ShotSample;
const on = (target: string) => ({ kind: 'player' as const, target, answeredAt: 0, reviewMs: 0 });
const nobody = { kind: 'none' as const, answeredAt: 0, reviewMs: 0 };

test('triage compares the decision with the label, and names the cause of a miss', () => {
  assert.equal(triage(shot('hit', 'p1', on('p1'))), 'right hit');
  assert.equal(triage(shot('eliminated', 'p2', on('p1'))), 'WRONG hit');
  assert.equal(triage(shot('hit', 'p1', nobody)), 'WRONG hit on a non-player');
  assert.equal(triage(shot('unclear', null, nobody)), 'right refusal');
  assert.equal(triage(shot('miss', null, on('p1'), null)), 'miss: nobody under the dot');
  assert.equal(triage(shot('unclear', null, on('p1'))), 'miss: unclear');
  assert.equal(triage(shot('stale frame', null, on('p1'))), 'miss: camera too slow');
  assert.equal(triage(shot('hit', 'p1', undefined)), null);
});

test('the summary lists every wrong shot and the two rates', () => {
  const s = summarise([shot('hit', 'p1', on('p1')), shot('unclear', null, on('p1')), shot('hit', 'p1', nobody), shot('miss', null, nobody)]);
  assert.equal(s.labelled, 4);
  assert.equal(s.hitRate, 0.5);
  assert.equal(s.refusalRate, 0.5);
  assert.equal(s.wrong.length, 1);
  assert.equal(s.wrong[0].verdict, 'WRONG hit on a non-player');
});
