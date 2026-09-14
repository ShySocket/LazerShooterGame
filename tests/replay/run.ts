/**
 * Replays every recording in a folder (default tests/replay/fixtures) through the current pipeline
 * and prints one row per file: npm run replay [folder] [--threshold 0.5] [--margin 0.2].
 * A recording has no ground truth; the table says what the game would decide with today's
 * calibration, which is what to compare across calibrations or read next to the recording's notes.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { replayRecording } from '../../src/debug/replay';
import type { Recording } from '../../src/debug/recorder';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : undefined; };
const folder = args.find((a) => !a.startsWith('--') && !/^[0-9.]+$/.test(a)) ?? new URL('./fixtures', import.meta.url).pathname;
const rows: Record<string, string | number>[] = [];
for (const file of readdirSync(folder).filter((f) => f.endsWith('.json')).sort()) {
  const rec = JSON.parse(readFileSync(join(folder, file), 'utf8')) as Recording;
  const r = await replayRecording(rec, { hitThreshold: opt('--threshold'), hitMargin: opt('--margin') });
  rows.push({
    recording: file,
    recordedWith: r.recordedWith,
    frames: r.frames,
    period: `${Math.round(r.periodMs)}ms`,
    shots: r.shots.length,
    hits: Object.entries(r.hitsBy).map(([id, n]) => `${id}:${n}`).join(' ') || '-',
    unclear: r.unclear,
    miss: r.miss,
    stale: r.stale,
    'lock frames': Object.entries(r.locksBy).map(([id, n]) => `${id}:${n}`).join(' ') || '-',
    notes: (rec.notes ?? '').slice(0, 60),
  });
}
console.table(rows);
console.log(`Replayed with calibration ${rows.length ? (await import('../../src/vision/calibration')).CALIBRATION_VERSION : '-'}.`);
