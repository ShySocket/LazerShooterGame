import test from 'node:test';
import assert from 'node:assert/strict';
import { isTimeout, TimeoutError, withTimeout } from '../src/net/withTimeout';
import { hitFailureText } from '../src/ui/advice';
import { NET_CALIB, SCHED_CALIB } from '../src/vision/calibration';
import { clothingDue, cropBudget, failureDecision } from '../src/vision/schedule';

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

test('a vision loop that fails every frame stops after the threshold and is reported, never spun silently', () => {
  assert.equal(failureDecision(SCHED_CALIB.loopFailuresBeforeReset - 1), 'continue');
  assert.equal(failureDecision(SCHED_CALIB.loopFailuresBeforeReset), 'reset');
  assert.ok(SCHED_CALIB.loopFailuresBeforeReset >= 5 && SCHED_CALIB.loopFailuresBeforeReset <= 30);
});

test('the work budget shrinks on a slow phone and is untouched on a fast one', () => {
  assert.equal(cropBudget(200, 1), 1);
  assert.equal(cropBudget(400, 1), 0);
  assert.equal(cropBudget(Number.NaN, 1), 1, 'before the period is known, nothing is shed');
  assert.equal(clothingDue(200, 0, 150), true);
  assert.equal(clothingDue(400, 0, 500), false, 'every other frame on a slow phone');
  assert.equal(clothingDue(400, 0, 800), true);
});
