import test from 'node:test';
import assert from 'node:assert/strict';
import { bodySampleDecision, bystanderDecision, FACE_PROMPTS, faceGate, gateHint, settleDone, smallRoomHint, SMALL_ROOM_TEXT, STEP_BACK_TEXT, faceBigEnough, farFacesDone, hintFor, holdStep, initialScanState, judgePose, promptFor, SCAN_CALIB, type ScanState } from '../src/vision/scan';
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
});

test('the face size gate is measured in full-frame pixels, so a 720p phone is not held closer', () => {
  // A 1080p camera detected on a 960 px copy: a 30 px face on the copy is 60 px in the frame.
  assert.ok(faceBigEnough(30, 40, SCAN_CALIB.minFacePx, 960 / 1920));
  // A 720p camera gets no downscale (copy scale 1): 30 px is 30 px.
  assert.ok(!faceBigEnough(30, 40, SCAN_CALIB.minFacePx, 1));
  assert.ok(faceBigEnough(48, 60, SCAN_CALIB.minFacePx, 1));
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

test('the face stage completes for a person who only turns one way, by patience and Skip, and never compares faces', async () => {
  const { faceStageStep, initialFaceStage, skipFaceAngle } = await import('../src/vision/scan');
  // A talker: small turns to one side only, chin only up. Different embedding every frame (no similarity gate may refuse it).
  let st = initialFaceStage(0);
  let skips = 0;
  for (let t = 0; t < 120_000 && st.samples.length < FACE_SAMPLES; t += 100) {
    const yaw = 10 * Math.sin(t / 900) - 8;
    const pitch = 6 + 4 * Math.sin(t / 1300);
    let r = faceStageStep(st, { t, faces: 1, box: [0.4, 0.3, 0.2, 0.25], blocked: '', yaw, pitch, embedding: [Math.sin(t), Math.cos(t)] });
    if (!r.accepted && r.skippable) {
      const k = skipFaceAngle(r.stage, t);
      if (k) {
        r = k;
        skips++;
      }
    }
    st = r.stage;
  }
  assert.equal(st.samples.length, FACE_SAMPLES, 'all eight angles end up taken');
  assert.ok(skips >= 1 && skips <= 4, `skips only for the moves never made: ${skips}`);
});

test('two faces in frame never give a sample, and the hint says why', async () => {
  const { faceStageStep, initialFaceStage } = await import('../src/vision/scan');
  let st = initialFaceStage(0);
  let hint = '';
  for (let t = 0; t < 30_000; t += 100) {
    const r = faceStageStep(st, { t, faces: 2, box: null, blocked: gateHint('many-faces'), yaw: 0, pitch: 0, embedding: [] });
    st = r.stage;
    hint = r.hint;
    assert.equal(r.skippable, false, 'nothing to skip with: no frame of the player was ever seen');
  }
  assert.equal(st.samples.length, 0);
  assert.equal(hint, gateHint('many-faces'));
});

test('a held pose is taken after the hold, and the next prompt waits out the settle', async () => {
  const { faceStageStep, initialFaceStage } = await import('../src/vision/scan');
  let st = initialFaceStage(0);
  const obs = (t: number, yaw: number) => ({ t, faces: 1, box: [0.4, 0.3, 0.2, 0.25] as NBox, blocked: '', yaw, pitch: 0, embedding: [1, 0] });
  let t = SCAN_CALIB.settleMs;
  for (let i = 0; i < SCAN_CALIB.holdFrames; i++, t += 100) st = faceStageStep(st, obs(t, 2)).stage;
  assert.equal(st.samples.length, 1, 'straight ahead taken');
  assert.equal(faceStageStep(st, obs(t, 20)).accepted, false, 'inside the settle nothing is taken');
});

