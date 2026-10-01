import test from 'node:test';
import assert from 'node:assert/strict';
import { isTimeout, TimeoutError, withTimeout } from '../src/net/withTimeout';
import { cameraRequestPlan, hitFailureText, hitOutcomeUnknown } from '../src/ui/advice';
import { CAM_CALIB, NET_CALIB, SCHED_CALIB } from '../src/vision/calibration';
import { clothingDue, cropBudget, failureDecision } from '../src/vision/schedule';
import { MODELS_CACHE, STALE_MODEL_CACHES } from '../src/vision/modelCache';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a hit that cannot reach the server within the deadline is reported as UNCONFIRMED, never left hanging', async () => {
  const never = new Promise<string>(() => undefined);
  await assert.rejects(withTimeout(never, 20, 'the hit'), (e: unknown) => isTimeout(e) && e instanceof TimeoutError && /the hit timed out after 20 ms/.test(e.message));
  assert.equal(await withTimeout(sleep(5).then(() => 'hit'), 50), 'hit');
  await assert.rejects(withTimeout(Promise.reject(new Error('PERMISSION_DENIED')), 50), /PERMISSION_DENIED/);
  // A timed-out write is still queued and may land (in its own round, once): it is not called lost.
  assert.equal(hitFailureText(new TimeoutError('the hit', 4000)), 'UNCONFIRMED');
  // An error means the write was dropped: those shots are lost, and say why.
  assert.equal(hitFailureText(new Error('network error')), 'NO CONNECTION, SHOT LOST');
  assert.equal(hitFailureText(new Error('PERMISSION_DENIED')), 'SHOT LOST');
  assert.ok(NET_CALIB.hitTimeoutMs >= 3000 && NET_CALIB.hitTimeoutMs <= 6000, 'a deadline a player will wait out');
});

test('a hit whose answer was cut off by a dropped connection is UNCONFIRMED, never SHOT LOST: the server may have applied it', () => {
  // @firebase/database rejects a transaction it had already sent with Error('disconnect') when the
  // socket drops (PersistentConnection.cancelSentTransactions_: "we don't know if our sent
  // transactions succeeded"). The target may have lost the life; telling the shooter it was lost and
  // to fire again would be false.
  assert.equal(hitOutcomeUnknown(new Error('disconnect')), true);
  assert.equal(hitFailureText(new Error('disconnect')), 'UNCONFIRMED');
  assert.equal(hitOutcomeUnknown(new TimeoutError('the hit', 4000)), true);
  // Errors after which nothing was applied stay lost: the SDK's own aborts (nothing committed) and refusals.
  for (const reason of ['set', 'maxretry', 'permission_denied']) {
    assert.equal(hitOutcomeUnknown(new Error(reason)), false, reason);
    assert.equal(hitFailureText(new Error(reason)), 'SHOT LOST', reason);
  }
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

test('the camera permission sheet is waited for: a minute, with a message, and no re-prompting after a timeout', () => {
  const prompt = cameraRequestPlan('prompt');
  assert.equal(prompt.timeoutMs, CAM_CALIB.promptTimeoutMs);
  assert.ok(prompt.timeoutMs >= 45000);
  assert.match(prompt.waitingText, /allow the camera/);
  assert.equal(prompt.fallbacksAfterTimeout, false);
  for (const st of ['granted', 'denied', 'unknown'] as const) {
    const plan = cameraRequestPlan(st);
    assert.equal(plan.timeoutMs, CAM_CALIB.requestTimeoutMs);
    assert.equal(plan.fallbacksAfterTimeout, true);
  }
});

test('the model cache is versioned and the old name is swept, so a bad cached shard can be retired', () => {
  assert.notEqual(MODELS_CACHE, 'vision-models');
  assert.ok(STALE_MODEL_CACHES.includes('vision-models'));
  assert.match(MODELS_CACHE, /^vision-models-v\d+$/);
});
