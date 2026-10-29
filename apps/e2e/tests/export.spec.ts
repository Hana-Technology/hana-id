// Key export (docs/batch-b-spec.md "Key export"): the launcher opens a top-level window on authOrigin, which signs in
// again through its own export-mode child popup (`max_age=0`), derives the key itself and shows it only there, behind
// a typed confirmation and a held button. The key never crosses postMessage; the test reads it off the export window
// and checks it opens the vault's address.
import { addressOfExport } from '@hana-id/core';
import { AUTH_ORIGIN } from '../src/stack.ts';
import { LOGIN_ENDPOINT, chooseAccount, clickLauncher, expect, login, newApp, okValue, openPartner, runAction, test } from './fixtures.ts';

for (const chain of ['stellar', 'evm'] as const) {
  test(`export completes for ${chain} through the export-mode child popup`, async ({ page, google, requests }) => {
    const app = await newApp();
    await openPartner(page, app);
    const addresses = await login(page);
    const loginsBefore = requests.count(LOGIN_ENDPOINT);

    await runAction(page, 'export', 'exportKey', chain);
    const exportWindow = await clickLauncher(page, 'Export key in Hana');
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
    await exportWindow.getByRole('button', { name: 'Continue' }).click();
    const hold = exportWindow.getByRole('button', { name: 'Hold to show the key' });
    const secret = exportWindow.locator('code.secret');
    await expect(secret).toHaveText('••••••••');
    await hold.hover();
    await exportWindow.mouse.down();
    const shown = (await secret.textContent()) ?? '';
    await exportWindow.mouse.up();
    await expect(secret).toHaveText('••••••••');

    expect(shown).toMatch(chain === 'stellar' ? /^S[A-Z2-7]{55}$/u : /^0x[0-9a-f]{64}$/u);
    expect(addressOfExport(chain, shown)).toBe(addresses[chain]);
    // One more login, made by the export window itself (the vault's cached key is never used for export).
    expect(requests.count(LOGIN_ENDPOINT)).toBe(loginsBefore + 1);
  });
}
