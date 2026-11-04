// The vault's wallet record (D310 point 3, D317): after a login, POST /v1/wallets/record with both addresses, each
// signed by its own key for the session's path; in the background (the login's result never waits for it), once, with a
// 15 s limit, never a key. The member case (the account root's path) is in linking.test.ts.
import { WALLET_RECORD_TIMEOUT_MS, verifyWalletRecord, verifyWalletRecordSession } from '@hana-id/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { APP_ID, Browser, ENV, type Google, PK, SCOPE, SUB, type Tab, apiError, google, login, readyTab, sleepReal } from './harness.ts';

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

async function tab(browser = new Browser()): Promise<Tab> {
  const t = await readyTab(browser, { googleJwk: g.jwk });
  tabs.push(t);
  return t;
}

const records = (t: Tab) => t.browser.backend.calls.filter((c) => c.path === '/v1/wallets/record');
type Body = { sessionPublicKey: number[]; issuedAtMs: number; path: string; wallets: Record<'stellar' | 'evm', { address: string; signature: number[] }>; sessionSignature: number[] };

describe('the wallet record after a login', () => {
  it('sends both addresses once, each signed by its own key for the session’s path and key, and nothing else', async () => {
    const t = await tab();
    const { reply } = await login(t, g);
    const addresses = (reply.result as { addresses: { stellar: string; evm: string } }).addresses;
    await t.waitUntil(() => records(t).length === 1, 'the record');
    const call = records(t)[0]!;
    expect(call.method).toBe('POST');
    expect([call.headers['x-hana-key'], call.headers['x-hana-parent-origin']]).toEqual([PK, 'https://partner.test']);
    const body = call.body as Body;
    expect(Object.keys(body).sort()).toEqual(['issuedAtMs', 'path', 'sessionPublicKey', 'sessionSignature', 'wallets']);
    expect(Object.keys(body.wallets).sort()).toEqual(['evm', 'stellar']);
    for (const w of Object.values(body.wallets)) expect(Object.keys(w).sort()).toEqual(['address', 'signature']);
    const session = (t.vault as unknown as { session: { sessionPk: Uint8Array; prk: Uint8Array } }).session;
    expect(body.path).toBe(`${SCOPE}#google#${SUB}#0`);
    expect([...t.browser.backend.sessions.values()][0]!.path).toBe(body.path);
    expect(body.sessionPublicKey).toEqual([...session.sessionPk]);
    expect(body.issuedAtMs).toBe(t.browser.timers.now);
    const ctx = { env: ENV.name, signer: ENV.signer, appId: APP_ID, scopeId: SCOPE, path: body.path, sessionPublicKey: session.sessionPk, issuedAtMs: body.issuedAtMs };
    for (const chain of ['stellar', 'evm'] as const) {
      expect(body.wallets[chain].address).toBe(addresses[chain]);
      expect(verifyWalletRecord(ctx, chain, { address: body.wallets[chain].address, signature: Uint8Array.from(body.wallets[chain].signature) })).toBe(addresses[chain]);
    }
    // The whole request is signed by this session's key (D311 as amended): the API refuses it otherwise.
    const proofs = { stellar: { address: body.wallets.stellar.address, signature: Uint8Array.from(body.wallets.stellar.signature) }, evm: { address: body.wallets.evm.address, signature: Uint8Array.from(body.wallets.evm.signature) } };
    expect(body.sessionSignature).toHaveLength(64);
    expect(verifyWalletRecordSession(ctx, proofs, Uint8Array.from(body.sessionSignature))).toBe(true);
    expect(verifyWalletRecordSession({ ...ctx, path: `${SCOPE}#google#other#0` }, proofs, Uint8Array.from(body.sessionSignature))).toBe(false);
    // No key material: the PRK's bytes appear nowhere in the body.
    const prkHex = Buffer.from(session.prk).toString('hex');
    expect(JSON.stringify(body)).not.toContain(prkHex);
    expect(JSON.stringify([...session.prk])).not.toBe('[]');
    expect(JSON.stringify(body)).not.toContain(JSON.stringify([...session.prk]).slice(1, -1));
    await sleepReal(20);
    expect(records(t)).toHaveLength(1);
  });

  it('a failing record leaves the login untouched and is never retried', async () => {
    const browser = new Browser();
    browser.backend.walletRecord = () => apiError(503, 'directory_unavailable');
    const t = await tab(browser);
    const { reply } = await login(t, g);
    expect(reply.error).toBeUndefined();
    expect((reply.result as { persistence: string }).persistence).toBe('session');
    await t.waitUntil(() => records(t).length === 1, 'the record');
    browser.timers.advance(10 * WALLET_RECORD_TIMEOUT_MS);
    await sleepReal(20);
    expect(records(t)).toHaveLength(1);
    expect(t.events.some((e) => e.event === 'persistenceChanged')).toBe(false);
    expect((await t.request('hana_status')).result).toMatchObject({ status: 'logged_in' });
  });

  it('a hung record never holds the login, and is aborted after 15 s', async () => {
    const browser = new Browser();
    let signal: AbortSignal | undefined;
    browser.backend.walletRecord = (_b, s) => {
      signal = s;
      return new Promise<never>(() => undefined);
    };
    const t = await tab(browser);
    const { reply } = await login(t, g);
    expect(reply.error).toBeUndefined();
    await t.waitUntil(() => signal !== undefined, 'the record');
    expect(signal!.aborted).toBe(false);
    browser.timers.advance(WALLET_RECORD_TIMEOUT_MS - 1);
    expect(signal!.aborted).toBe(false);
    browser.timers.advance(1);
    expect(signal!.aborted).toBe(true);
    expect(records(t)).toHaveLength(1);
  });

  it('a thrown network error is dropped too', async () => {
    const browser = new Browser();
    browser.backend.walletRecord = () => {
      throw new TypeError('Failed to fetch');
    };
    const t = await tab(browser);
    const { reply } = await login(t, g);
    expect(reply.error).toBeUndefined();
    await t.waitUntil(() => records(t).length === 1, 'the record');
    await sleepReal(20);
    expect((await t.request('hana_status')).result).toMatchObject({ status: 'logged_in' });
  });

  it('a newer login records again, for its own session', async () => {
    const t = await tab();
    await login(t, g);
    await login(t, g);
    await t.waitUntil(() => records(t).length === 2, 'two records');
    const [a, b] = records(t).map((c) => c.body as Body);
    expect(a!.sessionPublicKey).not.toEqual(b!.sessionPublicKey);
  });
});
