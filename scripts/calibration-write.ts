import { readFileSync, writeFileSync } from 'node:fs';
import { applyCalibration, readCalibration, syncReadme } from '../src/feedback/calibrationWrite';
import type { Params } from '../src/feedback/tune';

/**
 * node --import ./tests/register.mjs scripts/calibration-write.ts <params.json> [--day YYYY-MM-DD]
 * Writes a tuning proposal ({"faceAccept": 0.6, ...}, only the knobs that change) into
 * src/vision/calibration.ts, bumps CALIBRATION_VERSION and keeps the README's face bars in sync.
 * Prints the new version. Refuses unknown knobs and targets it cannot find exactly once.
 */
export function writeCalibration(changes: Partial<Params>, day: string, root = '.'): string {
  const calPath = `${root}/src/vision/calibration.ts`;
  const readmePath = `${root}/README.md`;
  const { source, version } = applyCalibration(readFileSync(calPath, 'utf8'), changes, day);
  writeFileSync(calPath, source);
  const all = readCalibration(source);
  const { text, updated } = syncReadme(readFileSync(readmePath, 'utf8'), all);
  if (updated) writeFileSync(readmePath, text);
  return version;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: calibration-write.ts <params.json> [--day YYYY-MM-DD]');
    process.exit(2);
  }
  const day = args.includes('--day') ? args[args.indexOf('--day') + 1] : new Date().toISOString().slice(0, 10);
  console.log(writeCalibration(JSON.parse(readFileSync(file, 'utf8')), day));
}
