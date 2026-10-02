import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SCENARIOS, simulate } from './engine';

/**
 * The wide sweep: the crossing and crowd scenarios over ten times the seeds `sim:full` gates on, where
 * the silent hops of 2026-10-01 hid (TRACKING_IMPROVEMENT_PLAN.md). Too slow for CI (about 4 minutes
 * for 1000 seeds); run it after any tracker, pipeline or scoring change, before a PR.
 *
 *   npm run sim:wide                              seeds 1-1000 of the family
 *   npm run sim:wide -- --from 1001 --seeds 2000  seeds 1001-3000
 *   npm run sim:wide -- occlusion                 one scenario (name substring)
 *
 * Prints, per scenario, hit and lock rates and every seed with a wrong hit or wrong-lock frames, and
 * writes .rubric/sim-wide.json for `npm run rubric`. Exits 1 when a wrong outcome appears that is
 * not one of the documented residuals below, so a new one cannot hide behind a known one.
 */
export const WIDE_FAMILY = ['crossing', 'pan-crossing', 'pan-crossing-far', 'crossing-backs', 'occlusion', 'crossing-lookalike-faces', 'crossing-lookalike-stranger', 'crowd-seven'];

/**
 * Wrong outcomes known and documented, by scenario and seed. crossing-lookalike-faces 282, 2032 and
 * 2528: an instant hit at a neighbour's edge (her detected box 12% narrower than she is, the dot just
 * outside it and outside AIM_EDGE_BAND); widening the band is a threshold change and was left alone.
 * pan-crossing 3410 (3 wrong-lock frames at the default period, present on main before the silent-hop
 * fix): at the turn of the pan Alice's track loses her and she comes back as a tentative track, Bob
 * is then hidden and her body lands where his track predicts him; no partner, no confirmed rival, and
 * nothing read on that body for about 650 ms while LOCK bob shows. The reversing-pan case of
 * TRACKING_IMPROVEMENT_PLAN.md "What remains": it needs camera-motion compensation or a read on a
 * body that moved off its last read, not a tracker threshold.
 */
export const KNOWN_WIDE: Record<string, { wrong: number[]; wrongLock: number[] }> = {
  'crossing-lookalike-faces': { wrong: [282, 2032, 2528], wrongLock: [] },
  'pan-crossing': { wrong: [], wrongLock: [3410] },
};

const args = process.argv.slice(2);
const valueOf = (flag: string): number | null => (args.indexOf(flag) >= 0 ? Number(args[args.indexOf(flag) + 1]) : null);
const seedCount = valueOf('--seeds') ?? 1000;
const firstSeed = valueOf('--from') ?? 1;
const valueIndexes = new Set(['--seeds', '--from'].map((f) => args.indexOf(f)).filter((i) => i >= 0).map((i) => i + 1));
const filter = args.filter((a, i) => !a.startsWith('--') && !valueIndexes.has(i));
const BATCH = 100;

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : '-');
const t0 = Date.now();
const rows: { scenario: string; seeds: number; hit: string; lock: string; wrongSeeds: number[]; wrongLockSeeds: number[]; unexpected: number[] }[] = [];
for (const name of WIDE_FAMILY) {
  if (filter.length && !filter.some((f) => name.includes(f))) continue;
  const scenario = SCENARIOS.find((s) => s.name === name);
  if (!scenario) throw new Error(`no scenario ${name}`);
  let possible = 0;
  let correct = 0;
  let locked = 0;
  let frames = 0;
  const wrongSeeds: number[] = [];
  const wrongLockSeeds: number[] = [];
  for (let start = firstSeed; start < firstSeed + seedCount; start += BATCH) {
    const seeds = Array.from({ length: Math.min(BATCH, firstSeed + seedCount - start) }, (_, i) => start + i);
    const runs = await Promise.all(seeds.map((seed) => simulate(scenario, { seed })));
    runs.forEach((r, i) => {
      possible += r.possibleShots;
      correct += r.counts.correct;
      locked += r.lockedFrames;
      frames += r.frames;
      if (r.counts.wrong > 0) wrongSeeds.push(seeds[i]);
      if (r.wrongLockFrames > 0) wrongLockSeeds.push(seeds[i]);
    });
  }
  const known = KNOWN_WIDE[name] ?? { wrong: [], wrongLock: [] };
  const unexpected = [...wrongSeeds.filter((s) => !known.wrong.includes(s)), ...wrongLockSeeds.filter((s) => !known.wrongLock.includes(s))];
  rows.push({ scenario: name, seeds: seedCount, hit: pct(correct, possible), lock: pct(locked, frames), wrongSeeds, wrongLockSeeds, unexpected: [...new Set(unexpected)].sort((a, b) => a - b) });
}

console.table(rows.map((r) => ({ ...r, wrongSeeds: r.wrongSeeds.join(' ') || '-', wrongLockSeeds: r.wrongLockSeeds.join(' ') || '-', unexpected: r.unexpected.join(' ') || '-' })));
const unexpected = rows.reduce((n, r) => n + r.unexpected.length, 0);
console.log(`\nseeds ${firstSeed}-${firstSeed + seedCount - 1}, ${Math.round((Date.now() - t0) / 1000)} s. ${unexpected ? `${unexpected} seed(s) with a wrong outcome that is not a documented residual: trace them with the CLAUDE.md snippet.` : 'No wrong outcome beyond the documented residuals (KNOWN_WIDE).'}`);

const root = resolve(import.meta.dirname, '..', '..');
let sha = 'unknown';
try {
  sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();
} catch {
  // not a checkout
}
mkdirSync(join(root, '.rubric'), { recursive: true });
writeFileSync(join(root, '.rubric', 'sim-wide.json'), JSON.stringify({ date: new Date().toISOString(), sha, firstSeed, seeds: seedCount, rows, unexpected }, null, 1));
process.exit(unexpected ? 1 : 0);
