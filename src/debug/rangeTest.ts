import { UNKNOWN_ID } from '../types';

export interface RangeShot {
  t: number;
  /** Marked distance to the target in metres. */
  distance: number;
  locked: boolean;
  /** Actual person aimed at, or UNKNOWN_ID when aiming at a non-player or empty scene. */
  expectedId?: string;
  /** Player selected by the recognition system when it locked. */
  targetId?: string;
  targetName?: string;
  score?: number;
  /** Time from the tap to the decision. 0 when the pre-tap belief was already enough. */
  resolveMs: number;
  via?: string;
  zoom: boolean;
}

export interface RangeSummary {
  distance: number;
  shots: number;
  lockRate: number;
  meanResolveMs: number;
  zoomRate: number;
  /** Shots with a known expected target; unlabelled attempts are excluded from correctness. */
  evaluated: number;
  correct: number;
  wrongPlayer: number;
  missed: number;
  falseLocks: number;
}

const shots: RangeShot[] = [];

/** Separate correct recognition from lock frequency, including correctly rejecting non-players. */
export function summarizeRangeShots(records: readonly RangeShot[]): RangeSummary[] {
  const byDist = new Map<number, RangeShot[]>();
  for (const shot of records) {
    const list = byDist.get(shot.distance);
    if (list) list.push(shot);
    else byDist.set(shot.distance, [shot]);
  }
  return [...byDist.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([distance, list]) => {
      const result: RangeSummary = {
        distance,
        shots: list.length,
        lockRate: list.filter((s) => s.locked).length / list.length,
        meanResolveMs: list.reduce((a, s) => a + s.resolveMs, 0) / list.length,
        zoomRate: list.filter((s) => s.zoom).length / list.length,
        evaluated: 0,
        correct: 0,
        wrongPlayer: 0,
        missed: 0,
        falseLocks: 0,
      };
      for (const shot of list) {
        if (shot.expectedId === undefined) continue;
        result.evaluated++;
        if (shot.expectedId === UNKNOWN_ID) {
          if (shot.locked) result.falseLocks++;
          else result.correct++;
        } else if (!shot.locked) result.missed++;
        else if (shot.targetId === shot.expectedId) result.correct++;
        else result.wrongPlayer++;
      }
      return result;
    });
}

/** Accuracy bench: range-test attempts deal no damage and compare recognition with the chosen target. */
export const rangeTest = {
  add(r: RangeShot): void {
    shots.push(r);
  },
  all(): RangeShot[] {
    return shots.slice();
  },
  clear(): void {
    shots.length = 0;
  },
  summary(): RangeSummary[] {
    return summarizeRangeShots(shots);
  },
};
