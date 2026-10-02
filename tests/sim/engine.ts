import { buildDetections, faceOwner, type Detection } from '../../src/vision/tracker';
import { VisionPipeline, type FireResult, type FrameOutcome, type LockState } from '../../src/vision/pipeline';
import { UNKNOWN_ID } from '../../src/types';
import type { Candidate } from '../../src/vision/scoring';
import type { NBox } from '../../src/vision/geometry';
import { Rng } from './rng';
import type { Recorder } from '../../src/debug/recorder';
import { buildScene, cropFaces, DEFAULT_DETECTOR, detect, faceBox, FRAME_H, FRAME_W, hitBox, personBox, sampleOutfit, step, torsoPixelsOf, type DetectorModel, type Pan, type Person, type PersonSpec, type Scene } from './world';

export interface SimOptions {
  seed: number;
  /** Time the phone spends in the full-frame detector per frame. */
  inferenceMs: number;
  /** Time per magnified face crop. */
  cropMs: number;
  /** Share of frames that take `hiccupFactor` times longer (garbage collection, thermal throttling). */
  hiccupChance: number;
  hiccupFactor: number;
  durationMs: number;
  fireEveryMs: number;
  /** Hand shake, as a fraction of the frame. */
  aimSd: number;
  /**
   * Where on the target the shooter aims: the middle of their box ('centre'), or the middle of the
   * widest part of their torso that nobody nearer covers ('visible'), the way a player aims at the
   * sliver of a half-hidden opponent. With nothing visible, 'visible' aims at the middle too.
   */
  aimAt?: 'centre' | 'visible';
  detector: DetectorModel;
  /** Who the shooter is aiming at throughout. */
  target: string;
  hitThreshold: number;
  hitMargin: number;
  /** Outcomes that get a frame trace in SimResult.wrongTraces; wrong hits and wrong locks always do. */
  traceOutcomes: Outcome[];
  /** Side-to-side camera pan; the aim keeps following the target through it. */
  pan?: Pan;
  /** Capture the round as a replayable recording (src/debug/recorder.ts). */
  recorder?: Recorder;
  /**
   * Frame-by-frame diagnosis: called after every frame with what the detector saw, who each
   * detection and face crop really belonged to, and the pipeline's outcome. Never changes the round.
   */
  probe?: (event: ProbeFrame | ProbeFire) => void;
}

/** A tap as the probe sees it: where the dot was, who was really visible under it, and what the pipeline did. */
export interface ProbeFire {
  kind: 'fire';
  t: number;
  aim: NBox;
  visible: Person | null;
  result: FireResult<{ t: number }>;
}

export interface ProbeFrame {
  kind: 'frame';
  capturedAt: number;
  completedAt: number;
  scene: Scene;
  dets: Detection[];
  /** The person each detection's body (or face, for a face-only detection) came from; null for a ghost. */
  owners: (Person | null)[];
  /** Every face a crop returned this frame, with the person it really was and the detection the pipeline gave it to (-1: nobody). */
  faces: { box: NBox; person: Person | null; det: number }[];
  outcome: FrameOutcome<{ t: number }>;
  crosshair: NBox;
}

export const DEFAULT_OPTIONS: Omit<SimOptions, 'target'> = {
  seed: 1,
  inferenceMs: 180,
  cropMs: 20,
  hiccupChance: 0,
  hiccupFactor: 3,
  durationMs: 30000,
  fireEveryMs: 1300,
  aimSd: 0.02,
  detector: DEFAULT_DETECTOR,
  hitThreshold: 0.5,
  hitMargin: 0.2,
  traceOutcomes: [],
};

/** ambiguous: the dot sat within the detector's jitter band of a nearer person's edge, so neither verdict is provable. */
export type Outcome = 'correct' | 'wrong' | 'ambiguous' | 'unclear' | 'miss' | 'stale' | 'no-camera' | 'busy';

export interface ShotRecord {
  t: number;
  outcome: Outcome;
  resolvedId?: string;
  elapsedMs: number;
}

export interface SimResult {
  shots: ShotRecord[];
  counts: Record<Outcome, number>;
  /** Shots taken while the target really was the visible person under the dot: the only ones that could hit. */
  possibleShots: number;
  frames: number;
  /** Frames where the dot was on the target and the label said LOCK with the right name. */
  lockedFrames: number;
  wrongLockFrames: number;
  /** Frames where the crosshair sat on a non-player and the label still named a player with a "maybe". */
  maybeOnNonPlayer: number;
  firstLockMs: number | null;
  /** Mean time from the tap to a correct hit, in ms (0 for an instant hit); null without a hit. */
  hitLatencyMs: number | null;
  periodMs: number;
  /** Distinct track ids the target body went through: continuity churn. */
  targetTrackIds: number;
  /** Compact per-frame trace around every wrong decision (last frames before it), for diagnosis. */
  wrongTraces: string[][];
}

export interface Scenario {
  name: string;
  /** What a real round would show; used in the report only. */
  expect: string;
  people: PersonSpec[];
  options: Partial<SimOptions> & { target: string };
}

export async function simulate(scenario: Scenario, overrides: Partial<SimOptions> = {}): Promise<SimResult> {
  const opts: SimOptions = { ...DEFAULT_OPTIONS, ...scenario.options, ...overrides };
  const rng = new Rng(opts.seed);
  const scene = buildScene(rng, scenario.people, 'me');
  scene.pan = opts.pan;
  const candidates: Candidate[] = Object.entries(scene.profiles).map(([id, profile]) => ({ id, profile }));
  const eligible = new Set(candidates.map((c) => c.id).filter((id) => id !== scene.selfId));
  let now = 0;
  const pipeline = new VisionPipeline<{ t: number; under: Truth }>(
    { candidates, exclusiveIds: new Set(candidates.map((c) => c.id)), eligible, hitThreshold: opts.hitThreshold, hitMargin: opts.hitMargin },
    () => now,
  );
  const target = scene.people.find((p) => p.id === opts.target);
  if (!target) throw new Error('unknown target ' + opts.target);

  const result: SimResult = {
    shots: [],
    counts: { correct: 0, wrong: 0, ambiguous: 0, unclear: 0, miss: 0, stale: 0, 'no-camera': 0, busy: 0 },
    possibleShots: 0,
    frames: 0,
    lockedFrames: 0,
    wrongLockFrames: 0,
    maybeOnNonPlayer: 0,
    firstLockMs: null,
    hitLatencyMs: null,
    periodMs: NaN,
    targetTrackIds: 0,
    wrongTraces: [],
  };
  const record = (t: number, outcome: Outcome, elapsedMs = 0, resolvedId?: string) => {
    result.shots.push({ t, outcome, elapsedMs, resolvedId });
    result.counts[outcome]++;
  };
  /**
   * Ground truth at one instant. `visible` is the nearest person whose real body contains the aim
   * point (a nearer person hides anybody behind them); only they may be credited, a hidden player
   * never is. `edge` lists people whose body is within the detector's jitter band of the point: when
   * one of them is nearer than `visible`, the visible person cannot be proven and the case is ambiguous.
   */
  interface Truth {
    visible: Person | null;
    /** Whether the dot is on the visible person's head or torso (world.ts hitBox), where a shot may land. */
    visibleHittable: boolean;
    /** Whether the dot is well inside the visible person, beyond the detector's jitter band of their edge. */
    visibleDeep: boolean;
    /** People whose body contains the dot but are farther than `visible` (hidden behind them). */
    behind: Person[];
    edge: Person[];
    hittable: (p: Person) => boolean;
  }
  const inBox = (b: NBox, px: number, py: number, gx = 0, gy = 0) => px >= b[0] - gx && px <= b[0] + b[2] + gx && py >= b[1] - gy && py <= b[1] + b[3] + gy;
  const truthAt = (crosshair: NBox): Truth => {
    const cx = crosshair[0] + crosshair[2] / 2;
    const cy = crosshair[1] + crosshair[3] / 2;
    let visible: Person | null = null;
    let visibleHittable = false;
    let visibleDeep = false;
    const inside: Person[] = [];
    const edge: Person[] = [];
    for (const p of scene.people) {
      const full = personBox(p);
      const [x, y, w, h] = full;
      // The whole silhouette hides what is behind it; only the head and torso can take a hit.
      const isInside = inBox(full, cx, cy);
      // Three sigma of the detector's box jitter (world.ts, 5% width): inside this band the detector cannot know.
      const gx = w * 0.15;
      const gy = h * 0.09;
      const hit = hitBox(p);
      const near = inBox(hit, cx, cy, gx, gy);
      const deep = cx >= x + gx && cx <= x + w - gx && cy >= y + gy && cy <= y + h - gy;
      if (isInside) {
        inside.push(p);
        if (!visible || p.distance < visible.distance) {
          visible = p;
          visibleHittable = inBox(hit, cx, cy);
          visibleDeep = deep;
        }
      } else if (near) edge.push(p);
    }
    return { visible, visibleHittable, visibleDeep, behind: inside.filter((p) => p !== visible), edge, hittable: (p) => p.player && eligible.has(p.id) && !p.copyOf };
  };
  /** Verdict for a resolved id against the truth at the tap. */
  const judge = (truth: Truth, id: string): 'correct' | 'wrong' | 'ambiguous' => {
    const v = truth.visible;
    if (v && v.id === id && truth.hittable(v)) {
      // The right person, but on an arm, a leg or the empty corner of their box: the game's region
      // from jittered landmarks may honestly disagree with the ideal one, so this is never credited
      // and never counted as a wrong hit either.
      if (!truth.visibleHittable) return 'ambiguous';
      // Somebody nearer may actually have covered the point.
      return truth.edge.some((p) => p.distance < v.distance) ? 'ambiguous' : 'correct';
    }
    const e = truth.edge.find((p) => p.id === id && truth.hittable(p));
    if (e && (!v || e.distance < v.distance)) return 'ambiguous';
    // A person behind the visible one, hit while the dot sat within jitter of the visible one's edge:
    // the detector may honestly have seen the nearer box end short of the dot.
    const b = truth.behind.find((p) => p.id === id && truth.hittable(p));
    if (b && v && !truth.visibleDeep) return 'ambiguous';
    return 'wrong';
  };
  /** Whether a lock on `id` is defensible at this instant. */
  const lockOk = (truth: Truth, id: string) => judge(truth, id) !== 'wrong';
  const underDot = (crosshair: NBox): Truth => truthAt(crosshair);
  const settle = (s: { track: unknown; resolution: { id: string } | null; elapsedMs: number; context: { t: number; under: Truth } }) => {
    if (s.resolution) {
      const verdict = judge(s.context.under, s.resolution.id);
      record(s.context.t, verdict, s.elapsedMs, s.resolution.id);
      if (verdict === 'wrong') recordWrong(s.context.t, `hit ${s.resolution.id} after ${s.elapsedMs}ms; visible under the dot at the tap: ${s.context.under.visible?.id ?? 'nobody'}`);
    } else {
      const outcome: Outcome = s.track ? 'unclear' : 'miss';
      record(s.context.t, outcome, s.elapsedMs);
      if (opts.traceOutcomes.includes(outcome)) recordWrong(s.context.t, `${outcome} after ${s.elapsedMs}ms; visible: ${s.context.under.visible?.id ?? 'nobody'}`);
    }
  };

  /** Middle of the widest stretch of the target's torso (world.ts hitBox) at height y that no nearer person's silhouette covers. */
  const visibleMiddle = (y: number): number | null => {
    const [hx, , hw] = hitBox(target);
    let open: [number, number][] = [[hx, hx + hw]];
    for (const q of scene.people) {
      if (q === target || q.distance >= target.distance) continue;
      const [qx, qy, qw, qh] = personBox(q);
      if (y < qy || y > qy + qh) continue;
      open = open.flatMap(([a, b]): [number, number][] => [[a, Math.min(b, qx)], [Math.max(a, qx + qw), b]]).filter(([a, b]) => b > a);
    }
    if (!open.length) return null;
    const [a, b] = open.reduce((best, s) => (s[1] - s[0] > best[1] - best[0] ? s : best));
    return (a + b) / 2;
  };
  const aim = (): NBox => {
    const [x, y, w, h] = personBox(target);
    const ty = y + h * 0.45;
    const tx = (opts.aimAt === 'visible' ? visibleMiddle(ty) : null) ?? x + w / 2;
    const cx = tx + rng.gauss(0, opts.aimSd);
    const cy = ty + rng.gauss(0, opts.aimSd);
    return [cx - 0.21, cy - 0.15, 0.42, 0.3];
  };

  /** The person whose face a crop's box is (the crop returns a jittered copy of their face box). */
  const nearestFace = (b: NBox): Person | null => {
    let best: Person | null = null;
    let bestD = Infinity;
    for (const p of scene.people) {
      const f = faceBox(p);
      const d = Math.hypot(f[0] - b[0], f[1] - b[1]);
      if (d < bestD) [best, bestD] = [p, d];
    }
    return best;
  };

  let pending: { token: object; deadline: number } | null = null;
  let lastCrops = 2;
  let nextFire = 1500;
  let t = 0;
  let lastStep = 0;
  const seenTrackIds = new Set<number>();
  // The world keeps moving while a frame is being processed and while the player taps FIRE.
  const advanceTo = (ms: number) => {
    if (ms <= lastStep) return;
    step(scene, (ms - lastStep) / 1000);
    lastStep = ms;
  };
  const recent: string[] = [];
  const noteFrame = (line: string) => {
    recent.push(line);
    if (recent.length > 8) recent.shift();
  };
  const recordWrong = (tapMs: number, verdict: string) => result.wrongTraces.push([...recent, `${tapMs} FIRE -> ${verdict}`]);
  while (t < opts.durationMs) {
    const capturedAt = t;
    advanceTo(capturedAt);
    const raw = detect(rng, scene, opts.detector);
    const dets = buildDetections(raw.bodies, raw.faces);
    const crosshair = aim();
    // The lock is judged against the scene as it was when the frame was captured. The label appears
    // one inference period later, but it describes what the detector saw; judging it against a
    // scene the taps have since advanced would penalise display latency, not recognition.
    const captureTruth = underDot(crosshair);
    // The pipeline decides how many faces to crop only while processing, but the frame's completion
    // time is needed first (taps happen during inference). The previous frame's actual crop count is
    // the estimate, bounded by what this frame could at most need.
    const crops = Math.min(dets.length > 1 ? 2 : dets.length, lastCrops);
    const slow = rng.chance(opts.hiccupChance) ? opts.hiccupFactor : 1;
    const completeAt = capturedAt + (opts.inferenceMs + crops * opts.cropMs) * slow;

    // Everything the player does while this frame is being processed.
    while (nextFire < completeAt || (pending && pending.deadline < completeAt)) {
      if (pending && pending.deadline <= nextFire) {
        now = pending.deadline;
        const s = pipeline.expirePending(pending.token);
        pending = null;
        if (s) settle(s);
        continue;
      }
      now = nextFire;
      nextFire += opts.fireEveryMs;
      // Aim and ground truth are judged against where people are at the tap, not at the last capture.
      advanceTo(now);
      const tapAim = aim();
      const truth = underDot(tapAim);
      if (truth.visible?.id === target.id && truth.hittable(truth.visible) && truth.visibleHittable) result.possibleShots++;
      opts.recorder?.fire(now, tapAim, target.player ? target.id : null);
      const fire = pipeline.fire({ t: now, under: truth }, tapAim);
      opts.probe?.({ kind: 'fire', t: now, aim: tapAim, visible: truth.visible, result: fire });
      if (fire.kind === 'pending') pending = { token: fire.token, deadline: fire.deadline };
      else if (fire.kind === 'instant') settle(fire.settlement);
      else {
        record(now, fire.kind);
        if (opts.traceOutcomes.includes(fire.kind)) recordWrong(now, `${fire.kind} at fire; visible: ${underDot(tapAim).visible?.id ?? 'nobody'}`);
      }
    }

    now = completeAt;
    let cropsThisFrame = 0;
    const probeFaces: ProbeFrame['faces'] = [];
    const baseOps = {
      sampleOutfit: (d: Detection) => {
        if (!d.body) return null;
        const owner = raw.owner.get(d.body) ?? null;
        // The clothes of whoever fills the torso; body ratios come from this body's landmarks, which a
        // read of somebody else's pixels does not have.
        const pixels = owner && opts.detector.frontPixels ? torsoPixelsOf(scene, owner) : owner;
        const obs = sampleOutfit(rng, pixels);
        return obs && pixels !== owner ? { ...obs, props: null } : obs;
      },
      cropFaces: async (region: NBox) => {
        cropsThisFrame++;
        const found = cropFaces(rng, scene, region, opts.detector);
        if (opts.probe) for (const f of found) probeFaces.push({ box: f.box, person: nearestFace(f.box), det: faceOwner(f.box, dets) });
        return found;
      },
      isCurrent: () => true,
    };
    const outcome = await pipeline.processFrame(dets, capturedAt, FRAME_W, FRAME_H, crosshair, opts.recorder ? opts.recorder.frame(capturedAt, crosshair, dets, baseOps) : baseOps);
    if (!outcome) throw new Error('frame abandoned');
    lastCrops = cropsThisFrame;
    result.frames++;
    result.periodMs = outcome.periodMs;
    noteFrame(`${capturedAt}@${Math.round(now)} ` + dets.map((d, i) => { const o = raw.owner.get(d.body ?? d.face!); const tr = outcome.tracks[i]; const top = Object.entries(tr.belief).sort((a, b) => b[1] - a[1])[0]; return `#${tr.id}=${o ? o.id : 'ghost'}[${d.box.map((v) => v.toFixed(2)).join(',')}]${d.associationAmbiguous ? 'A' : ''}${d.face ? 'F' : ''}${top ? `{${top[0]} ${top[1].toFixed(2)} ${tr.via}}` : ''}`; }).join(' ') + ` aim=${(crosshair[0] + 0.21).toFixed(2)},${(crosshair[1] + 0.15).toFixed(2)}`);
    opts.probe?.({ kind: 'frame', capturedAt, completedAt: now, scene, dets, owners: dets.map((d) => raw.owner.get(d.body ?? d.face!) ?? null), faces: probeFaces, outcome, crosshair });
    if (outcome.settled) {
      pending = null;
      settle(outcome.settled);
    }
    const targetDet = dets.findIndex((d) => d.body && raw.owner.get(d.body) === target);
    if (targetDet >= 0) seenTrackIds.add(outcome.tracks[targetDet].id);
    const lock: LockState | null = outcome.lock;
    if (lock?.kind === 'lock') {
      const truth = captureTruth;
      if (!lockOk(truth, lock.id)) {
        result.wrongLockFrames++;
        recordWrong(capturedAt, `LOCK ${lock.id} shown while visible under the dot: ${truth.visible?.id ?? 'nobody'}`);
      } else if (lock.id === target.id && truth.visible?.id === target.id && truth.visibleHittable) {
        result.lockedFrames++;
        result.firstLockMs ??= now;
      }
    } else if (lock?.kind === 'maybe' && outcome.inSight) {
      // A player's name under a stranger or a mirror, even hedged, is what a wrong lock grows from.
      const j = outcome.tracks.findIndex((tr) => tr.id === outcome.inSight!.id);
      const owner = j >= 0 ? raw.owner.get(dets[j].body ?? dets[j].face!) : undefined;
      if (!owner?.player || owner.copyOf) result.maybeOnNonPlayer++;
    }
    t = completeAt + 16;
  }
  result.targetTrackIds = seenTrackIds.size;
  const hits = result.shots.filter((s) => s.outcome === 'correct');
  result.hitLatencyMs = hits.length ? Math.round(hits.reduce((a, s) => a + s.elapsedMs, 0) / hits.length) : null;
  return result;
}

/** Shooter profile that is never in frame, so a mirror or twin can be tested against it. */
const ME: PersonSpec = { id: 'me', player: true, x: -5, distance: 3, facing: 'front', topHue: 9 };
const front = (id: string, x: number, distance: number, topHue: number, extra: Partial<PersonSpec> = {}): PersonSpec => ({ id, player: true, x, distance, facing: 'front', topHue, ...extra });
/** Seven people in view (two players, five strangers milling about), one more than the pose model returns. */
const CROWD_SEVEN: PersonSpec[] = [
  ME,
  front('alice', 0.42, 4, 0, { vx: 0.015 }),
  front('bob', 0.62, 4.5, 4, { vx: -0.015 }),
  { id: 's1', player: false, x: 0.5, distance: 4.2, facing: 'front', topHue: 0, bottomHue: 3, vx: 0.02 },
  { id: 's2', player: false, x: 0.12, distance: 5, facing: 'side', topHue: 4, vx: 0.01 },
  { id: 's3', player: false, x: 0.82, distance: 3.6, facing: 'front', topHue: 8, vx: -0.02 },
  { id: 's4', player: false, x: 0.3, distance: 6, facing: 'back', topHue: 2 },
  { id: 's5', player: false, x: 0.92, distance: 5.5, facing: 'front', topHue: 6, vx: -0.01 },
];

export const SCENARIOS: Scenario[] = [
  {
    name: 'duel-close',
    expect: 'face-on at 3 m with a bystander: nearly every shot lands',
    people: [ME, front('alice', 0.5, 3, 0), front('bob', 0.12, 5, 4)],
    options: { target: 'alice' },
  },
  {
    name: 'back-shot',
    expect: 'target facing away at 4 m: the outfit carries the hit',
    people: [ME, front('alice', 0.5, 4, 0, { facing: 'back' }), front('bob', 0.15, 4, 6, { facing: 'back' })],
    options: { target: 'alice' },
  },
  {
    name: 'range-8m',
    expect: 'face-on at 8 m: face too small, outfit decides',
    people: [ME, front('alice', 0.5, 8, 0), front('bob', 0.3, 8, 6)],
    options: { target: 'alice' },
  },
  {
    name: 'approach',
    expect: 'target walks from 7 m to 2 m facing the shooter',
    people: [ME, front('alice', 0.5, 7, 0, { vd: -0.25 }), front('bob', 0.15, 4, 6)],
    options: { target: 'alice' },
  },
  {
    name: 'crossing',
    expect: 'two players cross paths at 4 m; the aim follows one of them',
    people: [ME, front('alice', 0.2, 4, 0, { vx: 0.04 }), front('bob', 0.8, 4.4, 6, { vx: -0.04 })],
    options: { target: 'alice', durationMs: 15000 },
  },
  {
    name: 'pan-crossing',
    expect: 'the same crossing while the phone pans 15% of the frame each way every 3 s; the aim keeps following',
    people: [ME, front('alice', 0.2, 4, 0, { vx: 0.04 }), front('bob', 0.8, 4.4, 6, { vx: -0.04 })],
    options: { target: 'alice', durationMs: 15000, pan: { amplitude: 0.15, periodS: 3 } },
  },
  {
    // Review of 2026-10-01: the same pan crossing aimed at the farther player. Geometry under 250 ms
    // old let an instant hit decide while the pan had already moved the other player under the dot.
    name: 'pan-crossing-far',
    expect: 'the pan crossing aimed at the farther player: never the nearer one',
    people: [ME, front('alice', 0.2, 4, 0, { vx: 0.04 }), front('bob', 0.8, 4.4, 6, { vx: -0.04 })],
    options: { target: 'bob', durationMs: 15000, pan: { amplitude: 0.15, periodS: 3 } },
  },
  {
    // 2026-10-01: the farther player of a crossing aimed at where they can still be seen, the sliver
    // of torso beside the nearer player, so the oracle judges what a lock or hit on that sliver says.
    // The clothing sampler reads whoever fills a torso (frontPixels): a body found mostly behind the
    // nearer player reads the nearer player's clothes, as the game's sampler would.
    name: 'crossing-sliver',
    expect: 'the crossing aimed at the visible part of the farther player: never the nearer one',
    people: [ME, front('alice', 0.2, 4, 0, { vx: 0.04 }), front('bob', 0.8, 4.4, 6, { vx: -0.04 })],
    options: { target: 'bob', durationMs: 15000, aimAt: 'visible', detector: { ...DEFAULT_DETECTOR, frontPixels: true } },
  },
  {
    name: 'pan-crossing-far-sliver',
    expect: 'the pan crossing aimed at the visible part of the farther player: never the nearer one',
    people: [ME, front('alice', 0.2, 4, 0, { vx: 0.04 }), front('bob', 0.8, 4.4, 6, { vx: -0.04 })],
    options: { target: 'bob', durationMs: 15000, pan: { amplitude: 0.15, periodS: 3 }, aimAt: 'visible', detector: { ...DEFAULT_DETECTOR, frontPixels: true } },
  },
  {
    name: 'crossing-backs',
    expect: 'the same crossing with both players facing away: only the outfit can re-identify them',
    people: [ME, front('alice', 0.2, 4, 0, { vx: 0.04, facing: 'back' }), front('bob', 0.8, 4.4, 6, { vx: -0.04, facing: 'back' })],
    options: { target: 'alice', durationMs: 15000 },
  },
  {
    name: 'occlusion',
    expect: 'a nearer player walks across in front of the target and hides them for a moment',
    people: [ME, front('alice', 0.5, 5, 0), front('bob', -0.1, 2.5, 6, { vx: 0.09, facing: 'side' })],
    options: { target: 'alice', durationMs: 20000 },
  },
  {
    name: 'turn-around',
    expect: 'the target turns their back for 8 s mid-round, then faces the shooter again',
    people: [ME, front('alice', 0.5, 4, 0, { script: [{ at: 6, facing: 'back' }, { at: 14, facing: 'front' }] }), front('bob', 0.15, 5, 6)],
    options: { target: 'alice', durationMs: 22000 },
  },
  {
    name: 'lookalike-tops',
    expect: 'same hue, different shade, both facing away: the outfit still separates them',
    people: [ME, front('alice', 0.5, 5, 2, { facing: 'back', topShade: 3 }), front('bob', 0.2, 5, 2, { facing: 'back', topShade: 0 })],
    options: { target: 'alice' },
  },
  {
    name: 'identical-tops',
    expect: 'indistinguishable tops, both facing away: shots must refuse rather than guess',
    people: [ME, front('alice', 0.5, 5, 2, { facing: 'back', topShade: 3 }), front('bob', 0.2, 5, 2, { facing: 'back', outfitOf: 'alice' })],
    options: { target: 'alice' },
  },
  {
    name: 'same-shirt-stranger',
    expect: 'a non-player in the same top as a player but other trousers and hair, seen from behind: the rest of the outfit must keep them apart',
    people: [ME, front('alice', 0.12, 4, 2, { facing: 'back', topShade: 3, bottomHue: 7, hairBin: 0 }), { id: 'stranger', player: false, x: 0.5, distance: 3.5, facing: 'back', topHue: 2, topShade: 3, bottomHue: 1, hairBin: 2 }],
    options: { target: 'stranger' },
  },
  {
    name: 'lookalike-faces',
    expect: 'two players whose faces read 0.8 alike to the model: shots must resolve by outfit or refuse, never hit the wrong one',
    people: [ME, front('alice', 0.5, 3, 0), front('bob', 0.15, 3.5, 6, { faceLike: { id: 'alice', cos: 0.8 } })],
    options: { target: 'bob' },
  },
  {
    name: 'stranger',
    expect: 'a non-player in the crosshair: never a hit',
    people: [ME, front('alice', 0.12, 4, 0), { id: 'stranger', player: false, x: 0.5, distance: 3, facing: 'front', topHue: 7 }],
    options: { target: 'stranger' },
  },
  {
    // Real photos (npm run realcheck, 2026-09-26): different people reach 0.66 to 0.75 centred
    // similarity. Enrolled samples sit at 0.78 to the true face, so 0.85 here reads about 0.66.
    name: 'lookalike-stranger',
    expect: 'a non-player whose face reads about 0.66 like a player, in other clothes: never a hit',
    people: [ME, front('alice', 0.12, 4, 0), { id: 'stranger', player: false, x: 0.5, distance: 3, facing: 'front', topHue: 7, bottomHue: 3, faceLike: { id: 'alice', cos: 0.85 } }],
    options: { target: 'stranger' },
  },
  {
    // Review of 2026-10-01: on a slow phone clothing audits come ~1.8 s apart; a veto that lapses on
    // a clock (2 s) let the look-alike be hit 42 times in 40 seeds.
    name: 'lookalike-stranger-slow',
    expect: 'the look-alike stranger on a phone that takes 400 ms per frame: never a hit',
    people: [ME, front('alice', 0.12, 4, 0), { id: 'stranger', player: false, x: 0.5, distance: 3, facing: 'front', topHue: 7, bottomHue: 3, faceLike: { id: 'alice', cos: 0.85 } }],
    options: { target: 'stranger', inferenceMs: 400, cropMs: 45 },
  },
  {
    // Review of 2026-10-01: a look-alike whose torso can never be read is never vetoed, so only the
    // corroboration rule (the face-only bar without the player's own outfit backing it) refuses him.
    name: 'lookalike-stranger-hidden',
    expect: 'a non-player whose face reads about 0.66 like a player and whose torso cannot be read: never a hit',
    people: [ME, front('alice', 0.12, 4, 0), { id: 'stranger', player: false, x: 0.5, distance: 3, facing: 'front', topHue: 7, bottomHue: 3, faceLike: { id: 'alice', cos: 0.85 }, torsoHidden: 1 }],
    options: { target: 'stranger' },
  },
  {
    // A player crossing a non-player look-alike: no identity, outfit read or learned face may ride over.
    name: 'crossing-lookalike-stranger',
    expect: 'a player and a non-player look-alike cross: the stranger is never hit or locked as her',
    people: [ME, front('alice', 0.2, 4, 0, { vx: 0.06 }), { id: 'stranger', player: false, x: 0.8, distance: 4.2, facing: 'front', topHue: 7, bottomHue: 3, vx: -0.06, faceLike: { id: 'alice', cos: 0.85 } }],
    options: { target: 'stranger', durationMs: 15000 },
  },
  {
    // Fairness: a player whose hips are never in view faces the face-only bar.
    name: 'duel-hidden-torso',
    expect: 'face-on at 3 m with the torso never readable: hits only on a clear face, never wrong',
    people: [ME, front('alice', 0.5, 3, 0, { torsoHidden: 1 }), front('bob', 0.12, 5, 4)],
    options: { target: 'alice' },
  },
  {
    // Review of 2026-10-01: an identity must not ride across a crossing onto the wrong body. Two
    // players whose faces read 0.66 alike cross; the shooter keeps aiming at bob.
    name: 'crossing-lookalike-faces',
    expect: 'two players with look-alike faces cross: shots on bob never land on alice',
    people: [ME, front('alice', 0.2, 4, 0, { vx: 0.06 }), front('bob', 0.8, 4.2, 6, { vx: -0.06, faceLike: { id: 'alice', cos: 0.85 } })],
    options: { target: 'bob', durationMs: 15000 },
  },
  {
    // The reverse failure of the outfit veto: a real player whose clothing is misread a quarter of the
    // time gets vetoed on their own body; that must cost a refusal, never a hit on someone else.
    name: 'vetoed-player',
    expect: 'a player whose outfit is misread on a quarter of samples: refusals at worst, never a wrong hit',
    people: [ME, front('alice', 0.5, 3, 0, { outfitGlitch: 0.25 }), front('bob', 0.15, 4, 6)],
    options: { target: 'alice' },
  },
  {
    // Review of 2026-10-01: a practice target captured without the hips has no outfit, so the
    // outfit veto cannot protect it; a look-alike stranger must still be refused.
    name: 'lookalike-stranger-faceonly',
    expect: 'a face-only target (no outfit enrolled) and a non-player whose face reads about 0.66 like them: never a hit',
    people: [ME, front('alice', 0.12, 4, 0, { faceOnlyProfile: true }), { id: 'stranger', player: false, x: 0.5, distance: 3, facing: 'front', topHue: 7, bottomHue: 3, faceLike: { id: 'alice', cos: 0.85 } }],
    options: { target: 'stranger' },
  },
  {
    name: 'duel-faceonly',
    expect: 'face-on at 3 m against a face-only target: hits only on a clear face, never wrong',
    people: [ME, front('alice', 0.5, 3, 0, { faceOnlyProfile: true }), front('bob', 0.12, 5, 4)],
    options: { target: 'alice' },
  },
  {
    // Astra review 2026-10-01: MoveNet returns six bodies at most, so in a crowd somebody is always
    // missing and who it is changes frame to frame; a stranger in the target's colours stands beside her.
    name: 'crowd-seven',
    expect: 'seven people in view (two players, five strangers milling about): never a wrong hit or lock',
    people: CROWD_SEVEN,
    options: { target: 'alice' },
  },
  {
    // Review of 2026-10-01: the crowd rule measured the read's age against the decision clock, so a
    // phone that decides more than 400 ms after the capture refused every crowded shot.
    name: 'crowd-seven-slow',
    expect: 'crowd-seven on a phone that takes 400 ms per frame: crowded frames still hit on their own face read, never wrong',
    people: CROWD_SEVEN,
    options: { target: 'alice', inferenceMs: 400, cropMs: 45 },
  },
  {
    name: 'mirror',
    expect: 'the shooter in a mirror: never a hit',
    people: [ME, front('alice', 0.12, 4, 0), { id: 'mirror', player: false, copyOf: 'me', x: 0.5, distance: 3, facing: 'front', topHue: 9 }],
    options: { target: 'mirror' },
  },
  {
    name: 'slow-phone',
    expect: 'duel-close on a phone that takes 400 ms per frame',
    people: [ME, front('alice', 0.5, 3, 0), front('bob', 0.12, 5, 4)],
    options: { target: 'alice', inferenceMs: 400, cropMs: 45 },
  },
  {
    name: 'hiccups',
    expect: 'duel-close on a phone where one frame in six takes three times as long',
    people: [ME, front('alice', 0.5, 3, 0), front('bob', 0.12, 5, 4)],
    options: { target: 'alice', hiccupChance: 0.17 },
  },
  {
    name: 'flaky-pose',
    expect: 'duel at 4 m with the pose model dropping a quarter of frames',
    people: [ME, front('alice', 0.5, 4, 0), front('bob', 0.12, 5, 4)],
    options: { target: 'alice', detector: { ...DEFAULT_DETECTOR, bodyDropout: 0.25 } },
  },
  {
    name: 'dim-light',
    expect: 'faces match worse and are found less often',
    people: [ME, front('alice', 0.5, 4, 0), front('bob', 0.12, 5, 4)],
    options: { target: 'alice', detector: { ...DEFAULT_DETECTOR, faceAvailability: 0.6, faceSimShift: -0.08 } },
  },
];

export interface Aggregate {
  name: string;
  expect: string;
  shots: number;
  /** Shots where the target was visibly under the dot at the tap. */
  possible: number;
  correct: number;
  wrong: number;
  /** Hits the oracle could not judge: within jitter of a nearer person's edge, or on the right person off the torso. */
  ambiguous: number;
  unclear: number;
  miss: number;
  stale: number;
  lockFraction: number;
  wrongLockFrames: number;
  /** Frames with a hedged player label on a non-player, pooled over the seeds. */
  maybeOnNonPlayer: number;
  firstLockMs: number | null;
  /** Mean tap-to-hit latency over every correct shot in the pool, in ms. */
  hitLatencyMs: number | null;
  periodMs: number;
  trackChurn: number;
}

/** Run a scenario over several seeds and pool the counts. */
export async function aggregate(scenario: Scenario, seeds: number[], overrides: Partial<SimOptions> = {}): Promise<Aggregate> {
  const runs = await Promise.all(seeds.map((seed) => simulate(scenario, { ...overrides, seed })));
  const sum = (f: (r: SimResult) => number) => runs.reduce((a, r) => a + f(r), 0);
  const firstLocks = runs.map((r) => r.firstLockMs).filter((v): v is number => v !== null);
  return {
    name: scenario.name,
    expect: scenario.expect,
    shots: sum((r) => r.shots.length),
    possible: sum((r) => r.possibleShots),
    correct: sum((r) => r.counts.correct),
    wrong: sum((r) => r.counts.wrong),
    ambiguous: sum((r) => r.counts.ambiguous),
    unclear: sum((r) => r.counts.unclear),
    miss: sum((r) => r.counts.miss),
    stale: sum((r) => r.counts.stale + r.counts['no-camera']),
    lockFraction: sum((r) => r.lockedFrames) / Math.max(1, sum((r) => r.frames)),
    wrongLockFrames: sum((r) => r.wrongLockFrames),
    maybeOnNonPlayer: sum((r) => r.maybeOnNonPlayer),
    firstLockMs: firstLocks.length ? Math.round(firstLocks.reduce((a, b) => a + b, 0) / firstLocks.length) : null,
    hitLatencyMs: sum((r) => r.counts.correct) ? Math.round(sum((r) => (r.hitLatencyMs ?? 0) * r.counts.correct) / sum((r) => r.counts.correct)) : null,
    periodMs: Math.round(runs[0].periodMs),
    trackChurn: sum((r) => r.targetTrackIds) / runs.length,
  };
}

export { UNKNOWN_ID };
export type { Person };
