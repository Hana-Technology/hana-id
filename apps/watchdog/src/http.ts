// Size-capped body reads for every third-party answer the watchdog parses (NEAR RPC, Google's and Hana's JWKS, the
// transactions indexer). Hana's own API is a party the watchdog must survive (D86): a huge body must fail as a fetch
// failure, never exhaust the run's CPU or memory while it holds the run lock.

/** Byte limits per source. */
export const BODY_LIMITS = {
  /** Google's and Hana's JWKS (a few keys; Google's is ~2 KB). */
  jwks: 64 * 1024,
  /** One NEAR JSON-RPC answer (views, view_account, access key lists, transaction outcomes). */
  rpc: 4 * 1024 * 1024,
  /** The indexer's `/status`. */
  indexerStatus: 16 * 1024,
  /** One `/v0/account` page (≤ 100 rows of ~500 bytes). */
  indexerAccount: 512 * 1024,
  /** One `/v0/transactions` batch (≤ 20 transactions with their receipts). */
  indexerTransactions: 2 * 1024 * 1024,
} as const;

export class BodyTooLarge extends Error {
  constructor(limit: number) {
    super(`response body over ${limit} bytes`);
    this.name = 'BodyTooLarge';
  }
}

/**
 * The body as text, refusing more than `maxBytes`: first by `Content-Length`, then while streaming (a missing or
 * lying header can't get past the limit). The stream is cancelled at the limit.
 */
export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  return (await readCappedSized(res, maxBytes)).text;
}

/** `readCapped`, with the number of bytes read (for a budget across calls). */
export async function readCappedSized(res: Response, maxBytes: number): Promise<{ text: string; bytes: number }> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new BodyTooLarge(maxBytes);
  }
  if (!res.body) return { text: '', bytes: 0 };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return { text: new TextDecoder().decode(all), bytes: total };
}

/** `readCapped` then `JSON.parse`. */
export async function readJsonCapped<T>(res: Response, maxBytes: number): Promise<T> {
  return JSON.parse(await readCapped(res, maxBytes)) as T;
}
