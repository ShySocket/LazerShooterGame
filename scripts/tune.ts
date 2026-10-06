/**
 * The nightly tuning step (docs/tuning-loop.md):
 *
 *     npm run tune                         pull the live log (service account or firebase-tools login)
 *     npm run tune -- --file x.json        use a saved export (or npm run sim:feedback's)
 *     npm run tune -- --dry                decide and report, write nothing to src/ or README
 *     npm run tune -- --since 2026-09-26 --eval 2026-10-08   the same round filters as feedback:pull
 *
 * Triage, guarded search (src/feedback/tune.ts), and on a proposal the calibration written into
 * src/vision/calibration.ts with a version bump. Always writes <out>/pr-body.md, <out>/pr-title.txt
 * <out>/summary.json and <out>/samples.json, the labelled shots it decided on, for tune:gate (default
 * .rubric/tune, git-ignored). Exit 0: no change; 10: calibration changed (run
 * npm run tune:gate next); 2: could not run. LZ_TUNE_GUARDS (JSON) overrides guards and LZ_TUNE_ROOT
 * names the checkout to write into, for tests.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { summarise } from '../src/feedback/triage.ts';
import { tune, TUNE_GUARDS } from '../src/feedback/tune.ts';
import { prBody, prTitle } from '../src/feedback/tuneReport.ts';
import { CALIBRATION_VERSION } from '../src/vision/calibration.ts';
import { loadFeedback, optValue, playSamples, readRoundFilters, tuningSamples, usageError } from './feedback-source.ts';
import { writeCalibration } from './calibration-write.ts';

const args = process.argv.slice(2);
const ROOT = resolve(import.meta.dirname, '..');
const outDir = resolve(optValue(args, '--out') ?? join(ROOT, '.rubric', 'tune'));
const day = optValue(args, '--day') ?? new Date().toISOString().slice(0, 10);
const dry = args.includes('--dry');
let guards: Partial<typeof TUNE_GUARDS> = {};
try {
  guards = process.env.LZ_TUNE_GUARDS ? JSON.parse(process.env.LZ_TUNE_GUARDS) : {};
} catch {
  usageError('LZ_TUNE_GUARDS is not JSON');
}

const { since, split } = readRoundFilters(args);
const data = await loadFeedback(optValue(args, '--file'));
const tuning = tuningSamples(playSamples(data, since), split);
const samples = tuning.samples;
const result = tune(samples, { guards, calibrationVersion: CALIBRATION_VERSION });
let toVersion: string | null = null;
if (result.decision !== 'none' && !dry) {
  const changes = Object.fromEntries(result.changes.map((c) => [c.key, c.to]));
  toVersion = writeCalibration(changes, day, process.env.LZ_TUNE_ROOT ? resolve(process.env.LZ_TUNE_ROOT) : ROOT);
}
const body = prBody({ result, triage: summarise(samples), samples, fromVersion: CALIBRATION_VERSION, toVersion, day }) + (tuning.note ? `\n_${tuning.note}_\n` : '');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'pr-body.md'), body);
writeFileSync(join(outDir, 'pr-title.txt'), prTitle(result, toVersion));
// The shots the gate replays under the written calibration; the track's face mean is dropped, it is not needed.
writeFileSync(join(outDir, 'samples.json'), JSON.stringify(samples.filter((s) => s.label).map((s) => ({ ...s, target: s.target ? { ...s.target, faceMean: null } : null }))));
writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ day, decision: result.decision, fromVersion: CALIBRATION_VERSION, toVersion, changes: result.changes, reasons: result.reasons, evidence: result.evidence }, null, 2));
console.log(`${result.decision}${result.changes.length ? ': ' + result.changes.map((c) => `${c.key} ${c.from}->${c.to}`).join(', ') : ''}${toVersion ? ` (calibration ${toVersion})` : ''}`);
for (const r of result.reasons) console.log(`  ${r}`);
console.log(`report: ${join(outDir, 'pr-body.md')}`);
process.exit(result.decision === 'none' || dry ? 0 : 10);
