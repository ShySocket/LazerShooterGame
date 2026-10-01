/**
 * Small, exact statistics for the session report and realcheck: how sure a count of wrong hits lets
 * us be about the wrong-hit rate, and latency percentiles. Pure functions, no dependencies.
 */

/** P(X <= k) for X ~ Binomial(n, p), summed in log space so large n does not underflow. */
export function binomialCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  const lp = Math.log(p);
  const lq = Math.log1p(-p);
  const terms: number[] = [];
  let lnChoose = 0;
  let max = -Infinity;
  for (let i = 0; i <= k; i++) {
    if (i > 0) lnChoose += Math.log(n - i + 1) - Math.log(i);
    const t = lnChoose + i * lp + (n - i) * lq;
    terms.push(t);
    if (t > max) max = t;
  }
  let sum = 0;
  for (const t of terms) sum += Math.exp(t - max);
  return Math.min(1, Math.exp(max) * sum);
}

/**
 * Exact (Clopper-Pearson) one-sided upper confidence bound on a binomial rate after `k` events in
 * `n` trials: the largest rate p for which seeing k or fewer events still has probability at least
 * 1 - confidence. Equivalently the `confidence` quantile of Beta(k + 1, n - k). With no events it
 * is 1 - (1 - confidence)^(1/n): 0 wrong hits in 216 independent shots bounds the rate below about
 * 1.38% at 95%. The trials must be independent; for shots that share a cause see clusterWrongBound.
 * No trials say nothing, so n = 0 (and k = n) give 1.
 */
export function clopperPearsonUpper(k: number, n: number, confidence = 0.95): number {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n) throw new RangeError(`need integers 0 <= k <= n, got k=${k} n=${n}`);
  if (!(confidence > 0 && confidence < 1)) throw new RangeError(`confidence must be in (0, 1), got ${confidence}`);
  if (n === 0 || k === n) return 1;
  if (k === 0) return 1 - Math.pow(1 - confidence, 1 / n);
  // P(X <= k) falls monotonically as p rises: bisect for the p where it equals 1 - confidence.
  const alpha = 1 - confidence;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200 && hi - lo > 1e-13; i++) {
    const mid = (lo + hi) / 2;
    if (binomialCdf(k, n, mid) > alpha) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Upper bounds on the wrong-hit rate two ways: per attempt (every labelled shot) and per accepted
 * hit (only shots the game turned into a hit). Null where there is nothing to divide by.
 */
export function wrongHitBounds(wrong: number, attempts: number, accepted: number, confidence = 0.95): { perAttempt: number | null; perHit: number | null } {
  return {
    perAttempt: attempts > 0 ? clopperPearsonUpper(wrong, attempts, confidence) : null,
    perHit: accepted > 0 ? clopperPearsonUpper(wrong, accepted, confidence) : null,
  };
}

/**
 * The bound when shots come in clusters that share whatever could make them wrong (one photo, its
 * enrolment and the camera path in realcheck; one round and target in a session): each cluster counts
 * once, failed when any of its shots was wrong, and the bound is on the share of clusters that produce
 * a wrong hit. Shots in a cluster are not independent trials, so this is what they can support; the
 * per-shot bound over the same shots holds only if they were. 0 wrong in 216 shots from 9 photos
 * bounds the photo rate below 28.3%, not 1.38%.
 */
export function clusterWrongBound(wrongByCluster: Iterable<number>, confidence = 0.95): { clusters: number; failed: number; upper: number | null } {
  let clusters = 0;
  let failed = 0;
  for (const w of wrongByCluster) {
    clusters++;
    if (w > 0) failed++;
  }
  return { clusters, failed, upper: clusters > 0 ? clopperPearsonUpper(failed, clusters, confidence) : null };
}

/** One realcheck shoot run: 12 shots at one target in one static photo. */
export interface ShootRun {
  photo: string;
  shots: number;
  correct: number;
  wrong: number;
}

/**
 * What a realcheck shoot proves. Its shots are not independent: a run fires at one static photo with
 * one enrolment, deterministic models and the same camera path, and the runs of a photo share the
 * photo and its enrolment. So the photo is the unit the headline counts, then the run; the per-shot
 * and per-accepted-hit bounds are kept, labelled as holding only if every shot were independent.
 */
export function shootBounds(runs: ShootRun[], confidence = 0.95) {
  const byPhoto = new Map<string, number>();
  for (const r of runs) byPhoto.set(r.photo, (byPhoto.get(r.photo) ?? 0) + r.wrong);
  const shots = runs.reduce((a, r) => a + r.shots, 0);
  const wrong = runs.reduce((a, r) => a + r.wrong, 0);
  const accepted = runs.reduce((a, r) => a + r.correct + r.wrong, 0);
  const b = wrongHitBounds(wrong, shots, accepted, confidence);
  return {
    confidence,
    perPhoto: clusterWrongBound(byPhoto.values(), confidence),
    perRun: clusterWrongBound(runs.map((r) => r.wrong), confidence),
    assumingIndependentShots: { shots, wrong, accepted, wrongPerAttemptUpper: b.perAttempt, wrongPerHitUpper: b.perHit },
  };
}

export function formatShootBounds(b: ReturnType<typeof shootBounds>): string[] {
  const { perPhoto: p, perRun: r, assumingIndependentShots: s } = b;
  return [
    `wrong-hit rate, one-sided ${Math.round(100 * b.confidence)}% Clopper-Pearson upper bounds:`,
    `  per photo ${formatBound(p.upper)} (${p.failed} of ${p.clusters} photos had a wrong hit): the independent unit, what this run proves`,
    `  per run   ${formatBound(r.upper)} (${r.failed}/${r.clusters} runs; the runs of a photo share it)`,
    `  per shot  ${formatBound(s.wrongPerAttemptUpper)} (${s.wrong}/${s.shots}) and per accepted hit ${formatBound(s.wrongPerHitUpper)} (${s.wrong}/${s.accepted}), only if every shot were independent, which shots at one static photo are not`,
  ];
}

/**
 * The p-th percentile (0..100) by linear interpolation between closest ranks (numpy's default),
 * ignoring non-finite values. Null for no values.
 */
export function percentile(values: readonly number[], p: number): number | null {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const q = Math.max(0, Math.min(100, p)) / 100;
  const pos = q * (xs.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}

/** A rate bound as a percentage for tables: `≤1.38%`, or `-` when there was nothing to bound. */
export function formatBound(x: number | null): string {
  if (x === null) return '-';
  return `≤${(100 * x).toFixed(x < 0.1 ? 2 : 1)}%`;
}
