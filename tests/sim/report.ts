import { aggregate, SCENARIOS } from './engine';

/** Prints the laser-tag simulation table: npm run sim [scenario-name-substring] [--seeds N]. */
const args = process.argv.slice(2);
const seedsArg = args.indexOf('--seeds');
const seedCount = seedsArg >= 0 ? Number(args[seedsArg + 1]) : 3;
const filter = args.filter((a, i) => !a.startsWith('--') && (seedsArg < 0 || i !== seedsArg + 1));
const seeds = Array.from({ length: seedCount }, (_, i) => i + 1);

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '-');
const rows: Record<string, string | number>[] = [];
for (const scenario of SCENARIOS) {
  if (filter.length && !filter.some((f) => scenario.name.includes(f))) continue;
  const a = await aggregate(scenario, seeds);
  rows.push({
    scenario: a.name,
    shots: a.shots,
    hit: pct(a.correct, a.shots),
    wrong: a.wrong,
    unclear: a.unclear,
    miss: a.miss,
    stale: a.stale,
    'lock%': pct(a.lockFraction, 1),
    wrongLock: a.wrongLockFrames,
    firstLock: a.firstLockMs === null ? '-' : `${a.firstLockMs}ms`,
    period: `${a.periodMs}ms`,
    tracks: a.trackChurn.toFixed(1),
  });
}
console.table(rows);
console.log('\nhit = shots that registered on the aimed player; wrong = shots registered on anybody else (the worst outcome).');
console.log('lock% = frames with a green LOCK on the right name; tracks = track ids the target went through per run (1 is perfect continuity).');
