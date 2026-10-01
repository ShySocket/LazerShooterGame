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
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { agreement, asPlayed, collectSamples, evaluate, sweep } from '../src/feedback/replay.ts';
import { summarise } from '../src/feedback/triage.ts';
import type { ShotSample } from '../src/feedback/sample.ts';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

function fetchLog(): unknown {
  try {
    const out = execFileSync('npx', ['-y', 'firebase-tools', 'database:get', '/feedback', '--project', 'lazer-shooter', '--instance', 'lazer-shooter-default-rtdb'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out);
  } catch (e) {
    // firebase-tools prints its own errors on stdout; npm's install warnings fill stderr.
    const err = e as { stdout?: string; stderr?: string };
    const msg = `${err.stdout ?? ''}\n${err.stderr ?? String(e)}`.split('\n').filter((l) => !l.startsWith('npm warn')).join('\n');
    if (/login|authenticate|credential|401|403/i.test(msg)) {
      console.error('The feedback log is readable only with the project owner\'s login. Run this once, approve in the browser, then run npm run feedback:pull again:\n\n  npx firebase-tools login\n');
    } else console.error(msg.trim().slice(-2000));
    process.exit(2);
  }
}

const file = opt('--file');
const data = file ? JSON.parse(readFileSync(file, 'utf8')) : fetchLog();
if (!file) {
  const dir = join(ROOT, '.rubric', 'feedback');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `feedback-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify(data));
  console.log('saved', out);
}

const since = opt('--since') ? Date.parse(opt('--since')!) : 0;
// Probe and test rounds (TEST-...) are not play.
const samples = collectSamples(data).filter((s) => !s.round.key.startsWith('TEST-') && s.round.startAt >= since);
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
