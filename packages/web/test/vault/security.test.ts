// Invariants (docs/batch-b-spec.md "Invariants"; Tests → Web unit: the postMessage and BroadcastChannel spy plus a
// fuzz test): no message in any direction carries key bytes, PRK, K_s, a CKD response, a Google token or the relay
// read key; relayKey goes only to the authenticated login popup on authOrigin; malformed messages never break the vault.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { base64UrlDecode, toHex, utf8 } from '@hana-id/core';
import { evmPrivateKey, stellarSeed } from '@hana-id/core/derivation';
import { Browser, ENV, FakeWindow, type Google, PARTNER, type Tab, answer, google, login, openApproval, readyTab, sleepReal } from './harness.ts';
import { evmTx } from './chains.ts';

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

/** Every byte string inside a structured-clone value, as hex, plus every string. */
function flatten(v: unknown, out: string[] = []): string[] {
  if (v instanceof Uint8Array) out.push(toHex(v));
  else if (typeof v === 'string') out.push(v, toHex(utf8(v)));
  else if (Array.isArray(v)) {
    // Number arrays could carry bytes too.
    if (v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) out.push(toHex(Uint8Array.from(v as number[])));
    for (const x of v) flatten(x, out);
  } else if (v && typeof v === 'object') for (const x of Object.values(v)) flatten(x, out);
  return out;
}

const contains = (haystack: string[], secretHex: string) => haystack.some((h) => h.includes(secretHex));

describe('no secret crosses postMessage or the BroadcastChannel', () => {
  it('through login, reload, signing, export and logout', async () => {
    const browser = new Browser();
    const t = await readyTab(browser, { googleJwk: g.jwk });
    tabs.push(t);
    const { run, token } = await login(t, g);
    const prk = Uint8Array.from((t.vault as unknown as { session: { prk: Uint8Array } }).session.prk);
    // A second tab unlocks (K_s crosses only the API response).
    const t2 = await readyTab(browser, { googleJwk: g.jwk });
    tabs.push(t2);
    // A signature through the popup, and an export context.
    const sign = t.request('eth_signTransaction', { tx: evmTx() });
    for (let i = 0; i < 100 && t.launcher.label === null; i++) await sleepReal(5);
    const popup = openApproval(t);
    answer(t, popup, await popup.next('hana:approve-request'), true);
    await sign;
    const exp = t.request('hana_export', { chain: 'evm' });
    for (let i = 0; i < 100 && t.launcher.label !== 'Export key in Journear Passport'; i++) await sleepReal(5);
    t.launcher.click();
    const w = t.opened.at(-1)!;
    t.dispatch({ data: { v: 1, t: 'hana:export-hello' }, origin: ENV.authOrigin, source: w });
    await exp;
    await t.request('hana_logout');

    const secrets: [string, string][] = [
      ['PRK', toHex(prk)],
      ['the Stellar seed', toHex(stellarSeed(prk))],
      ['the EVM key', toHex(evmPrivateKey(prk))],
      ['the Google token', toHex(utf8(token))],
      ...[...browser.backend.shares.values()].map((s) => ['K_s', toHex(s.ks)] as [string, string]),
      ...browser.backend.calls.filter((c) => c.headers['x-hana-relay-key']).map((c) => ['relayReadKey', toHex(base64UrlDecode(c.headers['x-hana-relay-key']!))] as [string, string]),
      ...[...browser.backend.txs.values()].map((r) => ['the CKD response', toHex(utf8((r as { big_c: string }).big_c))] as [string, string]),
    ];
    expect(secrets.filter(([n]) => n === 'the CKD response').length).toBeGreaterThan(0);
    const relayKey = toHex(run.params.relayKey as Uint8Array);

    const toPartner = flatten([...t.portMessages, ...t2.portMessages]);
    const toPopups = [...t.opened, run.popup, ...t2.opened].map((p) => ({ p, flat: flatten(p.posted.map((x) => x.message)) }));
    const broadcast = flatten(browser.bus.sent.map((m) => m.data));
    for (const [name, hex] of secrets) {
      expect(contains(toPartner, hex), `${name} reached the partner`).toBe(false);
      expect(contains(broadcast, hex), `${name} was broadcast`).toBe(false);
      for (const { p, flat } of toPopups) expect(contains(flat, hex), `${name} reached ${p.url}`).toBe(false);
    }
    // relayKey: only in the auth-params to the login popup, posted to authOrigin.
    expect(contains(toPartner, relayKey)).toBe(false);
    expect(contains(broadcast, relayKey)).toBe(false);
    for (const { p, flat } of toPopups) {
      if (p === run.popup) {
        expect(p.posted.map((x) => [x.message.t, x.targetOrigin])).toEqual([['hana:auth-params', ENV.authOrigin]]);
        expect(contains(flat, relayKey)).toBe(true);
      } else expect(contains(flat, relayKey)).toBe(false);
    }
    // The parent window got nothing at all (it talks on its port).
    expect(t.parent.posted).toHaveLength(0);
    // Every port message is an event or a reply in the envelope.
    for (const m of t.portMessages) expect(Object.keys(m as object).sort()).toSatisfy((k: string[]) => ['data,event,v', 'id,result,v', 'error,id,v'].includes(k.join(',')));
  });
});

// ---- fuzz ----

/** A small deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const ODD_VALUES: unknown[] = [null, undefined, 0, -1, 1.5, 2 ** 53, '', 'x'.repeat(300), '0x', [], {}, [1, 2], new Uint8Array(0), new Uint8Array(33), true, { v: 1 }, '__proto__', 'constructor'];

function mutate(base: Record<string, unknown>, rnd: () => number): Record<string, unknown> {
  const m: Record<string, unknown> = structuredClone(base);
  const keys = Object.keys(m);
  const n = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const r = rnd();
    const k = keys[Math.floor(rnd() * keys.length)]!;
    if (r < 0.3) delete m[k];
    else if (r < 0.8) m[k] = ODD_VALUES[Math.floor(rnd() * ODD_VALUES.length)];
    else m[`extra${i}`] = ODD_VALUES[Math.floor(rnd() * ODD_VALUES.length)];
  }
  return m;
}

describe('fuzz', () => {
  it('mutated port requests and window messages never break the vault and never reach a signature or a secret', async () => {
    const t = await readyTab(new Browser(), { googleJwk: g.jwk });
    tabs.push(t);
    await login(t, g);
    const prk = toHex((t.vault as unknown as { session: { prk: Uint8Array } }).session.prk);
    const rnd = prng(42);
    const portBases: Record<string, unknown>[] = [
      { v: 1, id: 'f', method: 'hana_status' },
      { v: 1, id: 'f', method: 'hana_export', params: { chain: 'evm' } },
      { v: 1, id: 'f', method: 'personal_sign', params: ['0x00', '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23'] },
      { v: 1, id: 'f', method: 'hana_signRaw', params: { chain: 'evm', digest: new Uint8Array(32) } },
      { v: 1, id: 'f', method: 'eth_signTransaction', params: { tx: evmTx() } },
    ];
    const popup = new FakeWindow('x', 'x', '', t.parent);
    const windowBases: Record<string, unknown>[] = [
      { v: 1, t: 'hana:hello', sdk: '0.0.0' },
      { v: 1, t: 'hana:auth-hello' },
      { v: 1, t: 'hana:approve-hello' },
      { v: 1, t: 'hana:approve-result', id: 'ab'.repeat(16), approved: true, digest: new Uint8Array(32) },
      { v: 1, t: 'hana:consent-result', id: 'ab'.repeat(16), allowed: true, digest: new Uint8Array(32) },
      { v: 1, t: 'hana:export-hello' },
      { v: 1, t: 'hana:auto-approve-stop' },
    ];
    for (let i = 0; i < 300; i++) {
      const p = mutate(portBases[i % portBases.length]!, rnd);
      p.id = `fz${i}`;
      t.port.postMessage(p);
      const w = mutate(windowBases[i % windowBases.length]!, rnd);
      t.dispatch({ data: w, origin: rnd() < 0.5 ? ENV.authOrigin : PARTNER, source: rnd() < 0.5 ? popup : t.parent, ports: [] });
    }
    await sleepReal(100);
    // Still serving, still logged in.
    expect((await t.request('hana_status')).result).toMatchObject({ status: 'logged_in' });
    // No fuzzed request got a signature (none was approved), and nothing posted carries PRK.
    const replies = t.replies.filter((r) => String(r.id).startsWith('fz'));
    for (const r of replies) {
      if (r.error) continue;
      expect(typeof r.result === 'string' && /^0x[0-9a-f]{130}$/iu.test(r.result)).toBe(false);
      expect(r.result === null || typeof r.result === 'object').toBe(true);
    }
    expect(contains(flatten(t.portMessages), prk)).toBe(false);
    expect(popup.posted).toHaveLength(0);
    // Pending fuzzed sign requests are cancelled cleanly on logout.
    await t.request('hana_logout');
    expect((await t.request('hana_status')).result).toMatchObject({ status: 'logged_out' });
  });
});
