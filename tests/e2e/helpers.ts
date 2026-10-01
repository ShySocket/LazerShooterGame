import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { Room } from '../../src/types';

/** One simulated phone: its own browser context (own localStorage, own player id). */
export interface Phone {
  ctx: BrowserContext;
  page: Page;
  name: string;
  pid: string;
  /** Console errors and uncaught exceptions seen on this phone. */
  errors: string[];
}

declare global {
  interface Window {
    __lzE2E: {
      pid: () => string | null;
      code: () => string | null;
      room: (code?: string) => Promise<Room | null>;
      enroll: (seed: number, twin?: number) => Promise<void>;
      enrollFromImages: (urls: string[], seed: number) => Promise<number>;
      hit: (shooter: string, target: string) => Promise<string>;
      deleteRoom: (code: string) => Promise<void>;
      shots: () => string[];
      endRound: () => Promise<string>;
    };
  }
}

/** Dev-server noise that is not an app error. */
const IGNORED = [/\[vite\]/, /favicon/, /WebSocket/, /net::ERR_/];

export async function openPhone(browser: Browser, name: string, opts: { camera?: boolean } = {}): Promise<Phone> {
  const ctx = await browser.newContext({ permissions: opts.camera === false ? [] : ['camera'] });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = `${msg.text()} (${msg.location().url})`;
    if (!IGNORED.some((re) => re.test(text))) errors.push(`${name}: ${text}`);
  });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  return { ctx, page, name, pid: '', errors };
}

async function readPid(phone: Phone): Promise<string> {
  const pid = await phone.page.evaluate(() => localStorage.getItem('lz:pid'));
  if (!pid) throw new Error(`${phone.name} has no player id`);
  phone.pid = pid;
  return pid;
}

/** From the Home screen: type the name and create a room. Resolves to the code once the enrol screen shows. */
export async function createRoom(phone: Phone): Promise<string> {
  await phone.page.goto('/?e2e');
  await phone.page.getByPlaceholder('e.g. Sam').fill(phone.name);
  await phone.page.getByRole('button', { name: 'Create a room' }).click();
  await phone.page.waitForURL(/room=[A-Z]{4}/);
  await readPid(phone);
  return new URL(phone.page.url()).searchParams.get('room')!;
}

/** Open the share link (the URL carries the room code), type the name and join. */
export async function joinRoom(phone: Phone, code: string): Promise<void> {
  await phone.page.goto(`/?e2e&room=${code}`);
  await phone.page.getByPlaceholder('e.g. Sam').fill(phone.name);
  await phone.page.getByRole('button', { name: 'Join' }).click();
  await phone.page.waitForURL(/room=[A-Z]{4}/);
  await readPid(phone);
}

/** Replace the camera scans with a synthetic profile; the app then routes to the lobby. `twin` copies another seed's outfit. */
export async function enroll(phone: Phone, seed: number, twin?: number): Promise<void> {
  await expect(phone.page.getByText('Face 1 of 8')).toBeVisible();
  await phone.page.evaluate(([s, t]) => window.__lzE2E.enroll(s, t), [seed, twin] as [number, number | undefined]);
  await expect(phone.page.getByText(/Start game|Waiting for .* to start/)).toBeVisible();
}

export async function room(phone: Phone, code?: string): Promise<Room> {
  const r = await phone.page.evaluate((c) => window.__lzE2E.room(c ?? undefined), code ?? null);
  if (!r) throw new Error('room not found');
  return r;
}

/** Poll the room until `pred` holds. */
export async function waitForRoom(phone: Phone, pred: (r: Room) => boolean, what: string, timeoutMs = 15_000): Promise<Room> {
  const t0 = Date.now();
  for (;;) {
    const r = await room(phone);
    if (pred(r)) return r;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}: ${JSON.stringify({ status: r.status, players: Object.values(r.players).map((p) => [p.name, p.lives, p.status, p.connected]) })}`);
    await new Promise((res) => setTimeout(res, 200));
  }
}

/** Host taps Start; the round is playing once the 5 s countdown has run. */
export async function startGame(host: Phone): Promise<void> {
  await host.page.getByRole('button', { name: 'Start game' }).click();
  await waitForRoom(host, (r) => r.status === 'playing', 'the round to start');
}

export async function hit(shooter: Phone, target: Phone): Promise<string> {
  return shooter.page.evaluate(([s, t]) => window.__lzE2E.hit(s, t), [shooter.pid, target.pid]);
}

export async function deleteRoom(phone: Phone, code: string): Promise<void> {
  await phone.page.evaluate((c) => window.__lzE2E.deleteRoom(c), code).catch(() => undefined);
}

export async function closeAll(phones: Phone[]): Promise<void> {
  await Promise.all(phones.map((p) => p.ctx.close().catch(() => undefined)));
}

export const heartsOn = (phone: Phone) => phone.page.locator('.hearts .on');

/** A FIRE press as the game receives it (React listens for pointerdown). */
export async function tapFire(phone: Phone): Promise<void> {
  await phone.page.locator('button.fire').dispatchEvent('pointerdown');
}

export const banner = (phone: Phone) => phone.page.locator('.banner');

export async function shots(phone: Phone): Promise<string[]> {
  return phone.page.evaluate(() => window.__lzE2E.shots());
}

export const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
