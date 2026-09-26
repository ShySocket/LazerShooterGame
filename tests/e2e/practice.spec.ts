import { test, expect, chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { closeAll, openPhone, tapFire } from './helpers';

/**
 * Practice mode on one phone with the real models (?practice&e2e&vision): the camera is a real clip
 * of one person; she is added as a target with the lobby's Capture button, the round starts with
 * only the shooter enrolled, the shooter picks her as the aim and fires until the verdict says it
 * was right, never wrong, and the labelled shot lands in the feedback log (kept in memory in tests).
 */
const ROOT = resolve(import.meta.dirname, '..', '..');
const CLIP = join(ROOT, 'fixtures', 'real', 'clips', 'talker-pennington.mp4');

function cameraFile(): string {
  const out = join(ROOT, '.rubric', 'realcheck', 'talker-pennington.y4m');
  if (!existsSync(out)) {
    mkdirSync(join(ROOT, '.rubric', 'realcheck'), { recursive: true });
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '8', '-t', '12', '-i', CLIP, '-vf', 'fps=10', '-pix_fmt', 'yuv420p', out]);
  }
  return out;
}

test('[practice-solo] one phone: capture a target, aim at her, the verdict is right and the shot is logged with its label', async () => {
  test.skip(!existsSync(CLIP), 'needs npm run fixtures');
  test.setTimeout(240_000);
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${cameraFile()}`] });
  const me = await openPhone(browser, 'Sai');
  try {
    await me.page.goto('/?e2e&vision&practice');
    await me.page.getByPlaceholder('e.g. Sam').fill('Sai');
    await me.page.getByRole('button', { name: 'Start practice' }).click();
    await me.page.waitForURL(/room=[A-Z]{4}.*practice/);
    await expect(me.page.getByText('Face 1 of 8')).toBeVisible({ timeout: 60_000 });
    // The shooter's own scan is only a decoy here; the head-turn scan has its own test.
    await me.page.evaluate(() => window.__lzE2E.enroll(1));
    await me.page.getByRole('button', { name: 'Add a target' }).click();
    const capture = me.page.getByRole('button', { name: 'Capture' });
    await expect(capture).toBeEnabled({ timeout: 30_000 });
    await capture.click();
    await expect(me.page.getByText(/Target 1 added/)).toBeVisible({ timeout: 60_000 });
    await me.page.getByRole('button', { name: 'Done' }).click();
    await me.page.getByRole('button', { name: 'Start game' }).click();
    await me.page.getByLabel('Expected range test target').selectOption({ label: 'Target 1' });
    const verdicts: string[] = [];
    for (let i = 0; i < 30 && !verdicts.some((v) => v.startsWith('HIT Target 1')); i++) {
      await tapFire(me);
      await me.page.waitForTimeout(1500);
      const text = await me.page.locator('.banner span').first().textContent().catch(() => null);
      if (text && verdicts.at(-1) !== text) verdicts.push(text);
    }
    expect(verdicts.filter((v) => v.startsWith('WRONG')), verdicts.join(' | ')).toEqual([]);
    expect(verdicts.some((v) => v.startsWith('HIT Target 1 (right)')), verdicts.join(' | ')).toBe(true);
    const logged = await me.page.evaluate(() => (window as unknown as { __lz: { backend: { feedback: { sample: { label?: { kind: string } } }[] } } }).__lz.backend.feedback.map((f) => f.sample.label?.kind));
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.every((k) => k === 'player')).toBe(true);
  } finally {
    await closeAll([me]);
    await browser.close();
  }
});
