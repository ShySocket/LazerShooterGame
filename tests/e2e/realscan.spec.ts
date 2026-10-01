import { test, expect, chromium, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { closeAll, openPhone } from './helpers';

/**
 * The enrolment face scan with the real models on real people (?e2e&vision): a real interview clip
 * is the selfie camera and the real Scanner runs. A talker never performs every prompt (one side,
 * one tilt), so this also proves no prompt dead-ends: patience takes the best right-way frame and
 * the test taps Skip this angle whenever it appears. Two people in the selfie frame must never give
 * a sample. Needs `npm run fixtures`.
 */
const ROOT = resolve(import.meta.dirname, '..', '..');
const CLIPS = join(ROOT, 'fixtures', 'real', 'clips');
const OUT = join(ROOT, '.rubric', 'realcheck');

function y4m(name: string, parts: [clip: string, start: number, dur: number][]): string {
  const out = join(OUT, `${name}.y4m`);
  if (existsSync(out)) return out;
  mkdirSync(OUT, { recursive: true });
  const inputs = parts.flatMap(([clip, start, dur]) => ['-ss', String(start), '-t', String(dur), '-i', join(CLIPS, `${clip}.mp4`)]);
  const filter = parts.map((_, i) => `[${i}:v]fps=10,scale=640:360,setsar=1[v${i}]`).join(';') + ';' + parts.map((_, i) => `[v${i}]`).join('') + `concat=n=${parts.length}:v=1:a=0[out]`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', filter, '-map', '[out]', '-pix_fmt', 'yuv420p', out]);
  return out;
}

/** Drive the face stage: tap Skip when offered, record every hint, stop when the body stage shows or time runs out. */
async function runFaceStage(page: Page, timeoutMs: number): Promise<{ done: boolean; hints: string[]; faces: number }> {
  const hints: string[] = [];
  const t0 = Date.now();
  let faces = 0;
  while (Date.now() - t0 < timeoutMs) {
    if (await page.getByRole('button', { name: 'A friend is holding it' }).isVisible().catch(() => false)) return { done: true, hints, faces: 8 };
    const heading = (await page.locator('h2').first().textContent().catch(() => '')) ?? '';
    const m = heading.match(/Face (\d) of 8/);
    if (m) faces = Number(m[1]) - 1;
    const hint = (await page.locator('.enroll-panel .hint').first().textContent().catch(() => null)) ?? '';
    if (hint && hints.at(-1) !== hint) hints.push(hint);
    const skip = page.getByRole('button', { name: 'Skip this angle' });
    if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => undefined);
    await page.waitForTimeout(400);
  }
  return { done: false, hints, faces };
}

async function openScan(camera: string) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${camera}`] });
  const phone = await openPhone(browser, 'Scan');
  await phone.page.goto('/?e2e&vision');
  await phone.page.getByPlaceholder('e.g. Sam').fill('Scan');
  await phone.page.getByRole('button', { name: 'Create a room' }).click();
  await phone.page.waitForURL(/room=[A-Z]{4}/);
  await expect(phone.page.getByText('Face 1 of 8')).toBeVisible({ timeout: 60_000 });
  return { browser, phone };
}

test('[real-scan] a real person on the selfie camera completes the eight-angle face scan: no "different face", no dead end', async () => {
  test.skip(!existsSync(join(CLIPS, 'talker-pennington.mp4')), 'needs npm run fixtures');
  test.setTimeout(300_000);
  const { browser, phone } = await openScan(y4m('scan-pennington', [['talker-pennington', 0, 25]]));
  try {
    const r = await runFaceStage(phone.page, 200_000);
    writeFileSync(join(OUT, 'realscan-hints.json'), JSON.stringify(r, null, 1));
    expect(r.hints.filter((h) => /not the face|different face/i.test(h)), r.hints.join(' | ')).toEqual([]);
    expect(r.done, `face stage stuck at sample ${r.faces}; hints: ${r.hints.join(' | ')}`).toBe(true);
  } finally {
    await closeAll([phone]);
    await browser.close();
  }
});

test('[real-scan-two-faces] with two people in the selfie frame no sample is taken and the hint asks for one face', async () => {
  test.skip(!existsSync(join(CLIPS, 'talker-cordeiro.mp4')), 'needs npm run fixtures');
  test.setTimeout(180_000);
  const { browser, phone } = await openScan(y4m('scan-two-faces', [['talker-cordeiro', 0, 20]]));
  try {
    const r = await runFaceStage(phone.page, 25_000);
    writeFileSync(join(OUT, 'realscan-two-faces-hints.json'), JSON.stringify(r, null, 1));
    expect(r.faces, r.hints.join(' | ')).toBe(0);
    expect(r.hints.some((h) => /Only one face/.test(h)), r.hints.join(' | ')).toBe(true);
  } finally {
    await closeAll([phone]);
    await browser.close();
  }
});
