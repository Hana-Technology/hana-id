// The link-volume check's event source (docs/email-login-spec.md "Watchdog": "Link-volume check from identity_link_*
// events"). A contract's events are logs in receipt outcomes, which no JSON-RPC view lists, so the watchdog reads
// the signer's transactions from a NEAR transactions indexer (FastNear's transactions API, the manifest's
// `watchdog.linkVolume.indexerUrl`) and keeps only `EVENT_JSON` logs the signer itself emitted in receipts that
// succeeded. Detection only (D192): the indexer can hide events (a missed warning) or invent some (a false warning),
// never make the watchdog act; nothing on chain depends on it.
//
// Per run (the free plan's 50 subrequests): one `/status`, one `/v0/account` page of at most MAX_TXS transactions,
// and at most MAX_TXS / TX_BATCH `/v0/transactions` calls. A busier signer falls behind, which the run alerts.
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
  /** More transactions than one run reads were waiting. */
  truncated: boolean;
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

/** Transactions read per run, at most. */
export const MAX_TXS = 100;
/** `/v0/transactions` takes at most 20 hashes. */
export const TX_BATCH = 20;
/** Blocks left behind the indexer's head, so every receipt of a scanned transaction has executed and is indexed. */
export const SETTLE_BLOCKS = 60;
const INDEXER_TIMEOUT_MS = 8_000;
const MAX_SCOPE_BYTES = 64;
const MAX_PROVIDER_BYTES = 32;

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
    if (!eo || !o || o.executor_id !== signer || typeof eo.id !== 'string' || !Array.isArray(o.logs)) continue;
    if (typeof o.status !== 'object' || o.status === null || 'Failure' in o.status) continue;
    const at = nsToMs(eo.block_timestamp);
    const height = typeof eo.block_height === 'number' ? eo.block_height : null;
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
  typeof t === 'object' && t !== null && typeof (t as AccountTx).transaction_hash === 'string' && Number.isSafeInteger((t as AccountTx).tx_block_height);

/** FastNear's transactions API (`/status`, `/v0/account`, `/v0/transactions`). No key: public data only. */
export class FastNearLinkEvents implements LinkEventSource {
  constructor(
    private readonly baseUrl: string,
    private readonly signer: string,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  private async request<T>(path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl.replace(/\/+$/u, '')}${path}`;
    const res = await this.fetchFn(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(INDEXER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`indexer ${path} HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async scan(fromHeight: number | null, now: number): Promise<LinkScan> {
    const status = await this.request<{ latest_tx_block_height?: unknown; latest_block_height?: unknown; latest_block_timestamp?: unknown }>('/status');
    const latest = typeof status.latest_tx_block_height === 'number' ? status.latest_tx_block_height : status.latest_block_height;
    const latestAt = nsToMs(status.latest_block_timestamp);
    if (!Number.isSafeInteger(latest) || latestAt === null) throw new Error('indexer /status: unexpected shape');
    const upTo = (latest as number) - SETTLE_BLOCKS;
    const head = { latestHeight: latest as number, behindMs: Math.max(0, now - latestAt) };
    if (fromHeight === null) return { events: [], scannedTo: upTo, truncated: false, ...head };
    if (fromHeight > upTo) return { events: [], scannedTo: fromHeight - 1, truncated: false, ...head };

    const page = await this.request<{ account_txs?: unknown }>('/v0/account', { account_id: this.signer, from_tx_block_height: fromHeight, to_tx_block_height: upTo, desc: false, limit: MAX_TXS });
    if (!Array.isArray(page.account_txs) || !page.account_txs.every(validAccountTx)) throw new Error('indexer /v0/account: unexpected shape');
    let txs = (page.account_txs as AccountTx[]).filter((t) => t.tx_block_height >= fromHeight && t.tx_block_height <= upTo).sort((a, b) => a.tx_block_height - b.tx_block_height);
    const truncated = page.account_txs.length >= MAX_TXS;
    let scannedTo = upTo;
    let behindMs = head.behindMs;
    if (truncated && txs.length) {
      // The page may have cut a block's transactions short: re-read the last block next run (events dedupe by id),
      // unless the whole page is that one block.
      const last = txs[txs.length - 1]!;
      scannedTo = txs.every((t) => t.tx_block_height === last.tx_block_height) ? last.tx_block_height : last.tx_block_height - 1;
      txs = txs.filter((t) => t.tx_block_height <= scannedTo);
      const lastAt = nsToMs(last.tx_block_timestamp);
      if (lastAt !== null) behindMs = Math.max(behindMs, now - lastAt);
    }
    const hashes = [...new Set(txs.map((t) => t.transaction_hash))];
    const events: LinkEvent[] = [];
    for (let i = 0; i < hashes.length; i += TX_BATCH) {
      const got = await this.request<{ transactions?: unknown }>('/v0/transactions', { tx_hashes: hashes.slice(i, i + TX_BATCH) });
      if (!Array.isArray(got.transactions)) throw new Error('indexer /v0/transactions: unexpected shape');
      for (const tx of got.transactions) if (tx && typeof tx === 'object') events.push(...linkEventsOf(tx as { receipts?: unknown }, this.signer));
    }
    log({ event: 'link_scan', outcome: 'ok', code: truncated ? 'truncated' : 'complete' });
    return { events, scannedTo, latestHeight: head.latestHeight, behindMs, truncated };
  }
}
