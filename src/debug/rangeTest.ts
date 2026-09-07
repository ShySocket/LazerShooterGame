export interface RangeShot {
  t: number;
  /** Marked distance to the target in metres. */
  distance: number;
  locked: boolean;
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
}

const shots: RangeShot[] = [];

/** Accuracy bench: shots taken in range-test mode deal no damage, they only record how the lock behaved. */
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
    const byDist = new Map<number, RangeShot[]>();
    for (const s of shots) byDist.set(s.distance, [...(byDist.get(s.distance) ?? []), s]);
    return [...byDist.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([distance, list]) => ({
        distance,
        shots: list.length,
        lockRate: list.filter((s) => s.locked).length / list.length,
        meanResolveMs: list.reduce((a, s) => a + s.resolveMs, 0) / list.length,
        zoomRate: list.filter((s) => s.zoom).length / list.length,
      }));
  },
};
