// The link-volume check's event source (docs/email-login-spec.md "Watchdog": "Link-volume check from identity_link_*
// events"). A contract's events are logs in receipt outcomes, which no JSON-RPC view lists, so the watchdog reads
// the signer's transactions from a NEAR transactions indexer (FastNear's transactions API, the manifest's
// `watchdog.linkVolume.indexerUrl`) and keeps only `EVENT_JSON` logs the signer itself emitted in receipts that
// succeeded. Detection only (D192): the indexer can hide events (a missed warning) or invent some (a false warning),
// never make the watchdog act; nothing on chain depends on it.
//
// Per run: the RPC's final block, one `/status`, one `/v0/account` page of at most PAGE_TXS transactions, and
// `/v0/transactions` batches of TX_BATCH, all within SCAN_BUDGET_BYTES of indexer answers (a login transaction with
// its MPC receipts is ~75 KB). A busier signer falls behind, which the run alerts. Every answer is size-capped
// (http.ts), receipt ids and the events per scan are bounded, and the indexer's head is clamped to the RPC's final
// block, so bad indexer data can only make the check fail or skip a block, which pages.
import { BODY_LIMITS, BodyTooLarge, readCappedSized } from './http.ts';
import { log } from './log.ts';

/** The contract's link events (`docs/contract-interface.md` "Events", standard `hana-id` 1.2.0). */
export const LINK_EVENTS = ['identity_linked', 'identity_link_proposed', 'identity_link_activated', 'identity_link_cancelled', 'identity_unlinked'] as const;
export type LinkEventName = (typeof LINK_EVENTS)[number];
/** The events that add a link (active at once, or pending): what the volume threshold counts. */
export const NEW_LINK_EVENTS: readonly LinkEventName[] = ['identity_linked', 'identity_link_proposed'];

export interface LinkEvent {
  /** `<receipt id>:<log index>:<data index>`: one event, however often a scan re-reads its block. */
  id: string;
  event: LinkEventName;
  scope_id: string;
  provider: string;
  /** `identity_linked` / `identity_link_proposed`: an automatic link (D119); null for the other events. */
  auto: boolean | null;
  /** Block time of the receipt (ms). */
  at: number;
  block_height: number;
}

export interface LinkScan {
  events: LinkEvent[];
  /** Every transaction up to this block height was read: the next scan starts after it. */
  scannedTo: number;
  /** The indexer's latest block. */
  latestHeight: number;
  /** How far the scan is behind the chain (ms of block time): large when the indexer or the scan lags. */
  behindMs: number;
  /** More transactions than one run reads were waiting (a full page, or the byte budget ran out). */
  truncated: boolean;
  /**
   * A block this scan could not read whole even with a fresh run's budget (≥ PAGE_TXS of the signer's transactions,
   * or more bytes than SCAN_BUDGET_BYTES): the scan moves past it, so padding one block can't stall detection, and
   * the run keeps a critical `link_block_unscanned` condition open for it (D192). Null when none.
   */
  skipped: number | null;
}

export interface LinkEventSource {
  /** Reads link events from `fromHeight` (null: start at the chain's head now, no backfill). Throws when the indexer fails. */
  scan(fromHeight: number | null, now: number): Promise<LinkScan>;
}

/** Provisional link-volume thresholds (new links per hour, D192), overridable in the manifest's `watchdog.linkVolume`. */
export const DEFAULT_LINK_VOLUME = { perHour: 100, perScopePerHour: 20 } as const;

/** The `LINK_VOLUME` var (JSON `{perHour?, perScopePerHour?}` from the manifest): an unreadable value keeps the defaults. */
export function linkVolumeConfig(raw: string | undefined): { thresholds: { perHour: number; perScopePerHour: number }; problems: string[] } {
  const thresholds: { perHour: number; perScopePerHour: number } = { ...DEFAULT_LINK_VOLUME };
  if (raw === undefined || raw.trim() === '') return { thresholds, problems: [] };
  let v: { perHour?: unknown; perScopePerHour?: unknown };
  try {
    v = JSON.parse(raw) as typeof v;
  } catch {
    return { thresholds, problems: ['LINK_VOLUME is not JSON: default link-volume thresholds'] };
  }
  const problems: string[] = [];
  for (const k of ['perHour', 'perScopePerHour'] as const) {
    const x = v?.[k];
    if (x === undefined) continue;
    if (typeof x === 'number' && Number.isInteger(x) && x >= 1) thresholds[k] = x;
    else problems.push(`LINK_VOLUME.${k} is not a positive integer: default ${DEFAULT_LINK_VOLUME[k]}`);
  }
  return { thresholds, problems };
}

/** Transactions listed per `/v0/account` page (FastNear's maximum). */
export const PAGE_TXS = 200;
/** Hashes per `/v0/transactions` call (FastNear allows 20; 5 keeps one call ~375 KB, so the budget stops between calls). */
export const TX_BATCH = 5;
/** Bytes of indexer answers one scan may read in all (review: a run must not parse ~10 MB of JSON). */
export const SCAN_BUDGET_BYTES = 1024 * 1024;
/** Blocks left behind the indexer's head, so every receipt of a scanned transaction has executed and is indexed. */
export const SETTLE_BLOCKS = 60;
/** Events kept from one scan, at most (far above any threshold: more means the scan is flooded). */
export const MAX_EVENTS_PER_SCAN = 2_000;
const INDEXER_TIMEOUT_MS = 8_000;
const MAX_SCOPE_BYTES = 64;
const MAX_PROVIDER_BYTES = 32;
/** A NEAR receipt id is a base58 SHA-256 (43–44 characters). */
const RECEIPT_ID_RE = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/u;

interface ReceiptOutcome {
  execution_outcome?: {
    id?: unknown;
    block_height?: unknown;
    block_timestamp?: unknown;
    outcome?: { logs?: unknown; executor_id?: unknown; status?: unknown };
  };
}

/** ns block timestamps (a JSON number past 2^53, or a decimal string) to ms. */
const nsToMs = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v / 1e6);
  if (typeof v === 'string' && /^\d{1,25}$/u.test(v)) return Number(BigInt(v) / 1_000_000n);
  return null;
};

const shortString = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && new TextEncoder().encode(v).length <= max;

/**
 * Link events in one indexed transaction: `EVENT_JSON` logs of standard `hana-id` that `signer` emitted in a receipt
 * that didn't fail (a failed receipt's logs are recorded, but its state change, the link, was reverted).
 */
export function linkEventsOf(tx: { receipts?: unknown }, signer: string): LinkEvent[] {
  const out: LinkEvent[] = [];
  if (!Array.isArray(tx.receipts)) return out;
  for (const r of tx.receipts as ReceiptOutcome[]) {
    const eo = r?.execution_outcome;
    const o = eo?.outcome;
    if (!eo || !o || o.executor_id !== signer || typeof eo.id !== 'string' || !RECEIPT_ID_RE.test(eo.id) || !Array.isArray(o.logs)) continue;
    if (typeof o.status !== 'object' || o.status === null || 'Failure' in o.status) continue;
    const at = nsToMs(eo.block_timestamp);
    const height = typeof eo.block_height === 'number' && Number.isSafeInteger(eo.block_height) ? eo.block_height : null;
    if (at === null || height === null) continue;
    o.logs.forEach((line: unknown, li: number) => {
      if (typeof line !== 'string' || !line.startsWith('EVENT_JSON:')) return;
      let ev: { standard?: unknown; event?: unknown; data?: unknown };
      try {
        ev = JSON.parse(line.slice('EVENT_JSON:'.length)) as typeof ev;
      } catch {
        return;
      }
      if (ev?.standard !== 'hana-id' || !(LINK_EVENTS as readonly unknown[]).includes(ev.event) || !Array.isArray(ev.data)) return;
      ev.data.forEach((d: { scope_id?: unknown; provider?: unknown; auto?: unknown } | null, di: number) => {
        if (!d || !shortString(d.scope_id, MAX_SCOPE_BYTES) || !shortString(d.provider, MAX_PROVIDER_BYTES)) return;
        if (out.length >= MAX_EVENTS_PER_SCAN) return;
        out.push({ id: `${eo.id}:${li}:${di}`, event: ev.event as LinkEventName, scope_id: d.scope_id, provider: d.provider, auto: typeof d.auto === 'boolean' ? d.auto : null, at, block_height: height });
      });
    });
  }
  return out;
}

interface AccountTx {
  transaction_hash: string;
  tx_block_height: number;
  tx_block_timestamp: unknown;
}

const validAccountTx = (t: unknown): t is AccountTx =>
  typeof t === 'object' && t !== null && typeof (t as AccountTx).transaction_hash === 'string' && RECEIPT_ID_RE.test((t as AccountTx).transaction_hash) && Number.isSafeInteger((t as AccountTx).tx_block_height);

/** FastNear's transactions API (`/status`, `/v0/account`, `/v0/transactions`). No key: public data only. */
export class FastNearLinkEvents implements LinkEventSource {
  constructor(
    private readonly baseUrl: string,
    private readonly signer: string,
    /** The watchdog's own RPC's final block height: the indexer's head is never trusted past it. */
    private readonly finalHeight: () => Promise<number>,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  /**
   * One indexer call within the scan's byte budget. Over the path's own cap: an error. Over what is left of the budget
   * (but within the cap): `BudgetOut`, so the scan stops between calls.
   */
  private async request<T>(path: '/status' | '/v0/account' | '/v0/transactions', budget: { left: number }, body?: unknown): Promise<T> {
    const url = `${this.baseUrl.replace(/\/+$/u, '')}${path}`;
    const res = await this.fetchFn(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(INDEXER_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`indexer ${path} HTTP ${res.status}`);
    }
    const cap = path === '/status' ? BODY_LIMITS.indexerStatus : path === '/v0/account' ? BODY_LIMITS.indexerAccount : BODY_LIMITS.indexerTransactions;
    const limit = Math.min(cap, budget.left);
    let read: { text: string; bytes: number };
    try {
      read = await readCappedSized(res, limit);
    } catch (err) {
      if (err instanceof BodyTooLarge && limit < cap) throw new BudgetOut();
      throw err;
    }
    budget.left -= read.bytes;
    return JSON.parse(read.text) as T;
  }

  async scan(fromHeight: number | null, now: number): Promise<LinkScan> {
    const budget = { left: SCAN_BUDGET_BYTES };
    const status = await this.request<{ latest_tx_block_height?: unknown; latest_block_height?: unknown; latest_block_timestamp?: unknown }>('/status', budget);
    const latest = typeof status.latest_tx_block_height === 'number' ? status.latest_tx_block_height : status.latest_block_height;
    const latestAt = nsToMs(status.latest_block_timestamp);
    if (!Number.isSafeInteger(latest) || latestAt === null) throw new Error('indexer /status: unexpected shape');
    const final = await this.finalHeight();
    if (!Number.isSafeInteger(final)) throw new Error('RPC final block: unexpected shape');
    // An indexer claiming a head past the chain's final block is clamped (L2): it can't push the cursor ahead.
    const upTo = Math.min(latest as number, final) - SETTLE_BLOCKS;
    const head = { latestHeight: latest as number, behindMs: Math.max(0, now - latestAt) };
    const none = { events: [], truncated: false, skipped: null, ...head };
    if (fromHeight === null) return { ...none, scannedTo: upTo };
    if (fromHeight > upTo) return { ...none, scannedTo: fromHeight - 1 };

    const page = await this.request<{ account_txs?: unknown }>('/v0/account', budget, { account_id: this.signer, from_tx_block_height: fromHeight, to_tx_block_height: upTo, desc: false, limit: PAGE_TXS });
    if (!Array.isArray(page.account_txs) || page.account_txs.length > PAGE_TXS || !page.account_txs.every(validAccountTx)) throw new Error('indexer /v0/account: unexpected shape');
    const pageFull = page.account_txs.length >= PAGE_TXS;
    const txs = (page.account_txs as AccountTx[]).filter((t) => t.tx_block_height >= fromHeight && t.tx_block_height <= upTo).sort((a, b) => a.tx_block_height - b.tx_block_height);
    // Blocks in order, each with its transactions. A full page may cut its last block short: that block is read in a
    // later scan, unless it is the page's only block (≥ PAGE_TXS transactions: it can never be read whole).
    const blocks: { height: number; at: number | null; hashes: string[] }[] = [];
    for (const t of txs) {
      const b = blocks[blocks.length - 1];
      if (b?.height === t.tx_block_height) {
        if (!b.hashes.includes(t.transaction_hash)) b.hashes.push(t.transaction_hash);
      } else blocks.push({ height: t.tx_block_height, at: nsToMs(t.tx_block_timestamp), hashes: [t.transaction_hash] });
    }
    const cut = pageFull && blocks.length > 1 ? blocks.pop()! : null;
    const oversized = pageFull && blocks.length === 1 ? blocks[0]!.height : null;

    // Batches of TX_BATCH hashes across blocks, in block order, until the budget runs out; a block counts as read once
    // its last transaction's batch came back.
    const flat = blocks.flatMap((b, bi) => b.hashes.map((h) => ({ h, bi })));
    const events: LinkEvent[] = [];
    let fetched = 0;
    for (let j = 0; j < flat.length && events.length < MAX_EVENTS_PER_SCAN; j += TX_BATCH) {
      let got: { transactions?: unknown };
      try {
        got = await this.request<{ transactions?: unknown }>('/v0/transactions', budget, { tx_hashes: flat.slice(j, j + TX_BATCH).map((x) => x.h) });
      } catch (err) {
        if (!(err instanceof BudgetOut)) throw err;
        break;
      }
      if (!Array.isArray(got.transactions) || got.transactions.length > TX_BATCH) throw new Error('indexer /v0/transactions: unexpected shape');
      for (const tx of got.transactions) if (tx && typeof tx === 'object') events.push(...linkEventsOf(tx as { receipts?: unknown }, this.signer).slice(0, MAX_EVENTS_PER_SCAN - events.length));
      fetched = Math.min(flat.length, j + TX_BATCH);
    }
    // Blocks read whole: those whose every transaction was fetched (an oversized block never is).
    let whole = 0;
    while (whole < blocks.length && blocks[whole]!.height !== oversized && flat.findLastIndex((x) => x.bi === whole) < fetched) whole++;
    let scannedTo = cut ? cut.height - 1 : upTo;
    let unread: { height: number; at: number | null } | null = cut;
    let skipped: number | null = null;
    if (whole < blocks.length) {
      const block = blocks[whole]!;
      if (whole === 0) {
        // Not even a fresh run's budget reads this block whole (it is the scan's first): skip it, loudly, rather
        // than stall for good (M2). What was fetched of it is still counted.
        skipped = block.height;
        scannedTo = block.height;
        unread = blocks[1] ?? cut;
      } else {
        scannedTo = blocks[whole - 1]!.height;
        unread = block;
      }
    }
    const truncated = unread !== null;
    const behindMs = unread?.at != null ? Math.max(head.behindMs, now - unread.at) : head.behindMs;
    log({ event: 'link_scan', outcome: 'ok', code: skipped !== null ? 'skipped_block' : truncated ? 'truncated' : 'complete' });
    return { events, scannedTo, latestHeight: head.latestHeight, behindMs, truncated, skipped };
  }
}

/** The scan's byte budget ran out between calls (not an error: the scan stops there). */
class BudgetOut extends Error {}
