// Gas-free EVM actions end to end (D831, D838, D855, D856): the partner page's hana.evm.sendSponsored in a click, the
// vault's prepare against the stack's TEST-ONLY stand-in for the sponsorship routes (src/server/sponsor-standin.ts: it
// checks the session proof, the Execute and the authorization signatures as the real API will, and answers `executed`
// with a made-up hash; nothing reaches a chain), one approval window, and the vault's send.
//
// Covered: the first action (one window, the one-time setup note, the authorization sent), a later one (no note), a
// decline, an account set up by another app (the plain refusal, no window), a second action while one is still going
// through (`busy`), EIP-5792 through viem's own sendCalls, and the generic typed-data path still refusing the
// delegate's domain (D833).
//
// With HANA_SHOTS_DIR=<dir> (Chromium only) it saves the windows for the founder: sponsored-first-time(-details),
// sponsored-later, sponsored-token-first-time, sponsored-token-later, sponsored-unknown-call and
// sponsored-approve-warning.
import { type Page } from '@playwright/test';
import { parseFunctionSignature } from '@hana-id/core/decode';
import { SPONSOR_DELEGATES } from '@hana-id/core/evm-sponsor';
import { API_URL, EVM_CHAIN_ID } from '../src/stack.ts';
import { approve, clickAction, expect, login, newApp, okValue, openPartner, reject, settled, test } from './fixtures.ts';

const SHOTS = process.env.HANA_SHOTS_DIR;
const POPUP = { width: 420, height: 680 } as const;
const CHECK_IN = '0xa84BBd91a395ae028eE2890DcA0e20570C1Aa39e';
const UNKNOWN_CONTRACT = '0x4444444444444444444444444444444444444444';
const TOKEN = '0x1111111111111111111111111111111111111111';
const SPENDER = '0x3333333333333333333333333333333333333333';
const RECIPIENT = '0x000000000000000000000000000000000000dEaD';
const word = (v: bigint | string) => (typeof v === 'string' ? v.slice(2).toLowerCase().padStart(64, '0') : v.toString(16).padStart(64, '0'));
const call = (sig: string, ...args: (bigint | string)[]) => `${parseFunctionSignature(sig).selector}${args.map(word).join('')}`;

const CHECK_IN_CALL = { to: CHECK_IN, data: '0x183ff085' };
const TRANSFER = { to: TOKEN, data: call('transfer(address,uint256)', RECIPIENT, 5_000_000n) };
const UNLIMITED_APPROVE = { to: TOKEN, data: call('approve(address,uint256)', SPENDER, 2n ** 256n - 1n) };
const SETUP = 'One-time setup: this also turns on free network fees for your account on the local test chain 31337. Your address stays the same and you still approve every action.';

async function sponsorControl(body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${API_URL}/__e2e/evm-sponsor`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
}

async function sponsorLog(appId: string): Promise<{ prepares: number; sends: number; executed: number; proofRefusals: string[] }> {
  return (await (await fetch(`${API_URL}/__e2e/evm-sponsor?appId=${encodeURIComponent(appId)}`)).json()) as never;
}

async function shot(popup: Page, name: string, browserName: string): Promise<void> {
  if (!SHOTS || browserName !== 'chromium') return;
  await popup.setViewportSize(POPUP);
  await popup.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, animations: 'disabled' });
}

/** The action in a real click: the approval window opens in it (D99). */
async function sponsoredWindow(page: Page, name: string, calls: { to: string; data: string }[]): Promise<Page> {
  const popupP = page.waitForEvent('popup');
  await clickAction(page, name, 'sendSponsored', calls);
  const popup = await popupP;
  await expect(popup.locator('h2.summary-headline')).toBeVisible().catch(async (e: unknown) => {
    throw new Error(`no window for ${name}: ${JSON.stringify(await page.evaluate((n) => (window as any).e2e.results[n], name))}: ${String(e)}`);
  });
  await expect(popup.locator('.summary-failed')).toHaveCount(0);
  return popup;
}

/**
 * Signs in to a new app on a scope of its own, so each test (and each browser) has its own EVM account on the mocked
 * chain: the stand-in and the vault read the account's setup there.
 */
async function freshSession(page: Page): Promise<{ evm: string; appId: string }> {
  const app = await newApp({ scopeId: `sp${Math.random().toString(36).slice(2, 12)}` });
  await openPartner(page, app);
  const { evm } = await login(page);
  return { evm, appId: app.appId };
}

/**
 * Approves and waits for the result, then closes the window as a user would (the vault keeps an idle one for 15 s for
 * the next request: closed, the next click opens its own).
 */
async function approveAndWait(page: Page, popup: Page, name: string): Promise<unknown> {
  await approve(popup);
  const v = await okValue(page, name);
  if (!popup.isClosed()) await popup.close();
  await page.waitForTimeout(700);
  return v;
}

const fee = (popup: Page) => popup.locator('.summary-facts dt', { hasText: 'Network fee' }).locator('xpath=following-sibling::dd[1]');
const details = (popup: Page) => popup.locator('details.request-details');

test('the demo check-in, first and later: one window, the setup note only the first time; both run (D831, D854, D855)', async ({ page, browserName }) => {
  const { evm, appId } = await freshSession(page);
  expect(await page.evaluate(() => (window as any).e2e.hana.evm.sponsoredChains)).toEqual([EVM_CHAIN_ID]);

  // First: Journear's demo check-in (on the verified list, D854) with the account's one-time setup.
  let popup = await sponsoredWindow(page, 'first', [CHECK_IN_CALL]);
  await expect(popup.locator('h2.summary-headline')).toHaveText('E2E Partner wants to check you in');
  await expect(fee(popup)).toHaveText('none. Journear pays it for you.');
  await expect(popup.locator('.warning-box p.risk-lead.account-setup')).toHaveText(SETUP);
  await expect(popup.locator('.danger-box')).toHaveCount(0);
  expect(await popup.locator('body').innerText()).not.toMatch(/upgrade|smart account/iu);
  await shot(popup, 'sponsored-first-time', browserName);
  await popup.getByText('Show details', { exact: true }).click();
  await expect(details(popup).getByText('Account setup (EIP-7702)', { exact: true })).toBeVisible();
  await shot(popup, 'sponsored-first-time-details', browserName);
  const first = (await approveAndWait(page, popup, 'first')) as { transactionHash: string; status: string };
  expect(first).toEqual({ transactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/u), status: 'executed' });

  // Later: the same check-in, no box at all.
  popup = await sponsoredWindow(page, 'later', [CHECK_IN_CALL]);
  await expect(popup.locator('.risk-box')).toHaveCount(0);
  await expect(fee(popup)).toHaveText('none. Journear pays it for you.');
  await shot(popup, 'sponsored-later', browserName);
  expect(await approveAndWait(page, popup, 'later')).toMatchObject({ status: 'executed' });

  // The check-in's selector on a contract Journear doesn't know: the red "can't tell" line, no name.
  popup = await sponsoredWindow(page, 'unknown', [{ to: UNKNOWN_CONTRACT, data: '0x183ff085' }]);
  await expect(popup.locator('.danger-box p.risk-lead.summary-warning.cannot-explain')).toContainText('Journear can’t tell what this request does');
  await shot(popup, 'sponsored-unknown-call', browserName);
  expect(await approveAndWait(page, popup, 'unknown')).toMatchObject({ status: 'executed' });

  expect(await sponsorLog(appId)).toEqual({ prepares: 3, sends: 3, executed: 3, proofRefusals: [] });
  // Nothing the page saw carries a signature: the result is the hash and the status only (checked above), and the
  // vault's port answers are the SDK's (the partner app keeps them).
  expect(JSON.stringify(await page.evaluate(() => (window as any).e2e.results))).not.toMatch(/"signature"|authorization/iu);
  expect(evm).toMatch(/^0x/u);
});

test('a token transfer, first and later: the calls’ own summary, the setup note only the first time', async ({ page, browserName }) => {
  await freshSession(page);
  let popup = await sponsoredWindow(page, 'first', [TRANSFER]);
  await expect(popup.locator('h2.summary-headline')).toHaveText(`E2E Partner wants to send tokens of contract ${TOKEN} to ${RECIPIENT}`);
  await expect(popup.locator('.warning-box p.risk-lead.account-setup')).toHaveText(SETUP);
  await expect(popup.locator('.danger-box')).toHaveCount(0);
  await shot(popup, 'sponsored-token-first-time', browserName);
  expect(await approveAndWait(page, popup, 'first')).toMatchObject({ status: 'executed' });
  popup = await sponsoredWindow(page, 'later', [TRANSFER]);
  await expect(popup.locator('.risk-box')).toHaveCount(0);
  await shot(popup, 'sponsored-token-later', browserName);
  expect(await approveAndWait(page, popup, 'later')).toMatchObject({ status: 'executed' });
});

test('an unlimited approve on the first action: as alarming as unsponsored, plus the setup note', async ({ page, browserName }) => {
  await freshSession(page);
  const popup = await sponsoredWindow(page, 'approve', [UNLIMITED_APPROVE]);
  await expect(popup.locator('.danger-box p.risk-lead.summary-warning.unlimited-spend')).toContainText(`This lets ${SPENDER}, an address Journear hasn’t verified, spend all of your tokens of contract ${TOKEN}, with no limit`);
  await expect(popup.locator('.warning-box p.risk-lead.account-setup')).toHaveText(SETUP);
  await shot(popup, 'sponsored-approve-warning', browserName);
  await reject(popup);
  expect((await settled(page, 'approve')).state).toBe('error');
});

test('a decline: 4001, nothing sent', async ({ page }) => {
  const { appId } = await freshSession(page);
  const popup = await sponsoredWindow(page, 'declined', [CHECK_IN_CALL]);
  await reject(popup);
  const r = await settled(page, 'declined');
  expect(r).toMatchObject({ state: 'error', code: 4001 });
  expect(await sponsorLog(appId)).toMatchObject({ prepares: 1, sends: 0 });
});

test('an account set up by another app: the plain refusal, no approval screen (D840)', async ({ page }) => {
  const { evm } = await freshSession(page);
  await sponsorControl({ account: evm, delegation: 'other' });
  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'elsewhere', 'sendSponsored', [CHECK_IN_CALL]);
  const popup = await popupP;
  const r = await settled(page, 'elsewhere');
  expect(r).toMatchObject({ state: 'error', code: 4100, reason: 'delegated_elsewhere', message: 'Your account was set up by another wallet app, so Journear can’t pay network fees for it. Nothing was sent.' });
  // The window the click opened is told to close: the user never saw an Approve.
  await popup.waitForEvent('close', { timeout: 10_000 }).catch(() => undefined);
  expect(popup.isClosed()).toBe(true);
});

test('a second action while the first is still going through: busy, before anything is prepared; the first still runs', async ({ page }) => {
  const { appId } = await freshSession(page);
  await sponsorControl({ appId, hold: true });
  try {
    const popup = await sponsoredWindow(page, 'one', [CHECK_IN_CALL]);
    await approve(popup);
    await expect.poll(async () => (await sponsorLog(appId)).sends, { timeout: 10_000 }).toBeGreaterThan(0);
    const prepares = (await sponsorLog(appId)).prepares;
    await clickAction(page, 'two', 'sendSponsored', [CHECK_IN_CALL]);
    const two = await settled(page, 'two');
    expect(two).toMatchObject({ state: 'error', code: 'busy', reason: 'sponsor_in_flight', message: 'Your last action is still going through. Wait for it to finish, then try again.' });
    expect((await sponsorLog(appId)).prepares).toBe(prepares);
  } finally {
    await sponsorControl({ appId, hold: false });
  }
  expect(await okValue(page, 'one')).toMatchObject({ status: 'executed' });
});

test('EIP-5792: viem’s sendCalls runs as one gas-free action; capabilities say atomic (D838)', async ({ page }) => {
  await freshSession(page);
  const popupP = page.waitForEvent('popup');
  await clickAction(page, 'calls', 'viemSendCalls', [CHECK_IN_CALL]);
  const popup = await popupP;
  await expect(popup.locator('h2.summary-headline')).toBeVisible();
  await approve(popup);
  const v = await okValue<{ id: string; status: string; atomic: boolean; capabilities: Record<string, unknown> }>(page, 'calls');
  expect(v.id).toMatch(/^0x[0-9a-f]{64}$/u);
  // The mocked chain never mined the stand-in's made-up hash: the status is pending, atomic.
  expect(v).toMatchObject({ status: 'pending', atomic: true });
  expect(v.capabilities).toMatchObject({ [EVM_CHAIN_ID]: { atomic: { status: 'supported' } } });
});

test('the generic typed-data path still refuses the delegate’s domain (D833)', async ({ page }) => {
  const { evm } = await freshSession(page);
  const delegate = (SPONSOR_DELEGATES[EVM_CHAIN_ID] as { address: string }).address;
  const json = JSON.stringify({
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
        { name: 'salt', type: 'bytes32' },
      ],
      Order: [{ name: 'amount', type: 'uint256' }],
    },
    primaryType: 'Order',
    domain: { name: 'HanaDelegateExecutor', version: '1', chainId: EVM_CHAIN_ID, verifyingContract: evm, salt: `0x${'00'.repeat(12)}${delegate.slice(2).toLowerCase()}` },
    message: { amount: '1' },
  });
  await clickAction(page, 'typed', 'ethSignTypedData', json);
  expect(await settled(page, 'typed')).toMatchObject({ state: 'error', code: 4100, reason: 'sponsor_domain_reserved' });
});
