import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exportFeedback } from './sim/feedbackExport';
import { readCalibration, readVersion } from '../src/feedback/calibrationWrite';
import { CALIBRATION_VERSION } from '../src/vision/calibration';

const ROOT = resolve(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'tune-cli-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

/** A throwaway checkout holding the two files the tuner writes. */
function checkout(name: string): string {
  const root = join(dir, name);
  mkdirSync(join(root, 'src/vision'), { recursive: true });
  copyFileSync(join(ROOT, 'src/vision/calibration.ts'), join(root, 'src/vision/calibration.ts'));
  copyFileSync(join(ROOT, 'README.md'), join(root, 'README.md'));
  return root;
}

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ['--import', './tests/register.mjs', 'scripts/tune.ts', ...args], { cwd: ROOT, env: { ...process.env, PATH: '/nonexistent', ...env }, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const LOOSE = JSON.stringify({ minMissGain: 1, minMissGainShare: 0, minHoldoutGain: 0 });

test('npm run tune: a proposal is written into calibration.ts with a version bump and a PR body (exit 10)', async () => {
  const file = join(dir, 'clean.json');
  writeFileSync(file, JSON.stringify({ feedback: await exportFeedback({ seeds: [1, 2] }) }));
  const root = checkout('propose');
  const out = join(dir, 'out-propose');
  const r = run(['--file', file, '--out', out, '--day', '2031-02-03'], { LZ_TUNE_GUARDS: LOOSE, LZ_TUNE_ROOT: root });
  assert.equal(r.status, 10, r.stdout + r.stderr);
  const cal = readFileSync(join(root, 'src/vision/calibration.ts'), 'utf8');
  assert.equal(readVersion(cal), '2031-02-03.1');
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.decision, 'propose');
  assert.equal(summary.fromVersion, CALIBRATION_VERSION);
  for (const c of summary.changes) assert.equal(readCalibration(cal)[c.key as 'faceAccept'], c.to);
  const body = readFileSync(join(out, 'pr-body.md'), 'utf8');
  assert.match(body, /Proposal: fewer refused legitimate shots, zero replayed wrong hits/);
  assert.match(body, /\| candidate, hold-out \| \d+ \| \d+ \| 0 \|/);
  assert.match(readFileSync(join(out, 'pr-title.txt'), 'utf8'), /^tune\(calibration\): .*2031-02-03\.1/);
  // --dry decides the same and writes nothing.
  const dryRoot = checkout('dry');
  const d = run(['--file', file, '--out', join(dir, 'out-dry'), '--dry'], { LZ_TUNE_GUARDS: LOOSE, LZ_TUNE_ROOT: dryRoot });
  assert.equal(d.status, 0);
  assert.equal(readFileSync(join(dryRoot, 'src/vision/calibration.ts'), 'utf8'), readFileSync(join(ROOT, 'src/vision/calibration.ts'), 'utf8'));
});

test('npm run tune: poisoned labels change nothing and say why (exit 0)', async () => {
  const file = join(dir, 'poison.json');
  writeFileSync(file, JSON.stringify({ feedback: await exportFeedback({ seeds: [1, 2], poison: 0.25 }) }));
  const root = checkout('poison');
  const out = join(dir, 'out-poison');
  const r = run(['--file', file, '--out', out], { LZ_TUNE_GUARDS: LOOSE, LZ_TUNE_ROOT: root });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /labels unreliable/);
  assert.equal(readFileSync(join(root, 'src/vision/calibration.ts'), 'utf8'), readFileSync(join(ROOT, 'src/vision/calibration.ts'), 'utf8'));
  assert.match(readFileSync(join(out, 'pr-body.md'), 'utf8'), /No change: the calibration is kept/);
});

test('npm run tune: an unreadable guard override is a usage error (exit 2)', () => {
  assert.equal(run(['--file', 'nope.json'], { LZ_TUNE_GUARDS: '{' }).status, 2);
});
