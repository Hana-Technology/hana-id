// The approval popup opened in the partner's click (docs/batch-b-spec.md "Approval flow" step 1, docs/decisions.md
// D95): one click on the partner's "Sign" opens `{authOrigin}/approve?from=partner&v=…` with the request, no launcher;
// a blocked window.open (Safari after an await) falls back to the launcher; sequential requests reuse the window; an
// auto-approved request opens and closes the window without showing anything; and the partner page, which holds the
// window, can't make it show or approve anything.
import { type BrowserContext, type Page } from '@playwright/test';
import { AUTH_ORIGIN, EVM_CHAIN_ID } from '../src/stack.ts';
import { approve, clickAction, clickLauncher, errorCode, expect, login, newApp, okValue, openPartner, test } from './fixtures.ts';

/** Partner-page events of `name` recorded since `since` (the e2e app's event log). */
async function eventsSince(page: Page, name: string, since: number): Promise<unknown[]> {
  return page.evaluate(([n, s]) => ((window as any).e2e.events as { name: string; data: unknown }[]).slice(s as number).filter((e) => e.name === n).map((e) => e.data), [name, since] as const);
}
const eventCount = (page: Page): Promise<number> => page.evaluate(() => (window as any).e2e.events.length as number);

/** Every text and button state each /approve window shows, reported through its console (an init script). */
async function recordApproveUi(context: BrowserContext): Promise<string[]> {
  const seen: string[] = [];
  context.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('hana-e2e-approve-ui:')) seen.push(t.slice('hana-e2e-approve-ui:'.length));
  });
  await context.addInitScript(
    ([auth]) => {
      if (location.origin !== auth || location.pathname !== '/approve') return;
      const report = () => {
        const buttons = [...document.querySelectorAll('button')].map((b) => b.textContent ?? '').join('|');
        console.log(`hana-e2e-approve-ui:${(document.body?.innerText ?? '').replace(/\s+/gu, ' ').trim()}${buttons ? ` [buttons: ${buttons}]` : ''}`);
      };
      new MutationObserver(report).observe(document, { subtree: true, childList: true, characterData: true });
    },
    [AUTH_ORIGIN] as const,
  );
  return seen;
}

test('one click on the partner’s Sign opens the approval popup with the request, with no launcher', async ({ page }) => {
  await openPartner(page, await newApp());
  const { evm } = await login(page);
  const mark = await eventCount(page);

  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'sig', 'personalSign', 'one click');
  const popup = await popupP;
  const url = new URL(popup.url());
  expect(url.origin).toBe(AUTH_ORIGIN);
  expect(url.pathname).toBe('/approve');
  expect(url.searchParams.get('from')).toBe('partner');
  expect(url.searchParams.get('v')).toBe(await page.evaluate(() => (window as any).e2e.vaultFrameName()));
  await expect(popup.getByText('Request 1 of 1', { exact: false })).toBeVisible();
  await expect(popup.getByText('E2E Partner').first()).toBeVisible();
  await approve(popup);
  expect(await okValue(page, 'sig')).toMatchObject({ valid: true });
  expect(evm).toMatch(/^0x/u);
  expect((await eventsSince(page, 'launcher', mark)).filter((e) => (e as { visible: boolean }).visible)).toEqual([]);

  // The Stellar Wallets Kit module path, in the same window (it waits for follow-ups).
  await clickAction(page, 'swk', 'swk2SignTx');
  await expect(popup.getByText('Request 2 of 2', { exact: false })).toBeVisible();
  await approve(popup);
  expect(await okValue(page, 'swk')).toMatchObject({ valid: true });
  expect((await eventsSince(page, 'launcher', mark)).filter((e) => (e as { visible: boolean }).visible)).toEqual([]);
});

test('a blocked approval popup (Safari after an await) falls back to the vault’s launcher', async ({ page }) => {
  await openPartner(page, await newApp(), { blockPopups: 'approve' });
  await login(page);
  let opened = 0;
  page.on('popup', () => {
    opened += 1;
  });
  await clickAction(page, 'sig', 'stellarSignMessage', 'blocked');
  const popup = await clickLauncher(page, 'Review in Hana');
  expect(new URL(popup.url()).search).toBe('');
  await expect(popup.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
  await approve(popup);
  expect(await okValue(page, 'sig')).toBeTruthy();
  expect(opened).toBe(1); // only the launcher's window
});

test('two sequential requests from two clicks reuse the one approval window', async ({ page }) => {
  await openPartner(page, await newApp());
  await login(page);
  let opened = 0;
  page.on('popup', () => {
    opened += 1;
  });
  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'first', 'personalSign', 'first');
  const popup = await popupP;
  await approve(popup);
  expect(await okValue(page, 'first')).toMatchObject({ valid: true });
  await expect(popup.getByText('Waiting for the next request', { exact: false })).toBeVisible();

  await clickAction(page, 'second', 'stellarSignMessage', 'second');
  await expect(popup.getByText('Request 2 of 2', { exact: false })).toBeVisible();
  await approve(popup);
  expect(await okValue(page, 'second')).toBeTruthy();
  expect(opened).toBe(1);

  // Closing it: the next click opens a new one.
  await popup.close();
  await page.waitForTimeout(800); // the vault polls its window every 0.5 s
  const nextP = page.waitForEvent('popup');
  await clickAction(page, 'third', 'personalSign', 'third');
  const next = await nextP;
  await expect(next.getByText('Request 1 of 1', { exact: false })).toBeVisible();
  await next.getByRole('button', { name: 'Reject', exact: true }).click();
  expect(await errorCode(page, 'third')).toBe(4001);
});

const DEPOSIT_CONTRACT = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';
const AUTO_POLICY = {
  v: 1,
  label: 'Deposits',
  maxConsentMs: 3_600_000,
  limits: { perDayCount: 5 },
  evm: {
    chains: [
      {
        chainId: EVM_CHAIN_ID,
        maxValueWei: '100000',
        maxValueWeiPerDay: '1000000',
        maxFeeWei: '100000',
        contracts: [{ address: DEPOSIT_CONTRACT, name: 'Example vault', selectors: [{ selector: '0xb6b55f25', signature: 'deposit(uint256)' }] }],
      },
    ],
  },
};
/** deposit(5) to the listed contract, fully filled (no RPC): 100 000 gas at 1 wei, so 100 000 wei of maximum fee. */
const depositTx = (nonce: number) => ({
  type: '0x2',
  chainId: `0x${EVM_CHAIN_ID.toString(16)}`,
  nonce: `0x${nonce.toString(16)}`,
  gas: '0x186a0',
  maxFeePerGas: '0x1',
  maxPriorityFeePerGas: '0x1',
  to: DEPOSIT_CONTRACT,
  value: '0x0',
  data: `0xb6b55f25${(5).toString(16).padStart(64, '0')}`,
});

test('an auto-approved request opens the popup in the click and closes it without showing anything', async ({ page, context }) => {
  const ui = await recordApproveUi(context);
  await openPartner(page, await newApp({ settings: { autoApprovePolicy: AUTO_POLICY } }));
  await login(page);

  // Consent, from a click: the popup opens in it with the consent screen.
  const consentP = page.waitForEvent('popup');
  await clickAction(page, 'consent', 'requestAutoApprove');
  const consent = await consentP;
  await approve(consent, 'Allow');
  expect(await okValue(page, 'consent')).toMatchObject({ granted: true });
  await consent.close();
  await page.waitForTimeout(800); // the vault polls its window every 0.5 s, then tells the page it is gone
  // The control: the recorder saw the consent screen and its buttons.
  expect(ui.some((t) => t.includes('Allow automatic signing?') && t.includes('buttons:'))).toBe(true);
  ui.length = 0;
  const mark = await eventCount(page);

  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'auto', 'ethSignTx', depositTx(0));
  const popup = await popupP;
  const openedAt = Date.now();
  if (!popup.isClosed()) await popup.waitForEvent('close', { timeout: 10_000 });
  const openFor = Date.now() - openedAt;
  expect(await okValue(page, 'auto')).toMatchObject({ valid: true });
  expect(await eventsSince(page, 'autoApproved', mark)).toEqual([{ kind: 'eth_signTransaction', chain: 'evm', contract: DEPOSIT_CONTRACT, function: 'deposit(uint256)' }]);
  // Closed by the vault, not by its own 8 s timeout, and it never showed a request or a button.
  expect(openFor).toBeLessThan(5_000);
  expect(ui.filter((t) => /Request|Approve|Reject|buttons:/u.test(t))).toEqual([]);
  expect((await eventsSince(page, 'launcher', mark)).filter((e) => (e as { visible: boolean; label: string }).visible && (e as { label: string }).label === 'Review in Hana')).toEqual([]);
});

test('the partner page posting fake requests to an approval window it holds gets nothing shown or approved', async ({ page }) => {
  await openPartner(page, await newApp());
  await login(page);
  const popupP = page.waitForEvent('popup');
  expect(await page.evaluate(() => (window as any).e2e.openApproveWindow())).toBe(true);
  const popup = await popupP;
  await popup.waitForLoadState('domcontentloaded');
  const fake = {
    v: 1,
    t: 'hana:approve-request',
    id: 'ab'.repeat(16),
    appName: 'Totally Hana',
    parentOrigin: 'http://localhost:1',
    kind: 'personal_sign',
    chain: 'evm',
    address: '0x000000000000000000000000000000000000dEaD',
    bytes: new TextEncoder().encode('forged'),
    context: {},
    position: 1,
    queued: 1,
  };
  for (let i = 0; i < 5; i++) {
    await page.evaluate((m) => (window as any).e2e.postToApproveWindow({ ...m, bytes: new Uint8Array(m.bytes as unknown as number[]) }), { ...fake, bytes: Array.from(fake.bytes) as unknown as Uint8Array });
    await page.waitForTimeout(100);
  }
  await expect(popup.getByText('Totally Hana')).toHaveCount(0);
  await expect(popup.getByRole('button')).toHaveCount(0);
  // Nothing to adopt it for: it closes itself.
  await popup.waitForEvent('close', { timeout: 15_000 });
});
