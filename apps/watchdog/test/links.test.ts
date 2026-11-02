// The link-volume check's event source (FastNear's transactions API) against a stubbed fetch, and the email pins'
// parsing and policy verdicts. No network.
import { describe, expect, it } from 'vitest';
import type { EmailSnapshot } from '../src/chain.ts';
import { FastNearLinkEvents, linkEventsOf, linkVolumeConfig, MAX_TXS, SETTLE_BLOCKS, TX_BATCH } from '../src/links.ts';
import { emailKeyVerdict, parsePins, policyFindings, policyId } from '../src/pins.ts';
import { emailJwk, pinsOf } from './helpers.ts';

const SIGNER = 'signer.test.near';
const NS = 1_793_580_000_000_000_000n; // a block time in ns (past 2^53, as the indexer sends it)
const ev = (event: string, data: object) => `EVENT_JSON:${JSON.stringify({ standard: 'hana-id', version: '1.2.0', event, data: [data] })}`;
const receipt = (o: { executor?: string; logs: string[]; status?: unknown; id?: string }) => ({
  execution_outcome: { id: o.id ?? 'rcpt1', block_height: 500, block_timestamp: Number(NS), outcome: { executor_id: o.executor ?? SIGNER, logs: o.logs, status: o.status ?? { SuccessValue: '' } } },
});

describe('linkEventsOf', () => {
  it("keeps the signer's own link events from receipts that succeeded", () => {
    const linked = ev('identity_linked', { scope_id: 's1', root: 'aa', member: 'bb', provider: 'google', effective_at_ms: 1, auto: true });
    const proposed = ev('identity_link_proposed', { scope_id: 's2', root: 'aa', member: 'cc', provider: 'email', effective_at_ms: 2, auto: false });
    const cancelled = ev('identity_link_cancelled', { scope_id: 's2', root: 'aa', member: 'cc', provider: 'email', by: 'dd' });
    const tx = {
      receipts: [
        receipt({ logs: ['plain log', linked, proposed], id: 'r1' }),
        receipt({ logs: [cancelled], id: 'r2', status: { SuccessReceiptId: 'x' } }),
        // Another account can log anything: ignored.
        receipt({ executor: 'evil.test.near', logs: [linked], id: 'r3' }),
        // A failed receipt's logs are recorded but its link was reverted: ignored.
        receipt({ logs: [linked], id: 'r4', status: { Failure: { ActionError: {} } } }),
      ],
    };
    expect(linkEventsOf(tx, SIGNER)).toEqual([
      { id: 'r1:1:0', event: 'identity_linked', scope_id: 's1', provider: 'google', auto: true, at: Number(NS / 1_000_000n), block_height: 500 },
      { id: 'r1:2:0', event: 'identity_link_proposed', scope_id: 's2', provider: 'email', auto: false, at: Number(NS / 1_000_000n), block_height: 500 },
      { id: 'r2:0:0', event: 'identity_link_cancelled', scope_id: 's2', provider: 'email', auto: null, at: Number(NS / 1_000_000n), block_height: 500 },
    ]);
  });

  it('ignores other standards and events, malformed logs and oversized fields', () => {
    const logs = [
      `EVENT_JSON:${JSON.stringify({ standard: 'nep141', event: 'identity_linked', data: [{ scope_id: 's1', provider: 'google' }] })}`,
      ev('issuer_key_set', { scope_id: 's1', provider: 'google' }),
      'EVENT_JSON:{not json',
      ev('identity_linked', { scope_id: 'x'.repeat(65), provider: 'google' }),
      ev('identity_linked', { scope_id: 's1', provider: 7 }),
    ];
    expect(linkEventsOf({ receipts: [receipt({ logs })] }, SIGNER)).toEqual([]);
    expect(linkEventsOf({ receipts: 'nope' }, SIGNER)).toEqual([]);
    expect(linkEventsOf({}, SIGNER)).toEqual([]);
  });
});

type Call = { url: string; body: Record<string, unknown> | null };
function indexer(o: { latest?: number; txs?: { transaction_hash: string; tx_block_height: number; tx_block_timestamp: string }[]; tx?: (hash: string) => object; fail?: string }) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, body });
    const path = new URL(url).pathname;
    if (o.fail === path) return new Response('down', { status: 503 });
    if (path === '/status') return Response.json({ status: 'ok', latest_block_height: o.latest ?? 10_000, latest_tx_block_height: o.latest ?? 10_000, latest_block_timestamp: NS.toString() });
    if (path === '/v0/account') return Response.json({ account_txs: o.txs ?? [], txs_count: (o.txs ?? []).length });
    if (path === '/v0/transactions') return Response.json({ transactions: (body!.tx_hashes as string[]).map((h) => o.tx?.(h) ?? { receipts: [] }) });
    return new Response('?', { status: 404 });
  }) as typeof fetch;
  return { calls, src: new FastNearLinkEvents('https://tx.test.fastnear.com/', SIGNER, fetchFn) };
}
const now = Number(NS / 1_000_000n) + 2_000;

describe('FastNearLinkEvents', () => {
  it('starts at the head without reading transactions (no backfill)', async () => {
    const { calls, src } = indexer({});
    expect(await src.scan(null, now)).toEqual({ events: [], scannedTo: 10_000 - SETTLE_BLOCKS, latestHeight: 10_000, behindMs: 2_000, truncated: false });
    expect(calls.map((c) => c.url)).toEqual(['https://tx.test.fastnear.com/status']);
  });

  it("reads the signer's transactions from the cursor to the settled head, in batches of 20", async () => {
    const txs = Array.from({ length: 25 }, (_, i) => ({ transaction_hash: `h${i}`, tx_block_height: 9_000 + i, tx_block_timestamp: NS.toString() }));
    const { calls, src } = indexer({ txs, tx: (h) => ({ receipts: h === 'h3' ? [receipt({ logs: [ev('identity_linked', { scope_id: 's1', provider: 'google', auto: true })] })] : [] }) });
    const scan = await src.scan(9_000, now);
    expect(scan.events.map((e) => e.scope_id)).toEqual(['s1']);
    expect(scan).toMatchObject({ scannedTo: 10_000 - SETTLE_BLOCKS, truncated: false });
    expect(calls[1]).toEqual({ url: 'https://tx.test.fastnear.com/v0/account', body: { account_id: SIGNER, from_tx_block_height: 9_000, to_tx_block_height: 10_000 - SETTLE_BLOCKS, desc: false, limit: MAX_TXS } });
    expect(calls.slice(2).map((c) => (c.body!.tx_hashes as string[]).length)).toEqual([TX_BATCH, 5]);
  });

  it('a full page stops before its last block (re-read next run) and reports how far behind it is', async () => {
    const old = (NS - 2n * 3_600_000_000_000n).toString();
    const txs = Array.from({ length: MAX_TXS }, (_, i) => ({ transaction_hash: `h${i}`, tx_block_height: 5_000 + Math.floor(i / 2), tx_block_timestamp: old }));
    const { calls, src } = indexer({ txs });
    const scan = await src.scan(5_000, now);
    expect(scan.truncated).toBe(true);
    expect(scan.scannedTo).toBe(5_000 + 49 - 1);
    expect(scan.behindMs).toBeGreaterThan(2 * 3_600_000);
    // The last block's two transactions aren't fetched: the next scan starts at that block.
    const fetched = calls.slice(2).flatMap((c) => c.body!.tx_hashes as string[]);
    expect(fetched).toHaveLength(MAX_TXS - 2);
  });

  it('reads nothing when the cursor is past the settled head', async () => {
    const { calls, src } = indexer({});
    expect(await src.scan(10_000, now)).toMatchObject({ events: [], scannedTo: 9_999 });
    expect(calls).toHaveLength(1);
  });

  it('throws on an indexer error or an unexpected shape', async () => {
    await expect(indexer({ fail: '/status' }).src.scan(1, now)).rejects.toThrow(/HTTP 503/u);
    await expect(indexer({ fail: '/v0/account' }).src.scan(1, now)).rejects.toThrow(/HTTP 503/u);
    await expect(indexer({ txs: [{ nope: 1 } as never] }).src.scan(1, now)).rejects.toThrow(/unexpected shape/u);
  });
});

describe('linkVolumeConfig', () => {
  it('reads overrides and keeps the defaults for anything unreadable', () => {
    expect(linkVolumeConfig(undefined)).toEqual({ thresholds: { perHour: 100, perScopePerHour: 20 }, problems: [] });
    expect(linkVolumeConfig('{"perScopePerHour":5}').thresholds).toEqual({ perHour: 100, perScopePerHour: 5 });
    expect(linkVolumeConfig('{"perHour":0}').problems).toHaveLength(1);
    expect(linkVolumeConfig('nope').problems).toHaveLength(1);
  });
});

describe('parsePins', () => {
  const tp = (c: string) => c.repeat(43);
  it('absent: nothing pinned; well-formed: as written', () => {
    expect(parsePins(undefined)).toEqual({ pins: null, problems: [] });
    expect(parsePins('')).toEqual({ pins: null, problems: [] });
    expect(parsePins(JSON.stringify({ required: 1, signers: { hana: [tp('a')] } }))).toEqual({ pins: { required: 1, signers: { hana: [tp('a')] } }, problems: [] });
  });

  it('malformed: nothing pinned (never looser), with the problem for the config check', () => {
    for (const raw of ['{', '[]', '{"required":2,"signers":{"hana":["' + tp('a') + '"]}}', '{"required":1,"signers":{"hana":[]}}', '{"required":1,"signers":{"Hana":["' + tp('a') + '"]}}', '{"required":1,"signers":{"hana":["short"]}}', '{"required":1,"signers":{"a":["' + tp('a') + '"],"b":["' + tp('a') + '"]}}']) {
      const r = parsePins(raw);
      expect(r.pins, raw).toBeNull();
      expect(r.problems, raw).toHaveLength(1);
    }
  });
});

describe('emailKeyVerdict and policyFindings', () => {
  it('judges a key by thumbprint, kid and signer; without material by kid', async () => {
    const hana = await emailJwk(201);
    const pins = pinsOf({ hana: [hana] });
    const k = { kid: hana.kid, n: hana.n, e: hana.e };
    expect((await emailKeyVerdict(pins, k, 'hana', true)).reason).toBeNull();
    expect((await emailKeyVerdict(pins, k, null, false)).reason).toBeNull();
    expect((await emailKeyVerdict(pins, k, null, true)).reason).toBe('no_signer');
    expect((await emailKeyVerdict(pins, k, 'cosign', true)).reason).toBe('other_signer');
    expect((await emailKeyVerdict(pins, { ...k, kid: 'x' }, 'hana', true)).reason).toBe('kid_not_thumbprint');
    expect((await emailKeyVerdict(null, k, 'hana', true)).reason).toBe('not_pinned');
    expect((await emailKeyVerdict(pins, { kid: hana.kid, n: null, e: null }, 'hana', false)).reason).toBeNull();
    expect((await emailKeyVerdict(pins, { kid: 'other', n: null, e: null }, 'hana', false)).reason).toBe('not_pinned');
  });

  it('a pre-v3 contract and an env before set_issuer have no findings; ids name the chain state', async () => {
    const none: EmailSnapshot = { issuer: null, issuerKeys: null, selfIssued: null, hasSelfIssuedView: false };
    const pins = pinsOf({ hana: [await emailJwk(201)] });
    expect(policyFindings(null, none)).toEqual({ differences: [], weaker: [] });
    expect(policyFindings(pins, none)).toEqual({ differences: [], weaker: [] });
    expect(policyId(none)).toBe('none');
    const v2WithIssuer: EmailSnapshot = { ...none, issuer: { provider: 'email', iss_values: [], kids: [] } };
    expect(policyFindings(pins, v2WithIssuer).differences).toEqual(['the contract has no get_self_issued (pre-v3): the email issuer has no signer policy']);
    expect(policyId(v2WithIssuer)).toBe('not-self-issued');
  });
});
