import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { accessToken, serviceAccountFromEnv, signedAssertion } from '../scripts/feedback-rest';
import { exportFeedback } from './sim/feedbackExport';

const ROOT = resolve(import.meta.dirname, '..');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const TOKEN = 'test-access-token';

/** A stand-in for Google's token endpoint and the Realtime Database REST API. */
async function fakeGoogle(feedback: unknown): Promise<{ server: Server; base: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push(`${req.method} ${req.url}`);
      if (req.url === '/token' && req.method === 'POST') {
        const jwt = new URLSearchParams(body).get('assertion') ?? '';
        const [h, p, s] = jwt.split('.');
        const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url'));
        const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
        if (!ok || claims.iss !== 'tuner@test.iam' || !/firebase\.database/.test(claims.scope)) {
          res.writeHead(401).end('bad assertion');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: TOKEN }));
      } else if (req.url === '/feedback.json') {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) res.writeHead(401).end('{"error":"Permission denied"}');
        else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(feedback));
      } else res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${port}`, requests };
}

function run(args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', './tests/register.mjs', ...args], { cwd: ROOT, env: { ...process.env, PATH: '/nonexistent', ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

test('the key is read from FIREBASE_SA_KEY or the file GOOGLE_APPLICATION_CREDENTIALS names, and its assertion verifies', () => {
  assert.equal(serviceAccountFromEnv({}), null);
  const key = serviceAccountFromEnv({ FIREBASE_SA_KEY: JSON.stringify({ client_email: 'a@b', private_key: PEM }) })!;
  assert.equal(key.client_email, 'a@b');
  assert.throws(() => serviceAccountFromEnv({ FIREBASE_SA_KEY: '{"client_email":"a@b"}' }), /private_key/);
  const [h, p, s] = signedAssertion(key, 1000).split('.');
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url')));
  assert.equal(JSON.parse(Buffer.from(p, 'base64url').toString()).exp, 4600);
});

test('feedback:pull reads the log over REST with a service account, no firebase-tools on PATH', async () => {
  const data = await exportFeedback({ seeds: [1], filter: ['duel-close'] });
  const g = await fakeGoogle(data);
  const out = mkdtempSync(join(tmpdir(), 'pull-'));
  try {
    const key = JSON.stringify({ client_email: 'tuner@test.iam', private_key: PEM, token_uri: `${g.base}/token` });
    assert.equal(await accessToken(JSON.parse(key)), TOKEN);
    const r = await run(['scripts/feedback-pull.ts'], { FIREBASE_SA_KEY: key, LZ_FEEDBACK_DB_URL: g.base, LZ_FEEDBACK_OUT: out });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(g.requests.includes('GET /feedback.json'), g.requests.join(', '));
    assert.ok(!g.requests.some((u) => u.includes(TOKEN)), 'the token never travels in a URL');
    assert.equal(readdirSync(out).length, 1, 'the pull is saved');
    // A key the database does not accept is an error with exit code 2, not an empty report.
    const bad = JSON.stringify({ client_email: 'someone@else', private_key: PEM, token_uri: `${g.base}/token` });
    const r2 = await run(['scripts/feedback-pull.ts'], { FIREBASE_SA_KEY: bad, LZ_FEEDBACK_DB_URL: g.base, LZ_FEEDBACK_OUT: out });
    assert.equal(r2.status, 2);
    assert.match(r2.stderr, /token exchange failed: HTTP 401/);
  } finally {
    g.server.close();
    rmSync(out, { recursive: true, force: true });
  }
});
