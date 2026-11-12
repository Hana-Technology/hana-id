// Key export (docs/batch-b-spec.md "Key export"): the launcher opens a top-level window on authOrigin, which signs in
// again through its own export-mode child popup (`max_age=0`), derives the key itself and shows it only there, behind
// a typed confirmation and the Show key toggle, or copies it on Copy key (D268). The key never crosses postMessage; the
// test reads it off the export window and its clipboard and checks it opens the vault's address.
import { addressOfExport } from '@hana-id/core';
import type { Page } from '@playwright/test';
import { AUTH_ORIGIN } from '../src/stack.ts';
import { LOGIN_ENDPOINT, chooseAccount, clickLauncher, expect, guardedClick, login, newApp, okValue, openPartner, runAction, test } from './fixtures.ts';

for (const chain of ['stellar', 'evm'] as const) {
  test(`export completes for ${chain} through the export-mode child popup`, async ({ page, google, requests, browserName }) => {
    const app = await newApp();
    await openPartner(page, app);
    const addresses = await login(page);
    const loginsBefore = requests.count(LOGIN_ENDPOINT);

    await runAction(page, 'export', 'exportKey', chain);
    const exportWindow = await clickLauncher(page, 'Export key in Journear Passport');
    expect(new URL(exportWindow.url()).origin).toBe(AUTH_ORIGIN);
    expect(new URL(exportWindow.url()).pathname).toBe('/export');
    expect(await okValue(page, 'export')).toBeNull();
    await expect(exportWindow.getByText(addresses[chain])).toBeVisible();

    const childP = exportWindow.waitForEvent('popup');
    await exportWindow.getByRole('button', { name: 'Sign in with Google to continue' }).click();
    const child = await childP;
    expect(new URL(child.url()).search).toBe('?mode=export');
    await chooseAccount(child);
    // The export's own Google request asked for a fresh sign-in.
    expect(google.requests.at(-1)).toMatchObject({ ok: true, request: { maxAge: '0' } });

    await exportWindow.getByRole('textbox').fill('EXPORT');
    await guardedClick(exportWindow, 'Continue');
    // Show key / Hide key (D268): one click shows it, and it stays shown (and selectable) until the next click.
    const secret = exportWindow.locator('code.secret');
    await expect(secret).toHaveText('••••••••');
    // The export pattern (D765): Show key (the danger button) and Copy key wait for the user's tick.
    await expect(exportWindow.getByRole('button', { name: 'Show key' })).toBeDisabled();
    await exportWindow.locator('.reveal-ack input').check();
    await guardedClick(exportWindow, 'Show key');
    const keyText = chain === 'stellar' ? /^S[A-Z2-7]{55}$/u : /^0x[0-9a-f]{64}$/u;
    await expect(secret).toHaveText(keyText);
    const shown = (await secret.textContent()) ?? '';
    await exportWindow.mouse.move(0, 0);
    await expect(secret).toHaveText(shown);
    expect(await secret.evaluate((el) => getComputedStyle(el).userSelect || getComputedStyle(el).webkitUserSelect)).toBe('text');
    await exportWindow.getByRole('button', { name: 'Hide key' }).click();
    await expect(secret).toHaveText('••••••••');

    expect(shown).toMatch(keyText);
    expect(addressOfExport(chain, shown)).toBe(addresses[chain]);
    // One more login, made by the export window itself (the vault's cached key is never used for export).
    expect(requests.count(LOGIN_ENDPOINT)).toBe(loginsBefore + 1);

    // Copy key (D268), with the key hidden: the clipboard gets the same string (read by the test; the page never reads).
    const grants = CLIPBOARD_GRANTS[browserName] ?? [];
    if (grants.length > 0) await page.context().grantPermissions([...grants], { origin: AUTH_ORIGIN });
    const copy = exportWindow.getByRole('button', { name: 'Copy key' });
    await copy.click();
    await expect(exportWindow.getByRole('button', { name: 'Copied' })).toBeVisible();
    await expect(exportWindow.locator('.copy-status')).toHaveText('');
    await expect(secret).toHaveText('••••••••');
    await expect.poll(() => readClipboard(exportWindow)).toBe(shown);

    // The erase (here the session's end, on logout) blanks the clipboard while the window has focus. Playwright's
    // Firefox and WebKit allow that write without a user gesture; the shipped browsers may refuse it (D268).
    await runAction(page, 'logout', 'logout');
    await okValue(page, 'logout');
    await expect(exportWindow.getByText('Export ended')).toBeVisible();
    await expect.poll(() => readClipboard(exportWindow)).toBe('');
  });
}

/**
 * What each Playwright browser needs granted for the test to read the clipboard. Chromium takes both; WebKit knows
 * only `clipboard-read`; Firefox knows neither, and Playwright's Firefox lets a page read the clipboard without one.
 */
const CLIPBOARD_GRANTS: Record<string, readonly string[]> = { chromium: ['clipboard-read', 'clipboard-write'], webkit: ['clipboard-read'], firefox: [] };

const readClipboard = (p: Page): Promise<string> => p.evaluate(() => navigator.clipboard.readText());
