import type { Params, TunableKey } from './tune';

/**
 * Where each tunable knob lives in src/vision/calibration.ts, so the tuning loop can write a
 * proposal back as an ordinary edit of that file (scripts/calibration-write.ts). Pure string work:
 * every target must match exactly once, or nothing is written.
 */
export const KNOB_TARGETS: Record<TunableKey, { constant: string; field?: string }> = {
  faceReject: { constant: 'FACE_CALIB', field: 'reject' },
  faceAccept: { constant: 'FACE_CALIB', field: 'accept' },
  faceOnlyReject: { constant: 'FACE_ONLY_CALIB', field: 'reject' },
  faceOnlyAccept: { constant: 'FACE_ONLY_CALIB', field: 'accept' },
  wFace: { constant: 'EVIDENCE_WEIGHTS', field: 'face' },
  wCloth: { constant: 'EVIDENCE_WEIGHTS', field: 'cloth' },
  wBody: { constant: 'EVIDENCE_WEIGHTS', field: 'body' },
  clothFloor: { constant: 'CLOTHING_EVIDENCE', field: 'floor' },
  clothSpan: { constant: 'CLOTHING_EVIDENCE', field: 'span' },
  strangerBase: { constant: 'STRANGER_BASELINE' },
  faceAlpha: { constant: 'FACE_BELIEF_ALPHA' },
  clothAlpha: { constant: 'CLOTHING_BELIEF_ALPHA' },
};

const NUM = '-?\\d+(?:\\.\\d+)?';

function locate(source: string, key: TunableKey): { start: number; end: number; value: number } {
  const target = KNOB_TARGETS[key];
  if (!target) throw new Error(`unknown knob ${key}`);
  const re = target.field
    ? new RegExp(`(export const ${target.constant} = \\{[^}\\n]*?\\b${target.field}: )(${NUM})`, 'g')
    : new RegExp(`(export const ${target.constant} = )(${NUM})(;)`, 'g');
  const found = [...source.matchAll(re)];
  if (found.length !== 1) throw new Error(`${target.constant}${target.field ? '.' + target.field : ''}: expected one match in calibration.ts, found ${found.length}`);
  const m = found[0];
  const start = m.index! + m[1].length;
  return { start, end: start + m[2].length, value: Number(m[2]) };
}

/** The knob values as calibration.ts states them. */
export function readCalibration(source: string, keys: readonly TunableKey[] = Object.keys(KNOB_TARGETS) as TunableKey[]): Partial<Params> {
  return Object.fromEntries(keys.map((k) => [k, locate(source, k).value]));
}

export function readVersion(source: string): string {
  const m = source.match(/export const CALIBRATION_VERSION = '([^']+)';/);
  if (!m) throw new Error('CALIBRATION_VERSION not found');
  return m[1];
}

/** The next version after `current` on `day` (YYYY-MM-DD): the same day counts up, a new day starts at .1. */
export function nextVersion(current: string, day: string): string {
  const m = current.match(/^(\d{4}-\d{2}-\d{2})\.(\d+)$/);
  return m && m[1] === day ? `${day}.${Number(m[2]) + 1}` : `${day}.1`;
}

/** Format a value the way the file writes numbers: no trailing zeros, at most three decimals. */
const fmt = (v: number) => String(Math.round(v * 1000) / 1000);

/**
 * calibration.ts with `changes` written in and CALIBRATION_VERSION bumped. Throws on an unknown knob,
 * a target that does not match exactly once, or a non-finite value.
 */
export function applyCalibration(source: string, changes: Partial<Params>, day: string): { source: string; version: string } {
  const edits: { start: number; end: number; text: string }[] = [];
  for (const [key, value] of Object.entries(changes) as [TunableKey, number][]) {
    if (!(key in KNOB_TARGETS)) throw new Error(`unknown knob ${key}`);
    if (!Number.isFinite(value)) throw new Error(`${key}: not a number`);
    const at = locate(source, key);
    edits.push({ start: at.start, end: at.end, text: fmt(value) });
  }
  const version = nextVersion(readVersion(source), day);
  let out = source;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  out = out.replace(/export const CALIBRATION_VERSION = '[^']+';/, `export const CALIBRATION_VERSION = '${version}';`);
  return { source: out, version };
}

/**
 * README states the two face bars in prose; keep those numbers in sync (CLAUDE.md: README is the
 * authoritative description of the thresholds). Returns the text and how many spots changed.
 */
export function syncReadme(readme: string, p: Partial<Params>): { text: string; updated: number } {
  let updated = 0;
  let text = readme;
  const two = (v: number) => v.toFixed(2);
  if (p.faceReject !== undefined && p.faceAccept !== undefined) {
    text = text.replace(/`FACE_CALIB` \(`reject` \d\.\d+, `accept` \d\.\d+\)/g, () => {
      updated++;
      return `\`FACE_CALIB\` (\`reject\` ${two(p.faceReject!)}, \`accept\` ${two(p.faceAccept!)})`;
    });
  }
  if (p.faceOnlyReject !== undefined && p.faceOnlyAccept !== undefined) {
    text = text.replace(/`FACE_ONLY_CALIB`, \d\.\d+\/\d\.\d+\)/g, () => {
      updated++;
      return `\`FACE_ONLY_CALIB\`, ${two(p.faceOnlyReject!)}/${two(p.faceOnlyAccept!)})`;
    });
  }
  return { text, updated };
}
