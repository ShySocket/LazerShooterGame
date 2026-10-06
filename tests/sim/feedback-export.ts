import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { exportFeedback } from './feedbackExport';
import { agreement, collectSamples, evaluate } from '../../src/feedback/replay';

/**
 * npm run sim:feedback -- [scenario-substring...] [--seeds N] [--from S] [--poison P] [--out file]
 * Writes simulated rounds as a /feedback export (default .rubric/feedback/sim-feedback.json) and
 * prints how the replay scores them under the current calibration.
 */
const args = process.argv.slice(2);
const valueOf = (flag: string): string | null => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : null);
const seedCount = Number(valueOf('--seeds') ?? 3);
const firstSeed = Number(valueOf('--from') ?? 1);
const poison = Number(valueOf('--poison') ?? 0);
const out = valueOf('--out') ?? '.rubric/feedback/sim-feedback.json';
const valueIndexes = new Set(['--seeds', '--from', '--poison', '--out'].map((f) => args.indexOf(f)).filter((i) => i >= 0).map((i) => i + 1));
const filter = args.filter((a, i) => !a.startsWith('--') && !valueIndexes.has(i));

const data = await exportFeedback({ seeds: Array.from({ length: seedCount }, (_, i) => i + firstSeed), filter, poison });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ feedback: data }));
const samples = collectSamples(data);
const e = evaluate(samples);
console.log(`${Object.keys(data.rounds).length} rounds, ${samples.length} labelled samples${poison ? `, ${Math.round(poison * 100)}% labels poisoned` : ''} -> ${out}`);
console.log(`replay at current calibration: correct ${e.correct}, wrong ${e.wrong}, miss ${e.miss}, score ${e.score}; agreement with the game ${(agreement(samples) * 100).toFixed(1)}%`);
