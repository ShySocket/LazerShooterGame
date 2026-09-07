import {
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut as fbSignOut,
  type Auth,
  type User,
} from 'firebase/auth';
import { get, getDatabase, ref, set, update } from 'firebase/database';
import type { DeepProfile, UserRecord } from '../types';
import { firebaseApp, hasFirebaseConfig } from './firebaseApp';

export interface Account {
  uid: string;
  name: string;
  email: string | null;
  photo: string | null;
}

let auth: Auth | null = null;
function getAuthInstance(): Auth | null {
  if (!hasFirebaseConfig()) return null;
  if (!auth) auth = getAuth(firebaseApp());
  return auth;
}

export const authAvailable = hasFirebaseConfig();

function toAccount(u: User): Account {
  return { uid: u.uid, name: u.displayName ?? u.email?.split('@')[0] ?? 'Player', email: u.email, photo: u.photoURL };
}

/** Fires with the current account (or null) now and on every change. */
export function onAccount(cb: (a: Account | null) => void): () => void {
  const a = getAuthInstance();
  if (!a) {
    queueMicrotask(() => cb(null));
    return () => undefined;
  }
  // Complete a redirect-based sign-in if one is pending; errors surface through signInGoogle's caller.
  void getRedirectResult(a).catch(() => undefined);
  return onAuthStateChanged(a, (u) => cb(u ? toAccount(u) : null));
}

/** Popup first, which iOS Safari allows from a tap; fall back to a full redirect when the popup is blocked. */
export async function signInGoogle(): Promise<void> {
  const a = getAuthInstance();
  if (!a) throw new Error('Sign-in needs the Firebase config');
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await signInWithPopup(a, provider);
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment' || code === 'auth/cancelled-popup-request') {
      await signInWithRedirect(a, provider);
      return;
    }
    if (code === 'auth/popup-closed-by-user') return;
    if (code === 'auth/configuration-not-found' || code === 'auth/operation-not-allowed') {
      throw new Error('Google sign-in is not switched on in the Firebase console yet. Play as a guest for now.');
    }
    if (code === 'auth/unauthorized-domain') {
      throw new Error(`This site (${location.hostname}) is not in the Firebase authorized domains list yet. Play as a guest for now.`);
    }
    throw e;
  }
}

export async function signOut(): Promise<void> {
  const a = getAuthInstance();
  if (a) await fbSignOut(a);
}

function userRef(uid: string) {
  return ref(getDatabase(firebaseApp()), `users/${uid}`);
}

export async function loadUser(uid: string): Promise<UserRecord | null> {
  const snap = await get(userRef(uid));
  return (snap.val() as UserRecord | null) ?? null;
}

export async function saveUserName(uid: string, name: string): Promise<void> {
  await update(userRef(uid), { name });
}

export async function saveDeep(uid: string, name: string, deep: DeepProfile): Promise<void> {
  await set(userRef(uid), { name, deep } satisfies UserRecord);
}

export async function clearDeep(uid: string): Promise<void> {
  await update(userRef(uid), { deep: null });
}
