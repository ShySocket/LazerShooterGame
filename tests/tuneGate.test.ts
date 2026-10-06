import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exportFeedback } from './sim/feedbackExport';
import { collectSamples, replayShot } from '../src/feedback/replay';

const ROOT = resolve(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'tune-gate-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const gate = (out: string) => spawnSync(process.execPath, ['--import', './tests/register.mjs', 'scripts/tune-gate.ts', '--out', out, '--only', 'replay'], { cwd: ROOT, encoding: 'utf8' });

test('tune:gate passes clean shots and fails on a replayed wrong hit, writing the result into the PR body', async () => {
  const samples = collectSamples(await exportFeedback({ seeds: [1], filter: ['duel-close'] }));
  const clean = join(dir, 'clean');
  const bad = join(dir, 'bad');
  for (const [out, list] of [
    [clean, samples],
    // A replayed hit relabelled as somebody else's: what a proposal that lets a wrong hit through looks like.
    [bad, samples.map((s, i) => (i === samples.findIndex((x) => replayShot(x).resolved) ? { ...s, label: { kind: 'none' as const, answeredAt: 0, reviewMs: 1 } } : s))],
  ] as const) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'samples.json'), JSON.stringify(list));
    writeFileSync(join(out, 'pr-body.md'), '## body\n');
  }
  const ok = gate(clean);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(readFileSync(join(clean, 'pr-body.md'), 'utf8'), /### Gate: passed/);
  const no = gate(bad);
  assert.equal(no.status, 1, no.stdout + no.stderr);
  assert.match(readFileSync(join(bad, 'pr-body.md'), 'utf8'), /### Gate: FAILED[\s\S]*1 replayed wrong hit/);
  assert.equal(JSON.parse(readFileSync(join(bad, 'gate.json'), 'utf8')).ok, false);
});
