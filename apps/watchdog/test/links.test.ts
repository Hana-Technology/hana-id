// The link-volume check's event source (FastNear's transactions API) against a stubbed fetch, and the email pins'
// parsing and policy verdicts. No network.
import { describe, expect, it } from 'vitest';
import type { EmailSnapshot } from '../src/chain.ts';
import { FastNearLinkEvents, linkEventsOf, linkVolumeConfig, PAGE_TXS, SCAN_BUDGET_BYTES, SETTLE_BLOCKS, TX_BATCH } from '../src/links.ts';
import { emailKeyVerdict, OVERLAP_SLACK_MS, parsePins, POLICY_OVERLAP_MS, policyFindings, policyId } from '../src/pins.ts';
import { emailJwk, pinsOf } from './helpers.ts';

const SIGNER = 'signer.test.near';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** A receipt id or transaction hash as NEAR writes them (base58, 44 characters). */
const id58 = (tag: string, i = 0) => `${tag}${B58[i % 58]}${B58[Math.floor(i / 58) % 58]}`.padEnd(44, 'z');
const NS = 1_793_580_000_000_000_000n; // a block time in ns (past 2^53, as the indexer sends it)
const ev = (event: string, data: object) => `EVENT_JSON:${JSON.stringify({ standard: 'hana-id', version: '1.2.0', event, data: [data] })}`;
const receipt = (o: { executor?: string; logs: string[]; status?: unknown; id?: string }) => ({
  execution_outcome: { id: o.id ?? id58('R'), block_height: 500, block_timestamp: Number(NS), outcome: { executor_id: o.executor ?? SIGNER, logs: o.logs, status: o.status ?? { SuccessValue: '' } } },
});

describe('linkEventsOf', () => {
  it("keeps the signer's own link events from receipts that succeeded", () => {
    const linked = ev('identity_linked', { scope_id: 's1', root: 'aa', member: 'bb', provider: 'google', effective_at_ms: 1, auto: true });
    const proposed = ev('identity_link_proposed', { scope_id: 's2', root: 'aa', member: 'cc', provider: 'email', effective_at_ms: 2, auto: false });
    const cancelled = ev('identity_link_cancelled', { scope_id: 's2', root: 'aa', member: 'cc', provider: 'email', by: 'dd' });
    const tx = {
      receipts: [
        receipt({ logs: ['plain log', linked, proposed], id: id58('R1') }),
        receipt({ logs: [cancelled], id: id58('R2'), status: { SuccessReceiptId: 'x' } }),
        // Another account can log anything: ignored.
        receipt({ executor: 'evil.test.near', logs: [linked], id: id58('R3') }),
        // A failed receipt's logs are recorded but its link was reverted: ignored.
        receipt({ logs: [linked], id: id58('R4'), status: { Failure: { ActionError: {} } } }),
      ],
    };
    expect(linkEventsOf(tx, SIGNER)).toEqual([
      { id: `${id58('R1')}:1:0`, event: 'identity_linked', scope_id: 's1', provider: 'google', auto: true, at: Number(NS / 1_000_000n), block_height: 500 },
      { id: `${id58('R1')}:2:0`, event: 'identity_link_proposed', scope_id: 's2', provider: 'email', auto: false, at: Number(NS / 1_000_000n), block_height: 500 },
      { id: `${id58('R2')}:0:0`, event: 'identity_link_cancelled', scope_id: 's2', provider: 'email', auto: null, at: Number(NS / 1_000_000n), block_height: 500 },
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
    // A receipt id that isn't a NEAR id (unbounded, or another alphabet) is dropped with its events.
    const ok = ev('identity_linked', { scope_id: 's1', provider: 'google' });
    for (const bad of ['x'.repeat(200), 'r1', `${id58('R').slice(0, 43)}0`]) expect(linkEventsOf({ receipts: [receipt({ logs: [ok], id: bad })] }, SIGNER), bad).toEqual([]);
    expect(linkEventsOf({ receipts: 'nope' }, SIGNER)).toEqual([]);
    expect(linkEventsOf({}, SIGNER)).toEqual([]);
  });
});

type Call = { url: string; body: Record<string, unknown> | null };
type Tx = { transaction_hash: string; tx_block_height: number; tx_block_timestamp: string };
function indexer(o: { latest?: number; final?: number; txs?: Tx[]; tx?: (hash: string) => object; fail?: string; huge?: string; pad?: number }) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, body });
    const path = new URL(url).pathname;
    if (o.fail === path) return new Response('down', { status: 503 });
    if (o.huge === path) return new Response(new ReadableStream({ pull: (c) => c.enqueue(new Uint8Array(1024 * 1024).fill(32)) }));
    if (path === '/status') return Response.json({ status: 'ok', latest_block_height: o.latest ?? 10_000, latest_tx_block_height: o.latest ?? 10_000, latest_block_timestamp: NS.toString() });
    if (path === '/v0/account') {
      const lim = body!.limit as number;
      return Response.json({ account_txs: (o.txs ?? []).filter((t) => !(t.tx_block_height < (body!.from_tx_block_height as number))).slice(0, lim), txs_count: (o.txs ?? []).length });
    }
    // `pad`: bytes per transaction, as a login's MPC receipts make it (~75 KB on testnet).
    if (path === '/v0/transactions') return Response.json({ transactions: (body!.tx_hashes as string[]).map((h) => ({ ...(o.tx?.(h) ?? { receipts: [] }), ...(o.pad ? { pad: 'x'.repeat(o.pad) } : {}) })) });
    return new Response('?', { status: 404 });
  }) as typeof fetch;
  return { calls, src: new FastNearLinkEvents('https://tx.test.fastnear.com/', SIGNER, async () => o.final ?? 1_000_000, fetchFn) };
}
const now = Number(NS / 1_000_000n) + 2_000;
const txsOf = (n: number, height: (i: number) => number, ts = NS.toString()): Tx[] => Array.from({ length: n }, (_, i) => ({ transaction_hash: id58('H', i), tx_block_height: height(i), tx_block_timestamp: ts }));
const hashesFetched = (calls: Call[]) => calls.filter((c) => c.url.endsWith('/v0/transactions')).flatMap((c) => c.body!.tx_hashes as string[]);

describe('FastNearLinkEvents', () => {
  it('starts at the head without reading transactions (no backfill)', async () => {
    const { calls, src } = indexer({});
    expect(await src.scan(null, now)).toEqual({ events: [], scannedTo: 10_000 - SETTLE_BLOCKS, latestHeight: 10_000, behindMs: 2_000, truncated: false, skipped: null });
    expect(calls.map((c) => c.url)).toEqual(['https://tx.test.fastnear.com/status']);
  });

  it("reads the signer's transactions from the cursor to the settled head, in batches across blocks", async () => {
    const txs = txsOf(25, (i) => 9_000 + i);
    const { calls, src } = indexer({ txs, tx: (h) => ({ receipts: h === id58('H', 3) ? [receipt({ logs: [ev('identity_linked', { scope_id: 's1', provider: 'google', auto: true })] })] : [] }) });
    const scan = await src.scan(9_000, now);
    expect(scan.events.map((e) => e.scope_id)).toEqual(['s1']);
    expect(scan).toMatchObject({ scannedTo: 10_000 - SETTLE_BLOCKS, truncated: false, skipped: null });
    expect(calls[1]).toEqual({ url: 'https://tx.test.fastnear.com/v0/account', body: { account_id: SIGNER, from_tx_block_height: 9_000, to_tx_block_height: 10_000 - SETTLE_BLOCKS, desc: false, limit: PAGE_TXS } });
    expect(calls.slice(2).map((c) => (c.body!.tx_hashes as string[]).length)).toEqual([TX_BATCH, TX_BATCH, TX_BATCH, TX_BATCH, TX_BATCH]);
  });

  it('a full page stops before its last block (re-read next run) and reports how far behind it is', async () => {
    const old = (NS - 2n * 3_600_000_000_000n).toString();
    const { calls, src } = indexer({ txs: txsOf(PAGE_TXS, (i) => 5_000 + Math.floor(i / 2), old) });
    const scan = await src.scan(5_000, now);
    expect(scan).toMatchObject({ truncated: true, skipped: null, scannedTo: 5_000 + PAGE_TXS / 2 - 2 });
    expect(scan.behindMs).toBeGreaterThan(2 * 3_600_000);
    // The last block's two transactions aren't fetched: the next scan starts at that block.
    expect(hashesFetched(calls)).toHaveLength(PAGE_TXS - 2);
  });

  it('reads at most SCAN_BUDGET_BYTES of indexer answers per run and stops between blocks', async () => {
    const pad = 75_000;
    const { calls, src } = indexer({ txs: txsOf(40, (i) => 8_000 + i), pad });
    const scan = await src.scan(8_000, now);
    const read = Math.floor(SCAN_BUDGET_BYTES / pad);
    // Whole batches that fit: the scan ends at the last block read and the rest waits for the next run.
    expect(scan.truncated).toBe(true);
    expect(scan.skipped).toBeNull();
    expect(scan.scannedTo).toBe(8_000 + hashesFetched(calls).length - 1 - TX_BATCH);
    expect(hashesFetched(calls).length).toBeLessThanOrEqual(read + TX_BATCH);
    expect(calls.length).toBeLessThan(2 + 40 / TX_BATCH);
  });

  it('skips a first block no run can read whole, keeping what it read of it, so the scan moves on (M2)', async () => {
    const linked = ev('identity_linked', { scope_id: 's9', provider: 'email', auto: true });
    // ≥ PAGE_TXS of the signer's transactions in one block: the page is all that block.
    const big = indexer({ txs: txsOf(PAGE_TXS, () => 7_000), tx: (h) => ({ receipts: h === id58('H', 0) ? [receipt({ logs: [linked] })] : [] }) });
    const scan = await big.src.scan(6_990, now);
    expect(scan).toMatchObject({ skipped: 7_000, scannedTo: 7_000 });
    expect(scan.events.map((e) => e.scope_id)).toEqual(['s9']);
    // A block over the byte budget (fewer transactions, but each huge) is skipped the same way.
    const heavy = indexer({ txs: [...txsOf(30, () => 7_500), { transaction_hash: id58('Z'), tx_block_height: 7_501, tx_block_timestamp: NS.toString() }], pad: 75_000 });
    expect(await heavy.src.scan(7_400, now)).toMatchObject({ skipped: 7_500, scannedTo: 7_500, truncated: true });
  });

  it("clamps the indexer's head to the RPC's final block", async () => {
    const { calls, src } = indexer({ latest: 50_000, final: 10_000 });
    expect((await src.scan(null, now)).scannedTo).toBe(10_000 - SETTLE_BLOCKS);
    const r = await src.scan(9_000, now);
    expect(r.scannedTo).toBe(10_000 - SETTLE_BLOCKS);
    expect(calls.find((c) => c.url.endsWith('/v0/account'))?.body).toMatchObject({ to_tx_block_height: 10_000 - SETTLE_BLOCKS });
  });

  it('fails on a body over its size cap, whatever the headers say', async () => {
    await expect(indexer({ huge: '/status' }).src.scan(null, now)).rejects.toThrow(/over 16384 bytes/u);
    await expect(indexer({ huge: '/v0/account' }).src.scan(1, now)).rejects.toThrow(/over 524288 bytes/u);
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
    await expect(indexer({ txs: [{ transaction_hash: 'x'.repeat(500), tx_block_height: 2, tx_block_timestamp: '1' }] }).src.scan(1, now)).rejects.toThrow(/unexpected shape/u);
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
    // Material that can't be hashed fails closed: never judged by its (pinned) kid (L1).
    expect((await emailKeyVerdict(pins, { kid: hana.kid, n: 'a*b', e: 'AQAB' }, 'hana', false)).reason).toBe('bad_material');
    expect((await emailKeyVerdict(pins, { kid: hana.kid, n: hana.n, e: null }, 'hana', false)).reason).toBe('bad_material');
  });

  it('a pre-v3 contract and an env before set_issuer have no findings; ids name the chain state', async () => {
    const none: EmailSnapshot = { issuer: null, issuerKeys: null, selfIssued: null, hasSelfIssuedView: false };
    const pins = pinsOf({ hana: [await emailJwk(201)] });
    const empty = { differences: [], weaker: [], critical: [], transition: [] };
    expect(policyFindings(null, none, 0)).toEqual(empty);
    expect(policyFindings(pins, none, 0)).toEqual(empty);
    expect(policyId(none)).toBe('none');
    const v2WithIssuer: EmailSnapshot = { ...none, issuer: { provider: 'email', iss_values: [], kids: [] } };
    expect(policyFindings(pins, v2WithIssuer, 0).critical).toEqual(['the contract has no get_self_issued (pre-v3): the email issuer has no signer policy']);
    expect(policyId(v2WithIssuer)).toBe('not-self-issued');
  });

  it('an overlap of the contract\'s length is a transition; a longer one is weaker (M3)', async () => {
    const pins = pinsOf({ hana: [await emailJwk(201)] });
    const now = 1_000_000_000;
    const at = (overlap_until_ms: number | null): EmailSnapshot => ({
      issuer: { provider: 'email', iss_values: [], kids: [] },
      issuerKeys: [],
      selfIssued: { provider: 'email', signers: [{ id: 'hana', kids: [] }], required: 1, overlap_until_ms },
      hasSelfIssuedView: true,
    });
    expect(policyFindings(pins, at(null), now)).toEqual({ differences: [], weaker: [], critical: [], transition: [] });
    expect(policyFindings(pins, at(now - 1), now).differences).toEqual([]); // over (the view hides it too)
    const normal = policyFindings(pins, at(now + POLICY_OVERLAP_MS), now);
    expect(normal.weaker).toEqual([]);
    expect(normal.transition).toHaveLength(1);
    expect(policyFindings(pins, at(now + POLICY_OVERLAP_MS + OVERLAP_SLACK_MS), now).weaker).toEqual([]);
    const long = policyFindings(pins, at(now + POLICY_OVERLAP_MS + OVERLAP_SLACK_MS + 1), now);
    expect(long.weaker).toEqual([expect.stringContaining("longer than the contract's 10-minute overlap")]);
    expect(policyId(at(now + 1))).toBe('hana/1+overlap');
  });
});
