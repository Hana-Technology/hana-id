// Auto-approve policies, vault side (docs/batch-b-spec.md "Auto-approve policies"; Tests → Web unit → Auto-approve).
// The matcher and the validator are @hana-id/core's (tested there reason by reason); these tests cover the vault's
// wiring: consent, signing without a popup, the reasons shown in the popup, counters, expiry and revocation.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { functionSelector } from '@hana-id/core/decode';
import { policyId } from '@hana-id/core/policy';
import { openRecordStore, recordKey } from '../../src/vault/record.ts';
import { POPUP_REUSE_MS } from '../../src/vault/approvals.ts';
import { POLICY_FRESH_MS, POLICY_REFRESH_MS } from '../../src/vault/vault.ts';
import { APP_ID, Browser, ENV, type FakeWindow, type Google, HOUR, PARTNER, SCOPE, START_MS, type Tab, answer, answerConsent, apiError, google, login, makeConfig, openApproval, readyTab, sleepReal, waitLauncher } from './harness.ts';
import {
  CHAIN,
  EVM_FRIEND,
  EVM_VAULT,
  ISSUER,
  PASSPHRASE,
  POOL,
  UNLISTED,
  addr,
  authCall,
  authPreimage,
  authPreimageOf,
  changeTrust,
  evmCreation,
  evmTx,
  evmTxSigner,
  feeBump,
  invoke,
  invokeWithAuth,
  payment,
  stellarAuthSignedBy,
  stellarTx,
  stellarTxSignedBy,
  typedData,
  typedSigner,
  withdraw,
} from './chains.ts';

let g: Google;
const tabs: Tab[] = [];
beforeAll(async () => {
  g = await google();
});
afterEach(() => {
  for (const t of tabs.splice(0)) {
    t.close();
    t.browser.timers.dispose();
  }
});

const entry = (signature: string, addressArgs?: 'self-or-listed' | 'any') => ({ selector: functionSelector(signature), signature, ...(addressArgs ? { addressArgs } : {}) });

const POLICY = () => ({
  v: 1,
  label: 'Swaps on Example',
  maxConsentMs: 6 * HOUR,
  limits: { perDayCount: 3 },
  stellar: {
    networkPassphrases: [PASSPHRASE],
    maxFeeStroops: '100000',
    contracts: [{ id: POOL, name: 'Example pool', functions: [{ name: 'swap' }] }],
    changeTrustAssets: [`USDC:${ISSUER}`],
  },
  evm: {
    chains: [
      {
        chainId: CHAIN,
        // evmTx's maximum fee is 100 000 wei (gas 100 000 at 1 wei), which counts with the value against both limits.
        maxValueWei: '101000',
        maxValueWeiPerDay: '301500',
        maxFeeWei: '100000',
        contracts: [{ address: EVM_VAULT, name: 'Example vault', selectors: [entry('deposit(uint256)'), entry('withdraw(address,uint256)', 'self-or-listed')] }],
        typedData: [{ verifyingContract: EVM_VAULT, primaryType: 'Order' }],
      },
    ],
  },
});

interface Session {
  t: Tab;
  stellar: string;
  evm: string;
}

async function session(browser = new Browser(), policy: Record<string, unknown> | null = POLICY(), over: Parameters<typeof makeConfig>[0] = {}): Promise<Session> {
  // The API's clock moves with the test's: the vault re-anchors its clock on the serverTimeMs of each GET /v1/app.
  browser.backend.serverNow = () => browser.timers.now;
  const config = makeConfig({ ...over, settings: { autoApprovePolicy: policy, ...over.settings } });
  const t = await readyTab(browser, { googleJwk: g.jwk, config });
  tabs.push(t);
  const status = (await t.ready()) as { status: string; addresses?: { stellar: string; evm: string } };
  if (status.status === 'logged_in') return { t, ...status.addresses! };
  const { reply } = await login(t, g);
  const a = (reply.result as { addresses: { stellar: string; evm: string } }).addresses;
  return { t, stellar: a.stellar, evm: a.evm };
}

/** Event-driven (the launcher view and its `ui` event on the port), so a loaded machine only slows it down. */
const waitLabel = (t: Tab, label: string): Promise<void> => waitLauncher(t, label);

/** Opens the popup from the launcher and returns the consent screen it shows. */
async function consentScreen(s: Session): Promise<{ popup: FakeWindow; m: Record<string, unknown> }> {
  await waitLabel(s.t, 'Review in Hana');
  const popup = openApproval(s.t);
  return { popup, m: await popup.next('hana:consent-request') };
}

/** Grants consent through hana_requestAutoApprove. */
async function grant(s: Session): Promise<FakeWindow> {
  const reply = s.t.request('hana_requestAutoApprove');
  const { popup, m } = await consentScreen(s);
  answerConsent(s.t, popup, m, true);
  expect((await reply).result).toMatchObject({ granted: true });
  return popup;
}

const PID = policyId(POLICY(), { sessionTtlMs: 12 * HOUR });

const STRANGER = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const ORDER_TYPES = [
  { name: 'owner', type: 'address' },
  { name: 'amount', type: 'uint256' },
];
const order = (owner: string, over: { verifyingContract?: string; primaryType?: string; chainId?: number } = {}) =>
  typedData(over.verifyingContract ?? EVM_VAULT, over.primaryType ?? 'Order', { owner, amount: '5' }, ORDER_TYPES, over.chainId);
/** swap(self) → swap(self) → swap(`deepest`): an auth tree three calls deep. */
const nested = (self: string, deepest: string) => authCall(POOL, 'swap', [addr(self)], [authCall(POOL, 'swap', [addr(self)], [authCall(POOL, 'swap', [addr(deepest)])])]);

describe('consent', () => {
  it('no consent: a matching request opens the consent screen, then signs under it without an approval screen', async () => {
    const s = await session();
    const tx = evmTx();
    const reply = s.t.request('eth_signTransaction', { tx });
    const { popup, m } = await consentScreen(s);
    expect(m).toMatchObject({ appName: 'Partner', parentOrigin: PARTNER, policyId: PID, expiresAtMs: START_MS + 6 * HOUR, position: 1, queued: 1 });
    expect((m.policy as { label: string }).label).toBe('Swaps on Example');
    answerConsent(s.t, popup, m, true);
    expect(evmTxSigner((await reply).result as string, tx)).toBe(s.evm);
    expect(popup.posted.filter((p) => p.message.t === 'hana:approve-request')).toHaveLength(0);
    expect(await s.t.waitEvent('autoApproved')).toEqual({ kind: 'eth_signTransaction', chain: 'evm', contract: EVM_VAULT, function: 'deposit(uint256)' });
    expect((await s.t.request('hana_autoApproveStatus')).result).toEqual({ policyId: PID, label: 'Swaps on Example', expiresAtMs: START_MS + 6 * HOUR, used: { count: 1, native: '100000' } });
  });

  it('an Allow with a digest for another policy, origin or end time stores nothing', async () => {
    const s = await session();
    const reply = s.t.request('hana_requestAutoApprove');
    const { popup, m } = await consentScreen(s);
    answerConsent(s.t, popup, { ...m, policyId: 'f'.repeat(64) }, true);
    expect((await reply).result).toEqual({ granted: false });
    expect((await s.t.request('hana_autoApproveStatus')).result).toBeNull();
  });

  it('declined: the request goes to the approval screen (with the policy note), and later matches skip the consent screen', async () => {
    const s = await session();
    const reply = s.t.request('eth_signTransaction', { tx: evmTx() });
    const { popup, m } = await consentScreen(s);
    answerConsent(s.t, popup, m, false);
    const a = await popup.next('hana:approve-request');
    expect(a.autoApprove).toEqual({ label: 'Swaps on Example', active: false });
    answer(s.t, popup, a, true);
    expect((await reply).result).toMatch(/^0x02/u);
    const again = s.t.request('eth_signTransaction', { tx: evmTx({ nonce: '0x2' }) });
    const a2 = await popup.next('hana:approve-request', 1);
    expect(popup.posted.filter((p) => p.message.t === 'hana:consent-request')).toHaveLength(1);
    answer(s.t, popup, a2, false);
    expect((await again).error?.code).toBe(4001);
  });

  it('hana_requestAutoApprove grants once; a second call answers at once', async () => {
    const s = await session();
    await grant(s);
    const opened = s.t.opened.length;
    expect((await s.t.request('hana_requestAutoApprove')).result).toEqual({ granted: true, policyId: PID, expiresAtMs: START_MS + 6 * HOUR });
    expect(s.t.opened.length).toBe(opened);
  });

  it('hana_requestAutoApprove is 4100 when the app has no policy in force (and removal is immediate)', async () => {
    const s = await session(new Browser(), null);
    expect((await s.t.request('hana_requestAutoApprove')).error?.code).toBe(4100);
    expect((await s.t.request('hana_autoApproveStatus')).result).toBeNull();
  });

  it('a policy that fails the validator is treated as no policy', async () => {
    const bad = { ...POLICY(), limits: { perDayCount: 100_000 } };
    const s = await session(new Browser(), bad);
    expect((await s.t.request('hana_requestAutoApprove')).error?.code).toBe(4100);
  });
});

describe('with consent', () => {
  it('a matching request signs with no popup and no launcher, emits autoApproved and flashes the launcher', async () => {
    const s = await session();
    await grant(s);
    const opened = s.t.opened.length;
    const xdr = stellarTx(s.stellar, [invoke(POOL, 'swap', [addr(s.stellar)])]);
    const r = (await s.t.request('stellar_signTransaction', { xdr, networkPassphrase: PASSPHRASE })).result as { signedTxXdr: string };
    expect(stellarTxSignedBy(r.signedTxXdr, s.stellar)).toBe(true);
    expect(s.t.opened.length).toBe(opened);
    expect(await s.t.waitEvent('autoApproved')).toEqual({ kind: 'stellar_signTransaction', chain: 'stellar', contract: POOL, function: 'swap' });
    expect(s.t.launcher.history).toContain('Signed by Hana under Swaps on Example');
  });

  it.each([
    ['an unlisted contract', () => ['eth_signTransaction', { tx: evmTx({ to: EVM_FRIEND }) }], 'contract_not_listed'],
    ['an unlisted selector', () => ['eth_signTransaction', { tx: evmTx({ data: `${functionSelector('steal()')}` }) }], 'selector_not_listed'],
    ['an unlisted (test) chain', () => ['eth_signTransaction', { tx: evmTx({ chainId: '0xaa36a7' }) }], 'chain_not_listed'],
    ['an address argument that is not self or listed', () => ['eth_signTransaction', { tx: evmTx({ data: withdraw(EVM_FRIEND, 1n) }) }], 'address_not_allowed'],
    ['a value over the limit', () => ['eth_signTransaction', { tx: evmTx({ value: `0x${(101_001).toString(16)}` }) }], 'value_too_high'],
    ['a value over the limit with the maximum fee', () => ['eth_signTransaction', { tx: evmTx({ value: '0x3e9' }) }], 'value_plus_fee_too_high'],
    ['a fee over the limit', () => ['eth_signTransaction', { tx: evmTx({ maxFeePerGas: '0x2' }) }], 'fee_too_high'],
    ['calldata that does not decode', () => ['eth_signTransaction', { tx: evmTx({ data: `${functionSelector('deposit(uint256)')}00` }) }], 'calldata_mismatch'],
    ['contract creation', () => ['eth_signTransaction', { tx: evmCreation() }], 'contract_creation'],
    ['an unlisted Stellar contract', (s: Session) => ['stellar_signTransaction', { xdr: stellarTx(s.stellar, [invoke(UNLISTED, 'swap', [addr(s.stellar)])]), networkPassphrase: PASSPHRASE }], 'contract_not_listed'],
    ['a Stellar address argument that is not self', (s: Session) => ['stellar_signTransaction', { xdr: stellarTx(s.stellar, [invoke(POOL, 'swap', [addr('GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ')])]), networkPassphrase: PASSPHRASE }], 'address_not_allowed'],
    ['an auth entry for an unlisted contract', (s: Session) => ['stellar_signAuthEntry', { preimageXdr: authPreimage(UNLISTED, 'swap', [addr(s.stellar)]), networkPassphrase: PASSPHRASE }], 'contract_not_listed'],
    ['an auth entry whose address argument at depth 3 is a stranger', (s: Session) => ['stellar_signAuthEntry', { preimageXdr: authPreimageOf(nested(s.stellar, STRANGER)), networkPassphrase: PASSPHRASE }], 'address_not_allowed'],
    ['a transaction whose auth tree passes a stranger at depth 3', (s: Session) => ['stellar_signTransaction', { xdr: stellarTx(s.stellar, [invokeWithAuth(POOL, 'swap', [addr(s.stellar)], nested(s.stellar, STRANGER))]), networkPassphrase: PASSPHRASE }], 'address_not_allowed'],
    ['typed data with an unlisted primaryType', (s: Session) => ['eth_signTypedData_v4', [s.evm, order(s.evm, { primaryType: 'Permit' })]], 'typed_data_not_listed'],
    ['typed data for an unlisted verifyingContract', (s: Session) => ['eth_signTypedData_v4', [s.evm, order(s.evm, { verifyingContract: EVM_FRIEND })]], 'typed_data_not_listed'],
    ['typed data whose domain chainId is not listed', (s: Session) => ['eth_signTypedData_v4', [s.evm, order(s.evm, { chainId: 11155111 })]], 'chain_not_listed'],
    ['typed data with an address field that is not self or listed', (s: Session) => ['eth_signTypedData_v4', [s.evm, order(EVM_FRIEND)]], 'address_not_allowed'],
    ['a classic operation other than a listed changeTrust', (s: Session) => ['stellar_signTransaction', { xdr: stellarTx(s.stellar, [payment()]), networkPassphrase: PASSPHRASE }], 'operation_not_allowed'],
    ['a fee-bump', (s: Session) => ['stellar_signTransaction', { xdr: feeBump(stellarTx(s.stellar, [changeTrust()]), s.stellar), networkPassphrase: PASSPHRASE }], 'fee_bump'],
    ['an unlisted (test) network', (s: Session) => ['stellar_signTransaction', { xdr: stellarTx(s.stellar, [changeTrust()]), networkPassphrase: 'Test SDF Future Network ; October 2022' }], 'network_not_listed'],
  ] as const)('%s goes to the approval popup with the reason', async (_, make, reason) => {
    const s = await session();
    const popup = await grant(s);
    const [method, params] = (make as unknown as (s: Session) => readonly [string, unknown])(s);
    const reply = s.t.request(method, params);
    const shown = (await popup.next('hana:approve-request').catch(async () => {
      await waitLabel(s.t, 'Review in Hana');
      return openApproval(s.t).next('hana:approve-request');
    })) as Record<string, unknown>;
    expect(shown.autoApprove).toEqual({ label: 'Swaps on Example', active: true, reason });
    answer(s.t, popup.closed ? s.t.opened.at(-1)! : popup, shown, false);
    expect((await reply).error?.code).toBe(4001);
    expect(s.t.events.some((e) => e.event === 'autoApproved')).toBe(false);
  });

  it('a listed auth entry, nested calls included, is auto-approved and signed by the vault key', async () => {
    const s = await session();
    await grant(s);
    const opened = s.t.opened.length;
    const preimageXdr = authPreimageOf(nested(s.stellar, s.stellar));
    const r = (await s.t.request('stellar_signAuthEntry', { preimageXdr, networkPassphrase: PASSPHRASE })).result as { signedAuthEntry: string };
    expect(stellarAuthSignedBy(preimageXdr, r.signedAuthEntry, s.stellar)).toBe(true);
    expect(s.t.opened.length).toBe(opened);
    expect(await s.t.waitEvent('autoApproved')).toEqual({ kind: 'stellar_signAuthEntry', chain: 'stellar', contract: POOL, function: 'swap' });
  });

  it('a transaction whose auth tree is all self or listed is auto-approved', async () => {
    const s = await session();
    await grant(s);
    const xdr = stellarTx(s.stellar, [invokeWithAuth(POOL, 'swap', [addr(s.stellar)], nested(s.stellar, POOL))]);
    const r = (await s.t.request('stellar_signTransaction', { xdr, networkPassphrase: PASSPHRASE })).result as { signedTxXdr: string };
    expect(stellarTxSignedBy(r.signedTxXdr, s.stellar)).toBe(true);
  });

  it('listed typed data (verifyingContract, primaryType, owner self) is auto-approved', async () => {
    const s = await session();
    await grant(s);
    const json = order(s.evm);
    expect(typedSigner(json, (await s.t.request('eth_signTypedData_v4', [s.evm, json])).result as string)).toBe(s.evm);
    expect(await s.t.waitEvent('autoApproved')).toEqual({ kind: 'eth_signTypedData_v4', chain: 'evm', contract: EVM_VAULT, function: 'Order' });
  });

  it('a listed changeTrust is auto-approved', async () => {
    const s = await session();
    await grant(s);
    const xdr = stellarTx(s.stellar, [changeTrust()]);
    expect((await s.t.request('stellar_signTransaction', { xdr, networkPassphrase: PASSPHRASE })).result).toHaveProperty('signedTxXdr');
  });

  it('raw, personal_sign, stellar_signMessage and contract creation always need approval', async () => {
    // A live app: a test app can't sign raw at all (D39).
    const s = await session(new Browser(), POLICY(), { publishableKey: 'pk_live_1111111111111111111111', settings: { rawSign: 'approval' } });
    const popup = await grant(s);
    const requests: [string, unknown][] = [
      ['hana_signRaw', { chain: 'evm', digest: new Uint8Array(32).fill(1) }],
      ['personal_sign', ['0x6869', s.evm]],
      ['stellar_signMessage', { message: 'hi' }],
      ['eth_signTransaction', { tx: evmCreation() }],
    ];
    for (const [i, [method, params]] of requests.entries()) {
      const reply = s.t.request(method, params);
      const m = await popup.next('hana:approve-request', i);
      answer(s.t, popup, m, true);
      expect((await reply).error).toBeUndefined();
    }
    expect(s.t.events.some((e) => e.event === 'autoApproved')).toBe(false);
  });

  it('counts per day: perDayCount reached and the daily native value go to the popup', async () => {
    const s = await session();
    const popup = await grant(s);
    // Each spends value 1000 plus the maximum fee 100 000: 202 000 today.
    expect((await s.t.request('eth_signTransaction', { tx: evmTx({ value: '0x3e8' }) })).result).toMatch(/^0x02/u);
    expect((await s.t.request('eth_signTransaction', { tx: evmTx({ value: '0x3e8', nonce: '0x2' }) })).result).toMatch(/^0x02/u);
    // A third would pass the per-transaction limit but take the day to 303 000, over 301 500.
    const over = s.t.request('eth_signTransaction', { tx: evmTx({ value: '0x3e8', nonce: '0x3' }) });
    const m = await popup.next('hana:approve-request');
    expect((m.autoApprove as { reason: string }).reason).toBe('daily_value_exceeded');
    answer(s.t, popup, m, false);
    await over;
    // A cheaper one (gas 21 000, no value) still fits: 223 000.
    const cheap = (nonce: string) => evmTx({ nonce, gas: '0x5208' });
    expect((await s.t.request('eth_signTransaction', { tx: cheap('0x4') })).result).toMatch(/^0x02/u);
    expect((await s.t.request('hana_autoApproveStatus')).result).toMatchObject({ used: { count: 3, native: '223000' } });
    const fourth = s.t.request('eth_signTransaction', { tx: cheap('0x5') });
    const m4 = await popup.next('hana:approve-request', 1);
    expect((m4.autoApprove as { reason: string }).reason).toBe('daily_count_reached');
    answer(s.t, popup, m4, false);
    await fourth;
  });

  it('counters reset at the UTC day boundary', async () => {
    const browser = new Browser();
    const day = 86_400_000;
    const nearMidnight = (Math.floor(START_MS / day) + 1) * day - 30 * 60_000;
    browser.timers.now = nearMidnight;
    browser.backend.serverNow = () => browser.timers.now;
    const s = await session(browser, POLICY(), { serverTimeMs: nearMidnight });
    await grant(s);
    for (let i = 1; i <= 3; i++) expect((await s.t.request('eth_signTransaction', { tx: evmTx({ nonce: `0x${i}` }) })).result).toMatch(/^0x02/u);
    browser.timers.advance(31 * 60_000);
    expect((await s.t.request('eth_signTransaction', { tx: evmTx({ nonce: '0x9' }) })).result).toMatch(/^0x02/u);
    expect((await s.t.request('hana_autoApproveStatus')).result).toMatchObject({ used: { count: 1 } });
  });
});

describe('the policy in force, re-read while the vault stays open', () => {
  /** Past the freshness bound and the 15 s popup reuse window (so the launcher opens a new popup). */
  const STALE_MS = Math.max(POLICY_FRESH_MS, POPUP_REUSE_MS + 1);

  it('the freshness bound is the documented 10 s (docs/integration.md section 9)', () => {
    expect(POLICY_FRESH_MS).toBe(10_000);
  });

  /**
   * Sends a request the policy covers and returns the approval request it got instead (rejected). Every caller moved
   * the clock past the 15 s popup reuse window, so the launcher opens a new popup.
   */
  async function shownForApproval(s: Session): Promise<Record<string, unknown>> {
    const reply = s.t.request('eth_signTransaction', { tx: evmTx({ nonce: '0xa' }) });
    await waitLabel(s.t, 'Review in Hana');
    const popup = openApproval(s.t);
    const m = await popup.next('hana:approve-request');
    answer(s.t, popup, m, false);
    expect((await reply).error?.code).toBe(4001);
    return m;
  }

  it('a removal stops auto-approval without a reload: the background re-read drops the policy', async () => {
    const s = await session();
    await grant(s);
    expect((await s.t.request('eth_signTransaction', { tx: evmTx() })).result).toMatch(/^0x02/u);
    s.t.browser.backend.autoApprovePolicy = null;
    const before = s.t.browser.backend.count('/v1/app');
    s.t.browser.timers.advance(POLICY_REFRESH_MS);
    for (let i = 0; i < 100 && s.t.browser.backend.count('/v1/app') === before; i++) await sleepReal(5);
    await sleepReal(10);
    expect((await s.t.request('hana_autoApproveStatus')).result).toBeNull();
    expect((await s.t.request('hana_requestAutoApprove')).error?.code).toBe(4100);
    const m = await shownForApproval(s);
    // No policy any more: no note, and nothing was auto-signed.
    expect(m.autoApprove).toBeUndefined();
    expect(s.t.events.filter((e) => e.event === 'autoApproved')).toHaveLength(1);
  });

  it('a stale check is redone before an auto-sign, even when the background timer never ran (a throttled tab)', async () => {
    const s = await session();
    await grant(s);
    s.t.browser.backend.autoApprovePolicy = null;
    // The clock moves past the freshness window without running any timer.
    s.t.browser.timers.now += STALE_MS;
    const before = s.t.browser.backend.count('/v1/app');
    const m = await shownForApproval(s);
    expect(m.autoApprove).toBeUndefined();
    expect(s.t.browser.backend.count('/v1/app')).toBe(before + 1);
    expect(s.t.events.some((e) => e.event === 'autoApproved')).toBe(false);
  });

  it('a removal stops auto-signing once the last check is 10 s old, with no timer run', async () => {
    const s = await session();
    await grant(s);
    s.t.browser.backend.autoApprovePolicy = null;
    // Within the bound the cached check still holds (one burst shares one read)…
    s.t.browser.timers.now += POLICY_FRESH_MS - 1_000;
    expect((await s.t.request('eth_signTransaction', { tx: evmTx() })).result).toMatch(/^0x02/u);
    // …and at the bound it is re-read first: the removed policy signs nothing more.
    s.t.browser.timers.now += POPUP_REUSE_MS + 1;
    const m = await shownForApproval(s);
    expect(m.autoApprove).toBeUndefined();
    expect(s.t.events.filter((e) => e.event === 'autoApproved')).toHaveLength(1);
  });

  it('a fresh check signs without another GET /v1/app', async () => {
    const s = await session();
    await grant(s);
    const before = s.t.browser.backend.count('/v1/app');
    expect((await s.t.request('eth_signTransaction', { tx: evmTx() })).result).toMatch(/^0x02/u);
    expect(s.t.browser.backend.count('/v1/app')).toBe(before);
  });

  it('a changed policy (another policyId) served by the API is no policy until a reload', async () => {
    const s = await session();
    await grant(s);
    s.t.browser.backend.autoApprovePolicy = { ...POLICY(), limits: { perDayCount: 4 } };
    s.t.browser.timers.now += STALE_MS;
    const m = await shownForApproval(s);
    expect(m.autoApprove).toBeUndefined();
    expect(s.t.events.some((e) => e.event === 'autoApproved')).toBe(false);
  });

  it('a failed re-read sends that request to approval; the next good one signs again', async () => {
    const s = await session();
    await grant(s);
    const backend = s.t.browser.backend;
    backend.overrides.set('/v1/app', () => apiError(503, 'config_unavailable'));
    s.t.browser.timers.now += STALE_MS;
    const m = await shownForApproval(s);
    expect(m.autoApprove).toBeUndefined();
    backend.overrides.delete('/v1/app');
    expect((await s.t.request('eth_signTransaction', { tx: evmTx({ nonce: '0x7' }) })).result).toMatch(/^0x02/u);
    expect(await s.t.waitEvent('autoApproved')).toMatchObject({ kind: 'eth_signTransaction' });
  });

  it('a consent screen answered after the policy was removed signs nothing under it', async () => {
    const s = await session();
    const reply = s.t.request('eth_signTransaction', { tx: evmTx() });
    const { popup, m } = await consentScreen(s);
    s.t.browser.backend.autoApprovePolicy = null;
    s.t.browser.timers.now += STALE_MS;
    answerConsent(s.t, popup, m, true);
    const a = await popup.next('hana:approve-request');
    answer(s.t, popup, a, false);
    expect((await reply).error?.code).toBe(4001);
    expect(s.t.events.some((e) => e.event === 'autoApproved')).toBe(false);
  });
});

describe('persistence and tabs', () => {
  it('counters survive a reload (inside the encrypted record) and are shared across tabs', async () => {
    const browser = new Browser();
    const a = await session(browser);
    await grant(a);
    expect((await a.t.request('eth_signTransaction', { tx: evmTx({ gas: '0x5208' }) })).result).toMatch(/^0x02/u);
    const b = await session(browser);
    expect((await b.t.request('hana_autoApproveStatus')).result).toMatchObject({ policyId: PID, used: { count: 1 } });
    expect((await b.t.request('eth_signTransaction', { tx: evmTx({ nonce: '0x2', gas: '0x5208' }) })).result).toMatch(/^0x02/u);
    expect((await a.t.request('eth_signTransaction', { tx: evmTx({ nonce: '0x3', gas: '0x5208' }) })).result).toMatch(/^0x02/u);
    // The third is used up across both tabs: the fourth (in either tab) needs approval. Gas 21 000 keeps the four
    // maximum fees (84 000) inside the daily value limit, so the count is what runs out.
    const fourth = b.t.request('eth_signTransaction', { tx: evmTx({ nonce: '0x4', gas: '0x5208' }) });
    await waitLabel(b.t, 'Review in Hana');
    const popup = openApproval(b.t);
    const m = await popup.next('hana:approve-request');
    expect((m.autoApprove as { reason: string }).reason).toBe('daily_count_reached');
    answer(b.t, popup, m, false);
    await fourth;
  });

  it('hana_autoApproveStatus answers a dormant session from the last known consent, without an unlock', async () => {
    const s = await session();
    await grant(s);
    expect((await s.t.request('eth_signTransaction', { tx: evmTx() })).result).toMatch(/^0x02/u);
    const unlocks = () => s.t.browser.backend.count('/v1/vault/unlock');
    // The idle limit (2 h) passes with no request that uses the key: PRK is gone, the session dormant.
    s.t.browser.timers.advance(2 * HOUR);
    expect((s.t.vault as unknown as { session: unknown }).session).toBeNull();
    const before = unlocks();
    expect((await s.t.request('hana_autoApproveStatus')).result).toEqual({ policyId: PID, label: 'Swaps on Example', expiresAtMs: START_MS + 6 * HOUR, used: { count: 1, native: '100000' } });
    expect(unlocks()).toBe(before);
    expect((s.t.vault as unknown as { session: unknown }).session).toBeNull();
    // The next signature unlocks (it uses the key) and is still auto-approved under the consent in the record.
    expect((await s.t.request('eth_signTransaction', { tx: evmTx({ nonce: '0x2' }) })).result).toMatch(/^0x02/u);
    expect(unlocks()).toBe(before + 1);
    expect((await s.t.request('hana_autoApproveStatus')).result).toMatchObject({ used: { count: 2 } });
  });

  it('a changed policy (new policyId) ignores the old consent', async () => {
    const browser = new Browser();
    const a = await session(browser);
    await grant(a);
    const changed = { ...POLICY(), limits: { perDayCount: 4 } };
    const b = await session(browser, changed);
    expect((await b.t.request('hana_autoApproveStatus')).result).toBeNull();
    const reply = b.t.request('eth_signTransaction', { tx: evmTx() });
    const { popup, m } = await consentScreen(b);
    expect(m.policyId).toBe(policyId(changed, { sessionTtlMs: 12 * HOUR }));
    expect(m.policyId).not.toBe(PID);
    answerConsent(b.t, popup, m, true);
    expect((await reply).result).toMatch(/^0x02/u);
  });

  it('a record with a tampered consent fails its check: the record is deleted and the vault disconnects', async () => {
    const browser = new Browser();
    const a = await session(browser);
    await grant(a);
    const store = await openRecordStore(browser.idb);
    const key = recordKey(ENV.signer, APP_ID, SCOPE, 0);
    const r = (await store.get(key)) as { consent: { ct: Uint8Array } };
    r.consent.ct[0]! ^= 1;
    await store.put(key, r as never);
    expect((await a.t.request('eth_signTransaction', { tx: evmTx() })).error?.code).toBe(4900);
    expect(await store.get(key)).toBeUndefined();
  });

  it('"none" mode keeps the consent in memory', async () => {
    const s = await session(new Browser(), POLICY(), { settings: { persistence: 'none' } });
    await grant(s);
    expect((await s.t.request('eth_signTransaction', { tx: evmTx() })).result).toMatch(/^0x02/u);
  });
});

describe('the consent ends', () => {
  it('at its expiry', async () => {
    const s = await session();
    await grant(s);
    s.t.browser.timers.advance(6 * HOUR);
    expect((await s.t.request('hana_autoApproveStatus')).result).toBeNull();
  });

  it('at session expiry, when that comes first', async () => {
    const s = await session(new Browser(), { ...POLICY(), maxConsentMs: 12 * HOUR });
    const reply = s.t.request('hana_requestAutoApprove');
    const { popup, m } = await consentScreen(s);
    expect(m.expiresAtMs).toBe(START_MS + 12 * HOUR);
    answerConsent(s.t, popup, m, true);
    await reply;
  });

  it('on hana_revokeAutoApprove', async () => {
    const s = await session();
    await grant(s);
    expect((await s.t.request('hana_revokeAutoApprove')).result).toBeNull();
    expect((await s.t.request('hana_autoApproveStatus')).result).toBeNull();
  });

  it('on "Stop auto-approving" in the approval popup (only from the vault\'s popup)', async () => {
    const s = await session();
    const popup = await grant(s);
    s.t.dispatch({ data: { v: 1, t: 'hana:auto-approve-stop' }, origin: 'https://evil.test', source: popup });
    await sleepReal(20);
    expect((await s.t.request('hana_autoApproveStatus')).result).not.toBeNull();
    s.t.dispatch({ data: { v: 1, t: 'hana:auto-approve-stop' }, origin: ENV.authOrigin, source: popup });
    for (let i = 0; i < 50 && (await s.t.request('hana_autoApproveStatus')).result !== null; i++) await sleepReal(5);
    expect((await s.t.request('hana_autoApproveStatus')).result).toBeNull();
  });

  it('on logout (the record and its consent are gone)', async () => {
    const browser = new Browser();
    const s = await session(browser);
    await grant(s);
    await s.t.request('hana_logout');
    const again = await session(browser);
    expect((await again.t.request('hana_autoApproveStatus')).result).toBeNull();
  });
});
