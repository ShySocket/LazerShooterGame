import { aggregate, SCENARIOS, simulate } from './engine';

/**
 * Prints the laser-tag simulation table: npm run sim [scenario-name-substring] [--seeds N] [--strict].
 * With --strict the process exits 1 on any wrong hit or wrong-lock frame and prints the trace around
 * each one, so a wide seed sweep is an acceptance gate rather than a report.
 */
const args = process.argv.slice(2);
const seedsArg = args.indexOf('--seeds');
const seedCount = seedsArg >= 0 ? Number(args[seedsArg + 1]) : 3;
const strict = args.includes('--strict');
const filter = args.filter((a, i) => !a.startsWith('--') && (seedsArg < 0 || i !== seedsArg + 1));
const seeds = Array.from({ length: seedCount }, (_, i) => i + 1);

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '-');
const rows: Record<string, string | number>[] = [];
let failures = 0;
for (const scenario of SCENARIOS) {
  if (filter.length && !filter.some((f) => scenario.name.includes(f))) continue;
  const a = await aggregate(scenario, seeds);
  rows.push({
    scenario: a.name,
    shots: a.shots,
    possible: a.possible,
    hit: pct(a.correct, a.possible),
    wrong: a.wrong,
    ambig: a.ambiguous,
    unclear: a.unclear,
    miss: a.miss,
    stale: a.stale,
    'lock%': pct(a.lockFraction, 1),
    wrongLock: a.wrongLockFrames,
    maybeNP: a.maybeOnNonPlayer,
    firstLock: a.firstLockMs === null ? '-' : `${a.firstLockMs}ms`,
    latency: a.hitLatencyMs === null ? '-' : `${a.hitLatencyMs}ms`,
    period: `${a.periodMs}ms`,
    tracks: a.trackChurn.toFixed(1),
  });
  if (strict && (a.wrong > 0 || a.wrongLockFrames > 0)) {
    failures++;
    for (const seed of seeds) {
      const r = await simulate(scenario, { seed });
      for (const trace of r.wrongTraces) console.log(`\n${scenario.name} seed ${seed}:\n  ${trace.join('\n  ')}`);
    }
  }
}
console.table(rows);
console.log('\nhit = share of the possible shots (target visibly under the dot at the tap) that registered on them; wrong = shots registered on anybody else (the worst outcome).');
console.log('lock% = frames with a green LOCK on the right name; tracks = track ids the target went through per run (1 is perfect continuity).');
console.log('ambig = hits the oracle could not judge (within jitter of a nearer person or off the torso): never credited, never wrong.');
console.log('maybeNP = frames with a hedged player name shown on a non-player (what a wrong lock grows from); latency = mean tap-to-hit time of the correct shots.');
if (strict) {
  console.log(failures ? `\n${failures} scenario(s) produced a wrong hit or a wrong lock.` : '\nNo wrong hits and no wrong locks.');
  process.exit(failures ? 1 : 0);
}
