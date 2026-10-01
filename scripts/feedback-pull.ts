/**
 * Pull the shot feedback log (practice shots and review-card answers) and say what it shows.
 *
 *     npm run feedback:pull                    fetch with the Firebase CLI (one-time: npx firebase-tools login)
 *     npm run feedback:pull -- --file x.json   use an export instead (the console's Export JSON, or a saved pull)
 *     npm run feedback:pull -- --since 2026-09-26
 *
 * Every pull is saved to .rubric/feedback/ (git-ignored: the profiles in it are re-identifiable).
 * Then: right hits, wrong hits (listed), misses by cause, refusals of non-players, per build, and the
 * calibration sweep of `npm run replay` over the same samples.
 */
import { agreement, asPlayed, evaluate, sweep } from '../src/feedback/replay.ts';
import { summarise } from '../src/feedback/triage.ts';
import type { ShotSample } from '../src/feedback/sample.ts';
import { loadFeedback, playSamples } from './feedback-source.ts';

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

const data = loadFeedback(opt('--file'));
const since = opt('--since') ? Date.parse(opt('--since')!) : 0;
const samples = playSamples(data, since);
const labelled = samples.filter((s): s is ShotSample & { label: NonNullable<ShotSample['label']> } => Boolean(s.label));
const pct = (x: number | null) => (x === null ? '-' : `${Math.round(x * 100)}%`);

console.log(`\n${samples.length} samples, ${labelled.length} labelled, from ${new Set(samples.map((s) => s.round.key)).size} rounds`);
const byBuild = new Map<string, ShotSample[]>();
for (const s of labelled) byBuild.set(`${s.app.commit} ${s.app.faceModel}`, [...(byBuild.get(`${s.app.commit} ${s.app.faceModel}`) ?? []), s]);
for (const [build, list] of byBuild) {
  const t = summarise(list);
  console.log(`\nbuild ${build}: ${t.labelled} labelled shots, hit rate on players ${pct(t.hitRate)}, non-players refused ${pct(t.refusalRate)}`);
  for (const [k, n] of Object.entries(t.counts).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${n}`);
  for (const w of t.wrong) console.log(`  ! ${w.verdict}: round ${w.round} shot ${w.shot}, resolved ${w.resolvedTo}, labelled ${w.label}, belief ${JSON.stringify(w.belief)}`);
}
if (labelled.length) {
  const played = evaluate(labelled, {}, asPlayed);
  console.log(`\nAs played: correct ${played.correct}, wrong ${played.wrong}, miss ${played.miss}; replay with today's defaults agrees on ${Math.round(agreement(labelled) * 100)}%`);
  const rows = sweep(labelled);
  const w = Math.max(...rows.map((r) => r.name.length));
  console.log('\n' + 'calibration change'.padEnd(w) + '  correct  wrong  miss  score');
  for (const r of rows) console.log(`${r.name.padEnd(w)}  ${String(r.result.correct).padStart(7)}  ${String(r.result.wrong).padStart(5)}  ${String(r.result.miss).padStart(4)}  ${String(r.result.score).padStart(5)}`);
  console.log('\nscore = wrong x 5 + miss; lower is better. A change only ships after the sim and realcheck gates pass.');
}
