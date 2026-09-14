import { readFileSync } from 'node:fs';
import { agreement, asPlayed, collectSamples, evaluate, sweep } from '../src/feedback/replay';
import type { ShotSample } from '../src/feedback/sample';

/**
 * Replays labelled shot feedback with alternative calibrations.
 *
 *   npm run replay -- feedback.json            a JSON export of the database's `feedback` node (or of the whole database)
 *   npm run replay -- --url "https://<project>-default-rtdb.firebaseio.com/feedback.json?auth=<secret or access token>"
 *   npm run replay -- feedback.json --json     print the sweep rows as JSON instead of a table
 *
 * Export from the Firebase console (Realtime Database > the `feedback` node > Export JSON), or with
 * the REST API using a database secret or an OAuth access token; client rules deny reads on purpose.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
  const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--url');
  const data: unknown[] = [];
  if (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
    data.push(await res.json());
  }
  for (const f of files) data.push(JSON.parse(readFileSync(f, 'utf8')));
  if (data.length === 0) {
    console.error('usage: npm run replay -- <export.json> | --url <database url>');
    process.exit(2);
  }
  const samples = data.flatMap(collectSamples);
  const labelled = samples.filter((s): s is ShotSample & { label: NonNullable<ShotSample['label']> } => Boolean(s.label));
  const rounds = new Set(samples.map((s) => s.round.key));
  const commits = [...new Set(samples.map((s) => s.app.commit))];
  const players = labelled.filter((s) => s.label.kind === 'player').length;
  console.log(`${samples.length} samples from ${rounds.size} rounds (builds ${commits.join(', ') || 'none'}); ${labelled.length} labelled: ${players} name a player, ${labelled.length - players} say "should not count"`);
  if (labelled.length === 0) return;
  const played = evaluate(labelled, {}, asPlayed);
  console.log(`As played:  correct ${played.correct}  wrong ${played.wrong}  miss ${played.miss}  score ${played.score}`);
  console.log(`Replay with the defaults agrees with the game's own verdict on ${Math.round(agreement(labelled) * 100)}% of samples`);
  const rows = sweep(labelled);
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const w = Math.max(...rows.map((r) => r.name.length));
  console.log('\n' + 'parameter'.padEnd(w) + '  correct  wrong  miss  score');
  for (const r of rows) {
    const e = r.result;
    console.log(`${r.name.padEnd(w)}  ${String(e.correct).padStart(7)}  ${String(e.wrong).padStart(5)}  ${String(e.miss).padStart(4)}  ${String(e.score).padStart(5)}`);
  }
  console.log('\nscore = wrong x 5 + miss; lower is better. Change one calibration at a time and re-run the simulation gate before shipping it.');
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
