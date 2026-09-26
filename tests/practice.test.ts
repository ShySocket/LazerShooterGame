import test from 'node:test';
import assert from 'node:assert/strict';
import { PracticeBackend } from '../src/net/practice';
import { isPresent } from '../src/net/backend';
import type { Profile } from '../src/types';

const profile = { faceModel: 'x', face: [[1]], outfit: { front: { top: [] }, back: { top: [] } } } as Profile;

test('practice targets are enrolled players that always count as present, and shots go to the feedback sink', async () => {
  const sent: string[] = [];
  const b = new PracticeBackend({ submitShotFeedback: async (round) => void sent.push(round) });
  const code = await b.createRoom({ id: 'me', name: 'Sai' });
  const id = await b.addTarget(code, 'Target 1', profile);
  let room = await new Promise<import('../src/types').Room | null>((resolve) => b.subscribe(code, resolve));
  const t = room!.players[id];
  assert.equal(t.enrolled, true);
  assert.equal(t.seenAt, undefined);
  // Hours later a phone would be long gone; a target never is.
  assert.equal(isPresent(t, Date.now() + 3_600_000), true);
  await b.submitShotFeedback('ABCD-1234567890', {} as never, null);
  assert.deepEqual(sent, ['ABCD-1234567890']);
  assert.equal(b.feedback.length, 0, 'nothing kept locally when a sink exists');
  await b.removeTarget(code, id);
  room = await new Promise((resolve) => b.subscribe(code, resolve));
  assert.equal(room!.players[id].connected, false);
  await b.startRound(code, room!.settings, Date.now());
  await assert.rejects(() => b.addTarget(code, 'Late', profile), /before the round starts/);
});

test('without a sink, practice shots stay in memory like local mode', async () => {
  const b = new PracticeBackend(null);
  await b.submitShotFeedback('ABCD-1234567890', { shot: { id: 's' } } as never, null);
  assert.equal(b.feedback.length, 1);
});
