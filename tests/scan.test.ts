import test from 'node:test';
import assert from 'node:assert/strict';
import { bodySampleDecision, bystanderDecision, FACE_PROMPTS, faceGate, gateHint, SAME_FACE_TEXT, settleDone, smallRoomHint, SMALL_ROOM_TEXT, STEP_BACK_TEXT, faceBigEnough, farFacesDone, hintFor, holdStep, initialScanState, judgePose, promptFor, samePerson, SCAN_CALIB, type ScanState } from '../src/vision/scan';
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

test('a bystander pauses the body scan and keeps the samples; only a long intrusion starts over', () => {
  assert.equal(bystanderDecision(1000, 1000 + SCAN_CALIB.bodyGapMs - 1), 'pause');
  assert.equal(bystanderDecision(1000, 1000 + SCAN_CALIB.bodyGapMs + 1), 'restart');
});

test('the settle counts from the first usable body frame, not from the countdown', () => {
  assert.equal(settleDone(0, 5000), false, 'no usable frame yet');
  assert.equal(settleDone(4000, 4000 + SCAN_CALIB.bodySettleMs - 1), false);
  assert.equal(settleDone(4000, 4000 + SCAN_CALIB.bodySettleMs), true);
});

test('small room: after a while the step-back hint offers raising the phone and a legless scan', () => {
  assert.equal(smallRoomHint(0, 9000), STEP_BACK_TEXT);
  assert.equal(smallRoomHint(1000, 1000 + SCAN_CALIB.smallRoomHintMs - 1), STEP_BACK_TEXT);
  assert.equal(smallRoomHint(1000, 1000 + SCAN_CALIB.smallRoomHintMs + 1), `${STEP_BACK_TEXT} ${SMALL_ROOM_TEXT}`);
  assert.match(SMALL_ROOM_TEXT, /without the legs still counts/);
});

test('low light is named as the fix, not holding still, and each cheap gate has one message', () => {
  assert.equal(faceGate({ faces: 0 }), 'no-face');
  assert.equal(faceGate({ faces: 2, score: 0.9 }), 'many-faces');
  assert.equal(faceGate({ faces: 1, score: 0.6 }), 'low-light');
  assert.equal(gateHint('low-light'), 'Move into better light and face the camera.');
  assert.doesNotMatch(gateHint('low-light'), /hold still/i);
  assert.equal(faceGate({ faces: 1, score: 0.9, cropCount: 2, cropOverlap: 0.9 }), 'crop');
  assert.equal(faceGate({ faces: 1, score: 0.9, cropCount: 1, cropOverlap: 0.1 }), 'crop');
  assert.equal(gateHint('crop'), 'Keep just your face in the frame.');
  assert.equal(faceGate({ faces: 1, score: 0.9, cropCount: 1, cropOverlap: 0.6 }), 'ok');
  assert.match(SAME_FACE_TEXT, /better light/);
  assert.match(SAME_FACE_TEXT, /Restart scan/);
});

test('the face size gate is measured in full-frame pixels, so a 720p phone is not held closer', () => {
  // A 1080p camera detected on a 960 px copy: a 30 px face on the copy is 60 px in the frame.
  assert.ok(faceBigEnough(30, 40, SCAN_CALIB.minFacePx, 960 / 1920));
  // A 720p camera gets no downscale (copy scale 1): 30 px is 30 px.
  assert.ok(!faceBigEnough(30, 40, SCAN_CALIB.minFacePx, 1));
  assert.ok(faceBigEnough(48, 60, SCAN_CALIB.minFacePx, 1));
});

test('continuity: one face seen every frame is the same person; a gap, a second face or a jump breaks it', async () => {
  const { continuityStep, initialContinuity } = await import('../src/vision/scan');
  const box = (x: number): NBox => [x, 0.3, 0.2, 0.25];
  let c = initialContinuity();
  c = continuityStep(c, null, 0, 0);
  assert.equal(c.broken, false, 'no face before the first is not a break');
  c = continuityStep(c, box(0.4), 1, 100);
  // A turning head drifts a little every frame: never a break.
  for (let t = 200, x = 0.4; t < 3000; t += 100, x += 0.01) c = continuityStep(c, box(x), 1, t);
  assert.equal(c.broken, false, 'a slow drift over 3 s keeps the person');
  assert.equal(continuityStep(c, null, 0, 2900 + SCAN_CALIB.continuityGapMs - 50).broken, false, 'a dropped frame or two is not a break');
  assert.equal(continuityStep(c, null, 0, 2900 + SCAN_CALIB.continuityGapMs + 50).broken, true, 'missing longer than the gap breaks it');
  assert.equal(continuityStep(c, null, 2, 3000).broken, true, 'a second face breaks it');
  assert.equal(continuityStep(c, box(0.95), 1, 3000).broken, true, 'a jump of more than a face width breaks it');
  const broken = continuityStep(c, null, 2, 3000);
  assert.equal(continuityStep(broken, box(0.68), 1, 3100).broken, true, 'a break stays until the scan clears it');
});

test('re-verify after a break: only a frontal frame that matches the frontal samples continues the scan', async () => {
  const { reverify } = await import('../src/vision/scan');
  const sim = (a: number[], b: number[]) => (a[0] === b[0] ? 0.8 : 0.4);
  assert.equal(reverify(30, [1], [[1]], SCAN_CALIB.reverifyMin, sim), 'look-straight', 'a turned head is asked to look straight first');
  assert.equal(reverify(5, [1], [[1]], SCAN_CALIB.reverifyMin, sim), 'ok');
  assert.equal(reverify(5, [2], [[1]], SCAN_CALIB.reverifyMin, sim), 'not-same', 'somebody else at the phone is caught');
  // Measured on GhostNet: same person frontal-vs-frontal p1 0.60, other people at most 0.51.
  assert.ok(SCAN_CALIB.reverifyMin > 0.51 && SCAN_CALIB.reverifyMin < 0.6);
});

test('patience: after six seconds the best right-way frame stands in for the prompt; after twelve the angle can be skipped', async () => {
  const { angleNote, canSkipAngle, patienceAccepts, patienceLatch, promptProgress } = await import('../src/vision/scan');
  const latched: ScanState = { ...initialScanState(), yawSign: 1 };
  // Slight left latched as +; slight right wants -.
  assert.equal(promptProgress(P(2), -9, 0, latched), 9);
  assert.equal(promptProgress(P(2), 9, 0, latched), -Infinity, 'the wrong way never counts');
  assert.equal(patienceAccepts(P(2), 9, SCAN_CALIB.promptPatienceMs - 1), false, 'not before the patience runs out');
  assert.equal(patienceAccepts(P(2), 9, SCAN_CALIB.promptPatienceMs), true, '9 degrees is past half of 12');
  assert.equal(patienceAccepts(P(2), 4, 60_000), false, 'barely moving never stands in for a turn');
  assert.equal(patienceAccepts(P(3), 14, SCAN_CALIB.promptPatienceMs), true, 'further: half of 25');
  assert.equal(patienceAccepts(P(5), 5, SCAN_CALIB.promptPatienceMs), true, 'tilt: half of 8');
  assert.equal(patienceAccepts(P(0), -20, SCAN_CALIB.promptPatienceMs), true, 'straight: within twice its band');
  assert.equal(patienceAccepts(P(7), 0, SCAN_CALIB.promptPatienceMs), true, 'the smile has no pose');
  assert.deepEqual(patienceLatch(P(1), -10, 0, initialScanState()), { yawSign: -1 }, 'a patience sample latches like a normal one');
  assert.equal(canSkipAngle(SCAN_CALIB.promptSkipMs - 1), false);
  assert.equal(canSkipAngle(SCAN_CALIB.promptSkipMs), true);
  assert.equal(angleNote(P(1), 'turn-more', 7.4, 0), 'Now 7°, aim for 12°.');
  assert.equal(angleNote(P(5), 'tilt-more', 0, -3), 'Now 3°, aim for 8°.');
  assert.equal(angleNote(P(1), 'turn-less', 50, 0), '');
});
