import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyCalibration, KNOB_TARGETS, nextVersion, readCalibration, readVersion, syncReadme } from '../src/feedback/calibrationWrite';
import { currentParams, KNOBS, type Params } from '../src/feedback/tune';
import { writeCalibration } from '../scripts/calibration-write';
import { CALIBRATION_VERSION } from '../src/vision/calibration';

const source = readFileSync('src/vision/calibration.ts', 'utf8');

test('every tunable knob is found exactly once in calibration.ts, at the value the replay uses', () => {
  assert.deepEqual(Object.keys(KNOB_TARGETS).sort(), KNOBS.map((k) => k.key).sort());
  assert.deepEqual(readCalibration(source), currentParams());
  assert.equal(readVersion(source), CALIBRATION_VERSION);
});

test('a written proposal reads back exactly, touches nothing else and bumps the version', () => {
  const changes: Partial<Params> = { faceAccept: 0.6, wCloth: 0.35, strangerBase: 0.97, clothAlpha: 0.3 };
  const { source: out, version } = applyCalibration(source, changes, '2031-01-02');
  assert.equal(version, '2031-01-02.1');
  assert.equal(readVersion(out), version);
  assert.deepEqual(readCalibration(out), { ...currentParams(), ...changes });
  const before = source.split('\n');
  const after = out.split('\n');
  assert.equal(after.length, before.length);
  const diff = before.filter((l, i) => l !== after[i]);
  // The version line and the four constants' lines, nothing else.
  assert.equal(diff.length, 5, diff.join('\n'));
});

test('version numbering', () => {
  assert.equal(nextVersion('2026-10-06.3', '2026-10-06'), '2026-10-06.4');
  assert.equal(nextVersion('2026-10-01.11', '2026-10-06'), '2026-10-06.1');
  assert.equal(nextVersion('odd', '2026-10-06'), '2026-10-06.1');
});

test('unknown knobs and bad values are refused', () => {
  assert.throws(() => applyCalibration(source, { nope: 1 } as unknown as Partial<Params>, '2031-01-01'), /unknown knob/);
  assert.throws(() => applyCalibration(source, { faceAccept: NaN }, '2031-01-01'), /not a number/);
  assert.throws(() => applyCalibration(source.replace('export const STRANGER_BASELINE', '// gone'), { strangerBase: 0.9 }, '2031-01-01'), /expected one match/);
});

test('the README face bars follow the calibration', () => {
  const readme = readFileSync('README.md', 'utf8');
  const { text, updated } = syncReadme(readme, { ...currentParams(), faceReject: 0.32, faceAccept: 0.64, faceOnlyReject: 0.62, faceOnlyAccept: 0.97 });
  assert.ok(updated >= 2, `updated ${updated}`);
  assert.match(text, /`FACE_CALIB` \(`reject` 0\.32, `accept` 0\.64\)/);
  assert.match(text, /`FACE_ONLY_CALIB`, 0\.62\/0\.97\)/);
  assert.equal(syncReadme(readme, currentParams()).text, readme, 'the current values are what README says');
});

test('the script writes calibration.ts and README in a checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'calwrite-'));
  mkdirSync(join(root, 'src/vision'), { recursive: true });
  copyFileSync('src/vision/calibration.ts', join(root, 'src/vision/calibration.ts'));
  copyFileSync('README.md', join(root, 'README.md'));
  const version = writeCalibration({ faceAccept: 0.64 }, '2031-05-05', root);
  assert.equal(version, '2031-05-05.1');
  assert.equal(readCalibration(readFileSync(join(root, 'src/vision/calibration.ts'), 'utf8')).faceAccept, 0.64);
  assert.match(readFileSync(join(root, 'README.md'), 'utf8'), /`accept` 0\.64/);
});
