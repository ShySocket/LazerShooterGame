import assert from 'node:assert/strict';
import test from 'node:test';
import { createSerialQueue } from '../src/vision/serial';

test('a replacement camera loop waits for both detection and asynchronous crops', async () => {
  const queue = createSerialQueue();
  const events: string[] = [];
  let release!: () => void;
  const crop = new Promise<void>((resolve) => { release = resolve; });
  const first = queue(async () => {
    events.push('first detection');
    await crop;
    events.push('first crop');
  });
  const replacement = queue(async () => { events.push('replacement detection'); });
  await Promise.resolve();
  assert.deepEqual(events, ['first detection']);
  release();
  await Promise.all([first, replacement]);
  assert.deepEqual(events, ['first detection', 'first crop', 'replacement detection']);
});

test('a failed inference does not block subsequent camera sessions', async () => {
  const queue = createSerialQueue();
  const failure = queue(async () => { throw new Error('camera changed'); });
  const next = queue(async () => 42);
  await assert.rejects(failure, /camera changed/);
  assert.equal(await next, 42);
});
