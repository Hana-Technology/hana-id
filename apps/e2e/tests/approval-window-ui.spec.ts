// The approval window's whole addresses, its account's Copy and the line under Approve, in a real browser (D876,
// D878), Chromium only (clipboard permissions are Chromium's in Playwright): the counterparty row's value is the exact
// address on whole lines at a phone's width; Copy puts exactly the account on the clipboard and says "Copied"; the
// line under the buttons appears, changes and goes without moving Reject or Approve.
import { type Page } from '@playwright/test';
import { EVM_CHAIN_ID } from '../src/stack.ts';
import { approve, clickLauncher, expect, login, newApp, openPartner, runAction, test } from './fixtures.ts';

const RECIPIENT = '0x000000000000000000000000000000000000dEaD';
const PHONE = { width: 390, height: 844 } as const;
const evmTx = () => ({ type: '0x2', chainId: `0x${EVM_CHAIN_ID.toString(16)}`, nonce: '0x0', gas: '0x186a0', maxFeePerGas: '0x3b9aca00', maxPriorityFeePerGas: '0x1', to: RECIPIENT, value: `0x${(10n ** 16n).toString(16)}`, data: '0x' });

async function popupFor(page: Page): Promise<Page> {
  await runAction(page, 'send', 'ethSignTx', evmTx());
  const popup = await clickLauncher(page, 'Review in Journear Passport');
  await expect(popup.locator('h2.summary-headline')).toBeVisible();
  return popup;
}

/** The rendered lines of an element's text, by the top of each of its characters' boxes. */
const lineTexts = (popup: Page, selector: string) =>
  popup.locator(selector).evaluate((el) => {
    const range = document.createRange();
    const lines = new Map<number, string>();
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const t = n.textContent ?? '';
      for (let i = 0; i < t.length; i++) {
        range.setStart(n, i);
        range.setEnd(n, i + 1);
        const top = Math.round(range.getBoundingClientRect().top);
        lines.set(top, (lines.get(top) ?? '') + t[i]);
      }
    }
    return [...lines.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  });

test.describe('the approval window in a real browser (D876, D878)', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium: clipboard permissions');

  test('the To row is one line at 390 px; Copy copies exactly the account; the line under Approve never moves the buttons', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openPartner(page, await newApp());
    const { evm } = await login(page);
    const popup = await popupFor(page);
    await popup.setViewportSize(PHONE);

    // The counterparty row: the exact address, on one line at a phone's width (label above it).
    const to = popup.locator('h2.summary-headline + dl.id-rows dd code.id-full');
    await expect(to).toHaveText(RECIPIENT);
    expect(await lineTexts(popup, 'h2.summary-headline + dl.id-rows dd code.id-full')).toEqual([RECIPIENT]);

    // The line under the buttons: "One moment…", then the mouse line, then nothing; the buttons never move.
    const approveBtn = popup.getByRole('button', { name: 'Approve', exact: true });
    const rejectBtn = popup.getByRole('button', { name: 'Reject', exact: true });
    const line = popup.locator('p.guard-hint');
    const boxes = async () => [await approveBtn.boundingBox(), await rejectBtn.boundingBox()];
    // After the window's opening rise (an animation, not the line).
    await popup.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    await expect(line).toHaveText(/^(One moment…|Approve turns on when you move your mouse\.)$/u);
    const first = await boxes();
    await expect(line).toHaveText('Approve turns on when you move your mouse.');
    expect(await boxes()).toEqual(first);
    await expect(approveBtn).toBeDisabled();
    await expect(approveBtn).toHaveAttribute('aria-describedby', 'guard-hint');

    // Copy, in the details: exactly the account on the clipboard, "Copied" beside it; nothing below it moves.
    await popup.locator('details.request-details > summary').first().click();
    const before = await boxes();
    await popup.locator('button.copy-account').click();
    await expect(popup.locator('dl.your-account .account-copy-status')).toHaveText('Copied');
    expect(await popup.evaluate(() => navigator.clipboard.readText())).toBe(evm);
    expect(await boxes()).toEqual(before);
    // The account's own row: the exact address, its lines whole groups (no lone character).
    const account = await lineTexts(popup, 'dl.your-account code.id-full');
    expect(account.join('')).toBe(evm);
    for (const l of account) expect(l.length >= 4 || account.length === 1).toBe(true);

    // The pointer moved on the way to Copy: Approve is on and the line is gone, with the buttons where they were.
    await expect(approveBtn).toBeEnabled();
    await expect(line).toHaveText('');
    expect(await boxes()).toEqual(before);
    await approve(popup);
  });
});
