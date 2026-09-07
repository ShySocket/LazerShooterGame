import type { RoomBackend } from './backend';
import { FirebaseBackend, hasFirebaseConfig } from './firebase';
import { LocalBackend } from './local';

export const backend: RoomBackend = hasFirebaseConfig() ? new FirebaseBackend() : new LocalBackend();

/** Local mode is a one-phone test bench, so a round may start and end with a single player. */
export const MIN_PLAYERS = backend.mode === 'local' ? 1 : 2;

export type { RoomBackend, HitOutcome, JoinResult } from './backend';
