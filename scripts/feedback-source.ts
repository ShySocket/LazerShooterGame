/**
 * Where the feedback scripts (feedback:pull, session:report, replay) get the shot feedback log: a
 * saved export with --file, otherwise the live database through the Firebase CLI (the owner's login),
 * saved under .rubric/feedback/ (git-ignored: the profiles in it are re-identifiable; LZ_FEEDBACK_OUT
 * puts it elsewhere). Also the --since and --eval filters they share.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { collectSamples } from '../src/feedback/replay.ts';
import type { ShotSample } from '../src/feedback/sample.ts';
import { parseCutoff, parseEvalSplit, type EvalSplit } from '../src/feedback/sessionReport.ts';

const ROOT = resolve(import.meta.dirname, '..');

/** The `/feedback` node via `firebase-tools database:get`; exits 2 with the login hint when that is what is missing. */
export function fetchFeedbackLog(): unknown {
  try {
    const out = execFileSync('npx', ['-y', 'firebase-tools', 'database:get', '/feedback', '--project', 'lazer-shooter', '--instance', 'lazer-shooter-default-rtdb'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out);
  } catch (e) {
    // firebase-tools prints its own errors on stdout; npm's install warnings fill stderr.
    const err = e as { stdout?: string; stderr?: string };
    const msg = `${err.stdout ?? ''}\n${err.stderr ?? String(e)}`.split('\n').filter((l) => !l.startsWith('npm warn')).join('\n');
    if (/login|authenticate|credential|401|403/i.test(msg)) {
      const script = process.env.npm_lifecycle_event ?? 'feedback:pull';
      console.error(`The feedback log is readable only with the project owner's login. Run this once, approve in the browser, then run npm run ${script} again:\n\n  npx firebase-tools login\n`);
    } else console.error(msg.trim().slice(-2000));
    process.exit(2);
  }
}

/** A command line the feedback scripts cannot read: say why on stderr and exit 2, before anything is fetched or printed. */
export function usageError(message: string): never {
  console.error(message);
  process.exit(2);
}

/** The value after `name`; null when the flag is absent, a usage error when it is the last word or followed by another flag. */
export function optValue(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) usageError(`${name} needs a value`);
  return v;
}

/**
 * `--since` (ignore rounds that started before it) and `--eval` (hold out the rounds from it on) as
 * every feedback script reads them: the same dates, local midnight for a bare date
 * (src/feedback/sessionReport.ts parseCutoff and parseEvalSplit). A value that cannot be read is a
 * usage error, never an empty filter that lets the report pass.
 */
export function readRoundFilters(args: string[]): { since: number; split: EvalSplit | null } {
  const sinceArg = optValue(args, '--since');
  const evalArg = optValue(args, '--eval');
  try {
    let since = 0;
    if (sinceArg !== null) {
      const cut = parseCutoff(sinceArg, '--since');
      if (!cut) throw new Error(`--since: cannot read ${sinceArg}: give a date (2026-09-26, local midnight), a date-time, epoch milliseconds or a round key`);
      since = cut.t;
    }
    return { since, split: evalArg !== null ? parseEvalSplit(evalArg) : null };
  } catch (e) {
    return usageError((e as Error).message);
  }
}

/** The samples a tuning tool may look at: every one outside the held-out rounds, and a line saying how many were left out. */
export function tuningSamples<T extends ShotSample>(samples: T[], split: EvalSplit | null): { samples: T[]; note: string | null } {
  if (!split) return { samples, note: null };
  const held = samples.filter((s) => split.isEval(s));
  const rounds = new Set(held.map((s) => s.round.key)).size;
  return {
    samples: samples.filter((s) => !split.isEval(s)),
    note: `held out for evaluation, not tuned on: ${held.length} sample${held.length === 1 ? '' : 's'} from ${rounds} round${rounds === 1 ? '' : 's'}, the ${split.describe}; npm run session:report -- --eval reports them`,
  };
}

/** The export in `file`, or a fresh pull (saved under .rubric/feedback/) when there is none. */
export function loadFeedback(file: string | null): unknown {
  if (file) return JSON.parse(readFileSync(file, 'utf8'));
  const data = fetchFeedbackLog();
  const dir = process.env.LZ_FEEDBACK_OUT ? resolve(process.env.LZ_FEEDBACK_OUT) : join(ROOT, '.rubric', 'feedback');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `feedback-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify(data));
  // stderr: stdout is the report, and with --json it must be nothing but the JSON.
  console.error('saved', out);
  return data;
}

/** Every sample of real play or practice in the log; probe and test rounds (TEST-...) are not play. */
export function playSamples(data: unknown, sinceMs = 0): ShotSample[] {
  return collectSamples(data).filter((s) => !s.round.key.startsWith('TEST-') && s.round.startAt >= sinceMs);
}
