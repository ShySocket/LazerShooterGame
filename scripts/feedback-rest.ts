/**
 * The /feedback node over the Realtime Database REST API with a Google service account, for the
 * nightly tuning job (.github/workflows/tune.yml), where nobody can run `firebase-tools login`.
 * The key comes from FIREBASE_SA_KEY (the JSON itself, as a CI secret holds it) or from the file
 * GOOGLE_APPLICATION_CREDENTIALS names. A signed JWT is exchanged for an OAuth access token with
 * node:crypto and fetch only: no Google SDK. Give the account read access to the database only.
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const DEFAULT_DB_URL = 'https://lazer-shooter-default-rtdb.firebaseio.com';
const SCOPES = 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email';

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** The service-account key from the environment, or null when none is configured. */
export function serviceAccountFromEnv(env: NodeJS.ProcessEnv = process.env): ServiceAccountKey | null {
  const raw = env.FIREBASE_SA_KEY?.trim() || (env.GOOGLE_APPLICATION_CREDENTIALS ? readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8') : '');
  if (!raw) return null;
  const key = JSON.parse(raw) as ServiceAccountKey;
  if (!key.client_email || !key.private_key) throw new Error('service-account key lacks client_email or private_key');
  return key;
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/** A signed RS256 assertion for the OAuth jwt-bearer grant. */
export function signedAssertion(key: ServiceAccountKey, nowS = Math.floor(Date.now() / 1000)): string {
  const aud = key.token_uri ?? 'https://oauth2.googleapis.com/token';
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: key.client_email, scope: SCOPES, aud, iat: nowS, exp: nowS + 3600 }));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key.private_key);
  return `${head}.${body}.${b64url(sig)}`;
}

export async function accessToken(key: ServiceAccountKey): Promise<string> {
  const res = await fetch(key.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedAssertion(key) }),
  });
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('token exchange returned no access_token');
  return json.access_token;
}

/** GET a database URL (…/feedback.json); `token` is sent as a bearer header, never put in the URL. */
export async function fetchJson(url: string, token: string | null): Promise<unknown> {
  const res = await fetch(url, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  if (!res.ok) throw new Error(`GET ${url.replace(/\?.*/, '')} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** The /feedback node with the service account in the environment. */
export async function fetchFeedbackWithServiceAccount(key: ServiceAccountKey, dbUrl = process.env.LZ_FEEDBACK_DB_URL || DEFAULT_DB_URL): Promise<unknown> {
  return fetchJson(`${dbUrl.replace(/\/$/, '')}/feedback.json`, await accessToken(key));
}
