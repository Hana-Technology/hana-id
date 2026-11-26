// A network's widget inside a partner's page (D934, pieces P11 and P12), in the real windows on the local stack, in
// Chromium, Firefox and WebKit. The partner test app plays the widget (PARTNER_ORIGIN, the vault's parent); a page on
// SITE_B_ORIGIN plays the partner's site and frames it. The app lists both web addresses, the widget's marked
// frame-only.
//
// - P12: the widget works inside the partner's page; opened on its own (top-level), in a window it opens itself, inside
//   a page the app doesn't list, inside a sandboxed frame without its own origin, or inside a data: frame, the vault answers
//   nothing (`vault_unavailable`, `no_answer`), exactly as for any web address the app doesn't list. Where the browser
//   names every ancestor (`location.ancestorOrigins`), a widget framed by its own address at the top is refused too.
// - P11: the sign-in window and the approval window say "You're on {partner page}. This uses a widget from {widget}."
//   (an about:blank/srcdoc frame in between is the partner page's own and changes nothing).
// The same browser without `ancestorOrigins` (Firefox with it turned off, as Firefox releases before it shipped) is
// widget-frames-no-ancestors.spec.ts.
//
// With HANA_SHOTS_DIR=<dir> (Chromium) the framed sign-in and approval windows are saved at 1280 and 390 px, light.
import type { Page } from '@playwright/test';
import { DEMO_ORIGIN } from '../src/stack.ts';
import { expect, fontsLoaded, newApp, partnerUrl, test } from './fixtures.ts';
import { PAGE, WIDGET, approvalWindow, finishSignIn, neverReady, partnerPage, readyOf, signInWindow, widget, widgetApp } from './widget-steps.ts';

const SHOTS = process.env.HANA_SHOTS_DIR;

const lines = (popup: Page, sel: string) => popup.locator(`${sel} > p`).allTextContents().then((t) => t.map((x) => x.replace(/\s+/gu, ' ').trim()));

async function shoot(popup: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await fontsLoaded(popup);
  for (const [w, label] of [
    [1280, 'desktop'],
    [390, 'phone'],
  ] as const) {
    await popup.setViewportSize({ width: w, height: 900 });
    await popup.emulateMedia({ colorScheme: 'light' });
    await popup.screenshot({ path: `${SHOTS}/${name}-${label}.png`, fullPage: true });
  }
}

test.describe('P12: the widget’s web address only inside the partner’s page', () => {
  test('inside the partner’s page it works: the sign-in and approval windows name the partner’s page and the widget (P11)', async ({ page, browserName }) => {
    const app = await widgetApp();
    await partnerPage(page, PAGE, partnerUrl(app));
    const f = await widget(page);
    expect((await readyOf(f)).ready).toBe('ok');
    const signIn = await signInWindow(page, f);
    // Chromium, WebKit and this Firefox name every ancestor: the window names the page in the address bar.
    expect(await lines(signIn, '.asker-framed')).toEqual([`Signing in to Coffee Club at ${PAGE}`, `This uses a widget from ${WIDGET}.`]);
    if (browserName === 'chromium') await shoot(signIn, 'e2e-sign-in-framed');
    await finishSignIn(f, signIn);
    const approval = await approvalWindow(page, f);
    expect(await lines(approval, 'header.app')).toEqual(['From Coffee Club', `You’re on ${PAGE}.`, `This uses a widget from ${WIDGET}.`]);
    if (browserName === 'chromium') await shoot(approval, 'e2e-approval-framed');
    await approval.getByRole('button', { name: 'Reject', exact: true }).click();
  });

  test('opened on its own (top-level), the widget’s address is refused as any address the app doesn’t list: vault_unavailable, no_answer', async ({ page }) => {
    const app = await widgetApp();
    await page.goto(partnerUrl(app));
    await page.waitForFunction(() => (window as any).e2e?.ready !== 'pending' && (window as any).e2e?.ready !== undefined, null, { timeout: 15_000 });
    const top = await page.evaluate(() => ({ ready: (window as any).e2e.ready, error: (window as any).e2e.readyError, reason: (window as any).e2e.readyErrorReason }));
    // The same answer as an app that doesn't list the page at all (origins.spec.ts): nothing says which rule refused it.
    const unlisted = await newApp({ origins: [PAGE] });
    const other = await page.context().newPage();
    await other.goto(partnerUrl(unlisted));
    await other.waitForFunction(() => (window as any).e2e?.ready !== 'pending' && (window as any).e2e?.ready !== undefined, null, { timeout: 15_000 });
    const refused = await other.evaluate(() => ({ ready: (window as any).e2e.ready, error: (window as any).e2e.readyError, reason: (window as any).e2e.readyErrorReason }));
    expect(top).toEqual({ ready: 'error', error: 'vault_unavailable', reason: 'no_answer' });
    expect(refused).toEqual(top);
    // Without the flag the same widget opened on its own works (today's behaviour, every existing address).
    const plain = await widgetApp({ frameOnly: false });
    const third = await page.context().newPage();
    await third.goto(partnerUrl(plain));
    await third.waitForFunction(() => (window as any).e2e?.ready !== 'pending' && (window as any).e2e?.ready !== undefined, null, { timeout: 15_000 });
    expect(await third.evaluate(() => (window as any).e2e.ready)).toBe('ok');
  });

  test('a window the framed widget opens on its own address (top-level) is refused', async ({ page }) => {
    const app = await widgetApp();
    await partnerPage(page, PAGE, partnerUrl(app));
    const f = await widget(page);
    expect((await readyOf(f)).ready).toBe('ok');
    const popupP = page.waitForEvent('popup');
    await f.evaluate((url) => (window as any).e2e.openWindow(url), partnerUrl(app));
    const popup = await popupP;
    await popup.waitForFunction(() => (window as any).e2e?.ready !== 'pending' && (window as any).e2e?.ready !== undefined, null, { timeout: 15_000 });
    expect(await popup.evaluate(() => (window as any).e2e.readyError)).toBe('vault_unavailable');
  });

  test('inside a page the app doesn’t list, a sandboxed frame without its origin, or a data: frame: refused', async ({ page }) => {
    // An app that lists the widget (frame-only) and another page, not this one.
    const elsewhere = await newApp({ name: 'Coffee Club', origins: [DEMO_ORIGIN, WIDGET], frameOnly: [WIDGET] });
    await partnerPage(page, PAGE, partnerUrl(elsewhere));
    expect(await readyOf(await widget(page))).toMatchObject({ ready: 'error', error: 'vault_unavailable' });
    const app = await widgetApp();
    for (const mode of ['sandbox', 'data'] as const) {
      await partnerPage(page, PAGE, partnerUrl(app), mode);
      // The widget's page may not get far without an origin of its own (storage refused); it never gets a vault.
      expect(await neverReady(page), mode).not.toBe('ok');
    }
  });

  test('a srcdoc frame of the partner’s page in between changes nothing: it works and names the partner’s page', async ({ page }) => {
    const app = await widgetApp();
    await partnerPage(page, PAGE, partnerUrl(app), 'srcdoc');
    const f = await widget(page);
    expect((await readyOf(f)).ready).toBe('ok');
    const signIn = await signInWindow(page, f);
    expect(await lines(signIn, '.asker-framed')).toEqual([`Signing in to Coffee Club at ${PAGE}`, `This uses a widget from ${WIDGET}.`]);
    await signIn.close();
  });

  test('the widget framed by a page of its own address at the top is refused where the browser names every ancestor', async ({ page }) => {
    const app = await widgetApp();
    await partnerPage(page, WIDGET, partnerUrl(app));
    const f = await widget(page);
    expect(await readyOf(f)).toMatchObject({ ready: 'error', error: 'vault_unavailable' });
  });
});
