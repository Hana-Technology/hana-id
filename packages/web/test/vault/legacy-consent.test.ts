// A consent stored before registering existed (Hana Home H5, D531): no consent id, so the API can't see it and can't
// stop it remotely. It must never auto-sign: it is dropped at its first read and the user is asked again.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { functionSelector } from '@hana-id/core/decode';
import { openRecordStore, recordKey } from '../../src/vault/record.ts';
import { APP_ID, Browser, ENV, type Google, HOUR, type Tab, SCOPE, answerConsent, google, login, makeConfig, openApproval, readyTab, waitLauncher } from './harness.ts';
import { CHAIN, EVM_VAULT, evmTx, evmTxSigner } from './chains.ts';

/** Strips `consentId` from what `openConsent` returns once armed: a record written before registering existed. */
const legacy = vi.hoisted(() => ({ armed: false }));
vi.mock('../../src/vault/record.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/vault/record.ts')>();
  return {
    ...actual,
    openConsent: async (prk: Uint8Array, record: Parameters<typeof actual.openConsent>[1]) => {
      const consent = await actual.openConsent(prk, record);
      if (!legacy.armed || !consent) return consent;
      const { consentId: _dropped, ...rest } = consent;
      return rest;
    },
  };
});

let g: Google;
const tabs: Tab[] = [];
beforeAll(async () => {
  g = await google();
});
afterEach(() => {
  legacy.armed = false;
  for (const t of tabs.splice(0)) {
    t.close();
    t.browser.timers.dispose();
  }
});

const POLICY = () => ({
  v: 1,
  label: 'Swaps',
  maxConsentMs: 6 * HOUR,
  limits: { perDayCount: 5 },
  evm: { chains: [{ chainId: CHAIN, maxValueWei: '101000', maxValueWeiPerDay: '900000', maxFeeWei: '100000', contracts: [{ address: EVM_VAULT, name: 'Vault', selectors: [{ selector: functionSelector('deposit(uint256)'), signature: 'deposit(uint256)' }] }] }] },
});

async function open(browser: Browser): Promise<Tab> {
  browser.backend.serverNow = () => browser.timers.now;
  const t = await readyTab(browser, { googleJwk: g.jwk, config: makeConfig({ settings: { autoApprovePolicy: POLICY() } }) });
  tabs.push(t);
  return t;
}

async function loggedIn(browser: Browser): Promise<{ t: Tab; evm: string }> {
  const t = await open(browser);
  const status = (await t.ready()) as { status: string; addresses?: { evm: string } };
  if (status.status === 'logged_in') return { t, evm: status.addresses!.evm };
  const { reply } = await login(t, g);
  return { t, evm: (reply.result as { addresses: { evm: string } }).addresses.evm };
}

describe('a consent stored before registering existed', () => {
  it('never auto-signs: it is cleared from the record at its first read and the user is asked again', async () => {
    const browser = new Browser();
    const { t } = await loggedIn(browser);
    // Stored by a vault at the new code, then read back as a pre-H5 record would be (no id).
    const pending = t.request('hana_requestAutoApprove');
    await waitLauncher(t, 'Review in Journear Passport');
    const popup = openApproval(t);
    answerConsent(t, popup, await popup.next('hana:consent-request'), true);
    expect((await pending).result).toMatchObject({ granted: true });

    legacy.armed = true;
    const reloaded = await loggedIn(browser);

    // Its status reads nothing (it never was on the API), and the record no longer holds it.
    expect((await reloaded.t.request('hana_autoApproveStatus')).result).toBeNull();
    const store = await openRecordStore(browser.idb);
    const r = (await store.get(recordKey(ENV.signer, APP_ID, SCOPE, 0))) as { consent?: unknown };
    expect(r.consent).toBeUndefined();

    // The next covered request shows the consent screen again (and registers), never signs silently.
    legacy.armed = false;
    const before = browser.backend.count('/v1/vault/consents');
    const tx = evmTx();
    const reply = reloaded.t.request('eth_signTransaction', { tx });
    await waitLauncher(reloaded.t, 'Review in Journear Passport');
    const p2 = openApproval(reloaded.t);
    answerConsent(reloaded.t, p2, await p2.next('hana:consent-request'), true);
    expect(evmTxSigner((await reply).result as string, tx)).toBe(reloaded.evm);
    expect(browser.backend.count('/v1/vault/consents')).toBe(before + 1);
  });
});
