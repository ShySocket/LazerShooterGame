import { test, expect, chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { closeAll, deleteRoom, hit, openPhone, room, tapFire, waitForRoom, type Phone } from './helpers';

/**
 * A whole round with the real models on real footage (?e2e&vision): the shooter's camera is a real
 * clip of one person (Chrome's file-fed fake camera), that person is enrolled from her own frames by
 * the real models, a second real person is enrolled as a distractor, and the shooter keeps firing
 * at the middle of the frame. The hit must land on her and never on anyone else, then Results.
 * Needs the fixtures from `npm run fixtures` (skipped without them).
 */
const ROOT = resolve(import.meta.dirname, '..', '..');
const FIX = join(ROOT, 'fixtures', 'real');
const TARGET_CLIP = 'talker-pennington';
const OTHER_CLIP = 'talker-cordeiro';

function frames(clip: string): string[] {
  const dir = join(FIX, 'frames', `${clip}@5`);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    execFileSync('ffmpeg', ['-v', 'error', '-i', join(FIX, 'clips', `${clip}.mp4`), '-vf', 'fps=5', '-q:v', '2', join(dir, '%04d.jpg')]);
  }
  // The first 6 s, as the realcheck clips stage enrols.
  return readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort().slice(0, 30).map((f) => `/__fixtures/frames/${clip}@5/${f}`);
}

function cameraFile(clip: string): string {
  const out = join(ROOT, '.rubric', 'realcheck', `${clip}.y4m`);
  if (!existsSync(out)) {
    mkdirSync(join(ROOT, '.rubric', 'realcheck'), { recursive: true });
    // After the enrolment window, 12 s at 10 fps; Chrome loops it.
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '8', '-t', '12', '-i', join(FIX, 'clips', `${clip}.mp4`), '-vf', 'fps=10', '-pix_fmt', 'yuv420p', out]);
  }
  return out;
}

async function serveFixtures(phone: Phone): Promise<void> {
  await phone.ctx.route('**/__fixtures/**', (route) => {
    const file = join(FIX, decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/__fixtures\//, '')));
    if (!file.startsWith(FIX) || !existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ body: readFileSync(file), contentType: 'image/jpeg' });
  });
}

async function joinAs(phone: Phone, code: string | null): Promise<string> {
  await phone.page.goto(code ? `/?e2e&vision&room=${code}` : '/?e2e&vision');
  await phone.page.getByPlaceholder('e.g. Sam').fill(phone.name);
  await phone.page.getByRole('button', { name: code ? 'Join' : 'Create a room' }).click();
  await phone.page.waitForURL(/room=[A-Z]{4}/);
  phone.pid = (await phone.page.evaluate(() => localStorage.getItem('lz:pid')))!;
  await expect(phone.page.getByText('Face 1 of 8')).toBeVisible({ timeout: 60_000 });
  return new URL(phone.page.url()).searchParams.get('room')!;
}

test('[real-vision-round] real models on a real clip: the person in front of the camera is hit, nobody else, then Results', async ({ browser }) => {
  test.skip(!existsSync(join(FIX, 'clips', `${TARGET_CLIP}.mp4`)) || !existsSync(join(FIX, 'clips', `${OTHER_CLIP}.mp4`)), 'needs npm run fixtures');
  test.setTimeout(300_000);
  const shooterBrowser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${cameraFile(TARGET_CLIP)}`],
  });
  const shooter = await openPhone(shooterBrowser, 'Shooter');
  const target = await openPhone(browser, 'Raquel');
  const other = await openPhone(browser, 'Janaina');
  const phones = [shooter, target, other];
  let code = '';
  try {
    for (const p of phones) await serveFixtures(p);
    code = await joinAs(shooter, null);
    await joinAs(target, code);
    await joinAs(other, code);
    // The shooter never appears in frame: a synthetic profile is only a decoy candidate.
    await shooter.page.evaluate(() => window.__lzE2E.enroll(1));
    expect(await target.page.evaluate((u) => window.__lzE2E.enrollFromImages(u, 2), frames(TARGET_CLIP))).toBe(8);
    expect(await other.page.evaluate((u) => window.__lzE2E.enrollFromImages(u, 3), frames(OTHER_CLIP))).toBe(8);
    await expect(shooter.page.getByRole('button', { name: 'Start game' })).toBeEnabled({ timeout: 30_000 });
    await shooter.page.getByRole('button', { name: 'Start game' }).click();
    await waitForRoom(shooter, (r) => r.status === 'playing', 'the round to start', 30_000);
    const lives = (await room(shooter)).players[target.pid].lives;
    // Fire at the middle of the frame, where she is, until a hit registers (the models warm up first).
    let hitTarget = false;
    for (let i = 0; i < 40 && !hitTarget; i++) {
      await tapFire(shooter);
      await shooter.page.waitForTimeout(1500);
      const r = await room(shooter);
      expect(r.players[other.pid].lives, 'the distractor must never be hit').toBe(lives);
      expect(r.players[shooter.pid].lives).toBe(lives);
      hitTarget = r.players[target.pid].lives < lives;
    }
    expect(hitTarget, `no hit on the person in frame; shots: ${JSON.stringify(await shooter.page.evaluate(() => window.__lzE2E.shots()))}`).toBe(true);
    // Finish the round through the backend (the vision part is proven) and check everybody reaches Results.
    // A player hit a moment ago is invulnerable for 3 s: retry until each is out.
    for (const p of [target, other]) {
      for (let tries = 0; tries < 20 && (await room(shooter)).players[p.pid].lives > 0; tries++) {
        if ((await hit(shooter, p)) === 'invulnerable') await shooter.page.waitForTimeout(1000);
      }
    }
    await waitForRoom(shooter, (r) => r.status === 'ended', 'the round to end', 30_000);
    for (const p of phones) await expect(p.page.getByText(/wins|Winner|Results|Play again/i).first()).toBeVisible({ timeout: 30_000 });
  } finally {
    if (code) await deleteRoom(shooter, code);
    await closeAll(phones);
    await shooterBrowser.close();
  }
});
