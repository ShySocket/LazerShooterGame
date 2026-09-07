import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';

/**
 * The Firebase web config is public by design: it ships inside the browser bundle and access is
 * governed by the database rules, not by this key. Committing it means deployments need no
 * environment variables at all. Environment variables still override, so a fork can point at its
 * own project by setting VITE_FIREBASE_* without editing code.
 */
const DEFAULTS = {
  apiKey: 'AIzaSyC3YT-Iwv-Eo6hstyhVMm7HqRMiHDc4hdg',
  authDomain: 'lazer-shooter.firebaseapp.com',
  databaseURL: 'https://lazer-shooter-default-rtdb.firebaseio.com',
  projectId: 'lazer-shooter',
  appId: '1:1065834869406:web:86d05d797698821fd3818f',
};

/** Env values that are empty or visibly mangled (a masked paste such as "AIzaSyC3•••") are ignored. */
function pick(envValue: string | undefined, fallback: string): string {
  const v = envValue?.trim();
  if (!v || /[^\x20-\x7e]/.test(v)) return fallback;
  return v;
}

export const firebaseConfig = {
  apiKey: pick(import.meta.env.VITE_FIREBASE_API_KEY, DEFAULTS.apiKey),
  authDomain: pick(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN, DEFAULTS.authDomain),
  databaseURL: pick(import.meta.env.VITE_FIREBASE_DATABASE_URL, DEFAULTS.databaseURL),
  projectId: pick(import.meta.env.VITE_FIREBASE_PROJECT_ID, DEFAULTS.projectId),
  appId: pick(import.meta.env.VITE_FIREBASE_APP_ID, DEFAULTS.appId),
};

/** Local mode (one phone, no network) is opted into explicitly with VITE_LOCAL_MODE=1. */
export function hasFirebaseConfig(): boolean {
  return import.meta.env.VITE_LOCAL_MODE !== '1' && Boolean(firebaseConfig.databaseURL);
}

/** One Firebase app shared by the database and auth modules. */
export function firebaseApp(): FirebaseApp {
  const existing = getApps()[0];
  if (existing) return existing;
  return initializeApp(firebaseConfig);
}
