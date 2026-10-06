/**
 * The gate a tuning proposal must pass before the nightly job opens its pull request:
 *
 *     npm run tune:gate                    every check, after npm run tune exited 10
 *     npm run tune:gate -- --only replay,test   a subset (local runs and tests)
 *
 * Checks, in order: the replay of every shot npm run tune decided on (<out>/samples.json) under the
 * calibration now in src/ keeps zero wrong hits, on the hold-out rounds too, and the version was
 * bumped; npm test; typecheck; build; sim:full (100 seeds, strict); sim:wide (1000 seeds of the
 * crossing family); realcheck when fixtures/real is present (skipped and said so otherwise). Appends
 * a "Gate" section to <out>/pr-body.md and writes <out>/gate.json. Every check runs, so the report
 * says everything a person needs. Exit 0 when every check that ran passed; 3 when only the unit tests
 * failed and every safety check (replay, typecheck, build, sim:full, sim:wide, realcheck) passed: the
 * tests pin behaviour at today's numbers and need a person to update them, so the job opens a draft;
 * 1 otherwise.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { evaluate } from '../src/feedback/replay.ts';
import { isHoldout, TUNE_GUARDS } from '../src/feedback/tune.ts';
import type { ShotSample } from '../src/feedback/sample.ts';
import { CALIBRATION_VERSION } from '../src/vision/calibration.ts';
import { optValue } from './feedback-source.ts';

const args = process.argv.slice(2);
const ROOT = resolve(import.meta.dirname, '..');
const outDir = resolve(optValue(args, '--out') ?? join(ROOT, '.rubric', 'tune'));
const only = optValue(args, '--only')?.split(',');

interface Check {
  name: string;
  status: 'pass' | 'fail' | 'skipped';
  ms: number;
  detail: string;
}
const checks: Check[] = [];
const want = (name: string) => !only || only.includes(name);

function replayCheck(): Check {
  const t0 = Date.now();
  const file = join(outDir, 'samples.json');
  if (!existsSync(file)) return { name: 'replay', status: 'fail', ms: 0, detail: `${file} missing: run npm run tune first` };
  const summary = existsSync(join(outDir, 'summary.json')) ? JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8')) : null;
  const samples = JSON.parse(readFileSync(file, 'utf8')) as ShotSample[];
  const all = evaluate(samples);
  const hold = evaluate(samples.filter((s) => isHoldout(s.round.key, TUNE_GUARDS.holdoutShare)));
  const problems: string[] = [];
  if (all.wrong > 0) problems.push(`${all.wrong} replayed wrong hit(s)`);
  if (hold.wrong > 0) problems.push(`${hold.wrong} on the hold-out`);
  if (summary && summary.decision !== 'none' && summary.toVersion !== CALIBRATION_VERSION) problems.push(`calibration.ts says ${CALIBRATION_VERSION}, the proposal wrote ${summary.toVersion}`);
  const detail = `${all.n} shots under ${CALIBRATION_VERSION}: ${all.correct} right, ${all.wrong} wrong, ${all.miss} missed; hold-out ${hold.n} shots, ${hold.wrong} wrong`;
  return { name: 'replay', status: problems.length ? 'fail' : 'pass', ms: Date.now() - t0, detail: problems.length ? `${problems.join('; ')} (${detail})` : detail };
}

function npm(name: string, script: string[], skip?: string): Check {
  if (skip) return { name, status: 'skipped', ms: 0, detail: skip };
  const t0 = Date.now();
  const r = spawnSync('npm', ['run', '-s', ...script], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: process.env });
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  // node --test lists the failing tests after "failing tests:"; name those instead of the last lines.
  const failing = [...new Set(text.split('\n').filter((l) => /^✖ /.test(l) && !/failing tests/.test(l)).map((l) => l.replace(/^✖ /, '').replace(/ \([\d.]+ms\)$/, '')))];
  const tail = failing.length ? `failing: ${failing.join('; ')}\n\n${text.trim().split('\n').slice(-40).join('\n')}` : text.trim().split('\n').slice(-15).join('\n');
  console.log(`${r.status === 0 ? 'pass' : 'FAIL'} ${name} (${Math.round((Date.now() - t0) / 1000)} s)`);
  return { name, status: r.status === 0 ? 'pass' : 'fail', ms: Date.now() - t0, detail: r.status === 0 ? tail.split('\n').slice(-3).join(' / ') : tail };
}

if (want('replay')) {
  const c = replayCheck();
  console.log(`${c.status === 'pass' ? 'pass' : 'FAIL'} replay: ${c.detail}`);
  checks.push(c);
}
// Every check runs: a red unit test is often a test pinned to today's numbers, and whether the
// simulation sweeps still hold is what decides between a draft for a person and no pull request.
const steps: [string, string[], string?][] = [
  ['test', ['test']],
  ['typecheck', ['typecheck']],
  ['build', ['build']],
  ['sim:full', ['sim:full']],
  ['sim:wide', ['sim:wide']],
  ['realcheck', ['realcheck'], existsSync(join(ROOT, 'fixtures', 'real')) ? undefined : 'fixtures/real not present (npm run fixtures); run it on a developer machine before merging'],
];
for (const [name, script, skip] of steps) {
  if (!want(name)) continue;
  // A build that does not compile cannot be simulated meaningfully either.
  if (name.startsWith('sim') && checks.some((c) => (c.name === 'typecheck' || c.name === 'build') && c.status === 'fail')) {
    checks.push({ name, status: 'skipped', ms: 0, detail: 'the build failed' });
    continue;
  }
  checks.push(npm(name, script, skip));
}

const ok = checks.every((c) => c.status !== 'fail');
const failed = checks.filter((c) => c.status === 'fail').map((c) => c.name);
const testsOnly = !ok && failed.every((n) => n === 'test') && checks.some((c) => c.name === 'sim:full' && c.status === 'pass');
const icon = { pass: '✅', fail: '❌', skipped: '⏭️' } as const;
const plain = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, '');
/** One line for the table: a failure's first line (the failing tests), otherwise the output's last line. */
const cell = (c: Check) => {
  const lines = plain(c.detail).split('\n').map((l) => l.trim()).filter(Boolean);
  return ((c.status === 'fail' ? lines[0] : lines[lines.length - 1]) ?? '').replace(/\|/g, '\\|').slice(0, 300);
};
const md = [
  '',
  `### Gate: ${ok ? 'passed' : testsOnly ? 'safety checks passed, unit tests need updating' : 'FAILED'}`,
  ...(testsOnly ? ['', 'Replay, build and the simulation sweeps hold under the new numbers; the failing unit tests assert behaviour at the old ones. A person decides whether each is a pinned number to update or a real regression before this leaves draft.'] : []),
  '',
  '| check | result | time | detail |',
  '|---|---|---|---|',
  ...checks.map((c) => `| ${c.name} | ${icon[c.status]} ${c.status} | ${Math.round(c.ms / 1000)} s | ${cell(c)} |`),
  '',
  ...checks.filter((c) => c.status === 'fail').flatMap((c) => [`<details><summary>${c.name} output</summary>`, '', '```', plain(c.detail), '```', '</details>', '']),
].join('\n');
if (existsSync(join(outDir, 'pr-body.md'))) appendFileSync(join(outDir, 'pr-body.md'), md);
writeFileSync(join(outDir, 'gate.json'), JSON.stringify({ ok, testsOnly, calibration: CALIBRATION_VERSION, checks }, null, 2));
console.log(ok ? 'gate passed' : testsOnly ? 'gate: safety checks passed, unit tests failed' : 'gate FAILED');
process.exit(ok ? 0 : testsOnly ? 3 : 1);
