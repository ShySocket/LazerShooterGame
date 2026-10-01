/**
 * The session report: what the labelled shots of a play or practice session say, with exact bounds.
 *
 *     npm run session:report                          fetch with the Firebase CLI (one-time: npx firebase-tools login)
 *     npm run session:report -- --file x.json         a saved pull (.rubric/feedback/) or the console's Export JSON
 *     npm run session:report -- --eval 2026-09-30     hold out rounds from that date on (local midnight), reported apart
 *     npm run session:report -- --eval ABCD-1759312345678   ... from that round on; ABCD (a key prefix): that room's rounds
 *     npm run session:report -- --since 2026-09-26    ignore older rounds (local midnight, as --eval)
 *     npm run session:report -- --json                the report as JSON, alone on stdout (everything else goes to stderr)
 *
 * A --since or --eval value that cannot be read exits 2 with the reason. ?practice shots, range shots
 * in a real room and review-card answers are reported apart. Each section is
 * broken down by condition (distance, view, lighting, scenario when the label carries them), target
 * player, shooter phone and build, with the one-sided 95% Clopper-Pearson upper bound on the
 * wrong-hit rate per round x target group, and per shot and per accepted hit as if every shot were
 * independent (src/feedback/sessionReport.ts, src/feedback/stats.ts).
 */
import { buildSessionReport, formatSection, REPORT_LEGEND } from '../src/feedback/sessionReport.ts';
import { loadFeedback, optValue, playSamples, readRoundFilters } from './feedback-source.ts';

const args = process.argv.slice(2);

const { since, split } = readRoundFilters(args);
const data = loadFeedback(optValue(args, '--file'));
const samples = playSamples(data, since);
const report = buildSessionReport(samples, split);

if (args.includes('--json')) {
  console.log(JSON.stringify(report, null, 1));
} else {
  const rounds = new Set(samples.map((s) => s.round.key)).size;
  console.log(`\n${report.samples} samples from ${rounds} rounds, ${report.labelled} labelled${report.split ? `; held out for evaluation: ${report.split}` : ''}`);
  for (const s of report.sections) console.log('\n' + formatSection(s).join('\n'));
  console.log('\n' + REPORT_LEGEND.join('\n'));
}
// The outcome the game must never produce: say so in the exit code.
if (report.sections.some((s) => s.total.wrongPlayer + s.total.unknownFalse > 0)) process.exitCode = 1;
