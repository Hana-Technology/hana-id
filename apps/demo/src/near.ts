// The NEAR card's logic, without the DOM (near-card.ts wires it to the page): the guestbook's text rule, reads from
// the env's NEAR RPC, the borsh bytes the user signs, and the guestbook list made safe to show.
//
// The bytes come from @hana-id/core's NEAR codec (the one the vault decodes with), so the page carries no second
// borsh implementation and no NEAR SDK. Everything read from NEAR is attacker-controlled: anyone can write any text to
// the guestbook, so the list is parsed strictly, bounded, and shown as text with invisible and direction-changing
// characters neutralised.
import { type NearAction, base64Encode, encodeNearDelegateAction, encodeNearTransaction, isNearAccountId, nearImplicitPublicKey, toBytes, utf8 } from '@hana-id/core';
import { base58 } from '@scure/base';

// ---- the guestbook's text rule (contracts/hana-guestbook) ----

/** The contract's limit: characters (Unicode scalar values, Rust's `chars()`) after trimming. */
export const GUESTBOOK_MAX_CHARS = 200;

/** Rust's `str::trim`: leading and trailing Unicode White_Space (JavaScript's trim differs at U+0085 and U+FEFF). */
export const trimLikeRust = (s: string): string => s.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');

/** Characters as the contract counts them: Unicode scalar values (an emoji is 1; `.length` would count 2). */
export const scalarCount = (s: string): number => [...s].length;

export type TextCheck = { ok: true; text: string; chars: number } | { ok: false; reason: 'empty' | 'too_long' | 'malformed'; chars: number };

/**
 * The text `add_message` would store, or why the contract would refuse it. A lone surrogate (possible in a JavaScript
 * string, never in UTF-8) is `malformed`: the contract's JSON parser refuses it.
 */
export function checkGuestbookText(raw: string): TextCheck {
  const text = trimLikeRust(raw);
  const chars = scalarCount(text);
  if (/\p{Cs}/u.test(text)) return { ok: false, reason: 'malformed', chars };
  if (chars === 0) return { ok: false, reason: 'empty', chars };
  if (chars > GUESTBOOK_MAX_CHARS) return { ok: false, reason: 'too_long', chars };
  return { ok: true, text, chars };
}

// ---- showing what NEAR returns ----

/** Invisible or direction-changing code points: controls, format characters (bidi, zero-width), private use, separators, lone surrogates. */
const UNSAFE = /^[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]$/u;
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
const ZWJ = '‍';

/**
 * Attacker-controlled text made safe to put in a text node: tab, LF and CR become spaces, every other unsafe code point
 * becomes U+FFFD (so a right-to-left override can't reorder what follows, and hidden characters show), except a
 * zero-width joiner between two pictographs (an emoji sequence such as 👩‍💻), and the result is cut to `max`
 * characters. The caller still sets it as text, never as HTML.
 */
export function displayText(s: string, max: number = GUESTBOOK_MAX_CHARS): string {
  const cps = [...s.slice(0, max * 4)];
  const out: string[] = [];
  for (let i = 0; i < cps.length && out.length <= max; i++) {
    const c = cps[i]!;
    if (c === '\t' || c === '\n' || c === '\r') {
      out.push(' ');
      continue;
    }
    if (c === ZWJ) {
      const prev = cps[i - 1] === '️' ? cps[i - 2] : cps[i - 1];
      const next = cps[i + 1];
      if (prev !== undefined && next !== undefined && PICTOGRAPH.test(prev) && PICTOGRAPH.test(next)) {
        out.push(c);
        continue;
      }
    }
    out.push(UNSAFE.test(c) ? '�' : c);
  }
  return out.length > max ? `${out.slice(0, max).join('')}…` : out.join('');
}

/** `6e5e4e…f35000` for an implicit account, a long named account cut in the middle, a short one as is. */
export function shortAccount(id: string): string {
  if (/^[0-9a-f]{64}$/u.test(id)) return `${id.slice(0, 6)}…${id.slice(-6)}`;
  return id.length > 24 ? `${id.slice(0, 12)}…${id.slice(-10)}` : id;
}

export interface GuestbookMessage {
  index: number;
  accountId: string;
  text: string;
  timestampMs: number;
}

/** The most messages the card lists (the contract keeps 50). */
export const GUESTBOOK_LIST_LIMIT = 20;

/**
 * `get_messages`' answer, parsed strictly: at most GUESTBOOK_LIST_LIMIT entries, each with a valid NEAR account id, a
 * string text of bounded size and integer index and time; anything else is dropped. Newest first, by index.
 */
export function parseMessages(value: unknown): GuestbookMessage[] {
  if (!Array.isArray(value)) return [];
  const out: GuestbookMessage[] = [];
  for (const m of value.slice(0, 50)) {
    if (typeof m !== 'object' || m === null) continue;
    const r = m as Record<string, unknown>;
    if (!Number.isSafeInteger(r.index) || (r.index as number) < 0) continue;
    if (!isNearAccountId(r.account_id)) continue;
    if (typeof r.text !== 'string' || r.text.length > 4 * GUESTBOOK_MAX_CHARS) continue;
    if (!Number.isSafeInteger(r.block_timestamp_ms) || (r.block_timestamp_ms as number) < 0) continue;
    out.push({ index: r.index as number, accountId: r.account_id, text: r.text, timestampMs: r.block_timestamp_ms as number });
  }
  return out.sort((a, b) => b.index - a.index).slice(0, GUESTBOOK_LIST_LIMIT);
}

/** yoctoNEAR as NEAR, with up to 4 decimals (`0`, `0.0012`, `12.5`). */
export function formatNear(yocto: bigint): string {
  const whole = yocto / 10n ** 24n;
  const frac = ((yocto % 10n ** 24n) / 10n ** 20n).toString().padStart(4, '0').replace(/0+$/u, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

// ---- the bytes the user signs ----

/** Gas on the add_message call: the contract burns about 1.4 Tgas (its README); 30 Tgas is ample. */
export const GUESTBOOK_GAS = 30_000_000_000_000n;
/** A delegate action's lifetime: the latest final height plus this many blocks (about 10 minutes on testnet). */
export const DELEGATE_TTL_BLOCKS = 600n;
/**
 * The balance from which "Sign a transaction" also sends it: the 30 Tgas it prepays cost about 0.003 NEAR at testnet's
 * gas price, so 0.01 NEAR leaves a margin. Below it the transaction is signed and shown, not sent.
 */
export const TX_FEE_RESERVE = 10n ** 22n;

/** NEAR's window for a delegate action's nonce under a test app (the vault's rule): this many blocks below the height. */
export const DELEGATE_NONCE_WINDOW_BLOCKS = 10_000n;
const NONCES_PER_BLOCK = 1_000_000n;

/**
 * The nonce of the next delegate action: above the key's nonce and above any this page signed already, at least
 * (height − 10,000) × 10^6 + 1 and below height × 10^6 (the vault refuses a test app's delegate action outside that
 * window). The one place the card picks a nonce, so the core's helper can replace it.
 */
export function delegateNonce(p: { keyNonce: bigint; blockHeight: bigint; lastSigned?: bigint | undefined }): bigint {
  const floor = (p.blockHeight - DELEGATE_NONCE_WINDOW_BLOCKS) * NONCES_PER_BLOCK + 1n;
  let nonce = p.keyNonce + 1n;
  if (p.lastSigned !== undefined && p.lastSigned + 1n > nonce) nonce = p.lastSigned + 1n;
  if (floor > nonce) nonce = floor;
  if (nonce >= p.blockHeight * NONCES_PER_BLOCK) throw nearPageError('near_page_rpc_failed', 'The key’s nonce is ahead of the block height NEAR reported');
  return nonce;
}

/** The nonce of the next ordinary transaction: above the key's (0 for a key not on chain yet) and any this page signed. */
export const transactionNonce = (p: { keyNonce: bigint | null; lastSigned?: bigint | undefined }): bigint => {
  const base = p.keyNonce ?? 0n;
  return (p.lastSigned !== undefined && p.lastSigned > base ? p.lastSigned : base) + 1n;
};

export const addMessageAction = (text: string): NearAction => ({ type: 'functionCall', methodName: 'add_message', args: utf8(JSON.stringify({ text })), gas: GUESTBOOK_GAS, deposit: 0n });

const userKey = (accountId: string) => ({ type: 'ed25519' as const, bytes: nearImplicitPublicKey(accountId) });

/** borsh `DelegateAction`: `accountId` calls `add_message({ text })` on `guestbook`, valid until `blockHeight + DELEGATE_TTL_BLOCKS`. */
export function addMessageDelegate(p: { accountId: string; guestbook: string; text: string; nonce: bigint; blockHeight: bigint }): Uint8Array {
  return encodeNearDelegateAction({
    senderId: p.accountId,
    receiverId: p.guestbook,
    actions: [addMessageAction(p.text)],
    nonce: p.nonce,
    maxBlockHeight: p.blockHeight + DELEGATE_TTL_BLOCKS,
    publicKey: userKey(p.accountId),
  });
}

/** borsh `Transaction`: the same call as an ordinary transaction, which the account's own NEAR pays for. */
export function addMessageTransaction(p: { accountId: string; guestbook: string; text: string; nonce: bigint; blockHash: string }): Uint8Array {
  return encodeNearTransaction({ signerId: p.accountId, publicKey: userKey(p.accountId), nonce: p.nonce, receiverId: p.guestbook, blockHash: toBytes(base58.decode(p.blockHash)), actions: [addMessageAction(p.text)] });
}

// ---- reads from the env's NEAR RPC ----

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** A failure of the page's own NEAR read, with a code errors.ts maps to plain words. */
export const nearPageError = (code: 'near_page_rpc_failed' | 'near_account_pending' | 'near_send_failed', message: string): Error => Object.assign(new Error(message), { code });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const causeName = (b: Record<string, unknown>): unknown => (isObj(b.error) && isObj(b.error.cause) ? b.error.cause.name : undefined);

/** The user's key as NEAR reports it: its nonce, and the final block the answer is from. */
export interface AccessKeyState {
  nonce: bigint;
  blockHeight: bigint;
  blockHash: string;
}

/** The NEAR JSON-RPC of the env (manifest `rpc`, then `rpcFallback`), from the page. */
export class NearRpc {
  readonly #urls: readonly string[];
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(urls: readonly string[], fetchFn: FetchLike, timeoutMs = 10_000) {
    this.#urls = urls;
    this.#fetch = fetchFn;
    this.#timeoutMs = timeoutMs;
  }

  /** The first endpoint's body that `answered` accepts; a network error, a non-200 or another body tries the next. */
  async call(method: string, params: unknown, answered: (b: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    for (const url of this.#urls) {
      const ctl = new AbortController();
      const timer = globalThis.setTimeout(() => ctl.abort(), this.#timeoutMs);
      try {
        const res = await this.#fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'hana-demo', method, params }),
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal: ctl.signal,
        });
        if (!res.ok) continue;
        const body: unknown = await res.json();
        if (isObj(body) && answered(body)) return body;
      } catch {
        // next endpoint
      } finally {
        globalThis.clearTimeout(timer);
      }
    }
    throw nearPageError('near_page_rpc_failed', `NEAR testnet's RPC gave no usable answer to ${method}`);
  }

  /** `view_access_key` at final: the key's nonce, or null when the account or the key doesn't exist (not activated). */
  async accessKey(accountId: string, publicKey: string): Promise<AccessKeyState | null> {
    const missing = (b: Record<string, unknown>) =>
      causeName(b) === 'UNKNOWN_ACCESS_KEY' || causeName(b) === 'UNKNOWN_ACCOUNT' || (isObj(b.result) && typeof b.result.error === 'string' && /does not exist/u.test(b.result.error));
    const ok = (b: Record<string, unknown>) => b.error === undefined && isObj(b.result) && Number.isSafeInteger(b.result.nonce) && Number.isSafeInteger(b.result.block_height) && typeof b.result.block_hash === 'string';
    const body = await this.call('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey }, (b) => ok(b) || missing(b));
    if (!ok(body)) return null;
    const r = body.result as { nonce: number; block_height: number; block_hash: string };
    return { nonce: BigInt(r.nonce), blockHeight: BigInt(r.block_height), blockHash: r.block_hash };
  }

  /** The latest final block's height and hash. */
  async finalBlock(): Promise<{ height: bigint; hash: string }> {
    const ok = (b: Record<string, unknown>) => isObj(b.result) && isObj(b.result.header) && Number.isSafeInteger(b.result.header.height) && typeof b.result.header.hash === 'string';
    const body = await this.call('block', { finality: 'final' }, ok);
    const h = (body.result as { header: { height: number; hash: string } }).header;
    return { height: BigInt(h.height), hash: h.hash };
  }

  /** The account's balance in yoctoNEAR (0 when it doesn't exist yet). */
  async balance(accountId: string): Promise<bigint> {
    const missing = (b: Record<string, unknown>) => causeName(b) === 'UNKNOWN_ACCOUNT';
    const ok = (b: Record<string, unknown>) => b.error === undefined && isObj(b.result) && typeof b.result.amount === 'string' && /^\d{1,40}$/u.test(b.result.amount);
    const body = await this.call('query', { request_type: 'view_account', finality: 'final', account_id: accountId }, (b) => ok(b) || missing(b));
    return ok(body) ? BigInt((body.result as { amount: string }).amount) : 0n;
  }

  /** A contract view call's JSON result. */
  async view(contract: string, method: string, args: Record<string, unknown>): Promise<unknown> {
    const argsBase64 = base64Encode(utf8(JSON.stringify(args)));
    const ok = (b: Record<string, unknown>) => b.error === undefined && isObj(b.result) && Array.isArray(b.result.result);
    const body = await this.call('query', { request_type: 'call_function', finality: 'optimistic', account_id: contract, method_name: method, args_base64: argsBase64 }, ok);
    const bytes = (body.result as { result: unknown[] }).result;
    if (bytes.length > 256 * 1024 || !bytes.every((x) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 255)) throw nearPageError('near_page_rpc_failed', `${method} returned no bytes`);
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes as number[]))) as unknown;
    } catch {
      throw nearPageError('near_page_rpc_failed', `${method} returned no JSON`);
    }
  }

  /** Sends a signed transaction (`send_tx`) and waits for its execution. Throws when NEAR refuses it or it fails. */
  async sendTx(signedTxBase64: string): Promise<void> {
    const body = await this.call('send_tx', { signed_tx_base64: signedTxBase64, wait_until: 'EXECUTED_OPTIMISTIC' }, (b) => isObj(b.result) || isObj(b.error));
    const status = isObj(body.result) ? body.result.status : undefined;
    if (!isObj(status) || 'Failure' in status) throw nearPageError('near_send_failed', 'NEAR testnet refused or failed the transaction');
  }
}
