import { useEffect, useMemo, useRef, useState } from 'react';
import type { Human, Result } from '@vladmandic/human';
import { BODY_MODEL, UNKNOWN_ID, type OutfitSig, type Profile } from '../types';
import { useVisionLoop, type VisionFrame } from '../hooks/useVisionLoop';
import { useHumanStatus } from '../hooks/useHumanStatus';
import { buildDetections, containsPoint, type Detection } from '../vision/tracker';
import { toNBox, type NBox } from '../vision/geometry';
import { bodyProportions, FrameSampler, outfitSignature } from '../vision/clothing';
import { compactEmbedding, configurePass, FACE_MODEL, faceQuality, faceYawDeg, getHuman, isValidEmbedding, MAX_YAW_DEG, MIN_FACE_PX, unitEmbedding } from '../vision/human';
import { faceRegion, headRegion, ZoomPass } from '../vision/zoom';
import { VisionPipeline, type FaceObservation, type LockState } from '../vision/pipeline';
import { drawOverlay } from '../vision/overlay';
import { topBelief } from '../vision/scoring';
import { DEFAULT_SETTINGS } from '../types';
import { CAM_H, CAM_W, DEFAULT_MOTION, RANGE_LEVELS, rangeMetres, rangeMotion, STILL_MOTION, toCamera, windowAt, type Motion, type Window } from './virtualCamera';

/**
 * Tracking bench: open the app with ?bench. Scans a photo the way the lobby scans players, then
 * points a virtual camera at it and shoots, using the real models and the real game pipeline. Run it
 * on the phone you will play with to see the frame period, lock behaviour, and hit decisions that
 * phone produces, with nobody else in the room.
 */

interface Enrolled {
  id: string;
  name: string;
  profile: Profile;
  /** Face box in photo pixels. */
  face: NBox;
  /** Body (or estimated body) box in photo pixels. */
  body: NBox;
}

/** off-target: the aim point was not on the target's real body, so nothing should have happened. */
type Outcome = 'correct' | 'wrong' | 'unclear' | 'miss' | 'off-target' | 'stale' | 'no-camera';

interface Shot {
  at: number;
  outcome: Outcome;
  target: string;
  resolved?: string;
  elapsedMs: number;
}

interface FrameTrace {
  t: number;
  dets: number;
  /** Index of the detection under the dot, -1 for none, -2 for ambiguous overlap. */
  under: number;
  track: number | null;
  lock: string;
  top: string;
  face: boolean;
  /** Boxes of every detection this frame, rounded, with their track ids: x,y,w,h. */
  boxes: string;
}

export interface BenchStats {
  /** Last few hundred frames, newest last. */
  trace: FrameTrace[];
  frames: number;
  periodMs: number;
  lockFrames: number;
  wrongLockFrames: number;
  targetVisibleFrames: number;
  /** Frames in which the target's body was detected at all, and in which a full-frame face box was attached to it. */
  bodyFrames: number;
  faceFrames: number;
  /** Frames in which a face embedding reached the target's track (via === 'face' with a fresh face). */
  faceEvidenceFrames: number;
  /** Sum and count of the top belief score on the target's track, for the mean. */
  beliefSum: number;
  beliefN: number;
  trackIds: number[];
  shots: Shot[];
}

const FIRE_EVERY_MS = 1300;
/** Seconds spent at each level of the range sweep. */
const RANGE_LEVEL_S = 14;

function emptyStats(): BenchStats {
  return { trace: [], frames: 0, periodMs: NaN, lockFrames: 0, wrongLockFrames: 0, targetVisibleFrames: 0, bodyFrames: 0, faceFrames: 0, faceEvidenceFrames: 0, beliefSum: 0, beliefN: 0, trackIds: [], shots: [] };
}

function summarize(s: BenchStats) {
  const count = (o: Outcome) => s.shots.filter((x) => x.outcome === o).length;
  return {
    frames: s.frames,
    periodMs: Math.round(s.periodMs),
    lockPct: s.targetVisibleFrames ? Math.round((100 * s.lockFrames) / s.targetVisibleFrames) : 0,
    bodyPct: s.frames ? Math.round((100 * s.bodyFrames) / s.frames) : 0,
    facePct: s.frames ? Math.round((100 * s.faceFrames) / s.frames) : 0,
    faceEvidencePct: s.frames ? Math.round((100 * s.faceEvidenceFrames) / s.frames) : 0,
    meanBelief: s.beliefN ? Math.round((100 * s.beliefSum) / s.beliefN) : 0,
    wrongLockFrames: s.wrongLockFrames,
    tracks: s.trackIds.length,
    shots: s.shots.length,
    correct: count('correct'),
    wrong: count('wrong'),
    unclear: count('unclear'),
    miss: count('miss'),
    offTarget: count('off-target'),
    stale: count('stale') + count('no-camera'),
  };
}

export function Bench() {
  const { ready, status } = useHumanStatus();
  const [photo, setPhoto] = useState<HTMLCanvasElement | null>(null);
  const [photoName, setPhotoName] = useState('');
  const [people, setPeople] = useState<Enrolled[]>([]);
  const [targetId, setTargetId] = useState('');
  const [running, setRunning] = useState(false);
  const [moving, setMoving] = useState(true);
  const [rangeRows, setRangeRows] = useState<{ level: number; metres: number; personPx: number; stats: ReturnType<typeof summarize> }[]>([]);
  const motionRef = useRef<Motion>(DEFAULT_MOTION);
  const rangeLevel = useRef(-1);
  const [msg, setMsg] = useState('Load a photo with several people, then scan it.');
  const [lock, setLock] = useState<string>('');
  const [tick, setTick] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const camRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const zoom = useRef(new ZoomPass());
  const sampler = useRef(new FrameSampler());
  const windowRef = useRef<Window | null>(null);
  const stats = useRef<BenchStats>(emptyStats());
  const pipeline = useRef(new VisionPipeline<{ target: string }>({ candidates: [], exclusiveIds: new Set(), eligible: new Set(), hitThreshold: DEFAULT_SETTINGS.hitThreshold, hitMargin: DEFAULT_SETTINGS.hitMargin }));
  const pendingTimer = useRef<number | undefined>(undefined);
  const targetRef = useRef(targetId);
  targetRef.current = targetId;
  const peopleRef = useRef(people);
  peopleRef.current = people;
  // Latest closures for the console hooks below, which are registered once.
  const scanRef = useRef<() => Promise<void>>(async () => undefined);
  const loadRef = useRef<(src: string, name: string) => Promise<void>>(async () => undefined);

  const candidates = useMemo(() => people.map((p) => ({ id: p.id, profile: p.profile })), [people]);
  useEffect(() => {
    pipeline.current.configure({
      candidates,
      exclusiveIds: new Set(candidates.map((c) => c.id)),
      eligible: new Set(candidates.map((c) => c.id)),
      hitThreshold: DEFAULT_SETTINGS.hitThreshold,
      hitMargin: DEFAULT_SETTINGS.hitMargin,
    });
  }, [candidates]);
  const labels = useMemo<Record<string, string>>(() => ({ ...Object.fromEntries(people.map((p) => [p.id, p.name])), [UNKNOWN_ID]: 'STRANGER' }), [people]);

  // Console access for automated checks: window.__bench.stats().
  const rangeRowsRef = useRef(rangeRows);
  rangeRowsRef.current = rangeRows;
  useEffect(() => {
    (window as unknown as { __bench: unknown }).__bench = {
      stats: () => summarize(stats.current),
      raw: () => stats.current,
      people: () => peopleRef.current,
      range: () => rangeRowsRef.current,
      /** Console tuning: load any image URL and scan it the way the lobby would. */
      load: (src: string, name = src) => loadRef.current(src, name),
      scan: () => scanRef.current(),
      /** Console tuning: hold the still camera at range level z and start fresh stats. keepLearned keeps the round's live face samples. */
      setLevel: (z: number, keepLearned = false) => {
        motionRef.current = rangeMotion(z);
        rangeLevel.current = 0;
        stats.current = emptyStats();
        if (!keepLearned) pipeline.current.invalidate();
      },
      liveFaces: () => pipeline.current.liveFaceCounts(),
    };
  }, []);

  // ?bench&auto[=still|drift|range] runs the sample-person check hands-free, for devices that cannot be tapped remotely.
  const auto = useMemo(() => new URL(location.href).searchParams.get('auto'), []);
  const autoStage = useRef<'idle' | 'loaded' | 'scanned' | 'running'>('idle');
  useEffect(() => {
    if (auto === null || !ready) return;
    if (autoStage.current === 'idle') {
      autoStage.current = 'loaded';
      if (auto === 'still') setMoving(false);
      void loadImage(import.meta.env.BASE_URL + '_sample.jpg', 'sample person');
    } else if (autoStage.current === 'loaded' && photo && people.length === 0) {
      autoStage.current = 'scanned';
      void scan();
    } else if (autoStage.current === 'scanned' && people.length > 0 && targetId) {
      autoStage.current = 'running';
      if (auto === 'range') startRange();
      else start();
    }
  }); // eslint-disable-line react-hooks/exhaustive-deps

  loadRef.current = (src, name) => loadImage(src, name);
  const loadImage = (src: string, name: string) =>
    new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        // Square, letterboxed: the same shape Human sees in the scan, so photo coordinates stay simple.
        const side = Math.max(img.naturalWidth, img.naturalHeight);
        const c = document.createElement('canvas');
        c.width = side;
        c.height = side;
        const ctx = c.getContext('2d')!;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, side, side);
        ctx.drawImage(img, (side - img.naturalWidth) / 2, (side - img.naturalHeight) / 2);
        setPhoto(c);
        setPhotoName(name);
        setPeople([]);
        setTargetId('');
        setMsg(`Loaded ${name} (${img.naturalWidth}x${img.naturalHeight}). Scan it to enrol the people in it.`);
        resolve();
      };
      img.onerror = () => reject(new Error('could not load ' + src));
      img.src = src;
    });

  /**
   * Enrol everybody in the photo the way the lobby scan does: square face crops plus the outfit. A
   * face the full-frame detector missed is looked for in a magnified crop of the body, like the game does.
   */
  scanRef.current = () => scan();
  const scan = async () => {
    if (!photo || !ready) return;
    setMsg('Scanning photo…');
    const human: Human = getHuman();
    configurePass(human, 'frame');
    const res = await human.detect(photo);
    const dets = buildDetections(res.body, res.face);
    const img = sampler.current.grab(photo, 320);
    const found: Enrolled[] = [];
    let n = 0;
    const usable = (c: { face: { embedding?: number[]; score: number; rotation?: { angle?: { yaw?: number } } | null } }) =>
      isValidEmbedding(c.face.embedding) && c.face.score >= 0.7 && faceYawDeg(c.face) <= MAX_YAW_DEG;
    for (const d of dets) {
      if (d.associationAmbiguous) continue;
      let fb: NBox | null = d.face ? toNBox(d.face.boxRaw) : null;
      if (!fb && d.body) {
        // Head end of the body box, magnified: where a distant face turns up in the game too.
        const head: NBox = [d.box[0], d.box[1], d.box[2], Math.min(d.box[3], d.box[2] * 1.2)];
        const crops = await zoom.current.run(human, photo, head);
        const nose = d.body.keypoints.find((k) => k.part === 'nose' && k.score >= 0.3);
        const ax = nose ? nose.positionRaw[0] : d.box[0] + d.box[2] / 2;
        const ay = nose ? nose.positionRaw[1] : d.box[1] + d.box[2] * 0.35;
        const own = crops
          .filter(usable)
          .map((c) => ({ c, dist: Math.hypot(c.box[0] + c.box[2] / 2 - ax, c.box[1] + c.box[3] / 2 - ay) }))
          .sort((a, b) => a.dist - b.dist)[0];
        if (own && own.dist < d.box[2] * 0.6) fb = own.c.box;
      }
      if (!fb) continue;
      const embeddings: number[][] = [];
      for (const factor of [5, 6, 7]) {
        const crops = await zoom.current.run(human, photo, faceRegion(fb, 1, factor));
        const own = crops
          .filter(usable)
          .map((c) => ({ c, dist: Math.hypot(c.box[0] + c.box[2] / 2 - fb![0] - fb![2] / 2, c.box[1] + c.box[3] / 2 - fb![1] - fb![3] / 2) }))
          .filter((x) => x.dist < fb![3])
          .sort((a, b) => a.dist - b.dist)[0];
        if (own) embeddings.push(compactEmbedding(own.c.face.embedding!));
      }
      if (embeddings.length === 0) continue;
      const sig: OutfitSig | null = img && d.body ? outfitSignature(img, d.body) : null;
      const outfit = sig ?? { top: [] };
      n++;
      const scale = photo.width;
      found.push({
        id: `p${n}`,
        name: `P${n}`,
        profile: { faceModel: FACE_MODEL, face: embeddings, outfit: { front: outfit, back: outfit }, body: d.body ? bodyProportions(d.body) : null, bodyModel: BODY_MODEL },
        face: [fb[0] * scale, fb[1] * scale, fb[2] * scale, fb[3] * scale],
        body: [d.box[0] * scale, d.box[1] * scale, d.box[2] * scale, d.box[3] * scale],
      });
    }
    setPeople(found);
    setTargetId(found[0]?.id ?? '');
    setMsg(
      found.length
        ? `Enrolled ${found.length} of ${dets.length} people (${found.filter((p) => p.profile.outfit.front.top.length).length} with an outfit). Pick a target and start.`
        : `No usable faces found in this photo (${dets.length} people detected).`,
    );
  };

  // The virtual camera: draw the drifting window into a canvas and stream it into the <video>.
  useEffect(() => {
    if (!running || !photo) return;
    const cam = camRef.current;
    const v = videoRef.current;
    if (!cam || !v) return;
    cam.width = CAM_W;
    cam.height = CAM_H;
    const ctx = cam.getContext('2d')!;
    const stream = cam.captureStream(30);
    v.srcObject = stream;
    v.muted = true;
    void v.play().catch(() => undefined);
    if (rangeLevel.current < 0) motionRef.current = moving ? DEFAULT_MOTION : STILL_MOTION;
    const t0 = performance.now();
    const draw = () => {
      const win = windowAt(photo.width, photo.height, (performance.now() - t0) / 1000, motionRef.current);
      windowRef.current = win;
      // A plain wall behind the photo when the window is larger than it (range sweep).
      ctx.fillStyle = '#6f6a63';
      ctx.fillRect(0, 0, CAM_W, CAM_H);
      const sx = CAM_W / win.w;
      const sy = CAM_H / win.h;
      ctx.drawImage(photo, (0 - win.x) * sx, (0 - win.y) * sy, photo.width * sx, photo.height * sy);
    };
    draw();
    // A timer, not requestAnimationFrame: an occluded (but visible) page stops animating and the
    // captured stream would freeze, which looks like a dead camera to the vision loop.
    const timer = window.setInterval(draw, 33);
    return () => {
      window.clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      v.srcObject = null;
    };
  }, [running, photo, moving]);

  /** The crosshair follows the target's face, with the same rectangle the game uses around the centre dot. */
  const aim = (win: Window | null): NBox | null => {
    const target = peopleRef.current.find((p) => p.id === targetRef.current);
    if (!target || !win) return null;
    const f = toCamera(target.face, win);
    const cx = f[0] + f[2] / 2;
    const cy = f[1] + f[3] * 2.5;
    return [cx - 0.21, cy - 0.15, 0.42, 0.3];
  };
  /** People whose real body is under the aim point, only while that point is actually inside the frame. */
  const truthUnder = (crosshair: NBox, win: Window): Set<string> => {
    const cx = crosshair[0] + crosshair[2] / 2;
    const cy = crosshair[1] + crosshair[3] / 2;
    if (cx < 0 || cx > 1 || cy < 0 || cy > 1) return new Set();
    return new Set(peopleRef.current.filter((p) => containsPoint(toCamera(p.body, win), cx, cy)).map((p) => p.id));
  };

  const onFrame = async (res: Result, human: Human, frame: VisionFrame) => {
    const win = windowRef.current;
    const crosshair = aim(win);
    if (!win || !crosshair) return;
    const dets = buildDetections(res.body, res.face);
    const aspect = res.width / res.height;
    let img: ImageData | null | undefined;
    const outcome = await pipeline.current.processFrame(dets, frame.capturedAt, res.width, res.height, crosshair, {
      sampleOutfit: (d: Detection) => {
        if (!d.body) return null;
        if (img === undefined) img = sampler.current.grab(frame.frame);
        return img ? { sig: outfitSignature(img, d.body), props: bodyProportions(d.body) } : null;
      },
      cropFaces: async (_region, d): Promise<FaceObservation[]> => {
        const region: NBox = d.face ? faceRegion(toNBox(d.face.boxRaw), aspect) : d.body ? headRegion(d.body, d.box, aspect) : d.box;
        const faces = await zoom.current.run(human, frame.frame, region);
        return faces
          .map((zf) => ({ zf, px: Math.min(zf.box[2] * res.width, zf.box[3] * res.height) }))
          .filter(({ zf, px }) => isValidEmbedding(zf.face.embedding) && zf.face.score >= 0.7 && faceYawDeg(zf.face) <= MAX_YAW_DEG && px >= MIN_FACE_PX)
          .map(({ zf, px }) => ({ box: zf.box, embedding: unitEmbedding(zf.face.embedding!), quality: faceQuality(px) }));
      },
      isCurrent: frame.isCurrent,
    });
    if (!outcome) return;
    const s = stats.current;
    s.frames++;
    s.periodMs = outcome.periodMs;
    const under = truthUnder(crosshair, win);
    if (under.has(targetRef.current)) s.targetVisibleFrames++;
    const cx = crosshair[0] + crosshair[2] / 2;
    const cy = crosshair[1] + crosshair[3] / 2;
    const idx = dets.findIndex((d) => containsPoint(d.box, cx, cy));
    if (idx >= 0 && !s.trackIds.includes(outcome.tracks[idx].id)) s.trackIds.push(outcome.tracks[idx].id);
    const l: LockState | null = outcome.lock;
    const tb = outcome.inSight ? topBelief(outcome.inSight) : null;
    // Detection availability for the target: any body overlapping their true box, and a face on it.
    const targetPerson = peopleRef.current.find((p) => p.id === targetRef.current);
    if (targetPerson) {
      const tb0 = toCamera(targetPerson.body, win);
      const tcx = tb0[0] + tb0[2] / 2;
      const tcy = tb0[1] + tb0[3] * 0.4;
      const own = dets.findIndex((d) => containsPoint(d.box, tcx, tcy));
      if (own >= 0) {
        s.bodyFrames++;
        if (dets[own].face) s.faceFrames++;
        const t = outcome.tracks[own];
        if (t.via === 'face' && frame.capturedAt - t.lastFaceAt < 1) s.faceEvidenceFrames++;
        const top = topBelief(t);
        if (top && top.id === targetRef.current) {
          s.beliefSum += top.score;
          s.beliefN++;
        }
      }
    }
    s.trace.push({
      t: Math.round(frame.capturedAt),
      dets: dets.length,
      under: outcome.inSight ? idx : idx >= 0 ? -2 : -1,
      track: outcome.inSight?.id ?? null,
      lock: l ? (l.kind === 'lock' ? 'LOCK ' + l.id : l.kind === 'maybe' ? `${l.id}? ${Math.round(l.score * 100)}` : l.kind) : '',
      top: tb ? `${tb.id} ${Math.round(tb.score * 100)}/${Math.round(tb.margin * 100)} ${tb.via}` : '',
      face: Boolean(idx >= 0 && dets[idx].face),
      boxes: dets.map((d, i) => `#${outcome.tracks[i].id}[${d.box.map((v) => v.toFixed(2)).join(',')}]${d.associationAmbiguous ? 'A' : ''}`).join(' '),
    });
    if (s.trace.length > 400) s.trace.shift();
    if (l?.kind === 'lock') {
      if (under.has(l.id)) s.lockFrames++;
      else s.wrongLockFrames++;
    }
    setLock(l ? (l.kind === 'lock' ? `LOCK ${labels[l.id]}` : l.kind === 'maybe' ? `${labels[l.id]}? ${Math.round(l.score * 100)}%` : l.kind === 'top' ? labels[l.id] : 'UNKNOWN') : '');
    if (outcome.settled) {
      window.clearTimeout(pendingTimer.current);
      settle(outcome.settled.resolution?.id, outcome.settled.track !== null, outcome.settled.elapsedMs, outcome.settled.context.target, under);
    }
    if (overlayRef.current) {
      drawOverlay(overlayRef.current, { dets, tracks: outcome.tracks, vidW: res.width, vidH: res.height, labels }, false);
      const c = overlayRef.current.getContext('2d')!;
      const w = overlayRef.current.width;
      const h = overlayRef.current.height;
      const scale = Math.max(w / res.width, h / res.height);
      const ox = (w - res.width * scale) / 2;
      const oy = (h - res.height * scale) / 2;
      c.strokeStyle = l?.kind === 'lock' ? '#7cff3b' : '#ffd23b';
      c.lineWidth = 2;
      c.beginPath();
      c.arc(cx * res.width * scale + ox, cy * res.height * scale + oy, 10, 0, Math.PI * 2);
      c.stroke();
    }
    if (s.frames % 5 === 0) setTick((n) => n + 1);
  };

  const settle = (resolved: string | undefined, hadTrack: boolean, elapsedMs: number, target: string, under: Set<string>) => {
    const outcome: Outcome = resolved ? (under.has(resolved) ? 'correct' : 'wrong') : !under.has(target) ? 'off-target' : hadTrack ? 'unclear' : 'miss';
    stats.current.shots.push({ at: Date.now(), outcome, target, resolved, elapsedMs });
    setTick((n) => n + 1);
  };

  const fire = () => {
    const win = windowRef.current;
    const crosshair = aim(win);
    if (!win || !crosshair || pipeline.current.hasPending()) return;
    const target = targetRef.current;
    const r = pipeline.current.fire({ target }, crosshair, true);
    const under = truthUnder(crosshair, win);
    if (r.kind === 'busy') return;
    if (r.kind === 'stale' || r.kind === 'no-camera') stats.current.shots.push({ at: Date.now(), outcome: r.kind, target, elapsedMs: r.kind === 'stale' ? r.frameAgeMs : 0 });
    else if (r.kind === 'miss') stats.current.shots.push({ at: Date.now(), outcome: under.has(target) ? 'miss' : 'off-target', target, elapsedMs: 0 });
    else if (r.kind === 'instant') settle(r.settlement.resolution?.id, true, 0, target, under);
    else {
      const { token, burstMs } = r;
      pendingTimer.current = window.setTimeout(() => {
        const s = pipeline.current.expirePending(token);
        const w = windowRef.current;
        const c = w ? aim(w) : null;
        if (s) settle(undefined, s.track !== null, s.elapsedMs, target, w && c ? truthUnder(c, w) : new Set());
      }, burstMs);
    }
    setTick((n) => n + 1);
  };

  useEffect(() => {
    if (!running) return;
    const iv = window.setInterval(fire, FIRE_EVERY_MS);
    return () => window.clearInterval(iv);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  useVisionLoop(videoRef, running && ready && Boolean(photo), onFrame);

  const start = () => {
    stats.current = emptyStats();
    pipeline.current.invalidate();
    rangeLevel.current = -1;
    setRunning(true);
  };
  const stop = () => {
    setRunning(false);
    window.clearTimeout(pendingTimer.current);
    window.clearTimeout(rangeTimer.current);
    rangeLevel.current = -1;
    pipeline.current.invalidate();
  };

  /** Range sweep: the still camera at each RANGE_LEVELS zoom in turn, with separate stats per level. */
  const rangeTimer = useRef<number | undefined>(undefined);
  const startRange = () => {
    setRangeRows([]);
    stats.current = emptyStats();
    pipeline.current.invalidate();
    rangeLevel.current = 0;
    motionRef.current = rangeMotion(RANGE_LEVELS[0]);
    setRunning(true);
    const next = () => {
      const z = RANGE_LEVELS[rangeLevel.current];
      const target = peopleRef.current.find((p) => p.id === targetRef.current);
      const personPx = photo && target ? Math.round((target.body[3] / (photo.height * z)) * CAM_H) : 0;
      // Summarise now: a state updater runs lazily, after the stats below have been reset.
      const row = { level: z, metres: rangeMetres(z), personPx, stats: summarize(stats.current) };
      setRangeRows((rows) => [...rows, row]);
      rangeLevel.current++;
      if (rangeLevel.current >= RANGE_LEVELS.length) {
        setRunning(false);
        rangeLevel.current = -1;
        pipeline.current.invalidate();
        setMsg('Range sweep finished.');
        return;
      }
      stats.current = emptyStats();
      pipeline.current.invalidate();
      window.clearTimeout(pendingTimer.current);
      motionRef.current = rangeMotion(RANGE_LEVELS[rangeLevel.current]);
      rangeTimer.current = window.setTimeout(next, RANGE_LEVEL_S * 1000);
    };
    rangeTimer.current = window.setTimeout(next, RANGE_LEVEL_S * 1000);
  };

  const sum = summarize(stats.current);
  void tick;
  return (
    <div className="screen bench">
      <h2 style={{ margin: 0 }}>Tracking bench</h2>
      <p className="sub">{ready ? msg : status}</p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => void loadImage(import.meta.env.BASE_URL + '_sample.jpg', 'sample person')}>
          Sample person
        </button>
        {import.meta.env.DEV && (
          <button className="btn" onClick={() => void loadImage('/node_modules/@vladmandic/human/assets/samples.jpg', 'sample group')}>
            Sample group (dev)
          </button>
        )}
        <label className="btn">
          Photo from this phone
          <input
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void loadImage(URL.createObjectURL(f), f.name);
            }}
          />
        </label>
        <button className="btn primary" disabled={!photo || !ready || running} onClick={() => void scan()}>
          Scan photo
        </button>
      </div>
      {people.length > 0 && (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <label>
            Aim at{' '}
            <select aria-label="Bench target" value={targetId} onChange={(e) => setTargetId(e.target.value)} disabled={running}>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.profile.outfit.front.top.length ? '' : ' (no outfit)'}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input type="checkbox" checked={moving} onChange={(e) => setMoving(e.target.checked)} disabled={running} /> camera drifts
          </label>
          {running ? (
            <button className="btn" onClick={stop}>
              Stop
            </button>
          ) : (
            <>
              <button className="btn primary" disabled={!targetId || !ready} onClick={start}>
                Start
              </button>
              <button className="btn" disabled={!targetId || !ready} onClick={startRange}>
                Range sweep
              </button>
            </>
          )}
        </div>
      )}
      {photoName && (
        <p className="tag bench-line" style={{ fontSize: 15, color: 'var(--text)' }}>
          {running ? 'RUN' : 'IDLE'} · {sum.frames} frames · {Number.isFinite(sum.periodMs) ? sum.periodMs : '-'} ms · lock {sum.lockPct}% · tracks {sum.tracks} · shots {sum.shots}: hit {sum.correct} wrong {sum.wrong} unclear {sum.unclear} miss {sum.miss} off {sum.offTarget} stale {sum.stale}
        </p>
      )}
      {rangeRows.length > 0 && (
        <table className="bench-stats" style={{ width: '100%', fontSize: 13 }}>
          <thead>
            <tr>
              <th>~m</th>
              <th>px</th>
              <th>period</th>
              <th>body%</th>
              <th>face%</th>
              <th>emb%</th>
              <th>belief</th>
              <th>lock%</th>
              <th>hit/unc/miss/off</th>
              <th>tracks</th>
            </tr>
          </thead>
          <tbody>
            {rangeRows.map((r) => (
              <tr key={r.level}>
                <td>{r.metres}</td>
                <td>{r.personPx}</td>
                <td>{Number.isFinite(r.stats.periodMs) ? r.stats.periodMs : '-'}</td>
                <td>{r.stats.bodyPct}</td>
                <td>{r.stats.facePct}</td>
                <td>{r.stats.faceEvidencePct}</td>
                <td>{r.stats.meanBelief}</td>
                <td>{r.stats.lockPct}</td>
                <td>
                  {r.stats.correct}/{r.stats.unclear}/{r.stats.miss}/{r.stats.offTarget}
                </td>
                <td>{r.stats.tracks}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="cam-wrap bench-cam" ref={wrapRef} style={{ position: 'relative', width: '100%', maxWidth: 360, aspectRatio: '9 / 16', margin: '0 auto', background: '#000' }}>
        <canvas ref={camRef} style={{ display: 'none' }} />
        <video ref={videoRef} className="cam" autoPlay playsInline muted />
        <canvas ref={overlayRef} className="overlay" />
        {running && <div className="lock-label" style={{ position: 'absolute', bottom: 8, left: 8, color: lock.startsWith('LOCK') ? 'var(--good)' : 'var(--warn)' }}>{lock || '…'}</div>}
      </div>
      {photoName && (
        <table className="bench-stats" style={{ width: '100%', fontSize: 13 }}>
          <tbody>
            <tr>
              <td>frames</td>
              <td>{sum.frames}</td>
              <td>period</td>
              <td>{Number.isFinite(sum.periodMs) ? `${sum.periodMs} ms` : '-'}</td>
              <td>lock on target</td>
              <td>{sum.lockPct}%</td>
            </tr>
            <tr>
              <td>tracks</td>
              <td>{sum.tracks}</td>
              <td>wrong locks</td>
              <td>{sum.wrongLockFrames}</td>
              <td>shots</td>
              <td>{sum.shots}</td>
            </tr>
            <tr>
              <td>hits</td>
              <td>{sum.correct}</td>
              <td>wrong</td>
              <td>{sum.wrong}</td>
              <td>unclear / miss / off-target / stale</td>
              <td>
                {sum.unclear} / {sum.miss} / {sum.offTarget} / {sum.stale}
              </td>
            </tr>
          </tbody>
        </table>
      )}
      <p className="tag">
        Shots fire automatically every {FIRE_EVERY_MS / 1000}s at the chosen person. <b>Range sweep</b> holds the still camera at each of {RANGE_LEVELS.length} distances for {RANGE_LEVEL_S}s (metres are estimates from the person's height in pixels). "tracks" is how many track ids the person under the dot went through; 1 means the tracker never lost them.
      </p>
    </div>
  );
}
