/**
 * Where the feedback scripts (feedback:pull, session:report) get the shot feedback log: a saved
 * export with --file, otherwise the live database through the Firebase CLI (the owner's login), saved
 * under .rubric/feedback/ (git-ignored: the profiles in it are re-identifiable).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { collectSamples } from '../src/feedback/replay.ts';
import type { ShotSample } from '../src/feedback/sample.ts';

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

/** The export in `file`, or a fresh pull (saved under .rubric/feedback/) when there is none. */
export function loadFeedback(file: string | null): unknown {
  if (file) return JSON.parse(readFileSync(file, 'utf8'));
  const data = fetchFeedbackLog();
  const dir = join(ROOT, '.rubric', 'feedback');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `feedback-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify(data));
  console.log('saved', out);
  return data;
}

/** Every sample of real play or practice in the log; probe and test rounds (TEST-...) are not play. */
export function playSamples(data: unknown, sinceMs = 0): ShotSample[] {
  return collectSamples(data).filter((s) => !s.round.key.startsWith('TEST-') && s.round.startAt >= sinceMs);
}
