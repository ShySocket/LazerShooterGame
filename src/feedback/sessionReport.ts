import type { ShotLabel, ShotSample } from './sample';
import { formatBound, percentile, wrongHitBounds } from './stats';
import { triage } from './triage';

/**
 * The session report: what a play or practice session's labelled shots say, broken down by
 * condition, target, shooter phone and build, with exact upper bounds on the wrong-hit rate so a
 * clean session is read for what it proves ("0 wrong in 216 shots: the rate is below 1.4%") rather
 * than as "never". Pure functions over feedback samples; scripts/session-report.ts prints them.
 */
export type LabelledSample = ShotSample & { label: ShotLabel };

/** Condition fields a label may carry (set at shot time by a practice build that asks for them). */
export const CONDITION_FIELDS = ['distance', 'view', 'lighting', 'scenario'] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];
export const UNLABELLED = 'unlabelled';

/** A label's value for one condition, or `unlabelled` when the label does not carry it. */
export function conditionOf(s: ShotSample, field: ConditionField): string {
  const v = (s.label as Record<string, unknown> | undefined)?.[field];
  if (typeof v === 'number' && Number.isFinite(v)) return field === 'distance' ? `${v} m` : String(v);
  if (typeof v === 'string' && v.trim()) return v.trim();
  return UNLABELLED;
}

/** Practice shots are labelled with the aim selector at the tap (reviewMs 0); review-card labels come after the round. */
export function isPractice(s: ShotSample): boolean {
  return s.label?.reviewMs === 0;
}

export type Outcome = 'correct' | 'wrongPlayer' | 'unknownFalse' | 'rightRefusal' | 'rejected';

/** The triage verdict (src/feedback/triage.ts) folded into the report's five outcomes. */
export function outcomeOf(s: LabelledSample): Outcome {
  const v = triage(s);
  if (v === 'right hit') return 'correct';
  if (v === 'WRONG hit') return 'wrongPlayer';
  if (v === 'WRONG hit on a non-player') return 'unknownFalse';
  if (v === 'right refusal') return 'rightRefusal';
  return 'rejected';
}

/**
 * Time from the earliest recorded frame to the first frame whose lock names the labelled target as
 * a hit (`lock:<pid>`, the state in which a tap would land). The recorded window starts 12 frames
 * before the tap, so 0 means the target was already locked when the window began. Null when the
 * label names nobody or no recorded frame locked the target.
 */
export function lockAcquisitionMs(s: ShotSample): number | null {
  if (s.label?.kind !== 'player' || s.frames.length === 0) return null;
  const want = `lock:${s.label.target}`;
  const frames = [...s.frames].sort((a, b) => a.t - b.t);
  const first = frames.find((f) => f.lock === want);
  return first ? first.t - frames[0].t : null;
}

/** A user agent cut down to the phone and browser: `iPhone iOS 18.5 Safari 18.5`, `Android 14 Pixel 8 Chrome 140`. */
export function shortDevice(ua: string | null | undefined): string {
  if (!ua) return 'unknown device';
  const ios = /OS (\d+)[_.](\d+)/.exec(ua);
  const iosVer = ios ? ` iOS ${ios[1]}.${ios[2]}` : '';
  let device: string;
  if (/iPhone/.test(ua)) device = `iPhone${iosVer}`;
  else if (/iPad/.test(ua)) device = `iPad${iosVer}`;
  else if (/Android/.test(ua)) {
    const m = /Android ([\d.]+)(?:; ([^;)]+))?/.exec(ua);
    // Chrome's reduced user agent hides the model as "K"; older ones end it with " Build/...".
    const model = m?.[2]?.replace(/\s*Build\/.*$/, '').trim();
    device = `Android${m ? ` ${m[1]}` : ''}${model && model !== 'K' && model !== 'wv' ? ` ${model}` : ''}`;
  } else if (/Macintosh|Mac OS X/.test(ua)) device = 'Mac';
  else if (/Windows/.test(ua)) device = 'Windows';
  else if (/Linux|X11/.test(ua)) device = 'Linux';
  else device = ua.slice(0, 24);
  const browsers: [RegExp, string][] = [
    [/EdgA?\/(\d+)/, 'Edge'],
    [/SamsungBrowser\/(\d+)/, 'Samsung'],
    [/CriOS\/(\d+)/, 'Chrome'],
    [/FxiOS\/(\d+)/, 'Firefox'],
    [/Firefox\/(\d+)/, 'Firefox'],
    [/HeadlessChrome\/(\d+)/, 'HeadlessChrome'],
    [/Chrome\/(\d+)/, 'Chrome'],
    [/Version\/([\d.]+).*Safari/, 'Safari'],
  ];
  for (const [re, name] of browsers) {
    const m = re.exec(ua);
    if (m) return `${device} ${name} ${m[1]}`;
  }
  return device;
}

export interface Latency {
  n: number;
  p50: number | null;
  p95: number | null;
}

function latency(values: number[]): Latency {
  return { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95) };
}

export interface ReportRow {
  key: string;
  /** Labelled shots in the group. */
  attempts: number;
  /** Shots labelled with a player, and labelled "not a player". */
  playerAttempts: number;
  noneAttempts: number;
  correct: number;
  /** Hit on a different player than the label names. */
  wrongPlayer: number;
  /** Hit on a body labelled "not a player". */
  unknownFalse: number;
  /** Non-player shots the game refused. */
  rightRefusals: number;
  /** Player-labelled shots that did not land (refusals and misses of every cause). */
  rejected: number;
  /** Shots the game turned into a hit: correct + wrongPlayer + unknownFalse. */
  accepted: number;
  /** correct / playerAttempts, rejections included in the denominator; null without player shots. */
  legitSuccess: number | null;
  /** One-sided 95% Clopper-Pearson upper bounds on (wrongPlayer + unknownFalse) per attempt and per accepted hit. */
  wrongPerAttemptUpper: number | null;
  wrongPerHitUpper: number | null;
  /** resolveMs of accepted hits. */
  resolveMs: Latency;
  /** lockAcquisitionMs of player-labelled shots that locked their target in the recorded window. */
  lockMs: Latency;
}

export function summariseRow(key: string, samples: LabelledSample[]): ReportRow {
  const n = { correct: 0, wrongPlayer: 0, unknownFalse: 0, rightRefusal: 0, rejected: 0 };
  const resolve: number[] = [];
  const lock: number[] = [];
  let players = 0;
  for (const s of samples) {
    const o = outcomeOf(s);
    n[o]++;
    if (s.label.kind === 'player') players++;
    if ((o === 'correct' || o === 'wrongPlayer' || o === 'unknownFalse') && s.shot.resolveMs !== null && Number.isFinite(s.shot.resolveMs)) resolve.push(s.shot.resolveMs);
    const l = lockAcquisitionMs(s);
    if (l !== null) lock.push(l);
  }
  const accepted = n.correct + n.wrongPlayer + n.unknownFalse;
  const bounds = wrongHitBounds(n.wrongPlayer + n.unknownFalse, samples.length, accepted);
  return {
    key,
    attempts: samples.length,
    playerAttempts: players,
    noneAttempts: samples.length - players,
    correct: n.correct,
    wrongPlayer: n.wrongPlayer,
    unknownFalse: n.unknownFalse,
    rightRefusals: n.rightRefusal,
    rejected: n.rejected,
    accepted,
    legitSuccess: players ? n.correct / players : null,
    wrongPerAttemptUpper: bounds.perAttempt,
    wrongPerHitUpper: bounds.perHit,
    resolveMs: latency(resolve),
    lockMs: latency(lock),
  };
}

export type GroupBy = (s: LabelledSample) => string;

export const NOT_A_PLAYER = 'not a player';
/** Player ids are positional within a round (p0, p1, ...), so a target is named by round and pid. */
export const byTarget: GroupBy = (s) => (s.label.kind === 'player' ? `${s.round.key} ${s.label.target}` : NOT_A_PLAYER);
export const byPhone: GroupBy = (s) => shortDevice(s.app.ua);
export const byBuild: GroupBy = (s) => `${s.app.commit} ${s.app.faceModel}`;
export const byCondition = (field: ConditionField): GroupBy => (s) => conditionOf(s, field);

/** Keys sorted after every other row. */
const LAST = new Set([NOT_A_PLAYER, UNLABELLED]);

/** Rows sorted by key with numbers in order (2 m before 10 m), `not a player` and `unlabelled` last. */
export function groupRows(samples: LabelledSample[], by: GroupBy): ReportRow[] {
  const groups = new Map<string, LabelledSample[]>();
  for (const s of samples) {
    const k = by(s);
    const list = groups.get(k);
    if (list) list.push(s);
    else groups.set(k, [s]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => Number(LAST.has(a)) - Number(LAST.has(b)) || a.localeCompare(b, 'en', { numeric: true }))
    .map(([k, list]) => summariseRow(k, list));
}

/** Which rounds are held out for evaluation; everything else is the development set. */
export interface EvalSplit {
  describe: string;
  isEval: (s: ShotSample) => boolean;
}

/**
 * `--eval` argument: a date (`2026-09-30`, local midnight; or a date-time), epoch milliseconds, or a
 * full round key (`ABCD-1759312345678`) holds out every round that started at or after it; any other
 * string holds out the rounds whose key starts with it (a room code, say).
 */
export function parseEvalSplit(arg: string): EvalSplit {
  const a = arg.trim();
  const from = (t: number, what: string): EvalSplit => ({ describe: `rounds started at or after ${what}`, isEval: (s) => s.round.startAt >= t });
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a);
  if (date) {
    const d = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
    if (d.getMonth() !== Number(date[2]) - 1 || d.getDate() !== Number(date[3])) throw new Error(`--eval: no such date ${a}`);
    return from(d.getTime(), `${a} (local midnight)`);
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(a)) {
    const t = Date.parse(a);
    if (!Number.isFinite(t)) throw new Error(`--eval: cannot read the date ${a}`);
    return from(t, a);
  }
  if (/^\d{9,16}$/.test(a)) return from(Number(a), new Date(Number(a)).toISOString());
  const key = /^[A-Z]{4}-(\d{9,16})$/.exec(a);
  if (key) return from(Number(key[1]), `round ${a}`);
  if (!a) throw new Error('--eval needs a date, a round key or a round key prefix');
  return { describe: `rounds whose key starts with ${a}`, isEval: (s) => s.round.key.startsWith(a) };
}

export interface ReportTable {
  title: string;
  rows: ReportRow[];
}

export interface ReportSection {
  /** `practice` or `review`, prefixed with `dev` / `eval` when a split is given. */
  name: string;
  /** What the section's numbers can and cannot say. */
  note: string | null;
  total: ReportRow;
  rounds: number;
  tables: ReportTable[];
}

export interface SessionReport {
  samples: number;
  labelled: number;
  split: string | null;
  sections: ReportSection[];
}

/** The review card only asks about shots that did not land (sample.ts REVIEWABLE_OUTCOMES). */
export const REVIEW_NOTE = 'review cards ask only about shots that did not land: no hits can appear here, so legit success is not a hit rate; the rows say which refusals were real players';

function section(name: string, note: string | null, samples: LabelledSample[]): ReportSection {
  return {
    name,
    note,
    total: summariseRow('all', samples),
    rounds: new Set(samples.map((s) => s.round.key)).size,
    tables: [
      ...CONDITION_FIELDS.map((f) => ({ title: `by ${f}`, rows: groupRows(samples, byCondition(f)) })),
      { title: 'by target player', rows: groupRows(samples, byTarget) },
      { title: 'by shooter phone', rows: groupRows(samples, byPhone) },
      { title: 'by build', rows: groupRows(samples, byBuild) },
    ],
  };
}

/**
 * The whole report. Practice and review-card shots are never pooled: practice labels are the aim
 * the shooter chose before the tap, review labels are a memory of a failed shot. With a split, the
 * held-out rounds are reported apart from the development rounds the calibration was tuned on.
 */
export function buildSessionReport(samples: ShotSample[], split: EvalSplit | null = null): SessionReport {
  const labelled = samples.filter((s): s is LabelledSample => Boolean(s.label));
  const sets: [string, LabelledSample[]][] = split
    ? [
        ['dev', labelled.filter((s) => !split.isEval(s))],
        ['eval', labelled.filter((s) => split.isEval(s))],
      ]
    : [['', labelled]];
  const sections: ReportSection[] = [];
  for (const [set, list] of sets) {
    for (const [source, pick] of [
      ['practice', true],
      ['review', false],
    ] as const) {
      sections.push(section(set ? `${set} ${source}` : source, pick ? null : REVIEW_NOTE, list.filter((s) => isPractice(s) === pick)));
    }
  }
  return { samples: samples.length, labelled: labelled.length, split: split?.describe ?? null, sections };
}

const pct = (x: number | null) => (x === null ? '-' : `${Math.round(100 * x)}%`);
const ms = (l: Latency) => (l.n === 0 ? '-' : `${Math.round(l.p50!)}/${Math.round(l.p95!)}`);

const COLUMNS: { head: string; cell: (r: ReportRow) => string }[] = [
  { head: 'shots', cell: (r) => String(r.attempts) },
  { head: 'player', cell: (r) => String(r.playerAttempts) },
  { head: 'hit', cell: (r) => String(r.correct) },
  { head: 'wrongP', cell: (r) => String(r.wrongPlayer) },
  { head: 'wrongU', cell: (r) => String(r.unknownFalse) },
  { head: 'rejected', cell: (r) => String(r.rejected) },
  { head: 'refused', cell: (r) => String(r.rightRefusals) },
  { head: 'legit', cell: (r) => pct(r.legitSuccess) },
  { head: 'wrong/shot', cell: (r) => formatBound(r.wrongPerAttemptUpper) },
  { head: 'wrong/hit', cell: (r) => formatBound(r.wrongPerHitUpper) },
  { head: 'resolve p50/95', cell: (r) => ms(r.resolveMs) },
  { head: 'lock p50/95', cell: (r) => `${ms(r.lockMs)}${r.lockMs.n ? ` (${r.lockMs.n})` : ''}` },
];

/** One table as aligned text; a condition nobody labelled collapses to one line. */
export function formatTable(t: ReportTable): string[] {
  if (t.rows.length === 1 && t.rows[0].key === UNLABELLED) return [`${t.title}: no labels (${t.rows[0].attempts} shots unlabelled)`];
  const keyW = Math.max(t.title.length, ...t.rows.map((r) => r.key.length));
  const cells = t.rows.map((r) => COLUMNS.map((c) => c.cell(r)));
  const widths = COLUMNS.map((c, i) => Math.max(c.head.length, ...cells.map((row) => row[i].length)));
  const line = (key: string, values: string[]) => `${key.padEnd(keyW)}  ${values.map((v, i) => v.padStart(widths[i])).join('  ')}`;
  return [line(t.title, COLUMNS.map((c) => c.head)), ...t.rows.map((r, i) => line(r.key, cells[i]))];
}

export function formatSection(s: ReportSection): string[] {
  const t = s.total;
  if (t.attempts === 0) return [`== ${s.name}: no labelled shots`];
  const out = [
    `== ${s.name}: ${t.attempts} labelled shots from ${s.rounds} round${s.rounds === 1 ? '' : 's'}`,
    `   legit-shot success ${pct(t.legitSuccess)} (${t.correct}/${t.playerAttempts}, rejections counted); wrong hits ${t.wrongPlayer} on another player + ${t.unknownFalse} on a non-player; wrong-hit rate ${formatBound(t.wrongPerAttemptUpper)} per shot and ${formatBound(t.wrongPerHitUpper)} per accepted hit (one-sided 95% upper bounds, Clopper-Pearson)`,
  ];
  if (s.note) out.push(`   (${s.note})`);
  for (const table of s.tables) out.push('', ...formatTable(table));
  return out;
}

export const REPORT_LEGEND = [
  'shots: labelled attempts. player: labelled with a player. hit: right hits. wrongP: hit on another player. wrongU: hit on someone labelled not a player.',
  'rejected: player shots that did not land. refused: non-player shots refused. legit = hit / player (rejections in the denominator).',
  'wrong/shot, wrong/hit: one-sided 95% Clopper-Pearson upper bound on (wrongP + wrongU) per shot and per accepted hit.',
  'resolve: ms from tap to verdict of accepted hits. lock: ms from the earliest recorded frame (12 before the tap) to the first frame locked on the target, (n) shots that locked it.',
];
