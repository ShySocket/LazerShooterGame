import type { FrameSummary, ShotLabel, ShotSample } from './sample';
import { clusterWrongBound, formatBound, percentile, wrongHitBounds } from './stats';
import { triage } from './triage';

/**
 * The session report: what a play or practice session's labelled shots say, broken down by
 * condition, target, shooter phone and build, with exact upper bounds on the wrong-hit rate so a
 * clean session is read for what it proves (no wrong hit at 30 targets: at most about 10% of targets
 * draw one) rather than as "never". Pure functions over feedback samples; scripts/session-report.ts
 * prints them.
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

/**
 * Where a label came from. `practice`: ?practice, targets quick-enrolled with the rear camera (a
 * face-only one is held to FACE_ONLY_CALIB). `range`: range mode in a real room, players who did the
 * normal scan (the phone-session matrix). `review`: the review card after a round, failed shots only.
 */
export type ShotSource = 'practice' | 'range' | 'review';
/** Labels taken at the tap by a build that did not record whether it was ?practice or a real room's range mode. */
export const UNSPLIT = 'practice/range (unsplit)';
export type SectionSource = ShotSource | typeof UNSPLIT;

/**
 * A label's source. Review-card labels come after the round (reviewMs > 0); labels taken with the aim
 * selector at the tap (reviewMs 0) say `source` from the build that writes it, and older ones, which
 * cannot tell the two populations apart, are UNSPLIT.
 */
export function sourceOf(s: ShotSample): SectionSource {
  if (s.label?.reviewMs !== 0) return 'review';
  const source = (s.label as { source?: unknown }).source;
  return source === 'practice' || source === 'range' ? source : UNSPLIT;
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

/** The body the shot was about: nominated at the tap, else the target summary's, else the one under the dot at the decision. */
export function shotTrackId(s: ShotSample): number | null {
  return s.shot.trackId ?? s.target?.trackId ?? s.shot.decisionTrackId ?? null;
}

/** How the labelled target came to be locked in a shot's recorded frames (see lockAcquisition). */
export type LockAcquisition =
  /** The shot's body came under the dot in the recorded frames and locked on the target `ms` later. */
  | { kind: 'locked'; ms: number }
  /** Under the dot in the recorded frames and never locked on the target there: a failure. */
  | { kind: 'never' }
  /**
   * Already under the dot in the first recorded frame, not locked there, and locked `ms` later: it came
   * under the dot before the recording began, so `ms` is a lower bound. It is kept: dropping it would
   * drop exactly the slow locks, and a bound over the target already fails it.
   */
  | { kind: 'atLeast'; ms: number }
  /** Already locked in the first recorded frame: it locked before the recording began, the time is unknown. */
  | { kind: 'untimed' };

/**
 * How long the tracker took to lock the labelled target once their body was under the dot: from the
 * first recorded frame in which the shot's body (shotTrackId) is in sight to the first frame after
 * it in which that body, still in sight, is locked on the target (`lock:<pid>`, the state in which a
 * tap would land). Measured from the body coming under the dot, not from the start of the recorded
 * window (12 frames before the tap, whatever the frame period), so it says how fast the tracker locks
 * and not how long the shooter held aim. Null when the label names nobody or the shot's body was
 * never under the dot in the recorded frames.
 */
export function lockAcquisition(s: ShotSample): LockAcquisition | null {
  if (s.label?.kind !== 'player' || s.frames.length === 0) return null;
  const id = shotTrackId(s);
  if (id === null) return null;
  const want = `lock:${s.label.target}`;
  const frames = [...s.frames].sort((a, b) => a.t - b.t);
  const inSight = (f: FrameSummary) => f.tracks.some((t) => t.id === id && t.inSight);
  const start = frames.findIndex(inSight);
  if (start < 0) return null;
  const locked = frames.findIndex((f, i) => i >= start && inSight(f) && f.lock === want);
  if (locked < 0) return { kind: 'never' };
  if (start > 0) return { kind: 'locked', ms: frames[locked].t - frames[start].t };
  return locked === 0 ? { kind: 'untimed' } : { kind: 'atLeast', ms: frames[locked].t - frames[0].t };
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
  /**
   * One-sided 95% Clopper-Pearson upper bounds on (wrongPlayer + unknownFalse) per attempt and per
   * accepted hit. They treat every shot as an independent trial; shots at one target in one round
   * share their cause, so read them next to wrongPerTargetUpper. Null where nothing can be bounded.
   */
  wrongPerAttemptUpper: number | null;
  wrongPerHitUpper: number | null;
  /** Round x target groups (the shots at one labelled target, or at non-players, in one round), and how many had a wrong hit. */
  targets: number;
  wrongTargets: number;
  /** The same bound over those groups (clusterWrongBound): the share of targets that draw a wrong hit. */
  wrongPerTargetUpper: number | null;
  /** resolveMs of accepted hits. */
  resolveMs: Latency;
  /** lockAcquisition of player-labelled shots whose body came under the dot in the recorded frames and then locked. */
  lockMs: Latency;
  /** Player-labelled shots whose body was under the dot in the recorded frames and never locked on the target: failures. */
  lockNever: number;
  /** Player-labelled shots whose body was already under the dot in the first recorded frame and locked: time unknown, left out of lockMs. */
  lockUntimed: number;
  /** Of the lock times, how many are lower bounds (under the dot when the recording began, locked later). */
  lockAtLeast: number;
}

/** The round x target group a shot belongs to: shots in one share the person, the outfit and the light. */
const targetGroup = (s: LabelledSample) => `${s.round.key} ${s.label.kind === 'player' ? s.label.target : NOT_A_PLAYER}`;

export function summariseRow(key: string, samples: LabelledSample[]): ReportRow {
  const n = { correct: 0, wrongPlayer: 0, unknownFalse: 0, rightRefusal: 0, rejected: 0 };
  const resolve: number[] = [];
  const lock: number[] = [];
  const lockOther = { never: 0, untimed: 0, atLeast: 0 };
  const wrongByTarget = new Map<string, number>();
  let players = 0;
  for (const s of samples) {
    const o = outcomeOf(s);
    n[o]++;
    if (s.label.kind === 'player') players++;
    const wrong = o === 'wrongPlayer' || o === 'unknownFalse';
    wrongByTarget.set(targetGroup(s), (wrongByTarget.get(targetGroup(s)) ?? 0) + (wrong ? 1 : 0));
    if ((o === 'correct' || wrong) && s.shot.resolveMs !== null && Number.isFinite(s.shot.resolveMs)) resolve.push(s.shot.resolveMs);
    const l = lockAcquisition(s);
    if (l?.kind === 'locked') lock.push(l.ms);
    else if (l?.kind === 'atLeast') {
      // A lower bound among the times: it can only pull the percentiles down, so a p95 over the target fails for certain.
      lock.push(l.ms);
      lockOther.atLeast++;
    } else if (l) lockOther[l.kind]++;
  }
  const accepted = n.correct + n.wrongPlayer + n.unknownFalse;
  const bounds = wrongHitBounds(n.wrongPlayer + n.unknownFalse, samples.length, accepted);
  const byTargetBound = clusterWrongBound(wrongByTarget.values());
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
    targets: byTargetBound.clusters,
    wrongTargets: byTargetBound.failed,
    wrongPerTargetUpper: byTargetBound.upper,
    resolveMs: latency(resolve),
    lockMs: latency(lock),
    lockNever: lockOther.never,
    lockUntimed: lockOther.untimed,
    lockAtLeast: lockOther.atLeast,
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
 * A point in time as the feedback scripts take it (`--since`, `--eval`): a date (`2026-09-30`, local
 * midnight), a date-time (`2026-09-30T18:00`), epoch milliseconds, or a full round key
 * (`ABCD-1759312345678`, its start). Null when `arg` is none of these; throws on a date that has
 * the shape but does not exist, so a typo is never read as some other day.
 */
export function parseCutoff(arg: string, flag = '--since'): { t: number; describe: string } | null {
  const a = arg.trim();
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a);
  if (date) {
    const d = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
    if (d.getMonth() !== Number(date[2]) - 1 || d.getDate() !== Number(date[3])) throw new Error(`${flag}: no such date ${a}`);
    return { t: d.getTime(), describe: `${a} (local midnight)` };
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(a)) {
    const t = Date.parse(a);
    if (!Number.isFinite(t)) throw new Error(`${flag}: cannot read the date ${a}`);
    return { t, describe: a };
  }
  if (/^\d{9,16}$/.test(a)) return { t: Number(a), describe: new Date(Number(a)).toISOString() };
  const key = /^[A-Z]{4}-(\d{9,16})$/.exec(a);
  if (key) return { t: Number(key[1]), describe: `round ${a}` };
  return null;
}

/**
 * `--eval` argument: a cutoff (parseCutoff) holds out every round that started at or after it; a
 * prefix of a round key (`ABCD`, a room code, or `ABCD-17593`) holds out the rounds whose key starts
 * with it. Anything else could match no round, so it throws rather than hold out nothing.
 */
export function parseEvalSplit(arg: string): EvalSplit {
  const a = arg.trim();
  if (!a) throw new Error('--eval needs a date, a round key or a round key prefix');
  const cut = parseCutoff(a, '--eval');
  if (cut) return { describe: `rounds started at or after ${cut.describe}`, isEval: (s) => s.round.startAt >= cut.t };
  if (!/^([A-Z]{1,4}|[A-Z]{4}-\d*)$/.test(a)) throw new Error(`--eval: cannot read ${a}: give a date (2026-09-30), a date-time, a round key (ABCD-1759312345678) or a round key prefix (ABCD)`);
  return { describe: `rounds whose key starts with ${a}`, isEval: (s) => s.round.key.startsWith(a) };
}

export interface ReportTable {
  title: string;
  rows: ReportRow[];
}

export interface ReportSection {
  /** The source (`practice`, `range`, `practice/range (unsplit)` or `review`), prefixed with `dev` / `eval` when a split is given. */
  name: string;
  source: SectionSource;
  /** What the section's numbers can and cannot say. */
  note: string | null;
  /** Why the section has no wrong-hit bound (its rows' bounds are null), or null when it has one. */
  boundsNa: string | null;
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
export const REVIEW_NOTE = 'review cards ask only about shots that did not land: no hits can appear here, so legit success is not a hit rate and no wrong-hit rate can be bounded; the rows say which refusals were real players';
/** Why a review section prints no wrong-hit bound: zero wrong hits there is true by construction, not evidence. */
export const REVIEW_BOUNDS_NA = 'review cards hold only shots that did not land, so a wrong hit cannot appear in them';

const NOTES: Record<SectionSource, string | null> = {
  practice: '?practice: targets quick-enrolled with the rear camera (a face-only one must clear FACE_ONLY_CALIB), not players who did the normal scan',
  range: 'range mode in a real room: players who did the normal scan; the phone-session matrix is read here',
  [UNSPLIT]: 'labelled at the tap by a build that did not record whether it was ?practice or range mode in a real room: both pooled, so read neither population from it',
  review: REVIEW_NOTE,
};

const withoutBounds = (r: ReportRow): ReportRow => ({ ...r, wrongPerAttemptUpper: null, wrongPerHitUpper: null, wrongPerTargetUpper: null });

function section(name: string, source: SectionSource, samples: LabelledSample[]): ReportSection {
  const boundsNa = source === 'review' ? REVIEW_BOUNDS_NA : null;
  const rows = (list: ReportRow[]) => (boundsNa ? list.map(withoutBounds) : list);
  const total = summariseRow('all', samples);
  return {
    name,
    source,
    note: NOTES[source],
    boundsNa,
    total: boundsNa ? withoutBounds(total) : total,
    rounds: new Set(samples.map((s) => s.round.key)).size,
    tables: [
      ...CONDITION_FIELDS.map((f) => ({ title: `by ${f}`, rows: rows(groupRows(samples, byCondition(f))) })),
      { title: 'by target player', rows: rows(groupRows(samples, byTarget)) },
      { title: 'by shooter phone', rows: rows(groupRows(samples, byPhone)) },
      { title: 'by build', rows: rows(groupRows(samples, byBuild)) },
    ],
  };
}

const SOURCES: SectionSource[] = ['practice', 'range', UNSPLIT, 'review'];

/**
 * The whole report, one section per source present in the log. Sources are never pooled: ?practice
 * targets are quick-enrolled, range targets did the normal scan, and review labels are a memory of a
 * failed shot. With a split, the held-out rounds are reported apart from the development rounds the
 * calibration was tuned on.
 */
export function buildSessionReport(samples: ShotSample[], split: EvalSplit | null = null): SessionReport {
  const labelled = samples.filter((s): s is LabelledSample => Boolean(s.label));
  const sets: [string, LabelledSample[]][] = split
    ? [
        ['dev', labelled.filter((s) => !split.isEval(s))],
        ['eval', labelled.filter((s) => split.isEval(s))],
      ]
    : [['', labelled]];
  const present = SOURCES.filter((source) => labelled.some((s) => sourceOf(s) === source));
  const sections: ReportSection[] = [];
  for (const [set, list] of sets) {
    for (const source of present) sections.push(section(set ? `${set} ${source}` : source, source, list.filter((s) => sourceOf(s) === source)));
  }
  return { samples: samples.length, labelled: labelled.length, split: split?.describe ?? null, sections };
}

const pct = (x: number | null) => (x === null ? '-' : `${Math.round(100 * x)}%`);
const ms = (l: Latency) => (l.n === 0 ? '-' : `${Math.round(l.p50!)}/${Math.round(l.p95!)}`);

const COLUMNS: { head: string; bound?: true; cell: (r: ReportRow) => string }[] = [
  { head: 'shots', cell: (r) => String(r.attempts) },
  { head: 'player', cell: (r) => String(r.playerAttempts) },
  { head: 'hit', cell: (r) => String(r.correct) },
  { head: 'wrongP', cell: (r) => String(r.wrongPlayer) },
  { head: 'wrongU', cell: (r) => String(r.unknownFalse) },
  { head: 'rejected', cell: (r) => String(r.rejected) },
  { head: 'refused', cell: (r) => String(r.rightRefusals) },
  { head: 'legit', cell: (r) => pct(r.legitSuccess) },
  { head: 'wrong/shot', bound: true, cell: (r) => formatBound(r.wrongPerAttemptUpper) },
  { head: 'wrong/hit', bound: true, cell: (r) => formatBound(r.wrongPerHitUpper) },
  { head: 'resolve p50/95', cell: (r) => ms(r.resolveMs) },
  { head: 'lock p50/95', cell: (r) => `${ms(r.lockMs)}${r.lockMs.n ? ` (${r.lockMs.n})` : ''}` },
  { head: 'unlocked', cell: (r) => String(r.lockNever) },
  { head: 'untimed', cell: (r) => String(r.lockUntimed) },
];

/** One table as aligned text; a condition nobody labelled collapses to one line. `boundsNa` prints n/a in the bound columns. */
export function formatTable(t: ReportTable, boundsNa = false): string[] {
  if (t.rows.length === 1 && t.rows[0].key === UNLABELLED) return [`${t.title}: no labels (${t.rows[0].attempts} shots unlabelled)`];
  const keyW = Math.max(t.title.length, ...t.rows.map((r) => r.key.length));
  const cells = t.rows.map((r) => COLUMNS.map((c) => (boundsNa && c.bound ? 'n/a' : c.cell(r))));
  const widths = COLUMNS.map((c, i) => Math.max(c.head.length, ...cells.map((row) => row[i].length)));
  const line = (key: string, values: string[]) => `${key.padEnd(keyW)}  ${values.map((v, i) => v.padStart(widths[i])).join('  ')}`;
  return [line(t.title, COLUMNS.map((c) => c.head)), ...t.rows.map((r, i) => line(r.key, cells[i]))];
}

export function formatSection(s: ReportSection): string[] {
  const t = s.total;
  if (t.attempts === 0) return [`== ${s.name}: no labelled shots`];
  const bounds = s.boundsNa
    ? `wrong-hit rate n/a: ${s.boundsNa}`
    : `wrong-hit rate (one-sided 95% Clopper-Pearson upper bounds) ${formatBound(t.wrongPerTargetUpper)} per target (${t.wrongTargets} of ${t.targets} round x target groups had one), and ${formatBound(t.wrongPerAttemptUpper)} per shot, ${formatBound(t.wrongPerHitUpper)} per accepted hit if every shot were independent`;
  const out = [
    `== ${s.name}: ${t.attempts} labelled shots from ${s.rounds} round${s.rounds === 1 ? '' : 's'}`,
    `   legit-shot success ${pct(t.legitSuccess)} (${t.correct}/${t.playerAttempts}, rejections counted); wrong hits ${t.wrongPlayer} on another player + ${t.unknownFalse} on a non-player; ${bounds}`,
    `   lock acquisition p50/p95 ${ms(t.lockMs)} ms over ${t.lockMs.n} shot${t.lockMs.n === 1 ? '' : 's'} that locked after their target came under the dot (${t.lockAtLeast} of them lower bounds: under the dot when the recording began, so the percentiles are lower bounds when they count); ${t.lockNever} never locked (failures); ${t.lockUntimed} already locked when the recording began (time unknown)`,
  ];
  if (s.note) out.push(`   (${s.note})`);
  for (const table of s.tables) out.push('', ...formatTable(table, s.boundsNa !== null));
  return out;
}

export const REPORT_LEGEND = [
  'Sections: practice = ?practice, quick-enrolled targets; range = range mode in a real room, players who did the normal scan; practice/range (unsplit) = older labels that do not say which; review = review-card answers, failed shots only.',
  'shots: labelled attempts. player: labelled with a player. hit: right hits. wrongP: hit on another player. wrongU: hit on someone labelled not a player.',
  'rejected: player shots that did not land. refused: non-player shots refused. legit = hit / player (rejections in the denominator).',
  'wrong/shot, wrong/hit: one-sided 95% Clopper-Pearson upper bound on (wrongP + wrongU) per shot and per accepted hit, as if every shot were independent; shots at one target in one round are not, so the section line also bounds it per round x target group. n/a where no wrong hit could appear.',
  'resolve: ms from tap to verdict of accepted hits. lock: ms from the first recorded frame with the shot\'s body under the dot to the first frame locked on the labelled target, (n) shots measured.',
  'unlocked: the target was under the dot in the recorded frames and never locked (failures). untimed: already under the dot in the first recorded frame (12 before the tap) and locked there or later, so when it came under the dot, and the time, are unknown; left out of lock.',
];
