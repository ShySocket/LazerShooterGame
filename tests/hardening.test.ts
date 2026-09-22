import test from 'node:test';
import assert from 'node:assert/strict';
import { isTimeout, TimeoutError, withTimeout } from '../src/net/withTimeout';
import { hitFailureText } from '../src/ui/advice';
import { NET_CALIB } from '../src/vision/calibration';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a hit that cannot reach the server within the deadline is reported as lost, never left hanging', async () => {
  const never = new Promise<string>(() => undefined);
  await assert.rejects(withTimeout(never, 20, 'the hit'), (e: unknown) => isTimeout(e) && e instanceof TimeoutError && /the hit timed out after 20 ms/.test(e.message));
  assert.equal(await withTimeout(sleep(5).then(() => 'hit'), 50), 'hit');
  await assert.rejects(withTimeout(Promise.reject(new Error('PERMISSION_DENIED')), 50), /PERMISSION_DENIED/);
  assert.equal(hitFailureText(new TimeoutError('the hit', 4000)), 'NO CONNECTION, SHOT LOST');
  assert.equal(hitFailureText(new Error('network error')), 'NO CONNECTION, SHOT LOST');
  assert.equal(hitFailureText(new Error('PERMISSION_DENIED')), 'SHOT LOST');
  assert.ok(NET_CALIB.hitTimeoutMs >= 3000 && NET_CALIB.hitTimeoutMs <= 6000, 'a deadline a player will wait out');
});
