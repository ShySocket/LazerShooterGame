import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionReport, conditionOf, formatSection, formatTable, lockAcquisition, parseCutoff, parseEvalSplit, REPORT_LEGEND, shortDevice, sourceOf, summariseRow, UNLABELLED, UNSPLIT, type LabelledSample, type ReportRow, type ReportSection } from '../src/feedback/sessionReport';
import { clopperPearsonUpper } from '../src/feedback/stats';
import type { FrameSummary, ShotSample, TrackSummary } from '../src/feedback/sample';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const PIXEL = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.80 Mobile Safari/537.36';

// Two practice rounds on different phones and builds, two days apart, and a played round's review cards.
const START_A = new Date(2026, 8, 28, 20, 0).getTime();
const START_B = new Date(2026, 8, 30, 20, 0).getTime();
const KEY_A = `ABCD-${START_A}`;
const KEY_B = `EFGH-${START_B}`;

interface Spec {
  key: string;
  ua: string;
  commit: string;
  label?: { target?: string; distance?: number; view?: string; reviewMs?: number; source?: string };
  outcome: string;
  resolvedTo?: string;
  resolveMs?: number;
  trackId?: number | null;
  /** Frames: time, the lock, and the id of the body under the dot (default: the shot's body whenever there is a lock). */
  locks?: [number, string | null, (number | null)?][];
}

const body = (id: number, inSight: boolean): TrackSummary => ({ id, box: [0.4, 0.2, 0.2, 0.6], hit: [0.42, 0.3, 0.16, 0.3], belief: {}, via: 'face', conflict: false, ambiguous: false, faceSamples: 2, faceAgeMs: 0, evidenceAgeMs: 0, inSight });

let n = 0;
function sample(sp: Spec): ShotSample {
  const trackId = sp.trackId === undefined ? 1 : sp.trackId;
  const frames: FrameSummary[] = (sp.locks ?? []).map(([t, lock, under]) => {
    const inSight = under === undefined ? (lock !== null ? trackId : null) : under;
    const ids = new Set([trackId, inSight].filter((x): x is number => x !== null));
    return { t, lock, tracks: [...ids].map((id) => body(id, id === inSight)) };
  });
  const reviewMs = sp.label?.reviewMs ?? 0;
  const label = sp.label
    ? sp.label.target
      ? { kind: 'player' as const, target: sp.label.target, answeredAt: 0, reviewMs }
      : { kind: 'none' as const, answeredAt: 0, reviewMs }
    : undefined;
  if (label && sp.label?.distance !== undefined) Object.assign(label, { distance: sp.label.distance });
  if (label && sp.label?.view !== undefined) Object.assign(label, { view: sp.label.view });
  if (label && sp.label?.source !== undefined) Object.assign(label, { source: sp.label.source });
  return {
    v: 1,
    app: { commit: sp.commit, faceModel: 'ghost', bodyModel: 'movenet', ua: sp.ua },
    round: { key: sp.key, code: sp.key.slice(0, 4), startAt: Number(sp.key.slice(5)), settings: { hitThreshold: 0.5, hitMargin: 0.2 } as ShotSample['round']['settings'], players: 3, shooter: 'p0', eligible: ['p1', 'p2'] },
    device: { periodMs: 120, staleMs: 400, burstMs: 600, width: 720, height: 1280 },
    shot: {
      id: `s${n++}`,
      roundMs: 1000,
      outcome: sp.outcome,
      kind: sp.resolvedTo ? 'instant' : 'pending',
      resolvedTo: sp.resolvedTo ?? null,
      via: null,
      resolveMs: sp.resolveMs ?? null,
      zoom: false,
      frameAgeMs: 30,
      allowanceMs: 400,
      crosshair: [0.48, 0.48, 0.04, 0.04],
      trackId,
      decidedAtFrame: Math.max(0, frames.length - 1),
      settledBy: 'tap',
      decisionTrackId: trackId,
      decisionBelief: null,
    },
    frames,
    target: null,
    ...(label ? { label } : {}),
  };
}

const practiceA = (label: Spec['label'], rest: Omit<Spec, 'key' | 'ua' | 'commit' | 'label'>) => sample({ key: KEY_A, ua: IPHONE, commit: 'abc1234', label, ...rest });
const practiceB = (label: Spec['label'], rest: Omit<Spec, 'key' | 'ua' | 'commit' | 'label'>) => sample({ key: KEY_B, ua: PIXEL, commit: 'def5678', label, ...rest });

const SAMPLES: ShotSample[] = [
  // Labels without a source (builds before 2026-10-01): ?practice and real-room range shots unsplit.
  // 1-2: right hits at 2 m; the first comes under the dot at -300 and locks 100 ms later, the second is locked from the start.
  practiceA({ target: 'p1', distance: 2 }, { outcome: 'hit', resolvedTo: 'p1', resolveMs: 120, locks: [[-400, null], [-300, 'maybe:p1'], [-200, 'lock:p1'], [0, 'lock:p1']] }),
  practiceA({ target: 'p1', distance: 2, view: 'back' }, { outcome: 'hit', resolvedTo: 'p1', resolveMs: 300, locks: [[-500, 'lock:p1'], [0, 'lock:p1']] }),
  // 3: refused at 4 m (rejected legitimate shot); under the dot and never locked.
  practiceA({ target: 'p1', distance: 4 }, { outcome: 'unclear', locks: [[-300, 'top:p1'], [0, 'unknown']] }),
  // 4: aimed at p2, hit p1: a wrong-player hit. The lock named p1, not the target: never locked on p2.
  practiceA({ target: 'p2', distance: 4 }, { outcome: 'hit', resolvedTo: 'p1', resolveMs: 200, locks: [[-300, 'lock:p1']] }),
  // 5: aimed at a non-player, hit p2: an unknown-person false hit. 6: a right refusal.
  practiceA({}, { outcome: 'hit', resolvedTo: 'p2', resolveMs: 500 }),
  practiceA({}, { outcome: 'miss', trackId: null }),
  // 7-8: the second session at 10 m on an Android phone: one right hit, one stale-frame rejection.
  practiceB({ target: 'p1', distance: 10 }, { outcome: 'hit', resolvedTo: 'p1', resolveMs: 100, locks: [[-300, null], [-250, 'maybe:p1'], [-100, 'lock:p1'], [40, 'lock:p1']] }),
  practiceB({ target: 'p1', distance: 10 }, { outcome: 'stale frame' }),
  // 9-10: review cards of a played round (labelled after it, reviewMs > 0): failed shots only.
  sample({ key: KEY_A, ua: IPHONE, commit: 'abc1234', label: { target: 'p2', reviewMs: 4200 }, outcome: 'miss' }),
  sample({ key: KEY_A, ua: IPHONE, commit: 'abc1234', label: { reviewMs: 3100 }, outcome: 'unclear' }),
  // 11: never labelled: not part of any table.
  sample({ key: KEY_A, ua: IPHONE, commit: 'abc1234', outcome: 'miss' }),
];

const near = (actual: number | null, expected: number, tol = 1e-9) => assert.ok(actual !== null && Math.abs(actual - expected) <= tol, `expected ${expected}, got ${actual}`);
const row = (s: ReportSection, table: string, key: string): ReportRow => {
  const r = s.tables.find((t) => t.title === table)?.rows.find((x) => x.key === key);
  assert.ok(r, `no row ${key} in ${table}: ${JSON.stringify(s.tables.find((t) => t.title === table)?.rows.map((x) => x.key))}`);
  return r;
};
const pick = (report: ReturnType<typeof buildSessionReport>, name: string) => {
  const s = report.sections.find((x) => x.name === name);
  assert.ok(s, `no section ${name}`);
  return s;
};

test('?practice, range and review-card shots are kept apart, unsplit older labels too, and unlabelled samples are left out', () => {
  const report = buildSessionReport(SAMPLES);
  assert.equal(report.samples, 11);
  assert.equal(report.labelled, 10);
  // These labels predate `source`: the tap-labelled ones cannot be split into ?practice and range.
  assert.deepEqual(report.sections.map((s) => s.name), [UNSPLIT, 'review']);
  assert.equal(pick(report, UNSPLIT).total.attempts, 8);
  assert.equal(pick(report, 'review').total.attempts, 2);
  assert.match(pick(report, UNSPLIT).note ?? '', /did not record whether it was \?practice or range/);
  assert.match(pick(report, 'review').note ?? '', /did not land/);
  assert.deepEqual([sourceOf(SAMPLES[0]), sourceOf(SAMPLES[8]), sourceOf(SAMPLES[9])], [UNSPLIT, 'review', 'review']);
});

test('labels that say their source split ?practice from range shots in a real room', () => {
  const tagged = (source: string | undefined, key = KEY_A) => sample({ key, ua: IPHONE, commit: 'abc1234', label: { target: 'p1', source }, outcome: 'hit', resolvedTo: 'p1', resolveMs: 100 });
  const samples = [tagged('practice'), tagged('practice'), tagged('range', KEY_B), tagged('range', KEY_B), tagged('range', KEY_B), tagged(undefined), tagged('bogus'), SAMPLES[8]];
  assert.deepEqual(samples.map(sourceOf), ['practice', 'practice', 'range', 'range', 'range', UNSPLIT, UNSPLIT, 'review']);
  const report = buildSessionReport(samples);
  assert.deepEqual(report.sections.map((s) => [s.name, s.source, s.total.attempts]), [
    ['practice', 'practice', 2],
    ['range', 'range', 3],
    [UNSPLIT, UNSPLIT, 2],
    ['review', 'review', 1],
  ]);
  assert.match(pick(report, 'practice').note ?? '', /quick-enrolled/);
  assert.match(pick(report, 'range').note ?? '', /normal scan/);
  // Only the sources present get a section, and a split keeps them lined up.
  const rangeOnly = buildSessionReport(samples.slice(2, 5), parseEvalSplit('EFGH'));
  assert.deepEqual(rangeOnly.sections.map((s) => [s.name, s.total.attempts]), [
    ['dev range', 0],
    ['eval range', 3],
  ]);
});

test('the totals count every outcome, legit success has rejections in the denominator, and the bounds are exact', () => {
  const t = pick(buildSessionReport(SAMPLES), UNSPLIT).total;
  assert.deepEqual(
    { attempts: t.attempts, player: t.playerAttempts, none: t.noneAttempts, correct: t.correct, wrongPlayer: t.wrongPlayer, unknownFalse: t.unknownFalse, refusals: t.rightRefusals, rejected: t.rejected, accepted: t.accepted },
    { attempts: 8, player: 6, none: 2, correct: 3, wrongPlayer: 1, unknownFalse: 1, refusals: 1, rejected: 2, accepted: 5 },
  );
  assert.equal(t.legitSuccess, 0.5);
  near(t.wrongPerAttemptUpper, clopperPearsonUpper(2, 8));
  near(t.wrongPerHitUpper, clopperPearsonUpper(2, 5));
  // Round x target groups: A p1, A p2 (the wrong-player hit), A not a player (the non-player hit), B p1.
  assert.deepEqual([t.targets, t.wrongTargets], [4, 2]);
  near(t.wrongPerTargetUpper, clopperPearsonUpper(2, 4));
  // Accepted hits resolved in 100, 120, 200, 300, 500 ms (the wrong ones count: they were accepted).
  assert.deepEqual(t.resolveMs, { n: 5, p50: 200, p95: 460 });
  // Lock acquisition from the body coming under the dot: 100 (shot 1), 150 (shot 7). Shot 2 was
  // under the dot (and locked) when the recording began; shots 3 and 4 never locked on the target.
  assert.deepEqual(t.lockMs, { n: 2, p50: 125, p95: 147.5 });
  assert.deepEqual([t.lockNever, t.lockUntimed], [2, 1]);
});

test('review cards print no wrong-hit bound: a hit cannot appear in them', () => {
  const review = pick(buildSessionReport(SAMPLES), 'review');
  const t = review.total;
  assert.equal(t.rejected, 1);
  assert.equal(t.rightRefusals, 1);
  assert.equal(t.legitSuccess, 0);
  assert.equal(t.accepted, 0);
  assert.deepEqual([t.wrongPerAttemptUpper, t.wrongPerHitUpper, t.wrongPerTargetUpper], [null, null, null]);
  for (const table of review.tables) for (const r of table.rows) assert.deepEqual([r.wrongPerAttemptUpper, r.wrongPerHitUpper, r.wrongPerTargetUpper], [null, null, null], `${table.title} ${r.key}`);
  assert.deepEqual(t.resolveMs, { n: 0, p50: null, p95: null });
  assert.match(review.boundsNa ?? '', /only shots that did not land/);
  // 216 answered cards used to print "wrong-hit rate ≤1.38% per shot": zero by construction, not evidence.
  const cards = Array.from({ length: 216 }, (_, i) => sample({ key: KEY_A, ua: IPHONE, commit: 'abc1234', label: { target: 'p1', reviewMs: 1000 + i }, outcome: 'miss' }));
  const section = pick(buildSessionReport(cards), 'review');
  const text = formatSection(section).join('\n');
  assert.match(text, /wrong-hit rate n\/a: review cards hold only shots that did not land/);
  assert.doesNotMatch(text, /≤/);
  const byTarget = formatTable(section.tables.find((x) => x.title === 'by target player')!, true);
  assert.match(byTarget[1], /\s+n\/a\s+n\/a\s+/);
});

test('conditions group by the label fields, numbers in order, unlabelled last', () => {
  const tapped = pick(buildSessionReport(SAMPLES), UNSPLIT);
  const distance = tapped.tables.find((t) => t.title === 'by distance')!;
  assert.deepEqual(distance.rows.map((r) => [r.key, r.attempts]), [['2 m', 2], ['4 m', 2], ['10 m', 2], [UNLABELLED, 2]]);
  assert.equal(row(tapped, 'by distance', '2 m').legitSuccess, 1);
  const at4 = row(tapped, 'by distance', '4 m');
  assert.deepEqual([at4.correct, at4.wrongPlayer, at4.rejected, at4.legitSuccess], [0, 1, 1, 0]);
  near(at4.wrongPerAttemptUpper, clopperPearsonUpper(1, 2));
  near(at4.wrongPerHitUpper, clopperPearsonUpper(1, 1));
  const at10 = row(tapped, 'by distance', '10 m');
  assert.deepEqual([at10.correct, at10.rejected, at10.legitSuccess], [1, 1, 0.5]);
  assert.deepEqual(at10.lockMs, { n: 1, p50: 150, p95: 150 });
  near(at10.wrongPerAttemptUpper, 1 - Math.sqrt(0.05));
  near(at10.wrongPerHitUpper, 0.95);
  // Only one shot carries a view; the rest are unlabelled, and absent fields never throw.
  assert.deepEqual(tapped.tables.find((t) => t.title === 'by view')!.rows.map((r) => [r.key, r.attempts]), [['back', 1], [UNLABELLED, 7]]);
  assert.deepEqual(tapped.tables.find((t) => t.title === 'by lighting')!.rows.map((r) => [r.key, r.attempts]), [[UNLABELLED, 8]]);
  assert.equal(conditionOf(SAMPLES[10], 'distance'), UNLABELLED);
  assert.equal(conditionOf({ ...SAMPLES[0], label: Object.assign({ ...SAMPLES[0].label! }, { lighting: ' dusk ' }) }, 'lighting'), 'dusk');
});

test('target, phone and build tables name the round-scoped target, the phone and the commit', () => {
  const tapped = pick(buildSessionReport(SAMPLES), UNSPLIT);
  assert.deepEqual(tapped.tables.find((t) => t.title === 'by target player')!.rows.map((r) => [r.key, r.attempts]), [
    [`${KEY_A} p1`, 3],
    [`${KEY_A} p2`, 1],
    [`${KEY_B} p1`, 2],
    ['not a player', 2],
  ]);
  const p2 = row(tapped, 'by target player', `${KEY_A} p2`);
  assert.deepEqual([p2.wrongPlayer, p2.legitSuccess], [1, 0]);
  const nobody = row(tapped, 'by target player', 'not a player');
  assert.deepEqual([nobody.unknownFalse, nobody.rightRefusals, nobody.legitSuccess], [1, 1, null]);
  const iphone = row(tapped, 'by shooter phone', 'iPhone iOS 18.5 Safari 18.5');
  const pixel = row(tapped, 'by shooter phone', 'Android 14 Pixel 8 Chrome 140');
  assert.deepEqual([iphone.attempts, iphone.correct, pixel.attempts, pixel.correct], [6, 2, 2, 1]);
  assert.deepEqual(tapped.tables.find((t) => t.title === 'by build')!.rows.map((r) => [r.key, r.attempts, r.correct]), [
    ['abc1234 ghost', 6, 2],
    ['def5678 ghost', 2, 1],
  ]);
});

test('an eval split holds out the later rounds and reports them apart', () => {
  const split = parseEvalSplit('2026-09-30');
  const report = buildSessionReport(SAMPLES, split);
  assert.deepEqual(report.sections.map((s) => [s.name, s.total.attempts]), [
    [`dev ${UNSPLIT}`, 6],
    ['dev review', 2],
    [`eval ${UNSPLIT}`, 2],
    ['eval review', 0],
  ]);
  assert.match(report.split ?? '', /2026-09-30/);
  const evalTapped = pick(report, `eval ${UNSPLIT}`).total;
  assert.deepEqual([evalTapped.correct, evalTapped.rejected, evalTapped.wrongPlayer + evalTapped.unknownFalse], [1, 1, 0]);
  near(evalTapped.wrongPerAttemptUpper, 1 - Math.sqrt(0.05));
  assert.deepEqual(formatSection(pick(report, 'eval review')), ['== eval review: no labelled shots']);
});

test('the eval argument reads dates, round keys and key prefixes, and refuses anything that could match no round', () => {
  const a = SAMPLES[0];
  const b = SAMPLES[6];
  const date = parseEvalSplit('2026-09-29');
  assert.deepEqual([date.isEval(a), date.isEval(b)], [false, true]);
  // A bare date is local midnight, so an evening session belongs to its own day.
  const sameDay = parseEvalSplit('2026-09-28');
  assert.equal(sameDay.isEval(a), true);
  const key = parseEvalSplit(KEY_B);
  assert.deepEqual([key.isEval(a), key.isEval(b)], [false, true]);
  assert.equal(parseEvalSplit(KEY_A).isEval(a), true);
  const prefix = parseEvalSplit('EFGH');
  assert.deepEqual([prefix.isEval(a), prefix.isEval(b)], [false, true]);
  assert.equal(parseEvalSplit(`EFGH-${String(START_B).slice(0, 5)}`).isEval(b), true);
  const ms = parseEvalSplit(String(START_B));
  assert.deepEqual([ms.isEval(a), ms.isEval(b)], [false, true]);
  assert.throws(() => parseEvalSplit('2026-13-45T99:00'));
  assert.throws(() => parseEvalSplit('2026-02-30'));
  // A typo used to become a key prefix that holds out nothing, silently.
  assert.throws(() => parseEvalSplit('26/09/2026'), /--eval: cannot read 26\/09\/2026/);
  assert.throws(() => parseEvalSplit('efgh'), /cannot read/);
  assert.throws(() => parseEvalSplit('  '), /needs a date/);
});

test('--since reads the same dates as --eval, local midnight for a bare date, and nothing else', () => {
  const at = (arg: string) => parseCutoff(arg)?.t;
  assert.equal(at('2026-09-28'), new Date(2026, 8, 28).getTime());
  assert.equal(at('2026-09-30T20:00'), START_B);
  assert.equal(at(String(START_B)), START_B);
  assert.equal(at(KEY_B), START_B);
  assert.equal(parseCutoff('26/09/2026'), null);
  assert.equal(parseCutoff('EFGH'), null);
  assert.throws(() => parseCutoff('2026-02-30'), /--since: no such date/);
  // The same date is the same cut-off in both flags.
  const since = parseCutoff('2026-09-30')!.t;
  const split = parseEvalSplit('2026-09-30');
  for (const s of SAMPLES) assert.equal(split.isEval(s), s.round.startAt >= since);
});

test('lock acquisition is timed from the shot body coming under the dot to the first lock on the labelled target', () => {
  assert.deepEqual(lockAcquisition(SAMPLES[0]), { kind: 'locked', ms: 100 });
  assert.deepEqual(lockAcquisition(SAMPLES[1]), { kind: 'untimed' });
  assert.deepEqual(lockAcquisition(SAMPLES[2]), { kind: 'never' }, 'maybe/top/unknown are not a lock');
  assert.deepEqual(lockAcquisition(SAMPLES[3]), { kind: 'never' }, 'a lock on somebody else is not the target');
  assert.equal(lockAcquisition(SAMPLES[4]), null, 'a non-player label has no target');
  assert.equal(lockAcquisition(SAMPLES[7]), null, 'no recorded frames');
  // Frames out of order are sorted first.
  const shuffled = { ...SAMPLES[6], frames: [...SAMPLES[6].frames].reverse() };
  assert.deepEqual(lockAcquisition(shuffled), { kind: 'locked', ms: 150 });
});

test('lock acquisition measures the tracker, not how long the shooter held aim or the phone frame period', () => {
  const shot = (locks: Spec['locks'], trackId: number | null = 1) => sample({ key: KEY_A, ua: IPHONE, commit: 'abc1234', label: { target: 'p1' }, outcome: 'hit', resolvedTo: 'p1', resolveMs: 30, trackId, locks });
  // A 120 ms phone: the 12 frames kept before the tap span 1.3 s. Snap shot: the target comes under
  // the dot 150 ms before the tap and locks 90 ms after it. Timed from the window start this read 1440 ms.
  const pre = Array.from({ length: 12 }, (_, i) => -30 - 120 * (11 - i));
  const snap = shot([...pre.map((t): [number, string | null, number | null] => (t >= -150 ? [t, 'maybe:p1', 1] : [t, null, null])), [90, 'lock:p1']]);
  assert.deepEqual(lockAcquisition(snap), { kind: 'locked', ms: 240 });
  // Aim held for 2 s, locked throughout: it locked before the recording began, the time is unknown (it read 0 ms).
  const held = shot(pre.map((t): [number, string | null] => [t, 'lock:p1']));
  assert.deepEqual(lockAcquisition(held), { kind: 'untimed' });
  // Under the dot since before the recording and locking only 1.1 s into it: at least 1.1 s, perhaps
  // much more. Kept as a lower bound (review of 2026-10-01: dropping it hid exactly the slow locks the
  // p95 target is about), never timed as if the body arrived with the first recorded frame.
  const slow = shot(pre.map((t): [number, string | null] => [t, t < -200 ? 'maybe:p1' : 'lock:p1']));
  assert.deepEqual(lockAcquisition(slow), { kind: 'atLeast', ms: 1200 });
  // Under the dot the whole time and never locked: a failure, not left out.
  const never = shot(pre.map((t): [number, string | null] => [t, 'maybe:p1']));
  assert.deepEqual(lockAcquisition(never), { kind: 'never' });
  // Another body locked on the target's name is not this body's lock.
  const other = shot([
    [-400, 'lock:p1', 2],
    [-300, 'lock:p1', 2],
    [-200, 'maybe:p1', 1],
    [0, 'maybe:p1', 1],
  ]);
  assert.deepEqual(lockAcquisition(other), { kind: 'never' });
  // The body is found by the decision when the tap nominated nobody.
  const late = { ...snap, shot: { ...snap.shot, trackId: null } };
  assert.deepEqual(lockAcquisition(late), { kind: 'locked', ms: 240 });
  // Never under the dot: nothing to time.
  assert.equal(lockAcquisition(shot([[-200, 'lock:p1', 2]])), null);
  const r = summariseRow('all', [snap, held, never] as LabelledSample[]);
  assert.deepEqual([r.lockMs, r.lockNever, r.lockUntimed, r.lockAtLeast], [{ n: 1, p50: 240, p95: 240 }, 1, 1, 0]);
  // A slow lock seen only from the recording's start still counts against the p95, as a lower bound.
  const withSlow = summariseRow('all', [snap, slow] as LabelledSample[]);
  assert.equal(withSlow.lockAtLeast, 1);
  assert.equal(withSlow.lockMs.n, 2);
  assert.ok((withSlow.lockMs.p95 ?? 0) >= 500, `a 1.2 s lower bound fails the 500 ms target (${JSON.stringify(withSlow.lockMs)})`);
});

test('a session with no wrong hit in 216 shots bounds the per-shot rate below 1.38% only if the shots are independent', () => {
  // 216 shots at 18 targets (12 each, two per round): the targets are the independent units.
  const clean: LabelledSample[] = Array.from({ length: 216 }, (_, i) => {
    const key = `ABCD-${START_A + Math.floor(i / 24)}`;
    const target = `p${1 + (Math.floor(i / 12) % 2)}`;
    return (i % 3 === 0 ? sample({ key, ua: IPHONE, commit: 'abc1234', label: { target }, outcome: 'unclear' }) : sample({ key, ua: IPHONE, commit: 'abc1234', label: { target }, outcome: 'hit', resolvedTo: target, resolveMs: 100 + i })) as LabelledSample;
  });
  const r = summariseRow('all', clean);
  assert.deepEqual([r.attempts, r.correct, r.rejected, r.accepted], [216, 144, 72, 144]);
  near(r.wrongPerAttemptUpper, 0.013773397590468141, 1e-12);
  near(r.wrongPerHitUpper, 1 - Math.pow(0.05, 1 / 144), 1e-12);
  assert.deepEqual([r.targets, r.wrongTargets], [18, 0]);
  near(r.wrongPerTargetUpper, 1 - Math.pow(0.05, 1 / 18), 1e-12);
  near(r.legitSuccess, 144 / 216);
  const text = formatSection(buildSessionReport(clean).sections[0]).join('\n');
  assert.match(text, /≤15\.3% per target \(0 of 18 round x target groups had one\), and ≤1\.38% per shot, ≤2\.06% per accepted hit if every shot were independent/);
});

test('user agents shrink to phone, OS and browser', () => {
  assert.equal(shortDevice(IPHONE), 'iPhone iOS 18.5 Safari 18.5');
  assert.equal(shortDevice(PIXEL), 'Android 14 Pixel 8 Chrome 140');
  assert.equal(shortDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.122 Mobile/15E148 Safari/604.1'), 'iPhone iOS 17.6 Chrome 140');
  assert.equal(shortDevice('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'), 'Android 10 Chrome 140');
  assert.equal(shortDevice('Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36'), 'Android 14 SAMSUNG SM-S918B Samsung 26');
  assert.equal(shortDevice('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'), 'iPad iOS 17.0 Safari 17.0');
  assert.equal(shortDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36'), 'Mac HeadlessChrome 141');
  assert.equal(shortDevice('node'), 'node');
  assert.equal(shortDevice(''), 'unknown device');
});

test('tables print aligned rows with the bounds and lock counts, and a condition nobody labelled is one line', () => {
  const tapped = pick(buildSessionReport(SAMPLES), UNSPLIT);
  const distance = formatTable(tapped.tables.find((t) => t.title === 'by distance')!);
  assert.equal(distance.length, 5);
  assert.match(distance[0], /^by distance\s+shots\s+player\s+hit\s+wrongP\s+wrongU\s+rejected\s+refused\s+legit\s+wrong\/shot\s+wrong\/hit\s+resolve p50\/95\s+lock p50\/95\s+unlocked\s+untimed$/);
  assert.ok(distance.every((l) => l.length === distance[0].length), 'aligned');
  assert.match(distance[1], /^2 m\s+2\s+2\s+2\s+0\s+0\s+0\s+0\s+100%\s+≤77\.6%\s+≤77\.6%\s+210\/291\s+100\/100 \(1\)\s+0\s+1$/);
  assert.match(distance[2], /^4 m\s.*\s-\s+2\s+0$/);
  assert.deepEqual(formatTable(tapped.tables.find((t) => t.title === 'by lighting')!), ['by lighting: no labels (8 shots unlabelled)']);
  const text = formatSection(tapped).join('\n');
  assert.ok(text.startsWith(`== ${UNSPLIT}: 8 labelled shots from 2 rounds`));
  assert.match(text, /legit-shot success 50% \(3\/6, rejections counted\)/);
  assert.match(text, /lock acquisition p50\/p95 125\/148 ms over 2 shots that locked after their target came under the dot \(0 of them lower bounds: under the dot when the recording began, so the percentiles are lower bounds when they count\); 2 never locked \(failures\); 1 already locked when the recording began/);
  assert.ok(REPORT_LEGEND.some((l) => /as if every shot were independent/.test(l)));
});
