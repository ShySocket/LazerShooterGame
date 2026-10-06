import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Human, Result } from '@vladmandic/human';
import type { BodyProps, OutfitSig } from '../types';
import { useCamera, type Facing } from '../hooks/useCamera';
import { useVisionLoop, type VisionFrame } from '../hooks/useVisionLoop';
import { useHumanStatus } from '../hooks/useHumanStatus';
import { compactEmbedding, FACE_MIN_SAMPLES, FACE_SAMPLES, faceYawDeg, MAX_YAW_DEG, MIN_FACE_PX, isValidEmbedding } from '../vision/human';
import { bodySampleDecision, bystanderDecision, currentPrompt, faceBigEnough, faceGate, faceStageDone, faceStageStep, farFacesDone, gateHint, initialFaceStage, initialLap2Stage, LAP2_PROMPTS, needsExtra, promptIndex, SCAN_CALIB, settleDone, SKIP_ANGLE_TEXT, skipFaceAngle, smallRoomHint, type FaceStage, type FaceStep } from '../vision/scan';
import { useWakeLock } from '../hooks/useWakeLock';
import { saveError } from '../ui/advice';
import { averageOutfits, averageProps, bodyProportions, FrameSampler, outfitRegions, outfitSignature } from '../vision/clothing';
import { drawOverlay } from '../vision/overlay';
import { iou, toNBox, type NBox } from '../vision/geometry';
import { faceRegion, ZoomPass } from '../vision/zoom';
import type { Detection } from '../vision/tracker';
import { haptic, sfx, vibrate } from '../audio/sfx';
import { ScanRing } from './ScanRing';
import { BodySilhouette } from './BodySilhouette';

/**
 * The eight prompts, their head-angle bands, the hold and the same-person rule live in
 * src/vision/scan.ts (pure, unit-tested). This component only feeds it measured angles and shows
 * the hint it returns, plus a live yaw/pitch readout so a real phone tells us what the model sees.
 */
const BODY_SAMPLES = 12;
/**
 * Face samples taken from metres away during the front body scan. These match a round far better
 * than the close selfie set, so the front stage keeps recording until it has MIN_FAR_FACES of them
 * (or gives up SCAN_CALIB.farFacePatienceMs after the outfit completed, in poor light), not just until the outfit is sampled.
 */
const FAR_FACE_SAMPLES = 12;
const MIN_FAR_FACES = SCAN_CALIB.minFarFaces;
const FAR_FACE_INTERVAL_MS = 250;
const PROP_COUNTDOWN = 5;
/** How long the lap-complete sweep plays. */
const FLOURISH_MS = 900;
const BODY_SAMPLE_INTERVAL_MS = 150;

export interface ScanResult {
  face: number[][];
  /** For each face sample: its head angle and how it was taken (skipped angles have no sample). */
  faceMeta: { yaw: number; pitch: number; how: string }[];
  /** Face samples taken during the body scan, i.e. from 2 to 3 m: what the game sees in a round. */
  farFace: number[][];
  body: BodyProps | null;
  outfit: { front: OutfitSig; back: OutfitSig } | null;
}

interface Props {
  /** Capture the 8-angle face set. */
  face: boolean;
  /** Run the front and back body scan. */
  body: boolean;
  /** During the body scan, record clothing colours (per game) as well as body ratios (persistent). */
  outfit: boolean;
  /** Shown above the instructions, e.g. the player chip. */
  header?: ReactNode;
  /** Text while the result is being saved. */
  savingText?: string;
  onDone: (r: ScanResult) => Promise<void>;
  onCancel?: () => void;
}

type Stage = 'face' | 'bodyMode' | 'bodyFront' | 'bodyBack' | 'saving' | 'error';
type BodyMode = 'helper' | 'prop';

/** Camera-driven capture of face angles, outfit colours, and body ratios. Which parts run is up to the caller. */
export function Scanner({ face, body, outfit, header, savingText, onDone, onCancel }: Props) {
  const { ready: humanReady, status, failed: humanFailed, retry: retryModels, reportFailure } = useHumanStatus();
  const first: Stage = face ? 'face' : 'bodyMode';
  const [stage, setStageState] = useState<Stage>(first);
  const stageRef = useRef<Stage>(first);
  const [faceIdx, setFaceIdx] = useState(0);
  const [hint, setHint] = useState('');
  const [progress, setProgress] = useState(0);
  const [errMsg, setErrMsg] = useState('');
  const [bodyMode, setBodyMode] = useState<BodyMode>('prop');
  const [recording, setRecordingState] = useState(false);
  const recordingRef = useRef(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const facing: Facing = stage === 'face' || bodyMode === 'prop' ? 'user' : 'environment';
  const { videoRef, ready: camReady, error: camError, notice: camNotice, retry: retryCamera } = useCamera(facing, stage !== 'saving');
  // A propped phone must not fall asleep mid-scan.
  useWakeLock(true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const faces = useRef<number[][]>([]);
  const farFaces = useRef<number[][]>([]);
  /** The face stage's state (scan.ts faceStageStep): prompts, samples, patience. Lap 2 replaces it; lap 1 is kept in `lap1`. */
  const faceStage = useRef<FaceStage>(initialFaceStage(performance.now()));
  const lap1 = useRef<FaceStage | null>(null);
  const [ringReason, setRingReason] = useState<FaceStep['reason']>('wait');
  const [flourish, setFlourish] = useState(false);
  const flourishTimer = useRef<number | undefined>(undefined);
  /** Far-face samples so far, and whether the front stage is now only waiting for them (the silhouette's dots). */
  const [farCount, setFarCount] = useState(0);
  const [farWait, setFarWait] = useState(false);
  const [skippable, setSkippable] = useState(false);
  const [angles, setAngles] = useState<{ yaw: number; pitch: number } | null>(null);
  const lastFarFace = useRef(0);
  const outfits = useRef<OutfitSig[]>([]);
  const props = useRef<BodyProps[]>([]);
  const stageProps = useRef<BodyProps[]>([]);
  const lastBody = useRef<NBox | null>(null);
  const lastBodySample = useRef(0);
  /** When the outfit samples of the current body stage were complete; the far-face wait counts from here. */
  const outfitDoneAt = useRef(0);
  /** Since when somebody else has been in the frame (0 when it is just the player). */
  const intrudingSince = useRef(0);
  /** The first frame with a usable body while recording; the settle counts from it. */
  const firstUsableAt = useRef(0);
  /** Since when the "step back" hint has been showing. */
  const stepBackSince = useRef(0);
  const generation = useRef(0);
  const mounted = useRef(true);
  const front = useRef<OutfitSig | null>(null);
  const stageStart = useRef(performance.now());
  const sampler = useRef(new FrameSampler());
  const zoom = useRef(new ZoomPass());
  const countdownTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      window.clearInterval(countdownTimer.current);
      window.clearTimeout(flourishTimer.current);
    };
  }, []);

  const go = (s: Stage) => {
    generation.current++;
    stageRef.current = s;
    stageStart.current = performance.now();
    setStageState(s);
    setHint('');
  };
  const setRecording = (v: boolean) => {
    recordingRef.current = v;
    setRecordingState(v);
  };

  /** The captured scan, kept so a failed save can be retried without scanning again. */
  const lastResult = useRef<ScanResult | null>(null);

  const submit = async (result: ScanResult) => {
    lastResult.current = result;
    go('saving');
    try {
      await onDone(result);
    } catch (e) {
      if (!mounted.current) return;
      setErrMsg(saveError(e));
      go('error');
    }
  };

  /** Lap 1's samples, then lap 2's (tagged), in the order they were taken. */
  const faceSamples = () => [
    ...(lap1.current ?? faceStage.current).samples.map((x) => ({ ...x, how: x.how as string })),
    ...(lap1.current ? faceStage.current.samples.map((x) => ({ ...x, how: `lap2-${x.how}` })) : []),
  ];

  const finish = (back: OutfitSig | null) =>
    submit({
      face: faces.current,
      faceMeta: faceSamples().map((x) => ({ yaw: Math.round(x.yaw), pitch: Math.round(x.pitch), how: x.how })),
      farFace: farFaces.current,
      body: averageProps(props.current),
      outfit: outfit && front.current && back ? { front: front.current, back } : null,
    });

  /** Try the save again with the scan already captured; "Start over" is the separate, destructive path. */
  const retrySave = () => {
    if (lastResult.current) void submit(lastResult.current);
    else restart();
  };

  const restart = () => {
    window.clearInterval(countdownTimer.current);
    faces.current = [];
    farFaces.current = [];
    faceStage.current = initialFaceStage(performance.now());
    lap1.current = null;
    setRingReason('wait');
    window.clearTimeout(flourishTimer.current);
    setFlourish(false);
    setFarCount(0);
    setFarWait(false);
    setSkippable(false);
    setAngles(null);
    outfits.current = [];
    props.current = [];
    stageProps.current = [];
    lastBody.current = null;
    lastBodySample.current = 0;
    outfitDoneAt.current = 0;
    intrudingSince.current = 0;
    firstUsableAt.current = 0;
    stepBackSince.current = 0;
    front.current = null;
    setFaceIdx(0);
    setProgress(0);
    setCountdown(null);
    setRecording(false);
    go(first);
  };

  /** Helper mode: a friend taps Record. Prop mode: a countdown gives you time to step back. */
  const beginScan = () => {
    outfits.current = [];
    stageProps.current = [];
    lastBody.current = null;
    lastBodySample.current = 0;
    firstUsableAt.current = 0;
    setProgress(0);
    haptic();
    if (bodyMode === 'helper') {
      setRecording(true);
      stageStart.current = performance.now();
      return;
    }
    let n = PROP_COUNTDOWN;
    setCountdown(n);
    sfx.countdown();
    window.clearInterval(countdownTimer.current);
    countdownTimer.current = window.setInterval(() => {
      n--;
      if (n > 0) {
        setCountdown(n);
        sfx.countdown();
        return;
      }
      window.clearInterval(countdownTimer.current);
      setCountdown(null);
      sfx.go();
      setRecording(true);
      stageStart.current = performance.now();
    }, 1000);
  };

  const chooseMode = (m: BodyMode) => {
    setBodyMode(m);
    haptic();
    go('bodyFront');
  };

  const playFlourish = () => {
    sfx.lapDone();
    vibrate([20, 40, 20]);
    setFlourish(true);
    window.clearTimeout(flourishTimer.current);
    flourishTimer.current = window.setTimeout(() => mounted.current && setFlourish(false), FLOURISH_MS);
  };

  /** Apply one face-stage step: the hint, the Skip button, the ring, and a taken sample. */
  const applyFaceStep = (r: FaceStep) => {
    const before = faceStage.current.samples.length;
    faceStage.current = r.stage;
    if (r.skippable !== skippable) setSkippable(r.skippable);
    setRingReason(r.reason);
    if (!r.accepted) return setHint(r.hint);
    faces.current = faceSamples().map((x) => x.embedding);
    // A zone locked (a skip locks nothing): a tick that climbs through the lap.
    if (r.stage.samples.length > before) {
      sfx.lock(promptIndex(r.stage) + (r.stage.lap === 2 ? 3 : 0));
      vibrate(15);
    }
    setHint('');
    if (faceStageDone(r.stage, FACE_SAMPLES, FACE_MIN_SAMPLES)) {
      playFlourish();
      if (r.stage.lap === 1) {
        // Lap 2 at arm's length: the latched sides carry over; lap 1's face width is the reference.
        lap1.current = r.stage;
        faceStage.current = initialLap2Stage(r.stage, performance.now());
        setRingReason('wait');
        setFaceIdx(0);
      } else {
        // Let the last sweep play before the screen moves on; no frame adds to the finished lap meanwhile.
        const epoch = generation.current;
        window.setTimeout(() => {
          if (!mounted.current || generation.current !== epoch) return;
          if (body) go('bodyMode');
          else void finish(null);
        }, FLOURISH_MS);
      }
    } else setFaceIdx(promptIndex(r.stage));
  };

  /** Skip this angle: the face's last frame stands in for it. */
  const skipAngle = () => {
    const r = skipFaceAngle(faceStage.current, performance.now());
    if (!r) return setHint('Keep your face in view, then tap Skip again.');
    applyFaceStep(r);
  };

  const onFrame = async (res: Result, human: Human, context: VisionFrame) => {
    const v = videoRef.current;
    const canvas = canvasRef.current;
    if (!v) return;
    const now = context.capturedAt;
    const s = stageRef.current;
    const epoch = generation.current;
    const isCurrent = () => mounted.current && context.isCurrent() && generation.current === epoch && stageRef.current === s;
    if (!isCurrent()) return;
    if (canvas) {
      const dets: Detection[] = res.body.map((b) => ({ box: toNBox(b.boxRaw), body: b }));
      res.face.forEach((f) => dets.push({ box: toNBox(f.boxRaw), face: f }));
      drawOverlay(canvas, { dets, tracks: [], vidW: res.width, vidH: res.height }, facing === 'user');
    }
    if (s === 'face') {
      if (faceStageDone(faceStage.current, FACE_SAMPLES, FACE_MIN_SAMPLES)) return;
      // The gates and the crop turn this frame into one observation; scan.ts faceStageStep decides.
      const obs = { t: now, faces: res.face.length, box: res.face.length === 1 ? toNBox(res.face[0].boxRaw) : null, blocked: '', yaw: 0, pitch: 0, embedding: [] as number[], w: res.face.length === 1 ? res.face[0].boxRaw[2] : undefined };
      if (now < faceStage.current.settleUntil) return applyFaceStep(faceStageStep(faceStage.current, obs));
      const gate = faceGate({ faces: res.face.length, score: res.face[0]?.score });
      if (gate !== 'ok') return applyFaceStep(faceStageStep(faceStage.current, { ...obs, blocked: gateHint(gate) }));
      const detected = res.face[0];
      // The size gate is measured in full-frame pixels: the face stage detects on a downscaled copy.
      const copyScale = res.width / (v.videoWidth || res.width);
      if (!faceBigEnough(detected.boxRaw[2] * res.width, detected.boxRaw[3] * res.height, SCAN_CALIB.minFacePx, copyScale)) {
        return applyFaceStep(faceStageStep(faceStage.current, { ...obs, blocked: 'Move closer so your face is clear.' }));
      }
      // The embedding, and the head angle, come from a square crop, the same way the game reads faces (see
      // ZoomPass): the full-frame pass only finds boxes, so it cannot judge the angle.
      // Detection runs on a downscaled copy, but the embedding comes from the full-resolution camera
      // image, as in a round (frameOps.ts crops the full frame): the same pixels for scan and shot.
      const crops = await zoom.current.run(human, v, faceRegion(toNBox(detected.boxRaw), res.width / res.height));
      if (!isCurrent()) return;
      // A magnified crop can include a neighbour. Never take an arbitrary first face.
      const cropGate = faceGate({ faces: 1, cropCount: crops.length, cropOverlap: crops.length === 1 ? iou(crops[0].box, toNBox(detected.boxRaw)) : 0, score: crops[0]?.face.score });
      if (cropGate !== 'ok') return applyFaceStep(faceStageStep(faceStage.current, { ...obs, blocked: gateHint(cropGate) }));
      const f = crops[0].face;
      if (!isValidEmbedding(f.embedding) || !Number.isFinite(faceYawDeg(f))) return applyFaceStep(faceStageStep(faceStage.current, { ...obs, blocked: 'Hold still and face the camera a little more.' }));
      const yaw = ((f.rotation?.angle?.yaw ?? 0) * 180) / Math.PI;
      const pitch = ((f.rotation?.angle?.pitch ?? 0) * 180) / Math.PI;
      setAngles({ yaw: Math.round(yaw), pitch: Math.round(pitch) });
      applyFaceStep(faceStageStep(faceStage.current, { ...obs, yaw, pitch, embedding: compactEmbedding(f.embedding) }));
    } else if (s === 'bodyFront' || s === 'bodyBack') {
      const clearSamples = () => {
        outfits.current = [];
        stageProps.current = [];
        lastBody.current = null;
        lastBodySample.current = 0;
        outfitDoneAt.current = 0;
        firstUsableAt.current = 0;
        setProgress(0);
        setFarWait(false);
      };
      // Somebody else in the frame pauses the scan and keeps the samples; a long intrusion starts over.
      if (res.body.length > 1 || res.face.length > 1) {
        if (!intrudingSince.current) intrudingSince.current = now;
        if (bystanderDecision(intrudingSince.current, now) === 'restart') {
          clearSamples();
          setHint('Starting the body scan over: only the player being scanned should be in frame.');
        } else {
          setHint(outfits.current.length ? 'Paused, someone else is in frame. Samples kept.' : 'Only the player being scanned should be in frame.');
        }
        return;
      }
      intrudingSince.current = 0;
      const b = res.body[0];
      // The body scan is the one moment the enrolment camera is metres away, like an opponent's phone.
      // Face samples from here match a round far better than the close selfie set alone.
      if (recordingRef.current && res.face.length === 1 && farFaces.current.length < FAR_FACE_SAMPLES && now - lastFarFace.current > FAR_FACE_INTERVAL_MS) {
        lastFarFace.current = now;
        const fb = toNBox(res.face[0].boxRaw);
        if (Math.min(fb[2] * res.width, fb[3] * res.height) >= MIN_FACE_PX) {
          const crops = await zoom.current.run(human, context.frame, faceRegion(fb, res.width / res.height));
          if (!isCurrent()) return;
          const f = crops.length === 1 ? crops[0].face : null;
          // Only one body and one face are in frame here (a second person pauses the scan above), so the
          // face is the player's: no similarity gate, which turned heads and distance would fail anyway.
          if (f && isValidEmbedding(f.embedding) && f.score >= 0.7 && faceYawDeg(f) <= MAX_YAW_DEG) {
            farFaces.current.push(compactEmbedding(f.embedding));
            setFarCount(farFaces.current.length);
            // During the far-face wait the player is metres away: a tick per sample and a bar they can see.
            if (outfitDoneAt.current) {
              sfx.tick();
              setProgress(Math.min(1, farFaces.current.length / MIN_FAR_FACES));
            }
          }
        }
      }
      const regions = b ? outfitRegions(b, 0.4, res.width / res.height) : null;
      if (!b || !regions?.top) {
        if (lastBodySample.current && now - lastBodySample.current > SCAN_CALIB.bodyGapMs) clearSamples();
        if (!stepBackSince.current) stepBackSince.current = now;
        setHint(smallRoomHint(stepBackSince.current, now));
        return;
      }
      stepBackSince.current = 0;
      const wholeBody = Boolean(regions.shins?.length === 2);
      if (!recordingRef.current) {
        setHint(wholeBody ? 'Whole body in frame. Ready to scan.' : 'Shoulders and hips are in. Head to feet is best, and the legs help from behind.');
        return;
      }
      // The settle counts from the first usable frame while recording, not from the countdown's end.
      if (!firstUsableAt.current) firstUsableAt.current = now;
      if (!settleDone(firstUsableAt.current, now) || now - lastBodySample.current < BODY_SAMPLE_INTERVAL_MS) return;
      const box = toNBox(b.boxRaw);
      // A step or a phone shift skips the frame and keeps the samples; only a real gap starts over.
      const decision = outfits.current.length < BODY_SAMPLES ? bodySampleDecision(lastBody.current, box, now, lastBodySample.current, iou) : 'skip';
      if (decision === 'restart') {
        clearSamples();
        firstUsableAt.current = now;
        return setHint('Starting the body scan over, hold still.');
      }
      if (decision === 'skip' && outfits.current.length < BODY_SAMPLES) {
        lastBody.current = box;
        return setHint('Hold still.');
      }
      const img = decision === 'skip' ? null : sampler.current.grab(context.frame);
      const sig = img ? outfitSignature(img, b, 0.4) : null;
      if (sig) {
        outfits.current.push(sig);
        lastBody.current = box;
        lastBodySample.current = now;
        const bp = bodyProportions(b, 0.4);
        if (bp) stageProps.current.push(bp);
        setProgress(Math.min(1, outfits.current.length / BODY_SAMPLES));
        setHint(wholeBody ? '' : 'Feet are out of frame. Still scanning, but legs will not count.');
      }
      if (outfits.current.length >= BODY_SAMPLES && !outfitDoneAt.current) outfitDoneAt.current = now;
      const farDone = farFacesDone(s === 'bodyFront', farFaces.current.length, outfitDoneAt.current, now);
      if (outfits.current.length >= BODY_SAMPLES && !farDone) {
        // Outfit done; hold the pose a little longer so the far face set fills up. The bar shows the
        // far faces now, large enough to read from where the player stands.
        setProgress(Math.min(1, farFaces.current.length / MIN_FAR_FACES));
        setFarWait(true);
        setHint(res.face.length === 1 ? `Look at the phone: ${farFaces.current.length} / ${MIN_FAR_FACES}` : 'Look at the phone.');
        return;
      }
      if (outfits.current.length >= BODY_SAMPLES) {
        const avg = averageOutfits(outfits.current);
        props.current.push(...stageProps.current);
        stageProps.current = [];
        outfits.current = [];
        outfitDoneAt.current = 0;
        lastBody.current = null;
        lastBodySample.current = 0;
        setProgress(0);
        setFarWait(false);
        setRecording(false);
        sfx.lapDone();
        haptic();
        if (s === 'bodyFront') {
          front.current = avg;
          go('bodyBack');
        } else void finish(avg);
      }
    }
  };

  // The face stage needs face boxes only, from a copy no wider than SCAN_CALIB.faceDetectWidth: the
  // body model and a 1080p copy would cost a phone most of each frame for nothing. The body stages
  // keep the full frame and both models.
  useVisionLoop(videoRef, camReady && humanReady && stage !== 'saving' && stage !== 'error' && stage !== 'bodyMode', onFrame, {
    pass: stage === 'face' ? 'face' : 'frame',
    maxWidth: stage === 'face' ? SCAN_CALIB.faceDetectWidth : undefined,
    onFailure: reportFailure,
  });

  const copy = ((): { heading: string; prompt: string } => {
    switch (stage) {
      case 'face':
        if (needsExtra(faceStage.current, FACE_SAMPLES, FACE_MIN_SAMPLES)) return { heading: 'One more look', prompt: currentPrompt(faceStage.current).text };
        if (faceStage.current.lap === 2) return { heading: `Lap 2: ${Math.min(faceIdx, LAP2_PROMPTS.length - 1) + 1} of ${LAP2_PROMPTS.length}`, prompt: `Arm's length. ${currentPrompt(faceStage.current).text}` };
        return { heading: `Face ${Math.min(faceIdx, FACE_SAMPLES - 1) + 1} of ${FACE_SAMPLES}`, prompt: currentPrompt(faceStage.current).text };
      case 'bodyMode':
        return { heading: 'Body scan', prompt: 'The scan needs your shoulders and hips in frame; head to feet is best. Who is holding the phone?' };
      case 'bodyFront':
        return {
          heading: 'Body scan: front',
          prompt:
            bodyMode === 'helper'
              ? 'Friend: point the back camera at the player, whole body in frame, then tap Record.'
              : `Prop the phone up, tap Scan, and step back within ${PROP_COUNTDOWN} seconds. Face the phone.`,
        };
      case 'bodyBack':
        return {
          heading: 'Body scan: back',
          prompt: bodyMode === 'helper' ? 'Player turns around. Friend taps Record again.' : 'Tap Scan, then turn around during the countdown so the camera sees your back.',
        };
      case 'saving':
        return { heading: 'Saving', prompt: savingText ?? 'Uploading your signature.' };
      case 'error':
        return { heading: 'Something went wrong', prompt: errMsg };
    }
  })();
  const { heading, prompt } = copy;

  return (
    <div className="screen camera-screen">
      <div className={`cam-wrap ${facing === 'user' ? 'mirrored' : ''}`}>
        {stage !== 'bodyMode' && <video ref={videoRef} className="cam" autoPlay playsInline muted />}
        {/* The face stage draws the ring instead of detector boxes. */}
        <canvas ref={canvasRef} className={`overlay ${stage === 'face' ? 'off' : ''}`} />
        {stage === 'face' && camReady && humanReady && <ScanRing stage={faceStage.current} reason={ringReason} angles={angles} flourish={flourish} />}
        {(stage === 'bodyFront' || stage === 'bodyBack') && (
          <BodySilhouette side={stage === 'bodyFront' ? 'front' : 'back'} progress={farWait ? 1 : progress} farFaces={farCount} farTarget={MIN_FAR_FACES} farWait={farWait} recording={recording} />
        )}
        {countdown !== null && <div className="countdown">{countdown}</div>}
        {recording && <div className="rec-dot">REC</div>}
      </div>
      <div className="enroll-panel">
        <div className="enroll-top">
          <div>{header}</div>
          {onCancel && (
            <button className="link" onClick={onCancel}>
              Leave
            </button>
          )}
        </div>
        <h2>{heading}</h2>
        <p className="prompt">{prompt}</p>
        {progress > 0 && (
          <div className="bar">
            <div style={{ width: `${progress * 100}%` }} />
          </div>
        )}
        {hint && <p className="hint">{hint}</p>}
        {stage === 'face' && angles && (
          <p className="readout" aria-label="Measured head angle">
            yaw {angles.yaw}° · pitch {angles.pitch}°
          </p>
        )}
        {stage === 'face' && skippable && (
          <button className="btn" onClick={skipAngle}>
            {SKIP_ANGLE_TEXT}
          </button>
        )}
        {stage !== 'bodyMode' && (!camReady || !humanReady) && (
          <p className="hint">
            {camError ?? (camReady ? status : (camNotice ?? 'Starting camera'))}
            {(camError || humanFailed) && (
              <>
                {' '}
                <button className="btn" onClick={camError ? retryCamera : retryModels}>
                  {camError ? 'Retry camera' : 'Retry'}
                </button>
              </>
            )}
          </p>
        )}
        {stage === 'bodyMode' && (
          <div className="mode-pick">
            <button className="btn primary big" onClick={() => chooseMode('helper')}>
              A friend is holding it
            </button>
            <button className="btn big" onClick={() => chooseMode('prop')}>
              It is propped up, I am alone
            </button>
          </div>
        )}
        {(stage === 'bodyFront' || stage === 'bodyBack') && !recording && countdown === null && (
          <button className="btn primary big" disabled={!camReady || !humanReady} onClick={beginScan}>
            {bodyMode === 'helper' ? 'Record' : 'Scan'}
          </button>
        )}
        <div className="row">
          {stage === 'error' && (
            <>
              <button className="btn primary" onClick={retrySave}>
                Try again
              </button>
              <button className="link" onClick={restart}>
                Start over
              </button>
            </>
          )}
          {stage !== 'saving' && stage !== 'error' && (
            <button className="link" onClick={restart}>
              Restart scan
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
