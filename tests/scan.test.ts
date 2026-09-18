import test from 'node:test';
import assert from 'node:assert/strict';
import { bodySampleDecision, FACE_PROMPTS, faceBigEnough, farFacesDone, hintFor, holdStep, initialScanState, judgePose, promptFor, samePerson, SCAN_CALIB, type ScanState } from '../src/vision/scan';
import { iou, type NBox } from '../src/vision/geometry';
import { FACE_SAMPLES } from '../src/vision/embedding';

const P = (i: number) => FACE_PROMPTS[i];

/** Run a frame through judge + hold and return the new state plus whether the sample was taken. */
function frame(state: ScanState, promptIndex: number, yaw: number, pitch = 0) {
  const j = judgePose(promptFor(promptIndex), yaw, pitch, state);
  const h = holdStep(state, j);
  return { ...h, reason: j.reason };
}
/** Hold the pose for the required frames and return the state after the sample is taken. */
function take(state: ScanState, promptIndex: number, yaw: number, pitch = 0): ScanState {
  let s = state;
  for (let i = 0; i < SCAN_CALIB.holdFrames; i++) {
    const r = frame(s, promptIndex, yaw, pitch);
    assert.equal(r.reason, 'ok', `prompt ${promptIndex} at yaw ${yaw} pitch ${pitch}: ${r.reason}`);
    s = r.state;
    if (i === SCAN_CALIB.holdFrames - 1) assert.ok(r.ready, 'sample taken after the hold');
    else assert.ok(!r.ready, 'still holding');
  }
  return s;
}

test('there is one prompt per stored sample and the last one has no pose requirement', () => {
  assert.equal(FACE_PROMPTS.length, FACE_SAMPLES);
  assert.deepEqual(promptFor(99), FACE_PROMPTS[FACE_SAMPLES - 1]);
  assert.equal(P(7).yaw, undefined);
  assert.equal(P(7).tilt, undefined);
});

test('mirrored player: the first turn fixes the convention and either direction is accepted', () => {
  // Turning what the phone calls negative yaw on the "left" prompt is fine: it becomes side a.
  let s = take(initialScanState(), 0, 3);
  s = take(s, 1, -25);
  assert.equal(s.yawSign, -1);
  s = take(s, 2, 25);
  s = take(s, 3, -42);
  s = take(s, 4, 45);
  // The unmirrored player gets the same treatment with the opposite convention.
  let u = take(initialScanState(), 0, -4);
  u = take(u, 1, 25);
  assert.equal(u.yawSign, 1);
  u = take(u, 2, -25);
  assert.equal(frame(u, 3, 30).reason, 'ok');
});

test('turn-less, not other-way: an overshoot on a slight prompt asks to turn back', () => {
  const s = take(initialScanState(), 0, 0);
  const r = frame(s, 1, 50);
  assert.equal(r.reason, 'turn-less');
  assert.equal(hintFor(P(1), r.reason), 'Turn back a little, then hold it.');
  assert.equal(r.state.hold, 0);
  // Beyond the enrolment limit is still just "turn back", whatever the sign.
  assert.equal(frame(s, 2, -70).reason, 'turn-less');
});

test('turn-more: an undershoot asks for more, never the other way', () => {
  let s = take(initialScanState(), 0, 0);
  assert.equal(frame(s, 1, 5).reason, 'turn-more');
  s = take(s, 1, 25);
  // A small turn the wrong way on the second side is still "more", because the sign is noise below the band.
  assert.equal(frame(s, 2, 6).reason, 'turn-more');
  assert.equal(hintFor(P(2), 'turn-more'), 'Turn a bit more, then hold it.');
  // The straight prompt asks to look straight when the head is turned.
  assert.equal(frame(initialScanState(), 0, 30).reason, 'straighten');
});

test('other-way only when the sign is wrong on the second side', () => {
  let s = take(initialScanState(), 0, 0);
  s = take(s, 1, 25);
  assert.equal(frame(s, 2, 25).reason, 'other-way');
  assert.equal(hintFor(P(2), 'other-way'), 'The other way.');
  assert.equal(frame(s, 2, -25).reason, 'ok');
  s = take(s, 2, -25);
  // The "further" prompts keep the same convention.
  assert.equal(frame(s, 3, -40).reason, 'other-way');
  assert.equal(frame(s, 3, 40).reason, 'ok');
});

test('inverted pitch sign still completes chin up and chin down', () => {
  let s = take(initialScanState(), 0, 0);
  for (const [i, yaw] of [[1, 25], [2, -25], [3, 40], [4, -40]] as const) s = take(s, i, yaw);
  // The model calls chin-up negative on this device: fine, it latches.
  s = take(s, 5, 0, -20);
  assert.equal(s.pitchSign, -1);
  assert.equal(frame(s, 6, 0, -20).reason, 'other-way');
  assert.equal(hintFor(P(6), 'other-way'), 'The other way: chin down.');
  assert.equal(frame(s, 6, 0, 3).reason, 'tilt-more');
  assert.equal(frame(s, 6, 0, 60).reason, 'tilt-less');
  s = take(s, 6, 0, 20);
  assert.equal(frame(s, 7, 0, 0).reason, 'ok', 'the last prompt accepts anything');
});

test('the hold resets on a failed frame and the sample is taken after the hold', () => {
  let s = initialScanState();
  let r = frame(s, 0, 2);
  assert.equal(r.reason, 'ok');
  assert.ok(!r.ready);
  assert.equal(r.state.hold, 1);
  r = frame(r.state, 0, 30);
  assert.equal(r.state.hold, 0, 'a bad frame resets the hold');
  s = take(r.state, 0, 2);
  assert.equal(s.hold, 0, 'an accepted sample starts the next prompt from zero');
});

test('same-person chain: a 55-degree sample passes through the 30-degree sample when the frontal one is too different', () => {
  const frontal = [0];
  const thirty = [30];
  const fiftyFive = [55];
  const sim = (a: number[], b: number[]) => (Math.abs(a[0] - b[0]) <= 30 ? 0.5 : 0.2);
  assert.equal(samePerson(fiftyFive, [frontal], SCAN_CALIB.samePerson, sim), false, 'against the frontal frame alone it fails');
  assert.equal(samePerson(fiftyFive, [frontal, thirty], SCAN_CALIB.samePerson, sim), true, 'the adjacent angle vouches for it');
  assert.equal(samePerson(fiftyFive, [], SCAN_CALIB.samePerson, sim), true, 'the first sample has nothing to match');
  assert.ok(SCAN_CALIB.samePerson >= 0.25, 'never below FACE_CALIB.reject');
});

test('minimum face size for enrolment is 48 px, not 64', () => {
  assert.equal(SCAN_CALIB.minFacePx, 48);
  assert.ok(faceBigEnough(50, 70));
  assert.ok(!faceBigEnough(40, 70));
  assert.ok(faceBigEnough(64, 64));
});

test('movement does not lose the outfit samples: a step skips the frame, only a real gap starts over', () => {
  const here: NBox = [0.3, 0.1, 0.3, 0.8];
  const stepped: NBox = [0.65, 0.1, 0.3, 0.8];
  const nearby: NBox = [0.32, 0.1, 0.3, 0.8];
  assert.equal(bodySampleDecision(null, here, 1000, 0, iou), 'take', 'the first sample');
  assert.equal(bodySampleDecision(here, nearby, 1150, 1000, iou), 'take', 'a steady body samples');
  assert.equal(bodySampleDecision(here, stepped, 1150, 1000, iou), 'skip', 'a step is skipped, not punished');
  assert.equal(bodySampleDecision(here, here, 1000 + SCAN_CALIB.bodyGapMs + 1, 1000, iou), 'restart', 'a long gap without a usable body starts over');
  assert.equal(bodySampleDecision(here, stepped, 1000 + SCAN_CALIB.bodyGapMs + 1, 1000, iou), 'restart');
});

test('far faces are waited for after the outfit completes, six seconds at most', () => {
  assert.equal(farFacesDone(false, 0, 0, 5000), true, 'the back stage never waits');
  assert.equal(farFacesDone(true, 6, 0, 5000), true, 'enough far faces');
  assert.equal(farFacesDone(true, 2, 0, 20000), false, 'the outfit is not complete yet: keep going');
  assert.equal(farFacesDone(true, 2, 10000, 10000 + SCAN_CALIB.farFacePatienceMs - 1), false, 'still waiting');
  assert.equal(farFacesDone(true, 2, 10000, 10000 + SCAN_CALIB.farFacePatienceMs + 1), true, 'patience is up');
  assert.equal(SCAN_CALIB.farFacePatienceMs, 6000);
});
