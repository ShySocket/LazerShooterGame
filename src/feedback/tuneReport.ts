import type { Evaluation } from './replay';
import type { ShotSample } from './sample';
import type { TriageSummary } from './triage';
import type { TuneResult } from './tune';

/**
 * The pull-request description the nightly tuning job opens (scripts/tune.ts): what changed and why,
 * the evidence, and what the data says that no knob here can fix, for a person to read before merging.
 */
export interface ReportInput {
  result: TuneResult;
  triage: TriageSummary;
  samples: ShotSample[];
  fromVersion: string;
  toVersion: string | null;
  day: string;
}

const pct = (x: number | null | undefined) => (x === null || x === undefined ? '-' : `${(x * 100).toFixed(1)}%`);
const row = (name: string, e: Evaluation | undefined) => (e ? `| ${name} | ${e.n} | ${e.correct} | ${e.wrong} | ${e.miss} |` : `| ${name} | - | - | - | - |`);

/** Refusal rules of shots labelled with a player that did not land: where the misses come from. */
export function refusalsByRule(samples: ShotSample[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const s of samples) {
    if (s.label?.kind !== 'player' || s.shot.resolvedTo) continue;
    const rule = s.shot.refusal ?? (s.shot.trackId === null && s.shot.decisionTrackId === null ? 'nobody under the dot' : s.shot.outcome);
    counts.set(rule, (counts.get(rule) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}

export function prTitle(r: TuneResult, toVersion: string | null): string {
  const what = r.changes.map((c) => `${c.key} ${c.from}→${c.to}`).join(', ');
  return `${r.decision === 'tighten' ? 'fix(calibration): tighten' : 'tune(calibration):'} ${what}${toVersion ? ` (${toVersion})` : ''}`;
}

export function prBody(input: ReportInput): string {
  const { result: r, triage: t, samples, fromVersion, toVersion, day } = input;
  const ev = r.evidence;
  const lines: string[] = [];
  const headline =
    r.decision === 'none' ? 'No change: the calibration is kept.' : r.decision === 'tighten' ? 'Tightening: the current calibration replays a wrong hit.' : 'Proposal: fewer refused legitimate shots, zero replayed wrong hits.';
  lines.push(`## Nightly calibration tuning, ${day}`, '', `**${headline}**`, '');
  if (r.changes.length) {
    lines.push(`Calibration ${fromVersion} → ${toVersion ?? '(not written)'}`, '', '| knob | from | to |', '|---|---|---|');
    for (const c of r.changes) lines.push(`| \`${c.key}\` | ${c.from} | ${c.to} |`);
    lines.push('');
  }
  lines.push('### Why', '', ...r.reasons.map((x) => `- ${x}`), '');
  lines.push(
    '### Evidence (replay of every labelled shot)',
    '',
    `${ev.samples} labelled shots from ${ev.rounds} rounds (${ev.trainRounds} searched, ${ev.holdoutRounds} held out). Replay agrees with the game on ${pct(ev.agreement)} of ${ev.agreementSamples} shots${ev.agreementOwnVersion ? ` played by ${fromVersion}` : ' (all versions)'}. Labels contradicting a confident game hit: ${ev.contradictions} (${pct(ev.contradictionShare)}).`,
    '',
    '| set | shots | right | wrong | missed |',
    '|---|---|---|---|---|',
    row('current, all', ev.current.all),
    row('current, hold-out', ev.current.holdout),
    row('candidate, all', ev.candidate?.all),
    row('candidate, hold-out', ev.candidate?.holdout),
    '',
    `95% upper bound on wrong hits per accepted hit: current ${pct(ev.current.wrongPerHitUpper)}, candidate ${pct(ev.candidate?.wrongPerHitUpper)}. Per round: current ${pct(ev.current.roundWrongUpper)}, candidate ${pct(ev.candidate?.roundWrongUpper)}.`,
    '',
  );
  lines.push('### What the game did (as played)', '', `Hit rate on shots labelled with a player: ${pct(t.hitRate)}. Refusal rate on shots labelled "should not count": ${pct(t.refusalRate)}.`, '');
  for (const [v, n] of Object.entries(t.counts).sort((a, b) => b[1] - a[1])) lines.push(`- ${v}: ${n}`);
  if (t.wrong.length) {
    lines.push('', `**${t.wrong.length} wrong hit(s) as played** (round / shot / hit / label):`);
    for (const w of t.wrong.slice(0, 20)) lines.push(`- ${w.round} / ${w.shot} / ${w.resolvedTo} / ${w.label}`);
  }
  const rules = refusalsByRule(samples);
  lines.push(
    '',
    '### Refused legitimate shots, by rule',
    '',
    'The loop only moves the face, outfit and fusion knobs the replay re-runs faithfully, which act on rules such as margin, low confidence and no outfit backing. The rest (nobody under the dot, not a player, unconfirmed, hidden partner, re-acquiring, stale frames) come from the tracker, aim geometry, frame timing or the face model and its mean, and need a change by hand checked with the sim and realcheck:',
    '',
    ...(rules.length ? rules.slice(0, 12).map(([rule, n]) => `- ${rule}: ${n}`) : ['- none']),
    '',
  );
  if (r.decision !== 'none')
    lines.push('### Before merging', '', '- The gate results below must be green (tests, typecheck, build, sim:full, sim:wide, replay hold-out, realcheck when its fixtures are cached).', '- `npm run e2e` and a phone session are still on a person: CI cannot hold a phone.', '- Merging bumps CALIBRATION_VERSION; the next night continues from the merged values.', '');
  return lines.join('\n');
}
