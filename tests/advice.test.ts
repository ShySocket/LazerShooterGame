import test from 'node:test';
import assert from 'node:assert/strict';
import { connectState, isStalled, loadProgress, rejoinFailure, STALL_TEXT } from '../src/ui/advice';
import { LOAD_CALIB } from '../src/vision/calibration';

const REQUIRED = ['blazeface', 'facemesh', 'insightface-mobilenet-swish', 'movenet-multipose'];

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
