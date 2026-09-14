#!/usr/bin/env node
/**
 * Real-phone validation: replays every recording under a folder through the current pipeline and
 * prints counts with their denominators, then exits non-zero on any wrong hit.
 *
 *   node scripts/validate.mjs [folder]          (default: tests/replay/fixtures)
 *
 * Recordings come from the game opened with ?record (README 2e); taps made in range mode carry the
 * shooter's declared target, which is what makes a hit judgeable. Name files
 * <scenario>__<phone>__<n>.json to get one row per scenario and per phone.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The app's TypeScript is loaded through the same hook the tests use.
await import(pathToFileURL(resolve(new URL('.', import.meta.url).pathname, '../tests/register.mjs')).href);
const { replayRecording } = await import('../src/debug/replay.ts');
const { CALIBRATION_VERSION } = await import('../src/vision/calibration.ts');

const folder = resolve(process.argv[2] ?? 'tests/replay/fixtures');
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.json')) files.push(p);
  }
};
walk(folder);
if (!files.length) {
  console.error(`no recordings under ${folder}`);
  process.exit(2);
}

const pct = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : `${n}/0`);
const groups = new Map();
const totals = { labelled: 0, correct: 0, wrong: 0, unclear: 0, miss: 0, stale: 0, shots: 0, frames: 0, lockOnExpected: 0 };
const rows = [];
for (const file of files.sort()) {
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  const r = await replayRecording(rec);
  const base = file.slice(folder.length + 1).replace(/\.json$/, '');
  const [scenario = base, phone = '-'] = base.split('__');
  const expected = new Set(rec.fires.map((f) => f.expectedId).filter((id) => typeof id === 'string'));
  const lockOnExpected = [...expected].reduce((s, id) => s + (r.locksBy[id] ?? 0), 0);
  const row = { scenario, phone, frames: r.frames, shots: r.shots.length, labelled: r.labelled, correct: r.correct, wrong: r.wrong, unclear: r.unclear, miss: r.miss, stale: r.stale, lockOnExpected };
  rows.push({ file: base, ...row });
  const g = groups.get(scenario) ?? { scenario, files: 0, frames: 0, shots: 0, labelled: 0, correct: 0, wrong: 0, unclear: 0, miss: 0, stale: 0, lockOnExpected: 0 };
  g.files++;
  for (const k of ['frames', 'shots', 'labelled', 'correct', 'wrong', 'unclear', 'miss', 'stale', 'lockOnExpected']) { g[k] += row[k]; totals[k] += row[k]; }
  groups.set(scenario, g);
}

console.log(`Validation with calibration ${CALIBRATION_VERSION}, ${files.length} recording(s) under ${folder}\n`);
console.table(rows.map((r) => ({ recording: r.file, frames: r.frames, shots: r.shots, 'correct/labelled': pct(r.correct, r.labelled), wrong: r.wrong, unclear: r.unclear, miss: r.miss, stale: r.stale, 'lock on expected/frames': pct(r.lockOnExpected, r.frames) })));
console.log('\nPer scenario:');
console.table([...groups.values()].map((g) => ({ scenario: g.scenario, recordings: g.files, 'correct/labelled': pct(g.correct, g.labelled), 'wrong/labelled': pct(g.wrong, g.labelled), 'unclear/shots': pct(g.unclear, g.shots), 'miss/shots': pct(g.miss, g.shots), 'lock on expected/frames': pct(g.lockOnExpected, g.frames) })));
console.log(`\nTotal: correct ${pct(totals.correct, totals.labelled)} of labelled shots, wrong ${pct(totals.wrong, totals.labelled)}, unclear ${pct(totals.unclear, totals.shots)}, miss ${pct(totals.miss, totals.shots)}, stale ${pct(totals.stale, totals.shots)}, lock on the expected player ${pct(totals.lockOnExpected, totals.frames)} of frames.`);
console.log('Zero wrong hits in a sample is not proof of a zero rate; report the denominators.');
if (totals.wrong > 0) {
  console.error(`\nFAIL: ${totals.wrong} wrong hit(s).`);
  process.exit(1);
}
