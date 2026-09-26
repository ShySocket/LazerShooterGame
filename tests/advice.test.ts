import test from 'node:test';
import assert from 'node:assert/strict';
import { connectState, crashNotice, HIT_CONFIDENCE_NOTE, RANGE_TARGET_NOTE, updateAllowed, verdictAdvice, isStalled, loadProgress, lobbyHint, rejoinFailure, saveError, shareFallback, STALL_TEXT } from '../src/ui/advice';
import { LOAD_CALIB } from '../src/vision/calibration';

const REQUIRED = ['blazeface', 'facemesh', 'insightface-ghostnet-strides1', 'movenet-multipose'];

test('loading text counts the required models and the bytes so far', () => {
  const p = loadProgress(
    [
      { name: 'blazeface', loaded: true, sizeLoadedWeights: 400_000 },
      { name: 'facemesh', loaded: true, sizeLoadedWeights: 2_500_000 },
      { name: 'movenet-multipose', loaded: false, sizeLoadedWeights: 6_000_000 },
      { name: 'handtrack', loaded: true, sizeLoadedWeights: 1_000_000 },
    ],
    REQUIRED,
  );
  assert.equal(p.loaded, 2);
  assert.equal(p.total, 4);
  assert.equal(p.text, 'Loading models 2 of 4 (10 MB)');
  assert.equal(loadProgress([], REQUIRED).text, 'Loading models 0 of 4');
});

test('a stalled download is reported after the patience, with a Retry message', () => {
  assert.equal(isStalled(LOAD_CALIB.modelStallMs - 1), false);
  assert.equal(isStalled(LOAD_CALIB.modelStallMs + 1), true);
  assert.match(STALL_TEXT, /Retry/);
  assert.match(STALL_TEXT, /Wi-Fi/);
});

test('still connecting: the wait names itself, then admits it is long and offers Back', () => {
  assert.deepEqual(connectState('Connecting', 2000), { text: 'Connecting', showBack: false });
  const late = connectState('Rejoining your room', LOAD_CALIB.connectPatienceMs + 1);
  assert.equal(late.showBack, true);
  assert.match(late.text, /^Still rejoining your room/);
  assert.match(late.text, /go back/);
});

test('a failed rejoin says why in the player\'s words', () => {
  assert.equal(rejoinFailure('ABCD', 'missing'), 'Could not rejoin room ABCD: it no longer exists.');
  assert.match(rejoinFailure('ABCD', 'in-progress'), /a round is in progress/);
  assert.match(rejoinFailure('ABCD', new Error('network down')), /network down/);
  assert.match(rejoinFailure('ABCD', 'timeout'), /timeout/);
});

test('a failed scan upload is explained in plain words and always offers to try again', () => {
  assert.match(saveError(Object.assign(new Error('PERMISSION_DENIED: Permission denied'), { code: 'PERMISSION_DENIED' })), /server refused/);
  assert.match(saveError(new Error('Failed to fetch')), /no connection/);
  assert.match(saveError(new Error('write timed out after 6000 ms')), /timed out/);
  assert.match(saveError(new Error('something odd')), /something odd/);
  for (const e of [new Error('x'), 'y', null]) assert.match(saveError(e), /[Tt]ry again/);
});

test('the lobby names a phone that dropped before claiming it needs more players', () => {
  const base = { disconnectedEnrolled: [] as string[], enrolledConnected: 1, notEnrolled: [] as string[], stale: [] as string[], conflicts: 0, minPlayers: 2 };
  assert.equal(lobbyHint({ ...base, disconnectedEnrolled: ['Pia'] }), "Waiting for Pia's phone to reconnect.");
  assert.equal(lobbyHint({ ...base, disconnectedEnrolled: ['Pia', 'Quinn'] }), 'Waiting for Pia and Quinn to reconnect.');
  assert.equal(lobbyHint(base), 'Need at least 2 enrolled players.');
  assert.equal(lobbyHint({ ...base, enrolledConnected: 2, notEnrolled: ['Rae'] }), 'Waiting for Rae to enroll.');
  assert.equal(lobbyHint({ ...base, enrolledConnected: 2, stale: ['Rae'] }), 'Rae needs to redo an outdated scan.');
  assert.equal(lobbyHint({ ...base, enrolledConnected: 2, conflicts: 1 }), 'Resolve the clothing conflict above.');
  assert.equal(lobbyHint({ ...base, enrolledConnected: 2 }), '');
  // A dropped phone that does not block the start is not the headline.
  assert.equal(lobbyHint({ ...base, enrolledConnected: 2, disconnectedEnrolled: ['Zed'], notEnrolled: ['Rae'] }), 'Waiting for Rae to enroll.');
});

test('share fallback shows the code, and the hit confidence note says where the field stops', () => {
  assert.equal(shareFallback('ABCD'), 'Could not copy. The code is ABCD.');
  assert.match(HIT_CONFIDENCE_NOTE, /0\.7/);
});

test('verdict advice names what to do for every refusal and stays silent on hits and clean misses', () => {
  for (const v of ['UNCLEAR TARGET', 'NOT A PLAYER', 'THAT IS YOU', 'CAMERA TOO SLOW', 'NO FRESH FRAMES', 'NO CAMERA LOCK', 'SHOT LOST', 'NO CONNECTION, SHOT LOST']) {
    assert.ok(verdictAdvice(v).length > 10, `${v} has advice`);
  }
  assert.equal(verdictAdvice('MISS'), '');
  assert.equal(verdictAdvice('HIT Sam'), '');
  assert.match(verdictAdvice('UNCLEAR TARGET'), /closer|green name/);
  assert.match(verdictAdvice('CAMERA TOO SLOW'), /light/);
  assert.match(RANGE_TARGET_NOTE, /FIRE/);
});

test('update allowed only when nothing on the phone would be lost by a reload', () => {
  assert.equal(updateAllowed({ inRoom: false, profileOpen: false, inputFocused: false }), true);
  assert.equal(updateAllowed({ inRoom: true, profileOpen: false, inputFocused: false }), false);
  assert.equal(updateAllowed({ inRoom: false, profileOpen: true, inputFocused: false }), false);
  assert.equal(updateAllowed({ inRoom: false, profileOpen: false, inputFocused: true }), false);
});

test('crash notice speaks plainly and keeps the raw text behind details', () => {
  const n = crashNotice({ t: 0, kind: 'error', message: 'TypeError: x is undefined\n  at foo' });
  assert.equal(n.title, 'The app restarted unexpectedly');
  assert.doesNotMatch(n.summary, /TypeError/);
  assert.match(n.details, /TypeError: x is undefined/);
  const r = crashNotice({ t: 0, kind: 'reload', message: 'The page reloaded on its own while in room ABCD.' });
  assert.match(r.summary, /room ABCD/);
  assert.match(r.summary, /join again/);
});

test('practice messages: capture notes name what is missing, verdicts compare with the aimed target', async () => {
  const { practiceCaptureNote, practiceVerdict, PRACTICE_CHECKLIST } = await import('../src/ui/advice');
  assert.equal(practiceCaptureNote('Target 1', 12, 12, true), 'Target 1 added.');
  assert.match(practiceCaptureNote('Target 1', 3, 12, true), /only 3 of 12 frames/);
  assert.match(practiceCaptureNote('Target 2', 12, 12, false), /No outfit/);
  assert.deepEqual(practiceVerdict('Target 1', 'Target 1'), { text: 'HIT Target 1 (right)', kind: 'good' });
  assert.equal(practiceVerdict('Target 1', 'Target 2').kind, 'bad');
  assert.equal(practiceVerdict('nobody', null).kind, 'good');
  assert.equal(practiceVerdict('Target 1', null).kind, 'warn');
  assert.ok(PRACTICE_CHECKLIST.length >= 5);
});
