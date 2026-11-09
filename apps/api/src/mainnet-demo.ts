// The mainnet demo exception to D39 and the user events staff see (D428, D430; docs/mainnet-demo-and-key-export-spec.md):
// - whether an app has the demo on, as GET /v1/app serves it: only in a dev env on testnet, only for a test scope, only
//   when Hana staff set `apps.mainnet_demo` (migration 0013); anything unreadable is off;
// - POST /v1/mainnet-demo/events: the vault's report of one demo signature (no key or signed bytes), proven by the
//   session that signed and by the address's own wallet proof, stored as a `mainnet_signature` row naming the user;
// - the `key_exported` row the export window's /v1/login writes once it succeeded (login.ts), and Hana Home's
//   POST /v1/home/login at its derive (home/login.ts), which has no app, so its `app_id` is NULL (migration 0018).
//
// SECURITY: nothing here reads or stores a key, a token, a path or a sub. A report is bound to a live session and to the
// address's own key, but it is still the vault's word that the signature was made (the API never sees it); it is
// single use, rate-limited per app and labelled "reported by the vault".
import { MAINNET_DEMO_EVENTS_ENDPOINT, MAINNET_DEMO_EVM_CHAINS, MAINNET_DEMO_TX_CAP_USD_MICROS } from '@hana-id/core/demo-config';
import { directoryUser } from './directory/store.ts';
import type { Env } from './env.ts';
import { done, lap, limiter, newCtx, reject } from './handlers.ts';
import { readJson } from './http.ts';
import { log } from './log.ts';
import { IDENTITY_NONCE_BYTES, IDENTITY_PROOF_MARKER_MS, IDENTITY_PROOF_WINDOW_MS, identityMessage, identityRoot, mainnetDemoEventPayload, verifyWalletProof } from '@hana-id/core/identity';
import { hex } from './bytes.ts';
import { checkChainSession, proofMarker, verifyEd25519 } from './identity/token.ts';
import { mainnetDemoOn } from './mainnet-demo-setting.ts';
import { vaultApp, vaultLimits } from './vault/endpoints.ts';

export { MAINNET_DEMO_EVENTS_ENDPOINT };
export { mainnetDemoEnv, mainnetDemoOn } from './mainnet-demo-setting.ts';

/** Demo signatures one app may report per hour (a script on the page can't flood the table). */
export const MAINNET_DEMO_EVENTS_PER_HOUR = 120;
const HOUR = 3_600_000;
const MAX_BODY = 2048;

export interface MainnetDemoEvent {
  chain: 'evm' | 'stellar';
  network: string;
  kind: 'evm_tx' | 'stellar_tx';
  usdMicros: number;
}

/** A report's body, checked for shape: the event (a demo network, a value within the cap) and its session proofs. */
export interface MainnetDemoReport {
  event: MainnetDemoEvent;
  usdMicrosText: string;
  sessionPk: Uint8Array;
  issuedAtMs: number;
  nonce: Uint8Array;
  signature: Uint8Array;
  walletProof: { address: string; signature: Uint8Array };
}

const bytesOf = (v: unknown, n: number): Uint8Array | null =>
  Array.isArray(v) && v.length === n && v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255) ? Uint8Array.from(v as number[]) : null;

/** The event fields, exactly: a demo network, its kind, a value within the cap. */
export function toMainnetDemoEvent(b: Record<string, unknown>): MainnetDemoEvent | null {
  const { chain, network, kind, usdMicros } = b;
  if (typeof usdMicros !== 'string' || !/^\d{1,9}$/u.test(usdMicros) || BigInt(usdMicros) > MAINNET_DEMO_TX_CAP_USD_MICROS) return null;
  if (chain === 'evm') {
    if (kind !== 'evm_tx' || typeof network !== 'string' || !/^\d{1,10}$/u.test(network) || !MAINNET_DEMO_EVM_CHAINS.includes(Number(network))) return null;
  } else if (chain === 'stellar') {
    if (kind !== 'stellar_tx' || network !== 'pubnet') return null;
  } else return null;
  return { chain, network, kind, usdMicros: Number(usdMicros) };
}

/** The whole body, exactly its nine fields (D428 as reviewed). */
export function toMainnetDemoReport(body: unknown): MainnetDemoReport | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (Object.keys(b).sort().join(',') !== 'chain,issuedAtMs,kind,network,nonce,sessionPublicKey,signature,usdMicros,walletProof') return null;
  const event = toMainnetDemoEvent(b);
  const sessionPk = bytesOf(b.sessionPublicKey, 32);
  const nonce = bytesOf(b.nonce, IDENTITY_NONCE_BYTES);
  const signature = bytesOf(b.signature, 64);
  if (!event || !sessionPk || !nonce || !signature || !Number.isSafeInteger(b.issuedAtMs) || (b.issuedAtMs as number) < 0) return null;
  const wp = b.walletProof as Record<string, unknown> | null;
  if (typeof wp !== 'object' || wp === null || Array.isArray(wp) || Object.keys(wp).sort().join(',') !== 'address,signature' || typeof wp.address !== 'string' || wp.address.length > 64) return null;
  const proofSig = bytesOf(wp.signature, event.chain === 'evm' ? 65 : 64);
  if (!proofSig) return null;
  return { event, usdMicrosText: b.usdMicros as string, sessionPk, issuedAtMs: b.issuedAtMs as number, nonce, signature, walletProof: { address: wp.address, signature: proofSig } };
}

/**
 * POST /v1/mainnet-demo/events: from the vault page only, for an app with the demo on, proven by the session that
 * signed (D428 as reviewed): the session key's signature over the event, the session live on chain in the app's scope,
 * the wallet proof of the reported address made by that address's own key for this session and app, each proof used
 * once. The row names the session's user (its account root's internal id), never a bare address.
 */
export async function handleMainnetDemoEvent(request: Request, env: Env, requestId: string): Promise<Response> {
  const ctx = newCtx(env, requestId, MAINNET_DEMO_EVENTS_ENDPOINT, request);
  const gate = await vaultApp(request, env, ctx);
  if (!gate.ok) return gate.response;
  const { app } = gate;
  const limited = await vaultLimits(request, env, ctx, app);
  if (limited) return limited;
  const parsed = await readJson(request, MAX_BODY);
  if (!parsed.ok) return reject(ctx, parsed.status, 'bad_request', parsed.error);
  const r = toMainnetDemoReport(parsed.body);
  if (!r) return reject(ctx, 400, 'bad_request', 'Not a mainnet demo event');
  const now = Date.now();
  if (Math.abs(now - r.issuedAtMs) > IDENTITY_PROOF_WINDOW_MS) return done(ctx, 400, { error: 'The session proof is too old or too new', code: 'stale_proof', serverTimeMs: now });
  // The session key signed exactly this event, with exactly this wallet proof, for this app and signer.
  const payload = mainnetDemoEventPayload({ chain: r.event.chain, network: r.event.network, kind: r.event.kind, usdMicros: r.usdMicrosText, walletProof: r.walletProof });
  const message = identityMessage({ signer: env.SIGNER_ACCOUNT, appId: app.id, sessionPublicKey: r.sessionPk, issuedAtMs: r.issuedAtMs, nonce: r.nonce, payload });
  if (!(await verifyEd25519(r.sessionPk, r.signature, message))) return reject(ctx, 401, 'invalid_signature', 'Invalid session signature');
  lap(ctx, 'proof');
  if (!(await mainnetDemoOn(env, app))) return reject(ctx, 409, 'mainnet_demo_off', 'The mainnet demo is not on for this app');
  // The reported address is the session's own wallet: proven by its own key for this session key and app.
  const address = verifyWalletProof({ signer: env.SIGNER_ACCOUNT, appId: app.id, sessionPublicKey: r.sessionPk }, r.event.chain, r.walletProof);
  if (address === null) return done(ctx, 400, { error: 'The wallet proof does not verify', code: 'bad_wallet_proof', chain: r.event.chain });
  // The session: live, in the app's scope; its account root names the user.
  const chain = await checkChainSession(env, ctx, app, r.sessionPk, now);
  if (!chain.ok) return chain.response;
  const root = identityRoot(chain.session.path, app.scope_id);
  if (!root) return reject(ctx, 502, 'bad_contract_result', 'The session path is not one this API can read');
  const user = await directoryUser(env, app.scope_id, root);
  if (typeof user === 'string') return reject(ctx, 503, 'event_unavailable', 'Events are unavailable in this environment');
  lap(ctx, 'session');
  try {
    // Single use (as the identity token's proofs), then the app's hourly cap.
    if (!(await limiter(env, `mainnet-demo-proof:${hex(r.sessionPk)}`).reserve(await proofMarker(r), r.issuedAtMs + IDENTITY_PROOF_MARKER_MS, now))) {
      return reject(ctx, 409, 'proof_replayed', 'This session proof was already used');
    }
    const hit = await limiter(env, `mainnet-demo:${app.id}`).hit([{ name: 'mainnet_demo:hour', windowMs: HOUR, max: MAINNET_DEMO_EVENTS_PER_HOUR }]);
    if (!hit.ok) return reject(ctx, 429, 'rate_limited', 'Too many mainnet demo events for this app', { 'retry-after': String(hit.retryAfterS) });
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  try {
    await env.DB.prepare(
      `INSERT INTO user_events (kind, app_id, scope_id, user_id, chain, network, address, usd_micros, request_id, at)
       VALUES ('mainnet_signature', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
      .bind(app.id, app.scope_id, user.internalId, r.event.chain, r.event.network, address, r.event.usdMicros, requestId, now)
      .run();
  } catch {
    return reject(ctx, 503, 'event_unavailable', 'Could not record the event');
  }
  lap(ctx, 'insert');
  return done(ctx, 200, { recorded: true });
}

/**
 * The export window's login (login.ts) or a Home derive (home/login.ts) succeeded: records `key_exported` for the
 * account's user, `appId` null for a Home derive (a Home derive is per scope, and naming one of the scope's apps would
 * be a false row, D520). Never throws, never slows the answer (run in the background); a failure (the directory keys
 * missing, migration 0013 not applied) is logged without any identifier but the app's.
 */
export async function recordKeyExport(
  env: Env,
  a: { appId: string | null; scopeId: string; root: { provider: string; sub: string }; chain: 'stellar' | 'evm' | null; requestId: string },
): Promise<void> {
  const user = await directoryUser(env, a.scopeId, a.root).catch(() => 'no_user_id_key' as const);
  if (typeof user === 'string') {
    log({ event: 'key_export_unrecorded', requestId: a.requestId, appId: a.appId ?? undefined, code: user }, 'warn');
    return;
  }
  try {
    await env.DB.prepare(
      `INSERT INTO user_events (kind, app_id, scope_id, user_id, chain, network, address, usd_micros, request_id, at)
       VALUES ('key_exported', ?1, ?2, ?3, ?4, NULL, NULL, NULL, ?5, ?6)`,
    )
      .bind(a.appId, a.scopeId, user.internalId, a.chain, a.requestId, Date.now())
      .run();
  } catch {
    log({ event: 'key_export_unrecorded', requestId: a.requestId, appId: a.appId ?? undefined, code: 'write_failed' }, 'warn');
  }
}
