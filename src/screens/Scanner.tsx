import { useRef, useState, type ReactNode } from 'react';
import type { Human, Result } from '@vladmandic/human';
import type { BodyProps, OutfitSig } from '../types';
import { useCamera, type Facing } from '../hooks/useCamera';
import { useVisionLoop } from '../hooks/useVisionLoop';
import { useHumanStatus } from '../hooks/useHumanStatus';
import { compactEmbedding, faceSimilarity, faceYawDeg, MAX_YAW_DEG, SAME_PERSON_MIN } from '../vision/human';
import { averageOutfits, averageProps, bodyProportions, FrameSampler, outfitRegions, outfitSignature } from '../vision/clothing';
import { drawOverlay } from '../vision/overlay';
import { toNBox } from '../vision/geometry';
import { faceRegion, ZoomPass } from '../vision/zoom';
import type { Detection } from '../vision/tracker';
import { haptic, sfx } from '../audio/sfx';

const FACE_PROMPTS = [
  'Look straight at the camera',
  'Turn your head to the left',
  'Turn your head to the right',
  'Turn a little further left',
  'Turn a little further right',
  'Tilt your chin up',
  'Tilt your chin down',
  'Smile, or make a face',
];
const BODY_SAMPLES = 12;
const PROP_COUNTDOWN = 5;

export interface ScanResult {
  face: number[][];
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
  const { ready: humanReady, status } = useHumanStatus();
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
  const { videoRef, ready: camReady, error: camError } = useCamera(facing, stage !== 'saving');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const faces = useRef<number[][]>([]);
  const outfits = useRef<OutfitSig[]>([]);
  const props = useRef<BodyProps[]>([]);
  const front = useRef<OutfitSig | null>(null);
  const stageStart = useRef(performance.now());
  const sampler = useRef(new FrameSampler());
  const zoom = useRef(new ZoomPass());
  const countdownTimer = useRef<number | undefined>(undefined);

  const go = (s: Stage) => {
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
        body: averageProps(props.current),
        outfit: outfit && front.current && back ? { front: front.current, back } : null,
      });
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
      go('error');
    }
  };

  const restart = () => {
    window.clearInterval(countdownTimer.current);
    faces.current = [];
    outfits.current = [];
    props.current = [];
    front.current = null;
    setFaceIdx(0);
    setProgress(0);
    setCountdown(null);
    setRecording(false);
    go(first);
  };

  /** Helper mode: a friend taps Record. Prop mode: a countdown gives you time to step back. */
  const beginScan = () => {
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

  const onFrame = async (res: Result, human: Human) => {
    const v = videoRef.current;
    const canvas = canvasRef.current;
    if (!v) return;
    const now = performance.now();
    const s = stageRef.current;
    if (canvas) {
      const dets: Detection[] = res.body.map((b) => ({ box: toNBox(b.boxRaw), body: b }));
      res.face.forEach((f) => dets.push({ box: toNBox(f.boxRaw), face: f }));
      drawOverlay(canvas, { dets, tracks: [], vidW: res.width, vidH: res.height }, facing === 'user');
    }
    if (s === 'face') {
      if (now - stageStart.current < 1200) return;
      if (res.face.length === 0) return setHint('No face found. Move closer and face the camera.');
      if (res.face.length > 1) return setHint('Only one face in frame please.');
      const detected = res.face[0];
      if (detected.score < 0.7) return setHint('Hold still');
      if (faceYawDeg(detected) > MAX_YAW_DEG + 15) return setHint('Turned too far. Bring your face back a little.');
      // The embedding is taken from a square crop, the same way the game reads faces (see ZoomPass).
      const crops = await zoom.current.run(human, v, faceRegion(toNBox(detected.boxRaw), res.width / res.height));
      const f = crops[0]?.face;
      if (!f?.embedding?.length) return setHint('Hold still');
      if (faces.current.length > 0 && faceSimilarity(f.embedding, faces.current[0]) < SAME_PERSON_MIN) {
        return setHint('That does not look like the same person as frame 1.');
      }
      faces.current.push(compactEmbedding(f.embedding));
      sfx.tick();
      stageStart.current = now;
      setHint('');
      if (faces.current.length >= FACE_PROMPTS.length) {
        if (body) go('bodyMode');
        else void finish(null);
      } else setFaceIdx(faces.current.length);
    } else if (s === 'bodyFront' || s === 'bodyBack') {
      const b = [...res.body].sort((a, c) => c.boxRaw[2] * c.boxRaw[3] - a.boxRaw[2] * a.boxRaw[3])[0];
      const regions = b ? outfitRegions(b, 0.3) : null;
      if (!b || !regions?.top) {
        setHint('Shoulders and hips must both be visible. Step back so the whole body fits.');
        return;
      }
      const wholeBody = Boolean(regions.shins);
      if (!recordingRef.current) {
        setHint(wholeBody ? 'Whole body in frame. Ready to scan.' : 'Head to feet should be in frame for the best scan.');
        return;
      }
      if (now - stageStart.current < 800) return;
      const img = sampler.current.grab(v);
      const sig = img ? outfitSignature(img, b, 0.3) : null;
      if (!sig) return;
      outfits.current.push(sig);
      const bp = bodyProportions(b, 0.3);
      if (bp) props.current.push(bp);
      setProgress(outfits.current.length / BODY_SAMPLES);
      setHint(wholeBody ? '' : 'Feet are out of frame. Still scanning, but legs will not count.');
      if (outfits.current.length >= BODY_SAMPLES) {
        const avg = averageOutfits(outfits.current);
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

  useVisionLoop(videoRef, camReady && humanReady && stage !== 'saving' && stage !== 'error' && stage !== 'bodyMode', onFrame);

  const copy = ((): { heading: string; prompt: string } => {
    switch (stage) {
      case 'face':
        return { heading: `Face ${faceIdx + 1} of ${FACE_PROMPTS.length}`, prompt: FACE_PROMPTS[faceIdx] };
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
          prompt: bodyMode === 'helper' ? 'Player turns around. Friend taps Record again.' : 'Turn around so the camera sees your back, then tap Scan.',
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
        {stage !== 'bodyMode' && (!camReady || !humanReady) && <p className="hint">{camError ?? (camReady ? status : 'Starting camera')}</p>}
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
