import type { RoomBackend } from './backend';
import { FirebaseBackend, hasFirebaseConfig } from './firebase';
import { LocalBackend } from './local';

export const backend: RoomBackend = hasFirebaseConfig() ? new FirebaseBackend() : new LocalBackend();
export type { RoomBackend, HitOutcome } from './backend';
