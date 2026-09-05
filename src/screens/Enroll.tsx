import { useRef, useState } from 'react';
import type { Human, Result } from '@vladmandic/human';
import { backend } from '../net';
import type { Player, TorsoSig } from '../types';
import { useCamera } from '../hooks/useCamera';
import { useVisionLoop } from '../hooks/useVisionLoop';
import { useHumanStatus } from '../hooks/useHumanStatus';
import { compactEmbedding } from '../vision/human';
import { averageSigs, FrameSampler, torsoQuad, torsoSignature } from '../vision/clothing';
import { drawOverlay } from '../vision/overlay';
import type { NBox } from '../vision/geometry';
import type { Detection } from '../vision/tracker';
import { sfx } from '../audio/sfx';

interface Props {
  code: string;
  pid: string;
  me: Player;
  onLeave: () => void;
}

const FACE_PROMPTS = [
  'Look straight at the camera',
  'Turn your head a little to the left',
  'Turn your head a little to the right',
  'Tilt your chin up slightly',
  'Tilt your chin down slightly',
];
const BODY_SAMPLES = 10;

type Stage = 'face' | 'bodyFront' | 'bodyBack' | 'saving' | 'error';

export function Enroll({ code, pid, me, onLeave }: Props) {
  const { ready: humanReady, status } = useHumanStatus();
  const [stage, setStageState] = useState<Stage>('face');
  const stageRef = useRef<Stage>('face');
  const [faceIdx, setFaceIdx] = useState(0);
  const [hint, setHint] = useState('');
  const [progress, setProgress] = useState(0);
  const [errMsg, setErrMsg] = useState('');
  const { videoRef, ready: camReady, error: camError } = useCamera('user', stage !== 'saving');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const faces = useRef<number[][]>([]);
  const sigs = useRef<number[][]>([]);
  const front = useRef<number[] | null>(null);
  const stageStart = useRef(performance.now());
  const sampler = useRef(new FrameSampler());

  const go = (s: Stage) => {
    stageRef.current = s;
    stageStart.current = performance.now();
    setStageState(s);
    setHint('');
  };

  const save = async (torso: TorsoSig) => {
    go('saving');
    try {
      await backend.setProfile(code, pid, { face: faces.current, torso });
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
      go('error');
    }
  };

  const restart = () => {
    faces.current = [];
    sigs.current = [];
    front.current = null;
    setFaceIdx(0);
    setProgress(0);
    go('face');
  };

  const onFrame = (res: Result, human: Human) => {
    const v = videoRef.current;
    const canvas = canvasRef.current;
    if (!v) return;
    const now = performance.now();
    const s = stageRef.current;
    if (canvas) {
      const dets: Detection[] = res.body.map((b) => ({ box: b.boxRaw as NBox, body: b }));
      res.face.forEach((f) => dets.push({ box: f.boxRaw as NBox, face: f }));
      drawOverlay(canvas, { dets, tracks: [], vidW: res.width, vidH: res.height }, true);
    }
    if (s === 'face') {
      if (now - stageStart.current < 1200) return;
      if (res.face.length === 0) return setHint('No face found. Move closer and face the camera.');
      if (res.face.length > 1) return setHint('Only one face in frame please.');
      const f = res.face[0];
      if (!f.embedding || f.score < 0.7) return setHint('Hold still');
      if (faces.current.length > 0 && human.match.similarity(f.embedding, faces.current[0]) < 0.4) {
        return setHint('That does not look like the same person as frame 1.');
      }
      faces.current.push(compactEmbedding(f.embedding));
      sfx.tick();
      stageStart.current = now;
      setHint('');
      if (faces.current.length >= FACE_PROMPTS.length) go('bodyFront');
      else setFaceIdx(faces.current.length);
    } else if (s === 'bodyFront' || s === 'bodyBack') {
      if (now - stageStart.current < 2500) return;
      const body = [...res.body].sort((a, b) => b.boxRaw[2] * b.boxRaw[3] - a.boxRaw[2] * a.boxRaw[3])[0];
      const quad = body ? torsoQuad(body, 0.3) : null;
      if (!quad) return setHint('Shoulders and hips must both be visible. Step back or prop the phone up.');
      const img = sampler.current.grab(v);
      if (!img) return;
      sigs.current.push(torsoSignature(img, quad));
      setProgress(sigs.current.length / BODY_SAMPLES);
      setHint('');
      if (sigs.current.length >= BODY_SAMPLES) {
        const avg = averageSigs(sigs.current);
        sigs.current = [];
        setProgress(0);
        sfx.tick();
        if (s === 'bodyFront') {
          front.current = avg;
          go('bodyBack');
        } else {
          void save({ front: front.current!, back: avg });
        }
      }
    }
  };

  useVisionLoop(videoRef, camReady && humanReady && stage !== 'saving' && stage !== 'error', onFrame);

  const heading =
    stage === 'face'
      ? `Face ${faceIdx + 1} of ${FACE_PROMPTS.length}`
      : stage === 'bodyFront'
        ? 'Body scan: front'
        : stage === 'bodyBack'
          ? 'Body scan: back'
          : stage === 'saving'
            ? 'Saving profile'
            : 'Something went wrong';
  const prompt =
    stage === 'face'
      ? FACE_PROMPTS[faceIdx]
      : stage === 'bodyFront'
        ? 'Step back so your shoulders and hips are in frame. Prop the phone up or have a friend hold it.'
        : stage === 'bodyBack'
          ? 'Now turn around so the camera sees your back.'
          : stage === 'saving'
            ? 'Uploading your face and clothing signature.'
            : errMsg;

  return (
    <div className="screen camera-screen">
      <div className="cam-wrap mirrored">
        <video ref={videoRef} className="cam" autoPlay playsInline muted />
        <canvas ref={canvasRef} className="overlay" />
      </div>
      <div className="enroll-panel">
        <div className="enroll-top">
          <span className="chip" style={{ background: me.color }}>
            {me.name}
          </span>
          <button className="link" onClick={onLeave}>
            Leave
          </button>
        </div>
        <h2>{heading}</h2>
        <p className="prompt">{prompt}</p>
        {progress > 0 && (
          <div className="bar">
            <div style={{ width: `${progress * 100}%` }} />
          </div>
        )}
        {hint && <p className="hint">{hint}</p>}
        {(!camReady || !humanReady) && <p className="hint">{camError ?? (camReady ? status : 'Starting camera')}</p>}
        <div className="row">
          {stage === 'error' && (
            <button className="btn primary" onClick={restart}>
              Try again
            </button>
          )}
          {stage !== 'saving' && stage !== 'error' && (
            <button className="link" onClick={restart}>
              Restart enrollment
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
