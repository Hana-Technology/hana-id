// NEAR meta transactions for Hana wallets (D730–D739; docs/api.md "NEAR relay"): a Hana user's NEAR implicit account
// (64 hex characters, zero NEAR) makes its first transactions through a Hana relay account that pays the gas.
//
// - POST /v1/near/activate creates the implicit account (a zero Transfer from the relay account): NEAR refuses a
//   delegate action from an account that doesn't exist (AccountDoesNotExist, measured on near-sandbox; D731), and the
//   two can't share one transaction (the delegate's nonce must be above the access key nonce the creation sets).
// - POST /v1/near/relay wraps the user's SignedDelegateAction in the relay account's transaction (receiver = the
//   user's account, one Delegate action) and sends it.
//
// Both take the app gate (`appGate` kind `near`: publishable key, an origin in force for the app, the per-IP window):
// the SDK calls them from the partner's page (`hana.near.relay`, `hana.near.activate`), the vault may too. No session
// credential is required (D735): the limits per sender, app, IP and the daily NEAR budget bound what anyone holding a
// publishable key and an allowed origin can spend. A body may add the vault's session proof (the session key's
// signature over `identityMessage` with this request's payload, the session live in the app's scope, once); when it
// does, it is checked and the request also counts per user. The relayer pays the inner calls' gas AND any deposit they attach
// (measured: a delegate Transfer of 1 NEAR from a zero-balance account is paid by the relayer), so only zero-deposit
// FunctionCalls to allowlisted receivers are relayed (near/delegate.ts policyRefusal).
//
// SECURITY: nothing here logs a key, a signature, a path or an account id (log() has no field for them). Testnet only:
// the env's NETWORK must be `testnet`, the request's `network` too, and the key object checks NETWORK again.
import { identityMessage, identityRoot, IDENTITY_NONCE_BYTES, IDENTITY_PROOF_MARKER_MS, IDENTITY_PROOF_WINDOW_MS } from '@hana-id/core/identity';
import { base64Decode, base64Encode, borshString, concatBytes, hex, sha256 } from '../bytes.ts';
import { eventId } from '../changes/guard.ts';
import type { Env } from '../env.ts';
import { appGate, done, type Ctx, lap, lapRelay, limiter, newCtx, NOT_EXECUTED, reject } from '../handlers.ts';
import { readJson } from '../http.ts';
import { checkChainSession, proofMarker, verifyEd25519 } from '../identity/token.ts';
import { log } from '../log.ts';
import { placedStub } from '../placement.ts';
import type { App } from '../apps.ts';
import type { Limit } from '../rate-limiter.ts';
import { ALREADY_RELAYED, parseRelayerKeys, POOLS, POOL_SECRET } from '../relayer-config.ts';
import { type NearRelayJob, nearRelayKeyName, type RelayResult } from '../relayer-key.ts';
import { ACTIVATE_GAS, decodeSignedDelegate, IMPLICIT_ACCOUNT_RE, innerGas, NONCE_RANGE_MULTIPLIER, policyRefusal, RELAY_OVERHEAD_GAS, verifyDelegateSignature, type DecodedDelegate } from './delegate.ts';
import { type NearRelayConfig, NEAR_RELAY_LIMITS, parseNearRelayConfig } from './relay-config.ts';
import { type AccountKey, headBlock, implicitAccountKey } from './relay-chain.ts';
import { nearRpc } from './rpc.ts';

export const NEAR_RELAY_ENDPOINT = '/v1/near/relay';
export const NEAR_ACTIVATE_ENDPOINT = '/v1/near/activate';
export const NEAR_ENDPOINTS: readonly string[] = [NEAR_RELAY_ENDPOINT, NEAR_ACTIVATE_ENDPOINT];

/** What the session key signs, inside identityMessage (D735). */
export const NEAR_RELAY_PAYLOAD = 'near-relay';
export const NEAR_ACTIVATE_PAYLOAD = 'near-activate';

/** "near-relay" ‖ borsh(network) ‖ sha256(signedDelegateAction bytes). */
export async function nearRelayPayload(network: string, signedDelegate: Uint8Array): Promise<Uint8Array> {
  return concatBytes(new TextEncoder().encode(NEAR_RELAY_PAYLOAD), borshString(network), await sha256(signedDelegate));
}

/** "near-activate" ‖ borsh(network) ‖ borsh(accountId). */
export function nearActivatePayload(network: string, accountId: string): Uint8Array {
  return concatBytes(new TextEncoder().encode(NEAR_ACTIVATE_PAYLOAD), borshString(network), borshString(accountId));
}

const MAX_BODY = 8192;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** A delegate whose `max_block_height` is this close to the head expires before it can land. */
const MIN_BLOCKS_AHEAD = 3n;

const BUDGET_SUBJECT = 'near-relay:budget';
const BUDGET_WINDOW = 'near-relay:day';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (o: Obj, keys: string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => k in o);
const bytesOf = (v: unknown, n: number): Uint8Array | null =>
  Array.isArray(v) && v.length === n && v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255) ? Uint8Array.from(v as number[]) : null;

/** The vault's optional session proof (D735): all four fields or none. */
interface SessionProof {
  sessionPk: Uint8Array;
  issuedAtMs: number;
  nonce: Uint8Array;
  signature: Uint8Array;
}

const PROOF_FIELDS = ['sessionPublicKey', 'issuedAtMs', 'nonce', 'signature'] as const;

/** The proof fields: absent (null), well formed, or malformed ('bad'). */
function sessionProof(b: Obj): SessionProof | null | 'bad' {
  const present = PROOF_FIELDS.filter((k) => k in b);
  if (present.length === 0) return null;
  if (present.length !== PROOF_FIELDS.length) return 'bad';
  const sessionPk = bytesOf(b.sessionPublicKey, 32);
  const nonce = bytesOf(b.nonce, IDENTITY_NONCE_BYTES);
  const signature = bytesOf(b.signature, 64);
  if (!sessionPk || !nonce || !signature || !Number.isSafeInteger(b.issuedAtMs) || (b.issuedAtMs as number) < 0) return 'bad';
  return { sessionPk, issuedAtMs: b.issuedAtMs as number, nonce, signature };
}

/** Standard base64 with padding, canonical (re-encodes to itself). */
function strictBase64(v: unknown, maxChars: number): Uint8Array | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > maxChars || v.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(v)) return null;
  try {
    const out = base64Decode(v);
    return base64Encode(out) === v ? out : null;
  } catch {
    return null;
  }
}

interface Common {
  /** The body's `network`, `testnet` when absent; any other value is refused later (mainnet_not_allowed / bad_request). */
  network: string;
  proof: SessionProof | null;
}

export interface RelayRequest extends Common {
  signedDelegate: Uint8Array;
}

export interface ActivateRequest extends Common {
  accountId: string;
}

const onlyKeys = (o: Obj, allowed: readonly string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));

function common(b: Obj): Common | null {
  if ('network' in b && (typeof b.network !== 'string' || b.network.length > 16)) return null;
  const proof = sessionProof(b);
  if (proof === 'bad') return null;
  return { network: (b.network as string | undefined) ?? 'testnet', proof };
}

/** POST /v1/near/relay's body: `signedDelegateAction` (base64), optional `network` and the optional session proof; nothing else. */
export function toRelayRequest(body: unknown): RelayRequest | null {
  if (!isObj(body) || !onlyKeys(body, ['network', 'signedDelegateAction', ...PROOF_FIELDS])) return null;
  const c = common(body);
  const signedDelegate = strictBase64(body.signedDelegateAction, 6000);
  return c && signedDelegate ? { ...c, signedDelegate } : null;
}

/** POST /v1/near/activate's body: `accountId` (an implicit account), optional `network` and the optional session proof. */
export function toActivateRequest(body: unknown): ActivateRequest | null {
  if (!isObj(body) || !onlyKeys(body, ['network', 'accountId', ...PROOF_FIELDS])) return null;
  const c = common(body);
  if (!c || typeof body.accountId !== 'string' || !IMPLICIT_ACCOUNT_RE.test(body.accountId)) return null;
  return { ...c, accountId: body.accountId };
}

// ---- configuration ----

let keysParsed: { from: string | undefined; count: number } = { from: undefined, count: 0 };

/**
 * The relay's config and key count, or null when the relay is off (D733): the env isn't testnet, NEAR_RELAY is missing
 * or unreadable, there are no receivers, or NEAR_RELAY_KEYS is empty, unreadable or shares a key with a pool.
 */
export function nearRelayReady(env: Env): { config: NearRelayConfig; keyCount: number } | null {
  if (env.NETWORK !== 'testnet') return null;
  const config = parseNearRelayConfig(env.NEAR_RELAY);
  if (!config || config.receivers.length === 0) return null;
  const all = `${env.NEAR_RELAY_KEYS ?? ''}\n${POOLS.map((p) => env[POOL_SECRET[p]] ?? '').join('\n')}`;
  if (keysParsed.from !== all) {
    let count = 0;
    try {
      const keys = parseRelayerKeys(env.NEAR_RELAY_KEYS, 'NEAR_RELAY_KEYS');
      const poolKeys = new Set<string>();
      for (const p of POOLS) {
        try {
          for (const k of parseRelayerKeys(env[POOL_SECRET[p]], POOL_SECRET[p])) poolKeys.add(k);
        } catch {
          // A pool whose secret doesn't parse is refused on its own account.
        }
      }
      count = new Set(keys).size === keys.length && !keys.some((k) => poolKeys.has(k)) ? keys.length : 0;
    } catch {
      count = 0;
    }
    keysParsed = { from: all, count };
  }
  return keysParsed.count > 0 ? { config, keyCount: keysParsed.count } : null;
}

// ---- shared steps ----

type Step<T> = { ok: true; value: T } | { ok: false; response: Response };

/** `network` must be testnet (D733). */
function networkRefusal(ctx: Ctx, network: string): Response | null {
  if (network === 'mainnet') return reject(ctx, 403, 'mainnet_not_allowed', 'The NEAR relay is testnet only');
  if (network !== 'testnet') return reject(ctx, 400, 'bad_request', 'network must be testnet');
  return null;
}

/**
 * The optional session proof (D735), when the body carries one: the clock, the session key's signature over
 * `payload`, the session live on chain in the app's scope, the proof used once. Its account root is then counted.
 */
async function provenUser(env: Env, ctx: Ctx, app: App, proof: SessionProof, payload: Uint8Array): Promise<Step<{ provider: string; sub: string }>> {
  const now = Date.now();
  if (Math.abs(now - proof.issuedAtMs) > IDENTITY_PROOF_WINDOW_MS) return { ok: false, response: done(ctx, 400, { error: 'The session proof is too old or too new', code: 'stale_proof', serverTimeMs: now }) };
  const message = identityMessage({ signer: env.SIGNER_ACCOUNT, appId: app.id, sessionPublicKey: proof.sessionPk, issuedAtMs: proof.issuedAtMs, nonce: proof.nonce, payload });
  if (!(await verifyEd25519(proof.sessionPk, proof.signature, message))) return { ok: false, response: reject(ctx, 401, 'invalid_signature', 'Invalid session signature') };
  const chain = await checkChainSession(env, ctx, app, proof.sessionPk, now);
  if (!chain.ok) return chain;
  const root = identityRoot(chain.session.path, app.scope_id);
  if (!root) return { ok: false, response: reject(ctx, 502, 'bad_contract_result', 'The session path is not one this API can read') };
  try {
    if (!(await limiter(env, `near-relay-proof:${hex(proof.sessionPk)}`).reserve(await proofMarker(proof), proof.issuedAtMs + IDENTITY_PROOF_MARKER_MS, now))) {
      return { ok: false, response: reject(ctx, 409, 'proof_replayed', 'This session proof was already used') };
    }
  } catch {
    return { ok: false, response: reject(ctx, 503, 'rate_limiter_unavailable', 'Try again') };
  }
  lap(ctx, 'session');
  return { ok: true, value: root };
}

// ---- the wallet directory (D735) ----

/**
 * The directory's user for a NEAR account in a scope, or null when it holds none. The seam both routes call: the
 * wallet directory's NEAR record (the `feat/near-directory` build: the vault records each user's NEAR account at
 * login with a proof signed by the NEAR key, as `/v1/wallets/record` does for Stellar and EVM, in `end_user_wallets`
 * with chain `near`, its migration 0019). The default reads exactly what that build's
 * `nearAccountUser(db, scopeId, accountId)` (`directory/near.ts`) reads; at the merge it can call it instead. Before
 * that migration the CHECK holds no `near` row, so it finds none. A failed read throws. Tests replace
 * `nearDirectory.lookup`.
 */
export type NearAccountLookup = (db: D1Database, q: { scopeId: string; accountId: string }) => Promise<{ userId: string } | null>;

export const defaultNearAccountLookup: NearAccountLookup = async (db, { scopeId, accountId }) => {
  if (!IMPLICIT_ACCOUNT_RE.test(accountId)) return null;
  const row = await db
    .prepare("SELECT w.user_id AS user_id FROM end_user_wallets w JOIN end_users u ON u.user_id = w.user_id WHERE w.chain = 'near' AND w.address = ?1 AND u.scope_id = ?2 LIMIT 1")
    .bind(accountId, scopeId)
    .first<{ user_id: string }>();
  return row ? { userId: row.user_id } : null;
};

export const nearDirectory: { lookup: NearAccountLookup } = { lookup: defaultNearAccountLookup };

/** `nearAccountKnown(db, {scopeId, accountId})`: whether the directory holds the account for a user of the scope. */
export async function nearAccountKnown(db: D1Database, q: { scopeId: string; accountId: string }): Promise<boolean> {
  return (await nearDirectory.lookup(db, q)) !== null;
}

/**
 * With `near.relay.requireKnownAccount` (the default): the account must be a directory user's of the app's scope:
 * `409 near_account_unrecorded`, retryable (`retryable: true`, `retry-after: 2`) on both routes, since the vault's
 * background wallet record usually lands within a second of the login and can lag up to 15 s (the client retries for
 * about 20 s). A failed read is `503 directory_unavailable`, never "unknown". The value is the user's limiter subject,
 * or null with the setting off.
 */
async function knownAccount(env: Env, ctx: Ctx, app: App, config: NearRelayConfig, accountId: string): Promise<Step<string | null>> {
  if (!config.requireKnownAccount) return { ok: true, value: null };
  let found: { userId: string } | null;
  try {
    found = await nearDirectory.lookup(env.DB, { scopeId: app.scope_id, accountId });
  } catch {
    return { ok: false, response: reject(ctx, 503, 'directory_unavailable', 'The wallet directory is unavailable, try again') };
  }
  lap(ctx, 'directory');
  if (!found) {
    return { ok: false, response: done(ctx, 409, { error: 'This NEAR account is not recorded for a user of this app (yet): sign in, then retry', code: 'near_account_unrecorded', retryable: true }, { 'retry-after': '2' }) };
  }
  return { ok: true, value: `near-relay:user:${found.userId}` };
}

interface Window {
  subject: string;
  limits: Limit[];
  what: string;
}

/** Asks each window in turn; a refusal by a later one takes the hit back from the earlier ones (D100). Null when all accept. */
async function quota(env: Env, ctx: Ctx, windows: Window[]): Promise<Response | null> {
  const now = Date.now();
  const taken: Window[] = [];
  try {
    for (const w of windows) {
      const hit = await limiter(env, w.subject).hit(w.limits, now);
      if (!hit.ok) {
        await Promise.all(taken.map((t) => limiter(env, t.subject).unhit(t.limits, now)));
        return reject(ctx, 429, 'rate_limited', `Rate limit exceeded (${w.what})`, { 'retry-after': String(hit.retryAfterS) });
      }
      taken.push(w);
    }
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  return null;
}

const userSubject = async (scopeId: string, root: { provider: string; sub: string }): Promise<string> =>
  `near-relay:user:${hex((await sha256(new TextEncoder().encode(`${scopeId}#${root.provider}#${root.sub}`))).slice(0, 16))}`;

/**
 * Takes the worst case from the app's day budget, then from the env's (D736: the app's is below the env's, so one app
 * can't use up the day); a refusal by the env's gives the app's back. Writes the day's alert past budgetAlertPct.
 */
async function reserveBudget(env: Env, ctx: Ctx, app: App, config: NearRelayConfig, amount: bigint, now: number): Promise<Step<null>> {
  let a;
  let r;
  try {
    a = await limiter(env, `app:${app.id}`).spend(BUDGET_WINDOW, DAY, config.appDailyBudgetYocto.toString(), amount.toString(), now);
    if (!a.ok) return { ok: false, response: reject(ctx, 429, 'app_budget_exhausted', "This app's daily NEAR relay budget is used up, try again later", { 'retry-after': String(a.retryAfterS) }) };
    r = await limiter(env, BUDGET_SUBJECT).spend(BUDGET_WINDOW, DAY, config.dailyBudgetYocto.toString(), amount.toString(), now);
    if (!r.ok) await limiter(env, `app:${app.id}`).giveBack(BUDGET_WINDOW, DAY, amount.toString(), now);
  } catch {
    return { ok: false, response: reject(ctx, 503, 'rate_limiter_unavailable', 'Try again') };
  }
  const spent = BigInt(r.spent);
  if (spent * 100n >= config.dailyBudgetYocto * BigInt(NEAR_RELAY_LIMITS.budgetAlertPct)) await noteBudgetHigh(env, ctx, spent, config.dailyBudgetYocto, now);
  if (!r.ok) return { ok: false, response: reject(ctx, 503, 'relay_budget_exhausted', "The NEAR relay's daily budget is used up, try again later", { 'retry-after': String(r.retryAfterS) }) };
  return { ok: true, value: null };
}

/** One `near_relay_budget_high` security event per UTC day (a fixed id). Amounts only. Never throws. */
async function noteBudgetHigh(env: Env, ctx: Ctx, spent: bigint, budget: bigint, now: number): Promise<void> {
  const day = new Date(Math.floor(now / DAY) * DAY).toISOString().slice(0, 10);
  try {
    await env.DB.prepare("INSERT OR IGNORE INTO security_events (id, detected_at, kind, detail_json) VALUES (?1, ?2, 'near_relay_budget_high', ?3)")
      .bind(await eventId('near_relay_budget_high', day), now, JSON.stringify({ day, spentYocto: spent.toString(), budgetYocto: budget.toString(), thresholdPct: NEAR_RELAY_LIMITS.budgetAlertPct }))
      .run();
  } catch {
    log({ event: 'near_relay_alert_failed', requestId: ctx.requestId, endpoint: ctx.endpoint, code: 'near_relay_budget_high' }, 'warn');
  }
}

/** Gives back what a relay didn't spend: all of it when it never executed, else the worst case less what it burnt. */
async function settleBudget(env: Env, app: App, reserved: bigint, result: RelayResult, at: number): Promise<void> {
  let back = 0n;
  if (!result.ok && (NOT_EXECUTED.has(result.code) || result.code === ALREADY_RELAYED)) back = reserved;
  else if (result.relayTokensBurnt && /^\d{1,40}$/u.test(result.relayTokensBurnt)) back = reserved - BigInt(result.relayTokensBurnt);
  if (back <= 0n) return;
  try {
    await Promise.all([limiter(env, BUDGET_SUBJECT).giveBack(BUDGET_WINDOW, DAY, back.toString(), at), limiter(env, `app:${app.id}`).giveBack(BUDGET_WINDOW, DAY, back.toString(), at)]);
  } catch {
    // The count stays high: the budget errs on the side of spending less.
  }
}

/** The key object a sender's relays go through: sha256(account) mod the key count, so copies of one request meet at one object. */
async function keyIndexFor(accountId: string, count: number): Promise<number> {
  const h = await sha256(new TextEncoder().encode(accountId));
  return new DataView(h.buffer).getUint32(0) % count;
}

async function relayThrough(env: Env, ctx: Ctx, keyCount: number, job: NearRelayJob, claim: string): Promise<RelayResult> {
  const keyIndex = await keyIndexFor(job.receiverId, keyCount);
  try {
    return (await placedStub(env, env.RELAYER_KEY, nearRelayKeyName(keyIndex)).relayNear(keyIndex, job, ctx.requestId, claim)) as RelayResult;
  } catch {
    return { ok: false, status: 503, code: 'relayer_unavailable', error: 'The relayer is unavailable, try again' };
  }
}

/** Why NEAR refused the delegate action itself (in the sender's receipt), from the failure's text; null for a call's own failure. */
export function delegateFailure(error: string): string | null {
  if (/DelegateActionExpired/u.test(error)) return 'expired';
  if (/DelegateActionInvalidNonce/u.test(error)) return 'invalid_nonce';
  if (/DelegateActionNonceTooLarge/u.test(error)) return 'nonce_too_large';
  if (/DelegateActionAccessKeyError/u.test(error)) return 'access_key';
  if (/DelegateActionInvalidSignature/u.test(error)) return 'invalid_signature';
  if (/DelegateActionSenderDoesNotMatchTxReceiver/u.test(error)) return 'sender_mismatch';
  if (/AccountDoesNotExist/u.test(error)) return 'account_missing';
  return null;
}

/** The relay's answer: `{transactionHash, status}` (D737), with the API's error fields on a failure. */
function relayAnswer(ctx: Ctx, result: RelayResult, sender: string, extra: Obj = {}): Response {
  if (result.ok) return done(ctx, 200, { transactionHash: result.nearTx, status: 'executed', nearTx: result.nearTx, ...extra });
  const tx = result.nearTx ? { transactionHash: result.nearTx, nearTx: result.nearTx } : {};
  if (result.code === 'timeout') return done(ctx, 504, { error: 'Timed out waiting for the transaction outcome; poll the transaction', code: 'timeout', status: 'pending', ...tx });
  if (result.code === 'contract_rejected') {
    const reason = result.executor === sender || result.executor === null ? delegateFailure(result.error) : null;
    if (reason) return done(ctx, 422, { error: 'NEAR refused the delegate action', code: 'delegate_rejected', reason, status: 'failed', ...tx });
    return done(ctx, 422, { error: result.error, code: 'contract_rejected', status: 'failed', executor: result.executor ?? null, ...tx });
  }
  return done(ctx, result.status, { error: result.error, code: result.code, ...tx }, result.code === 'relayer_busy' || result.code === 'relayer_unavailable' ? { 'retry-after': '1' } : {});
}

// ---- POST /v1/near/relay ----

/** The refusal of a decoded delegate, in the API's error style. */
function delegateRefusal(ctx: Ctx, d: DecodedDelegate, config: NearRelayConfig): Response | null {
  const refusal = policyRefusal(d, { receivers: config.receivers, maxGas: config.maxGas });
  if (!refusal) return null;
  switch (refusal.code) {
    case 'sender_not_implicit':
      return reject(ctx, 400, 'sender_not_implicit', "sender_id must be the implicit account (hex) of the delegate's own public key");
    case 'action_not_allowed':
      return done(ctx, 403, { error: 'Only function calls are relayed', code: 'action_not_allowed', index: refusal.index, action: refusal.action });
    case 'no_actions':
      return reject(ctx, 400, 'bad_delegate', 'The delegate action has no actions');
    case 'deposit_not_allowed':
      return done(ctx, 403, { error: 'A relayed call attaches no deposit', code: 'deposit_not_allowed', index: refusal.index });
    case 'receiver_not_allowed':
      return done(ctx, 403, { error: 'This receiver is not relayed', code: 'receiver_not_allowed', receiverId: refusal.receiverId });
    case 'gas_too_high':
      return done(ctx, 403, { error: 'The calls attach too much gas', code: 'gas_too_high', maxGas: refusal.maxGas.toString() });
  }
}

export async function handleNearRelay(request: Request, env: Env, requestId: string): Promise<Response> {
  const ctx = newCtx(env, requestId, NEAR_RELAY_ENDPOINT, request);
  const gate = await appGate(request, env, ctx, 'near');
  if (!gate.ok) return gate.response;
  const { app } = gate;
  const ready = nearRelayReady(env);
  if (!ready) return reject(ctx, 503, 'relayer_unconfigured', 'The NEAR relay is not configured');
  const { config, keyCount } = ready;
  const parsed = await readJson(request, MAX_BODY);
  if (!parsed.ok) return reject(ctx, parsed.status, 'bad_request', parsed.error);
  const req = toRelayRequest(parsed.body);
  if (!req) return reject(ctx, 400, 'bad_request', 'Not a NEAR relay request');
  const net = networkRefusal(ctx, req.network);
  if (net) return net;

  const decoded = decodeSignedDelegate(req.signedDelegate);
  if (!decoded.ok) return done(ctx, 400, { error: 'Not a signed delegate action', code: 'bad_delegate', reason: decoded.error });
  const d = decoded.value;
  const refused = delegateRefusal(ctx, d, config);
  if (refused) return refused;
  if (!(await verifyDelegateSignature(d))) return reject(ctx, 400, 'bad_delegate_signature', "The delegate action's signature does not verify");
  lap(ctx, 'checks');
  const known = await knownAccount(env, ctx, app, config, d.senderId);
  if (!known.ok) return known.response;
  let user: string | null = known.value;
  if (req.proof) {
    const proven = await provenUser(env, ctx, app, req.proof, await nearRelayPayload(req.network, req.signedDelegate));
    if (!proven.ok) return proven.response;
    user ??= await userSubject(app.scope_id, proven.value);
  }

  // The chain: the head (expiry, the budget's gas price) and the sender's own key (exists, nonce unused).
  let head: { height: bigint; gasPrice: bigint };
  let key: AccountKey;
  try {
    const rpc = nearRpc(env);
    [head, key] = await Promise.all([headBlock(rpc), implicitAccountKey(rpc, d.senderId)]);
  } catch {
    return reject(ctx, 502, 'near_unavailable', 'Could not read NEAR, try again');
  }
  lap(ctx, 'chain');
  if (key.kind === 'no_account') return reject(ctx, 409, 'account_not_activated', 'The NEAR account does not exist yet: activate it first (POST /v1/near/activate)');
  if (key.kind === 'no_key') return reject(ctx, 409, 'access_key_missing', "The account doesn't hold the delegate's public key");
  const top = key.height > head.height ? key.height : head.height;
  if (d.nonce <= key.nonce) return done(ctx, 409, { error: 'The delegate nonce is already used', code: 'delegate_nonce_used', accessKeyNonce: key.nonce.toString() });
  if (d.nonce >= (top + 1n) * NONCE_RANGE_MULTIPLIER) return done(ctx, 400, { error: 'The delegate nonce is too large', code: 'delegate_nonce_too_large', accessKeyNonce: key.nonce.toString() });
  if (d.maxBlockHeight < top + MIN_BLOCKS_AHEAD) return done(ctx, 400, { error: 'The delegate action has expired or expires too soon', code: 'delegate_expired', blockHeight: Number(top) });
  const maxAhead = top + BigInt(NEAR_RELAY_LIMITS.maxBlocksAhead);
  if (d.maxBlockHeight > maxAhead) return done(ctx, 400, { error: 'max_block_height is too far ahead', code: 'block_height_too_far', blockHeight: Number(top), maxBlockHeight: Number(maxAhead) });

  const q = await quota(env, ctx, [
    { subject: `near-relay:sender:${d.senderId}`, limits: [{ name: 'near-relay:day', windowMs: DAY, max: config.perSenderPerDay }], what: 'per account' },
    ...(user ? [{ subject: user, limits: [{ name: 'near-relay:day', windowMs: DAY, max: NEAR_RELAY_LIMITS.perUserPerDay }], what: 'per user' }] : []),
    {
      subject: `app:${app.id}`,
      limits: [
        { name: 'near-relay:minute', windowMs: MINUTE, max: NEAR_RELAY_LIMITS.perAppPerMinute },
        { name: 'near-relay:day', windowMs: DAY, max: config.perAppPerDay },
      ],
      what: 'per app',
    },
    { subject: 'near-relay:global', limits: [{ name: 'near-relay:day', windowMs: DAY, max: config.relaysPerDay }], what: 'across the env' },
  ]);
  if (q) return q;
  const now = Date.now();
  const reserved = (innerGas(d) + RELAY_OVERHEAD_GAS) * head.gasPrice;
  const budget = await reserveBudget(env, ctx, app, config, reserved, now);
  if (!budget.ok) return budget.response;
  lap(ctx, 'limits');

  const result = await relayThrough(env, ctx, keyCount, { receiverId: d.senderId, action: { kind: 'delegate', signedDelegate: req.signedDelegate } }, `delegate:${hex(await sha256(req.signedDelegate))}`);
  lapRelay(ctx, result);
  await settleBudget(env, app, reserved, result, now);
  return relayAnswer(ctx, result, d.senderId);
}

// ---- POST /v1/near/activate ----

export async function handleNearActivate(request: Request, env: Env, requestId: string): Promise<Response> {
  const ctx = newCtx(env, requestId, NEAR_ACTIVATE_ENDPOINT, request);
  const gate = await appGate(request, env, ctx, 'near-activate');
  if (!gate.ok) return gate.response;
  const { app } = gate;
  const ready = nearRelayReady(env);
  if (!ready) return reject(ctx, 503, 'relayer_unconfigured', 'The NEAR relay is not configured');
  const { config, keyCount } = ready;
  const parsed = await readJson(request, MAX_BODY);
  if (!parsed.ok) return reject(ctx, parsed.status, 'bad_request', parsed.error);
  const req = toActivateRequest(parsed.body);
  if (!req) return reject(ctx, 400, 'bad_request', 'Not a NEAR activation request');
  const net = networkRefusal(ctx, req.network);
  if (net) return net;
  const known = await knownAccount(env, ctx, app, config, req.accountId);
  if (!known.ok) return known.response;
  let user: string | null = known.value;
  if (req.proof) {
    const proven = await provenUser(env, ctx, app, req.proof, nearActivatePayload(req.network, req.accountId));
    if (!proven.ok) return proven.response;
    user ??= await userSubject(app.scope_id, proven.value);
  }

  let head: { height: bigint; gasPrice: bigint };
  let key: AccountKey;
  try {
    const rpc = nearRpc(env);
    [head, key] = await Promise.all([headBlock(rpc), implicitAccountKey(rpc, req.accountId)]);
  } catch {
    return reject(ctx, 502, 'near_unavailable', 'Could not read NEAR, try again');
  }
  lap(ctx, 'chain');
  if (key.kind !== 'no_account') {
    // Already there: nothing to send. The key's nonce tells the client what to sign next.
    return done(ctx, 200, { created: false, accountId: req.accountId, accessKeyNonce: key.kind === 'key' ? key.nonce.toString() : null, blockHeight: Number(key.kind === 'key' && key.height > head.height ? key.height : head.height) });
  }
  const q = await quota(env, ctx, [
    ...(user ? [{ subject: user, limits: [{ name: 'near-activate:day', windowMs: DAY, max: NEAR_RELAY_LIMITS.activationsPerUserPerDay }], what: 'per user' }] : []),
    { subject: `app:${app.id}`, limits: [{ name: 'near-activate:day', windowMs: DAY, max: config.activationsPerAppPerDay }], what: 'per app' },
    { subject: 'near-activate:global', limits: [{ name: 'near-activate:day', windowMs: DAY, max: config.activationsPerDay }], what: 'across the env' },
  ]);
  if (q) return q;
  const now = Date.now();
  const reserved = ACTIVATE_GAS * head.gasPrice + config.activationYocto;
  const budget = await reserveBudget(env, ctx, app, config, reserved, now);
  if (!budget.ok) return budget.response;
  lap(ctx, 'limits');

  const result = await relayThrough(env, ctx, keyCount, { receiverId: req.accountId, action: { kind: 'activate', amount: config.activationYocto } }, `activate:${req.accountId}`);
  lapRelay(ctx, result);
  await settleBudget(env, app, reserved, result, now);
  if (!result.ok) return relayAnswer(ctx, result, req.accountId);
  // The new key's nonce (the creation block × 10^6), read back so the client signs its first delegate with nonce + 1.
  let after: AccountKey | null = null;
  try {
    after = await implicitAccountKey(nearRpc(env), req.accountId);
  } catch {
    after = null;
  }
  return done(ctx, 200, {
    created: true,
    accountId: req.accountId,
    accessKeyNonce: after?.kind === 'key' ? after.nonce.toString() : null,
    blockHeight: after?.kind === 'key' ? Number(after.height) : null,
    transactionHash: result.nearTx,
    nearTx: result.nearTx,
  });
}
