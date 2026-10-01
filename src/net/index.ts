import type { RoomBackend } from './backend';
import { FirebaseBackend, hasFirebaseConfig } from './firebase';
import { LocalBackend } from './local';
import { isPractice, PracticeBackend } from './practice';
import { isE2E } from '../e2e/hook';

/**
 * ?practice keeps the room on this phone and sends only the labelled shots to Firebase (the browser
 * tests keep those in memory too); otherwise Firebase when configured, else the one-phone bench.
 */
export const backend: RoomBackend = isPractice()
  ? new PracticeBackend(hasFirebaseConfig() && !isE2E() ? new FirebaseBackend() : null)
  : hasFirebaseConfig()
    ? new FirebaseBackend()
    : new LocalBackend();

export const practiceBackend: PracticeBackend | null = backend instanceof PracticeBackend ? backend : null;

/** Local mode is a one-phone test bench, so a round may start and end with a single player. */
export const MIN_PLAYERS = backend.mode === 'local' ? 1 : 2;

export type { RoomBackend, HitOutcome, JoinResult } from './backend';
