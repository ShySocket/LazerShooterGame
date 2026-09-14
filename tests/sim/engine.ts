import { buildDetections } from '../../src/vision/tracker';
import { VisionPipeline, type LockState } from '../../src/vision/pipeline';
import { UNKNOWN_ID } from '../../src/types';
import type { Candidate } from '../../src/vision/scoring';
import type { NBox } from '../../src/vision/geometry';
import { Rng } from './rng';
import { buildScene, cropFaces, DEFAULT_DETECTOR, detect, FRAME_H, FRAME_W, hitBox, personBox, sampleOutfit, step, type DetectorModel, type Person, type PersonSpec } from './world';

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
  detector: DetectorModel;
  /** Who the shooter is aiming at throughout. */
  target: string;
  hitThreshold: number;
  hitMargin: number;
  /** Outcomes that get a frame trace in SimResult.wrongTraces; wrong hits and wrong locks always do. */
  traceOutcomes: Outcome[];
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
  firstLockMs: number | null;
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
    firstLockMs: null,
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

  const aim = (): NBox => {
    const [x, y, w, h] = personBox(target);
    const cx = x + w / 2 + rng.gauss(0, opts.aimSd);
    const cy = y + h * 0.45 + rng.gauss(0, opts.aimSd);
    return [cx - 0.21, cy - 0.15, 0.42, 0.3];
  };

  let pending: { token: object; deadline: number } | null = null;
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
    const crops = dets.length > 1 ? 2 : dets.length;
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
      const fire = pipeline.fire({ t: now, under: truth }, tapAim);
      if (fire.kind === 'pending') pending = { token: fire.token, deadline: fire.deadline };
      else if (fire.kind === 'instant') settle(fire.settlement);
      else {
        record(now, fire.kind);
        if (opts.traceOutcomes.includes(fire.kind)) recordWrong(now, `${fire.kind} at fire; visible: ${underDot(tapAim).visible?.id ?? 'nobody'}`);
      }
    }

    now = completeAt;
    const outcome = await pipeline.processFrame(dets, capturedAt, FRAME_W, FRAME_H, crosshair, {
      sampleOutfit: (d) => (d.body ? sampleOutfit(rng, raw.owner.get(d.body) ?? null) : null),
      cropFaces: async (region) => cropFaces(rng, scene, region, opts.detector),
      isCurrent: () => true,
    });
    if (!outcome) throw new Error('frame abandoned');
    result.frames++;
    result.periodMs = outcome.periodMs;
    noteFrame(`${capturedAt}@${Math.round(now)} ` + dets.map((d, i) => { const o = raw.owner.get(d.body ?? d.face!); const tr = outcome.tracks[i]; const top = Object.entries(tr.belief).sort((a, b) => b[1] - a[1])[0]; return `#${tr.id}=${o ? o.id : 'ghost'}[${d.box.map((v) => v.toFixed(2)).join(',')}]${d.associationAmbiguous ? 'A' : ''}${d.face ? 'F' : ''}${top ? `{${top[0]} ${top[1].toFixed(2)} ${tr.via}}` : ''}`; }).join(' ') + ` aim=${(crosshair[0] + 0.21).toFixed(2)},${(crosshair[1] + 0.15).toFixed(2)}`);
    if (outcome.settled) {
      pending = null;
      settle(outcome.settled);
    }
    const targetDet = dets.findIndex((d) => d.body && raw.owner.get(d.body) === target);
    if (targetDet >= 0) seenTrackIds.add(outcome.tracks[targetDet].id);
    const lock: LockState | null = outcome.lock;
    if (lock?.kind === 'lock') {
      const truth = underDot(crosshair);
      if (!lockOk(truth, lock.id)) {
        result.wrongLockFrames++;
        recordWrong(capturedAt, `LOCK ${lock.id} shown while visible under the dot: ${truth.visible?.id ?? 'nobody'}`);
      } else if (lock.id === target.id && truth.visible?.id === target.id && truth.visibleHittable) {
        result.lockedFrames++;
        result.firstLockMs ??= now;
      }
    }
    t = completeAt + 16;
  }
  result.targetTrackIds = seenTrackIds.size;
  return result;
}

/** Shooter profile that is never in frame, so a mirror or twin can be tested against it. */
const ME: PersonSpec = { id: 'me', player: true, x: -5, distance: 3, facing: 'front', topHue: 9 };
const front = (id: string, x: number, distance: number, topHue: number, extra: Partial<PersonSpec> = {}): PersonSpec => ({ id, player: true, x, distance, facing: 'front', topHue, ...extra });

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
  unclear: number;
  miss: number;
  stale: number;
  lockFraction: number;
  wrongLockFrames: number;
  firstLockMs: number | null;
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
    unclear: sum((r) => r.counts.unclear),
    miss: sum((r) => r.counts.miss),
    stale: sum((r) => r.counts.stale + r.counts['no-camera']),
    lockFraction: sum((r) => r.lockedFrames) / Math.max(1, sum((r) => r.frames)),
    wrongLockFrames: sum((r) => r.wrongLockFrames),
    firstLockMs: firstLocks.length ? Math.round(firstLocks.reduce((a, b) => a + b, 0) / firstLocks.length) : null,
    periodMs: Math.round(runs[0].periodMs),
    trackChurn: sum((r) => r.targetTrackIds) / runs.length,
  };
}

export { UNKNOWN_ID };
export type { Person };
