import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Human, Result } from '@vladmandic/human';
import type { BodyProps, OutfitSig } from '../types';
import { useCamera, type Facing } from '../hooks/useCamera';
import { useVisionLoop, type VisionFrame } from '../hooks/useVisionLoop';
import { useHumanStatus } from '../hooks/useHumanStatus';
import { compactEmbedding, FACE_SAMPLES, faceYawDeg, MAX_YAW_DEG, MIN_FACE_PX, isValidEmbedding } from '../vision/human';
import { faceBigEnough, hintFor, holdStep, initialScanState, judgePose, promptFor, samePerson, SCAN_CALIB, type Judgement, type ScanState } from '../vision/scan';
import { averageOutfits, averageProps, bodyProportions, FrameSampler, outfitRegions, outfitSignature } from '../vision/clothing';
import { drawOverlay } from '../vision/overlay';
import { iou, toNBox, type NBox } from '../vision/geometry';
import { faceRegion, ZoomPass } from '../vision/zoom';
import type { Detection } from '../vision/tracker';
import { haptic, sfx } from '../audio/sfx';

/**
 * The eight prompts, their head-angle bands, the hold and the same-person rule live in
 * src/vision/scan.ts (pure, unit-tested). This component only feeds it measured angles and shows
 * the hint it returns, plus a live yaw/pitch readout so a real phone tells us what the model sees.
 */
const BODY_SAMPLES = 12;
/**
 * Face samples taken from metres away during the front body scan. These match a round far better
 * than the close selfie set, so the front stage keeps recording until it has MIN_FAR_FACES of them
 * (or gives up after FAR_FACE_PATIENCE_MS in poor light), not just until the outfit is sampled.
 */
const FAR_FACE_SAMPLES = 12;
const MIN_FAR_FACES = 6;
const FAR_FACE_INTERVAL_MS = 250;
const FAR_FACE_PATIENCE_MS = 9000;
const PROP_COUNTDOWN = 5;
const BODY_SAMPLE_INTERVAL_MS = 150;

export interface ScanResult {
  face: number[][];
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
  /** A known face sample of this player, so far samples taken during the body scan are verified as theirs. */
  referenceFace?: number[];
  onDone: (r: ScanResult) => Promise<void>;
  onCancel?: () => void;
}

type Stage = 'face' | 'bodyMode' | 'bodyFront' | 'bodyBack' | 'saving' | 'error';
type BodyMode = 'helper' | 'prop';

/** Camera-driven capture of face angles, outfit colours, and body ratios. Which parts run is up to the caller. */
export function Scanner({ face, body, outfit, header, savingText, referenceFace, onDone, onCancel }: Props) {
  const { ready: humanReady, status, failed: humanFailed, retry: retryModels } = useHumanStatus();
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
  const { videoRef, ready: camReady, error: camError, retry: retryCamera } = useCamera(facing, stage !== 'saving');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const faces = useRef<number[][]>([]);
  const farFaces = useRef<number[][]>([]);
  const scan = useRef<ScanState>(initialScanState());
  const [angles, setAngles] = useState<{ yaw: number; pitch: number } | null>(null);
  const lastFarFace = useRef(0);
  const outfits = useRef<OutfitSig[]>([]);
  const props = useRef<BodyProps[]>([]);
  const stageProps = useRef<BodyProps[]>([]);
  const lastBody = useRef<NBox | null>(null);
  const lastBodySample = useRef(0);
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

  const finish = async (back: OutfitSig | null) => {
    go('saving');
    try {
      await onDone({
        face: faces.current,
        farFace: farFaces.current,
        body: averageProps(props.current),
        outfit: outfit && front.current && back ? { front: front.current, back } : null,
      });
    } catch (e) {
      if (!mounted.current) return;
      setErrMsg(e instanceof Error ? e.message : String(e));
      go('error');
    }
  };

  const restart = () => {
    window.clearInterval(countdownTimer.current);
    faces.current = [];
    farFaces.current = [];
    scan.current = initialScanState();
    setAngles(null);
    outfits.current = [];
    props.current = [];
    stageProps.current = [];
    lastBody.current = null;
    lastBodySample.current = 0;
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
      if (now - stageStart.current < SCAN_CALIB.settleMs) return;
      if (res.face.length === 0) return setHint('No face found. Move closer and face the camera.');
      if (res.face.length > 1) return setHint('Only one face in frame please.');
      const detected = res.face[0];
      if (detected.score < 0.7) return setHint('Hold still');
      if (!faceBigEnough(detected.boxRaw[2] * res.width, detected.boxRaw[3] * res.height)) {
        return setHint('Move closer so your face is clear.');
      }
      // The embedding, and the head angle, come from a square crop, the same way the game reads faces (see
      // ZoomPass): the full-frame pass only finds boxes, so it cannot judge the angle.
      const crops = await zoom.current.run(human, context.frame, faceRegion(toNBox(detected.boxRaw), res.width / res.height));
      if (!isCurrent()) return;
      // A magnified crop can include a neighbour. Never take an arbitrary first face.
      if (crops.length !== 1 || iou(crops[0].box, toNBox(detected.boxRaw)) < 0.25) {
        return setHint('Keep just your face in frame and hold still.');
      }
      const f = crops[0].face;
      if (!isValidEmbedding(f.embedding) || f.score < 0.7 || !Number.isFinite(faceYawDeg(f))) return setHint('Hold still and face the camera a little more.');
      const yawSigned = ((f.rotation?.angle?.yaw ?? 0) * 180) / Math.PI;
      const pitchSigned = ((f.rotation?.angle?.pitch ?? 0) * 180) / Math.PI;
      setAngles({ yaw: Math.round(yawSigned), pitch: Math.round(pitchSigned) });
      // The prompt must actually be performed: the head angle has to sit in the requested band, and
      // stay there for a couple of frames, before the sample counts. The judgement names the one
      // thing to change; a turn past what enrolment keeps is "turn back", whatever the prompt.
      const prompt = promptFor(faces.current.length);
      let judgement: Judgement = judgePose(prompt, yawSigned, pitchSigned, scan.current);
      if (judgement.ok && Math.abs(yawSigned) > SCAN_CALIB.enrolYawMax) judgement = { ok: false, reason: 'turn-less', latch: {} };
      const held = holdStep(scan.current, judgement);
      if (!held.ready) {
        scan.current = held.state;
        return setHint(hintFor(prompt, judgement.reason));
      }
      // A different face than the earlier samples: keep the hold so the next good frame retries at once.
      if (!samePerson(f.embedding, faces.current)) {
        scan.current = { ...scan.current, hold: SCAN_CALIB.holdFrames - 1 };
        return setHint('That does not look like the same person as the earlier frames.');
      }
      scan.current = held.state;
      faces.current.push(compactEmbedding(f.embedding));
      sfx.tick();
      stageStart.current = performance.now();
      setHint('');
      if (faces.current.length >= FACE_SAMPLES) {
        if (body) go('bodyMode');
        else void finish(null);
      } else setFaceIdx(faces.current.length);
    } else if (s === 'bodyFront' || s === 'bodyBack') {
      const clearSamples = () => {
        outfits.current = [];
        stageProps.current = [];
        lastBody.current = null;
        lastBodySample.current = 0;
        setProgress(0);
      };
      if (res.body.length > 1 || res.face.length > 1) {
        clearSamples();
        setHint('Only the player being scanned should be in frame.');
        return;
      }
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
          const known = referenceFace ? [referenceFace, ...faces.current] : faces.current;
          if (f && isValidEmbedding(f.embedding) && f.score >= 0.7 && faceYawDeg(f) <= MAX_YAW_DEG && samePerson(f.embedding, known)) {
            farFaces.current.push(compactEmbedding(f.embedding));
          }
        }
      }
      const regions = b ? outfitRegions(b, 0.4, res.width / res.height) : null;
      if (!b || !regions?.top) {
        if (lastBodySample.current && now - lastBodySample.current > 1500) clearSamples();
        setHint('Shoulders and hips must both be visible. Step back so the whole body fits.');
        return;
      }
      const wholeBody = Boolean(regions.shins?.length === 2);
      if (!recordingRef.current) {
        setHint(wholeBody ? 'Whole body in frame. Ready to scan.' : 'Head to feet should be in frame for the best scan.');
        return;
      }
      if (now - stageStart.current < 800 || now - lastBodySample.current < BODY_SAMPLE_INTERVAL_MS) return;
      const box = toNBox(b.boxRaw);
      if (lastBody.current && (iou(lastBody.current, box) < 0.25 || now - lastBodySample.current > 1500)) clearSamples();
      const img = sampler.current.grab(context.frame);
      const sig = img ? outfitSignature(img, b, 0.4) : null;
      if (!sig) return;
      outfits.current.push(sig);
      lastBody.current = box;
      lastBodySample.current = now;
      const bp = bodyProportions(b, 0.4);
      if (bp) stageProps.current.push(bp);
      setProgress(Math.min(1, outfits.current.length / BODY_SAMPLES));
      setHint(wholeBody ? '' : 'Feet are out of frame. Still scanning, but legs will not count.');
      const farDone = s !== 'bodyFront' || farFaces.current.length >= MIN_FAR_FACES || now - stageStart.current > FAR_FACE_PATIENCE_MS;
      if (outfits.current.length >= BODY_SAMPLES && !farDone) {
        // Outfit done; hold the pose a little longer so the far face set fills up.
        setHint(res.face.length === 1 ? `Look at the phone: ${farFaces.current.length} of ${MIN_FAR_FACES} far face samples.` : 'Look at the phone so it can learn your face from here.');
        return;
      }
      if (outfits.current.length >= BODY_SAMPLES) {
        const avg = averageOutfits(outfits.current);
        props.current.push(...stageProps.current);
        stageProps.current = [];
        outfits.current = [];
        setProgress(0);
        setRecording(false);
        sfx.tick();
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
  });

  const copy = ((): { heading: string; prompt: string } => {
    switch (stage) {
      case 'face':
        return { heading: `Face ${faceIdx + 1} of ${FACE_SAMPLES}`, prompt: promptFor(faceIdx).text };
      case 'bodyMode':
        return { heading: 'Body scan', prompt: 'The scan needs your whole body, head to feet. Who is holding the phone?' };
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
        <canvas ref={canvasRef} className="overlay" />
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
        {stage !== 'bodyMode' && (!camReady || !humanReady) && (
          <p className="hint">
            {camError ?? (camReady ? status : 'Starting camera')}
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
            <button className="btn primary" onClick={restart}>
              Try again
            </button>
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
