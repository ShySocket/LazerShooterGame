import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ShotSample } from '../src/feedback/sample';

/**
 * The feedback scripts as a user runs them (session:report, feedback:pull, replay), on a small saved
 * log: two rounds two days apart, the later one holding a wrong hit.
 */
const ROOT = resolve(import.meta.dirname, '..');
const START_A = new Date(2026, 8, 28, 20, 0).getTime();
const START_B = new Date(2026, 8, 30, 20, 0).getTime();
const KEY_A = `ABCD-${START_A}`;
const KEY_B = `EFGH-${START_B}`;

let n = 0;
function shot(key: string, resolvedTo: string, target: string): ShotSample {
  return {
    v: 2,
    app: { commit: 'abc1234', faceModel: 'ghost', bodyModel: 'movenet', ua: 'node' },
    round: { key, code: key.slice(0, 4), startAt: Number(key.slice(5)), settings: { hitThreshold: 0.5, hitMargin: 0.2 } as ShotSample['round']['settings'], players: 3, shooter: 'p0', eligible: ['p1', 'p2'] },
    device: { periodMs: 120, staleMs: 400, burstMs: 600, width: 720, height: 1280 },
    shot: { id: `s${n++}`, roundMs: 1000, outcome: 'hit', kind: 'instant', resolvedTo, via: 'face', resolveMs: 50, zoom: false, frameAgeMs: 30, allowanceMs: 400, crosshair: [0.48, 0.48, 0.04, 0.04], trackId: 1, decidedAtFrame: 0, settledBy: 'tap', decisionTrackId: 1, decisionBelief: { p1: 0.9 } },
    frames: [],
    target: null,
    label: { kind: 'player', target, answeredAt: 0, reviewMs: 0 },
  };
}

const dir = mkdtempSync(join(tmpdir(), 'lz-feedback-cli-'));
const LOG = join(dir, 'feedback.json');
writeFileSync(
  LOG,
  JSON.stringify({
    feedback: {
      rounds: {
        [KEY_A]: { samples: { a: shot(KEY_A, 'p1', 'p1'), b: shot(KEY_A, 'p1', 'p1') } },
        // The held-out round: one right hit and one wrong-player hit.
        [KEY_B]: { samples: { c: shot(KEY_B, 'p1', 'p2'), d: shot(KEY_B, 'p1', 'p1') } },
      },
    },
  }),
);
// A stand-in for `npx firebase-tools database:get /feedback`: what a live pull returns.
const BIN = join(dir, 'bin');
mkdirSync(BIN);
writeFileSync(join(BIN, 'npx'), `#!/bin/sh\ncat '${LOG}'\n`);
chmodSync(join(BIN, 'npx'), 0o755);
const PULLS = join(dir, 'pulls');

test.after(() => rmSync(dir, { recursive: true, force: true }));

function run(script: string, args: string[], live = false) {
  const env = { ...process.env, LZ_FEEDBACK_OUT: PULLS, ...(live ? { PATH: `${BIN}:${process.env.PATH}` } : {}) };
  const r = spawnSync(process.execPath, ['--import', './tests/register.mjs', `scripts/${script}`, ...args], { cwd: ROOT, env, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('session:report exits 2 with the reason on a --since or --eval it cannot read, instead of an empty pass', () => {
  // The log holds a wrong hit, so a report that read it exits 1; a typo used to drop every round and exit 0.
  assert.equal(run('session-report.ts', ['--file', LOG]).status, 1);
  const since = run('session-report.ts', ['--file', LOG, '--since', '26/09/2026']);
  assert.equal(since.status, 2);
  assert.match(since.stderr, /--since: cannot read 26\/09\/2026/);
  assert.equal(since.stdout, '');
  const evalTypo = run('session-report.ts', ['--file', LOG, '--eval', '26/09/2026']);
  assert.equal(evalTypo.status, 2);
  assert.match(evalTypo.stderr, /--eval: cannot read 26\/09\/2026/);
  const noValue = run('session-report.ts', ['--file', LOG, '--since']);
  assert.equal(noValue.status, 2);
  assert.match(noValue.stderr, /--since needs a value/);
  // A date it can read keeps working: only the later round, which has the wrong hit.
  const later = run('session-report.ts', ['--file', LOG, '--since', '2026-09-30', '--json']);
  assert.equal(later.status, 1);
  assert.equal(JSON.parse(later.stdout).samples, 2);
});

test('session:report --json writes nothing but the report to stdout, also on a live pull', () => {
  const r = run('session-report.ts', ['--json'], true);
  assert.equal(r.status, 1, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.samples, 4);
  // Where the pull was saved goes to stderr.
  assert.match(r.stderr, /^saved .*feedback-.*\.json$/m);
  assert.equal(readdirSync(PULLS).length, 1);
});

test('feedback:pull leaves the held-out rounds out of the triage and the calibration sweep, and says how many', () => {
  const all = run('feedback-pull.ts', ['--file', LOG]);
  assert.match(all.stdout, /As played: correct 3, wrong 1, miss 0/);
  const r = run('feedback-pull.ts', ['--file', LOG, '--eval', '2026-09-30']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /held out for evaluation, not tuned on: 2 samples from 1 round, the rounds started at or after 2026-09-30/);
  assert.match(r.stdout, /As played: correct 2, wrong 0, miss 0/);
  assert.doesNotMatch(r.stdout, /WRONG hit/);
  assert.equal(run('feedback-pull.ts', ['--file', LOG, '--eval', '26/09/2026']).status, 2);
});

test('the replay takes the same --eval, sweeps without the held-out rounds, and --json is only the rows', () => {
  const r = run('replay-feedback.ts', [LOG, '--eval', '2026-09-30']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /held out for evaluation, not tuned on: 2 samples from 1 round/);
  assert.match(r.stdout, /As played: {2}correct 2 {2}wrong 0 {2}miss 0/);
  const json = run('replay-feedback.ts', [LOG, '--eval', KEY_B, '--json']);
  assert.equal(json.status, 0, json.stderr);
  const rows = JSON.parse(json.stdout) as { name: string; result: { correct: number; wrong: number; miss: number } }[];
  assert.ok(rows.length > 0 && rows.every((x) => x.result.correct + x.result.wrong + x.result.miss === 2));
  assert.match(json.stderr, /held out for evaluation/);
});
