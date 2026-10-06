import { test, expect, type Page } from '@playwright/test';
import { closeAll, createRoom, deleteRoom, enroll, joinRoom, startGame, type Phone } from '../e2e/helpers';

/**
 * Phone-native and accessibility contract on every reachable screen: tap targets >= 44 px (or an
 * expanded hit area), inputs >= 16 px so iOS never zooms, text contrast >= 4.5:1 (3:1 for large text)
 * against what it sits on, and a visible keyboard focus ring.
 */
type Finding = { screen: string; what: string; el: string };

async function audit(page: Page, screen: string): Promise<Finding[]> {
  return page.evaluate((screen) => {
    const out: { screen: string; what: string; el: string }[] = [];
    const label = (el: Element) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${(el.textContent ?? '').trim().slice(0, 30)}"`;
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
    };
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = (el: Element | null): number[] | null => {
      for (let e = el; e; e = e.parentElement) {
        const c = rgb(getComputedStyle(e).backgroundColor);
        if (c.length >= 3 && (c[3] ?? 1) > 0.5) return c.slice(0, 3);
        if (e.classList.contains('game') || e.classList.contains('cam-wrap')) return null; // over the camera: plates are checked instead
      }
      return rgb(getComputedStyle(document.body).backgroundColor).slice(0, 3);
    };
    for (const el of document.querySelectorAll('button, a, input, select, summary, [role="radio"]')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const after = getComputedStyle(el, '::after');
      const expanded = after.content !== 'none' && after.position === 'absolute' && parseFloat(after.top) < 0;
      const h = expanded ? r.height - 2 * parseFloat(after.top) : r.height;
      if (h < 43.5 && !(el.closest('.segmented') && r.height >= 40)) out.push({ screen, what: `tap target ${Math.round(h)} px tall`, el: label(el) });
      if (el.tagName === 'INPUT' && parseFloat(getComputedStyle(el).fontSize) < 16) out.push({ screen, what: 'input font < 16 px (iOS zoom)', el: label(el) });
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || seen.has(el) || !(n.textContent ?? '').trim() || !visible(el)) continue;
      seen.add(el);
      const cs = getComputedStyle(el);
      const bg = bgOf(el);
      if (!bg) continue;
      const fg = rgb(cs.color);
      if ((fg[3] ?? 1) < 1 || el.closest('button:disabled, .dim')) continue;
      const [a, b] = [lum(fg.slice(0, 3)), lum(bg)].sort((x, y) => y - x);
      const ratio = (a + 0.05) / (b + 0.05);
      const large = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) out.push({ screen, what: `contrast ${ratio.toFixed(2)}:1`, el: label(el) });
    }
    return out;
  }, screen);
}

test.describe.configure({ mode: 'serial' });
let phones: Phone[] = [];
let code = '';
test.afterAll(async () => {
  if (code && phones[0]) await deleteRoom(phones[0], code);
  await closeAll(phones);
});

test('every screen meets the tap, zoom, contrast and focus contract', async ({ browser }) => {
  test.setTimeout(120_000);
  const mk = async (name: string): Promise<Phone> => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['camera'] });
    return { ctx, page: await ctx.newPage(), name, pid: '', errors: [] };
  };
  const host = await mk('Host');
  const guest = await mk('Riley');
  phones = [host, guest];
  const findings: Finding[] = [];

  await host.page.goto('/?e2e');
  await host.page.waitForSelector('.title');
  findings.push(...(await audit(host.page, 'home')));
  await host.page.keyboard.press('Tab');
  await host.page.keyboard.press('Tab');
  const ring = await host.page.evaluate(() => {
    const el = document.activeElement!;
    return `${getComputedStyle(el).outlineStyle} ${getComputedStyle(el).outlineWidth} on ${el.tagName}.${el.className}`;
  });
  expect(ring, 'keyboard focus shows a ring').not.toMatch(/^none/);

  code = await createRoom(host);
  await expect(host.page.getByText('Face 1 of 8')).toBeVisible();
  findings.push(...(await audit(host.page, 'scan')));
  await enroll(host, 1);
  findings.push(...(await audit(host.page, 'lobby-host')));
  await host.page.locator('.fine-tune summary').click();
  findings.push(...(await audit(host.page, 'lobby-fine-tune')));
  await joinRoom(guest, code);
  await enroll(guest, 2);
  findings.push(...(await audit(guest.page, 'lobby-guest')));
  await startGame(host);
  findings.push(...(await audit(host.page, 'game')));
  await host.page.getByRole('button', { name: 'end round' }).click();
  await expect(host.page.getByRole('button', { name: 'Back to lobby' })).toBeVisible();
  findings.push(...(await audit(host.page, 'results')));

  expect(findings, JSON.stringify(findings, null, 1)).toEqual([]);
});
