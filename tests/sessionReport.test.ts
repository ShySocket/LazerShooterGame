import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionReport, conditionOf, formatSection, formatTable, isPractice, lockAcquisitionMs, parseEvalSplit, shortDevice, summariseRow, UNLABELLED, type LabelledSample, type ReportRow, type ReportSection } from '../src/feedback/sessionReport';
import { clopperPearsonUpper } from '../src/feedback/stats';
import type { FrameSummary, ShotSample } from '../src/feedback/sample';

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
  label?: { target?: string; distance?: number; view?: string; reviewMs?: number };
  outcome: string;
  resolvedTo?: string;
  resolveMs?: number;
  trackId?: number | null;
  locks?: [number, string | null][];
}

let n = 0;
function sample(sp: Spec): ShotSample {
  const frames: FrameSummary[] = (sp.locks ?? []).map(([t, lock]) => ({ t, lock, tracks: [] }));
  const reviewMs = sp.label?.reviewMs ?? 0;
  const label = sp.label
    ? sp.label.target
      ? { kind: 'player' as const, target: sp.label.target, answeredAt: 0, reviewMs }
      : { kind: 'none' as const, answeredAt: 0, reviewMs }
    : undefined;
  if (label && sp.label?.distance !== undefined) Object.assign(label, { distance: sp.label.distance });
  if (label && sp.label?.view !== undefined) Object.assign(label, { view: sp.label.view });
  const trackId = sp.trackId === undefined ? 1 : sp.trackId;
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
  // 1-2: right hits at 2 m; the first locks 200 ms into its window, the second is locked from the start.
  practiceA({ target: 'p1', distance: 2 }, { outcome: 'hit', resolvedTo: 'p1', resolveMs: 120, locks: [[-400, null], [-300, 'maybe:p1'], [-200, 'lock:p1'], [0, 'lock:p1']] }),
  practiceA({ target: 'p1', distance: 2, view: 'back' }, { outcome: 'hit', resolvedTo: 'p1', resolveMs: 300, locks: [[-500, 'lock:p1'], [0, 'lock:p1']] }),
  // 3: refused at 4 m (rejected legitimate shot); never locked.
  practiceA({ target: 'p1', distance: 4 }, { outcome: 'unclear', locks: [[-300, 'top:p1'], [0, 'unknown']] }),
  // 4: aimed at p2, hit p1: a wrong-player hit. The lock named p1, not the target, so no lock time.
  practiceA({ target: 'p2', distance: 4 }, { outcome: 'hit', resolvedTo: 'p1', resolveMs: 200, locks: [[-300, 'lock:p1']] }),
  // 5: aimed at a non-player, hit p2: an unknown-person false hit. 6: a right refusal.
  practiceA({}, { outcome: 'hit', resolvedTo: 'p2', resolveMs: 500 }),
  practiceA({}, { outcome: 'miss', trackId: null }),
  // 7-8: the second session at 10 m on an Android phone: one right hit, one stale-frame rejection.
  practiceB({ target: 'p1', distance: 10 }, { outcome: 'hit', resolvedTo: 'p1', resolveMs: 100, locks: [[-300, null], [-100, 'lock:p1'], [40, 'lock:p1']] }),
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

test('practice and review-card shots are kept apart and unlabelled samples are left out', () => {
  const report = buildSessionReport(SAMPLES);
  assert.equal(report.samples, 11);
  assert.equal(report.labelled, 10);
  assert.deepEqual(report.sections.map((s) => s.name), ['practice', 'review']);
  assert.equal(pick(report, 'practice').total.attempts, 8);
  assert.equal(pick(report, 'review').total.attempts, 2);
  assert.equal(pick(report, 'practice').note, null);
  assert.match(pick(report, 'review').note ?? '', /did not land/);
  assert.ok(isPractice(SAMPLES[0]) && !isPractice(SAMPLES[8]) && !isPractice(SAMPLES[10]));
});

test('the practice totals count every outcome, legit success has rejections in the denominator, and the bounds are exact', () => {
  const t = pick(buildSessionReport(SAMPLES), 'practice').total;
  assert.deepEqual(
    { attempts: t.attempts, player: t.playerAttempts, none: t.noneAttempts, correct: t.correct, wrongPlayer: t.wrongPlayer, unknownFalse: t.unknownFalse, refusals: t.rightRefusals, rejected: t.rejected, accepted: t.accepted },
    { attempts: 8, player: 6, none: 2, correct: 3, wrongPlayer: 1, unknownFalse: 1, refusals: 1, rejected: 2, accepted: 5 },
  );
  assert.equal(t.legitSuccess, 0.5);
  near(t.wrongPerAttemptUpper, clopperPearsonUpper(2, 8));
  near(t.wrongPerHitUpper, clopperPearsonUpper(2, 5));
  // Accepted hits resolved in 100, 120, 200, 300, 500 ms (the wrong ones count: they were accepted).
  assert.deepEqual(t.resolveMs, { n: 5, p50: 200, p95: 460 });
  // Lock acquisition: 200 (shot 1), 0 (shot 2), 200 (shot 7); shot 4's lock named somebody else.
  assert.deepEqual(t.lockMs, { n: 3, p50: 200, p95: 200 });
});

test('the review cards say which refusals were real players and bound nothing they cannot', () => {
  const t = pick(buildSessionReport(SAMPLES), 'review').total;
  assert.equal(t.rejected, 1);
  assert.equal(t.rightRefusals, 1);
  assert.equal(t.legitSuccess, 0);
  assert.equal(t.accepted, 0);
  assert.equal(t.wrongPerHitUpper, null);
  near(t.wrongPerAttemptUpper, 1 - Math.sqrt(0.05));
  assert.deepEqual(t.resolveMs, { n: 0, p50: null, p95: null });
});

test('conditions group by the label fields, numbers in order, unlabelled last', () => {
  const practice = pick(buildSessionReport(SAMPLES), 'practice');
  const distance = practice.tables.find((t) => t.title === 'by distance')!;
  assert.deepEqual(distance.rows.map((r) => [r.key, r.attempts]), [['2 m', 2], ['4 m', 2], ['10 m', 2], [UNLABELLED, 2]]);
  assert.equal(row(practice, 'by distance', '2 m').legitSuccess, 1);
  const at4 = row(practice, 'by distance', '4 m');
  assert.deepEqual([at4.correct, at4.wrongPlayer, at4.rejected, at4.legitSuccess], [0, 1, 1, 0]);
  near(at4.wrongPerAttemptUpper, clopperPearsonUpper(1, 2));
  near(at4.wrongPerHitUpper, clopperPearsonUpper(1, 1));
  const at10 = row(practice, 'by distance', '10 m');
  assert.deepEqual([at10.correct, at10.rejected, at10.legitSuccess], [1, 1, 0.5]);
  assert.deepEqual(at10.lockMs, { n: 1, p50: 200, p95: 200 });
  near(at10.wrongPerAttemptUpper, 1 - Math.sqrt(0.05));
  near(at10.wrongPerHitUpper, 0.95);
  // Only one shot carries a view; the rest are unlabelled, and absent fields never throw.
  assert.deepEqual(practice.tables.find((t) => t.title === 'by view')!.rows.map((r) => [r.key, r.attempts]), [['back', 1], [UNLABELLED, 7]]);
  assert.deepEqual(practice.tables.find((t) => t.title === 'by lighting')!.rows.map((r) => [r.key, r.attempts]), [[UNLABELLED, 8]]);
  assert.equal(conditionOf(SAMPLES[10], 'distance'), UNLABELLED);
  assert.equal(conditionOf({ ...SAMPLES[0], label: Object.assign({ ...SAMPLES[0].label! }, { lighting: ' dusk ' }) }, 'lighting'), 'dusk');
});

test('target, phone and build tables name the round-scoped target, the phone and the commit', () => {
  const practice = pick(buildSessionReport(SAMPLES), 'practice');
  assert.deepEqual(practice.tables.find((t) => t.title === 'by target player')!.rows.map((r) => [r.key, r.attempts]), [
    [`${KEY_A} p1`, 3],
    [`${KEY_A} p2`, 1],
    [`${KEY_B} p1`, 2],
    ['not a player', 2],
  ]);
  const p2 = row(practice, 'by target player', `${KEY_A} p2`);
  assert.deepEqual([p2.wrongPlayer, p2.legitSuccess], [1, 0]);
  const nobody = row(practice, 'by target player', 'not a player');
  assert.deepEqual([nobody.unknownFalse, nobody.rightRefusals, nobody.legitSuccess], [1, 1, null]);
  const iphone = row(practice, 'by shooter phone', 'iPhone iOS 18.5 Safari 18.5');
  const pixel = row(practice, 'by shooter phone', 'Android 14 Pixel 8 Chrome 140');
  assert.deepEqual([iphone.attempts, iphone.correct, pixel.attempts, pixel.correct], [6, 2, 2, 1]);
  assert.deepEqual(practice.tables.find((t) => t.title === 'by build')!.rows.map((r) => [r.key, r.attempts, r.correct]), [
    ['abc1234 ghost', 6, 2],
    ['def5678 ghost', 2, 1],
  ]);
});

test('an eval split holds out the later rounds and reports them apart', () => {
  const split = parseEvalSplit('2026-09-30');
  const report = buildSessionReport(SAMPLES, split);
  assert.deepEqual(report.sections.map((s) => [s.name, s.total.attempts]), [
    ['dev practice', 6],
    ['dev review', 2],
    ['eval practice', 2],
    ['eval review', 0],
  ]);
  assert.match(report.split ?? '', /2026-09-30/);
  const evalPractice = pick(report, 'eval practice').total;
  assert.deepEqual([evalPractice.correct, evalPractice.rejected, evalPractice.wrongPlayer + evalPractice.unknownFalse], [1, 1, 0]);
  near(evalPractice.wrongPerAttemptUpper, 1 - Math.sqrt(0.05));
  assert.deepEqual(formatSection(pick(report, 'eval review')), ['== eval review: no labelled shots']);
});

test('the eval argument reads dates, round keys and key prefixes', () => {
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
  const ms = parseEvalSplit(String(START_B));
  assert.deepEqual([ms.isEval(a), ms.isEval(b)], [false, true]);
  assert.throws(() => parseEvalSplit('2026-13-45T99:00'));
  assert.throws(() => parseEvalSplit('2026-02-30'));
});

test('lock acquisition is measured from the earliest frame to the first lock on the labelled target', () => {
  assert.equal(lockAcquisitionMs(SAMPLES[0]), 200);
  assert.equal(lockAcquisitionMs(SAMPLES[1]), 0);
  assert.equal(lockAcquisitionMs(SAMPLES[2]), null, 'maybe/top/unknown are not a lock');
  assert.equal(lockAcquisitionMs(SAMPLES[3]), null, 'a lock on somebody else is not the target');
  assert.equal(lockAcquisitionMs(SAMPLES[4]), null, 'a non-player label has no target');
  // Frames out of order are sorted first.
  const shuffled = { ...SAMPLES[6], frames: [...SAMPLES[6].frames].reverse() };
  assert.equal(lockAcquisitionMs(shuffled), 200);
});

test('a session with no wrong hit in 216 shots bounds the rate below 1.38%', () => {
  const clean: LabelledSample[] = Array.from({ length: 216 }, (_, i) =>
    (i % 3 === 0 ? practiceA({ target: 'p1' }, { outcome: 'unclear' }) : practiceA({ target: 'p1' }, { outcome: 'hit', resolvedTo: 'p1', resolveMs: 100 + i })) as LabelledSample,
  );
  const r = summariseRow('all', clean);
  assert.deepEqual([r.attempts, r.correct, r.rejected, r.accepted], [216, 144, 72, 144]);
  near(r.wrongPerAttemptUpper, 0.013773397590468141, 1e-12);
  near(r.wrongPerHitUpper, 1 - Math.pow(0.05, 1 / 144), 1e-12);
  near(r.legitSuccess, 144 / 216);
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

test('tables print aligned rows with the bounds, and a condition nobody labelled is one line', () => {
  const practice = pick(buildSessionReport(SAMPLES), 'practice');
  const distance = formatTable(practice.tables.find((t) => t.title === 'by distance')!);
  assert.equal(distance.length, 5);
  assert.match(distance[0], /^by distance\s+shots\s+player\s+hit\s+wrongP\s+wrongU\s+rejected\s+refused\s+legit\s+wrong\/shot\s+wrong\/hit/);
  assert.ok(distance.every((l) => l.length === distance[0].length), 'aligned');
  assert.match(distance[1], /^2 m\s+2\s+2\s+2\s+0\s+0\s+0\s+0\s+100%\s+≤77\.6%\s+≤77\.6%\s+210\/291\s+100\/190 \(2\)$/);
  assert.deepEqual(formatTable(practice.tables.find((t) => t.title === 'by lighting')!), ['by lighting: no labels (8 shots unlabelled)']);
  const text = formatSection(practice).join('\n');
  assert.match(text, /== practice: 8 labelled shots from 2 rounds/);
  assert.match(text, /legit-shot success 50% \(3\/6, rejections counted\)/);
});
