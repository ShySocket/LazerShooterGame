import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';

export function hasFirebaseConfig(): boolean {
  return Boolean(import.meta.env.VITE_FIREBASE_DATABASE_URL);
}

/** One Firebase app shared by the database and auth modules. */
export function firebaseApp(): FirebaseApp {
  const existing = getApps()[0];
  if (existing) return existing;
  return initializeApp({
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  });
}
