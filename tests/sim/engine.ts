import { buildDetections } from '../../src/vision/tracker';
import { VisionPipeline, type LockState } from '../../src/vision/pipeline';
import { UNKNOWN_ID } from '../../src/types';
import type { Candidate } from '../../src/vision/scoring';
import type { NBox } from '../../src/vision/geometry';
import { Rng } from './rng';
import { buildScene, cropFaces, DEFAULT_DETECTOR, detect, FRAME_H, FRAME_W, personBox, sampleOutfit, step, type DetectorModel, type Person, type PersonSpec } from './world';

export interface SimOptions {
  seed: number;
  /** Time the phone spends in the full-frame detector per frame. */
  inferenceMs: number;
  /** Time per magnified face crop. */
  cropMs: number;
  durationMs: number;
  fireEveryMs: number;
  /** Hand shake, as a fraction of the frame. */
  aimSd: number;
  detector: DetectorModel;
  /** Who the shooter is aiming at throughout. */
  target: string;
  hitThreshold: number;
  hitMargin: number;
}

export const DEFAULT_OPTIONS: Omit<SimOptions, 'target'> = {
  seed: 1,
  inferenceMs: 180,
  cropMs: 20,
  durationMs: 30000,
  fireEveryMs: 1300,
  aimSd: 0.02,
  detector: DEFAULT_DETECTOR,
  hitThreshold: 0.5,
  hitMargin: 0.2,
};

export type Outcome = 'correct' | 'wrong' | 'unclear' | 'miss' | 'stale' | 'no-camera' | 'busy';

export interface ShotRecord {
  t: number;
  outcome: Outcome;
  resolvedId?: string;
  elapsedMs: number;
}

export interface SimResult {
  shots: ShotRecord[];
  counts: Record<Outcome, number>;
  frames: number;
  /** Frames where the dot was on the target and the label said LOCK with the right name. */
  lockedFrames: number;
  wrongLockFrames: number;
  firstLockMs: number | null;
  periodMs: number;
  /** Distinct track ids the target body went through: continuity churn. */
  targetTrackIds: number;
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
  const pipeline = new VisionPipeline<{ t: number; under: Set<string> }>(
    { candidates, exclusiveIds: new Set(candidates.map((c) => c.id)), eligible, hitThreshold: opts.hitThreshold, hitMargin: opts.hitMargin },
    () => now,
  );
  const target = scene.people.find((p) => p.id === opts.target);
  if (!target) throw new Error('unknown target ' + opts.target);

  const result: SimResult = {
    shots: [],
    counts: { correct: 0, wrong: 0, unclear: 0, miss: 0, stale: 0, 'no-camera': 0, busy: 0 },
    frames: 0,
    lockedFrames: 0,
    wrongLockFrames: 0,
    firstLockMs: null,
    periodMs: NaN,
    targetTrackIds: 0,
  };
  const record = (t: number, outcome: Outcome, elapsedMs = 0, resolvedId?: string) => {
    result.shots.push({ t, outcome, elapsedMs, resolvedId });
    result.counts[outcome]++;
  };
  /** Players whose real body contains the aim point: the only ids a verdict may name. */
  const underDot = (crosshair: NBox): Set<string> => {
    const cx = crosshair[0] + crosshair[2] / 2;
    const cy = crosshair[1] + crosshair[3] / 2;
    const ids = new Set<string>();
    for (const p of scene.people) {
      const [x, y, w, h] = personBox(p);
      if (cx >= x && cx <= x + w && cy >= y && cy <= y + h && p.player && eligible.has(p.id) && !p.copyOf) ids.add(p.id);
    }
    return ids;
  };
  const settle = (s: { track: unknown; resolution: { id: string } | null; elapsedMs: number; context: { t: number; under: Set<string> } }) => {
    if (s.resolution) record(s.context.t, s.context.under.has(s.resolution.id) ? 'correct' : 'wrong', s.elapsedMs, s.resolution.id);
    else record(s.context.t, s.track ? 'unclear' : 'miss', s.elapsedMs);
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
  while (t < opts.durationMs) {
    const capturedAt = t;
    step(scene, (capturedAt - lastStep) / 1000);
    lastStep = capturedAt;
    const raw = detect(rng, scene, opts.detector);
    const dets = buildDetections(raw.bodies, raw.faces);
    const crosshair = aim();
    const crops = dets.length > 1 ? 2 : dets.length;
    const completeAt = capturedAt + opts.inferenceMs + crops * opts.cropMs;

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
      const fire = pipeline.fire({ t: now, under: underDot(crosshair) }, crosshair);
      if (fire.kind === 'pending') pending = { token: fire.token, deadline: fire.deadline };
      else if (fire.kind === 'instant') settle(fire.settlement);
      else record(now, fire.kind);
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
    if (outcome.settled) {
      pending = null;
      settle(outcome.settled);
    }
    const targetDet = dets.findIndex((d) => d.body && raw.owner.get(d.body) === target);
    if (targetDet >= 0) seenTrackIds.add(outcome.tracks[targetDet].id);
    const lock: LockState | null = outcome.lock;
    if (lock?.kind === 'lock') {
      if (!underDot(crosshair).has(lock.id)) result.wrongLockFrames++;
      else if (lock.id === target.id) {
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
    people: [ME, front('alice', 0.25, 4, 0, { vx: 0.05 }), front('bob', 0.75, 4.4, 6, { vx: -0.05 })],
    options: { target: 'alice', durationMs: 20000 },
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
    people: [ME, front('alice', 0.5, 5, 2, { facing: 'back', topShade: 3 }), front('bob', 0.2, 5, 2, { facing: 'back', topShade: 3 })],
    options: { target: 'alice' },
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
