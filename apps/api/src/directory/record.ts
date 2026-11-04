// POST /v1/wallets/record (D310 point 3, D313): after a login the vault reports the wallet's two addresses, each
// signed by its own key over the record statement (core wallet-record.ts). Vault only, as /v1/vault/* and the
// identity token are. Checks, cheapest first, so a forged or replayed request costs no chain read and no write:
//
//   1. the vault gate: key, app active, Origin = VAULT_ORIGIN, parent allowed for the app, no scope_conflict; then the
//      vault's limits (per IP, then the app's vault quota);
//   2. the body: exactly {sessionPublicKey (32 bytes), issuedAtMs, path, wallets: {stellar, evm}}, ≤ 4 KiB;
//   3. issuedAtMs within ±5 min of the API's clock (`stale_record`);
//   4. the path is the app's scope's (`scope#provider#sub#key_index`);
//   5. each record verifies for (env, signer, app, scope, path, chain, address, session key, issuedAtMs) by the
//      address's own key (`bad_wallet_record`);
//   6. a directory key (USER_ID_KEY) is set (`directory_unavailable`, 503);
//   7. the session on chain is live, in the app's scope (identity/token.ts checkChainSession, re-read fresh before
//      refusing) and its path is exactly the record's (`session_mismatch`): another session's path is refused;
//   8. one D1 batch: the user (the path's account root, D312), both wallets, the root's identity row.
//
// No session-key signature: the record binds the session key inside each chain key's signature, and step 7 binds the
// session to the path; a replay of a whole request rewrites the same rows with the same times, so it changes nothing.
// The vault sends it in the background, never awaited by the login, once, with a timeout (D317).
//
// SECURITY: nothing here logs the body, an address, the path or a sub; the request log has the app, outcome and code.
import { identityRoot } from '@hana-id/core/identity';
import { WALLET_RECORD_MAX_BODY, WALLET_RECORD_WINDOW_MS, type WalletRecordChain, type WalletRecordContext, verifyWalletRecord } from '@hana-id/core/wallet-record';
import type { Env } from '../env.ts';
import { type Ctx, done, lap, newCtx, reject } from '../handlers.ts';
import { readJson } from '../http.ts';
import { checkChainSession } from '../identity/token.ts';
import { vaultApp, vaultLimits } from '../vault/endpoints.ts';
import { directoryUser, identityKeyHex, noteDirectoryUnavailable, upsertIdentity, upsertUser, upsertWallet, writeDirectory } from './store.ts';

export const WALLET_RECORD_ENDPOINT = '/v1/wallets/record';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactly = (o: Obj, keys: string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const bytesOf = (v: unknown, n: number): Uint8Array | null => (Array.isArray(v) && v.length === n && v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255) ? Uint8Array.from(v as number[]) : null);

interface RecordRequest {
  sessionPk: Uint8Array;
  issuedAtMs: number;
  path: string;
  wallets: Record<WalletRecordChain, { address: string; signature: Uint8Array }>;
}

const SIG_BYTES: Record<WalletRecordChain, number> = { stellar: 64, evm: 65 };

/** Exactly the documented body, each field well formed; null otherwise. */
export function toRecordRequest(body: unknown): RecordRequest | null {
  if (!isObj(body) || !exactly(body, ['sessionPublicKey', 'issuedAtMs', 'path', 'wallets'])) return null;
  const sessionPk = bytesOf(body.sessionPublicKey, 32);
  const { issuedAtMs, path, wallets } = body;
  if (!sessionPk || !Number.isSafeInteger(issuedAtMs) || (issuedAtMs as number) < 0) return null;
  if (typeof path !== 'string' || path.length === 0 || path.length > 512) return null;
  if (!isObj(wallets) || !exactly(wallets, ['stellar', 'evm'])) return null;
  const out = {} as RecordRequest['wallets'];
  for (const chain of ['stellar', 'evm'] as const) {
    const w = wallets[chain];
    if (!isObj(w) || !exactly(w, ['address', 'signature']) || typeof w.address !== 'string' || w.address.length === 0 || w.address.length > 64) return null;
    const signature = bytesOf(w.signature, SIG_BYTES[chain]);
    if (!signature) return null;
    out[chain] = { address: w.address, signature };
  }
  return { sessionPk, issuedAtMs: issuedAtMs as number, path, wallets: out };
}

const bad = (ctx: Ctx): Response => reject(ctx, 400, 'bad_request', 'Body must be {sessionPublicKey: 32 bytes, issuedAtMs, path, wallets: {stellar: {address, signature}, evm: {address, signature}}}');

export async function handleWalletRecord(request: Request, env: Env, requestId: string): Promise<Response> {
  const ctx = newCtx(env, requestId, WALLET_RECORD_ENDPOINT, request);
  const gate = await vaultApp(request, env, ctx);
  if (!gate.ok) return gate.response;
  const { app } = gate;
  const limited = await vaultLimits(request, env, ctx, app);
  if (limited) return limited;

  const parsed = await readJson(request, WALLET_RECORD_MAX_BODY);
  if (!parsed.ok) return reject(ctx, parsed.status, 'bad_request', parsed.error);
  const req = toRecordRequest(parsed.body);
  if (!req) return bad(ctx);

  const now = Date.now();
  if (Math.abs(now - req.issuedAtMs) > WALLET_RECORD_WINDOW_MS) return done(ctx, 400, { error: 'The record is too old or too new', code: 'stale_record', serverTimeMs: now });
  const root = identityRoot(req.path, app.scope_id);
  if (!root) return reject(ctx, 400, 'bad_request', 'path must be a path of the app’s scope');
  const keyIndex = Number(req.path.slice(req.path.lastIndexOf('#') + 1));

  // Each address proven by its own key for exactly this env, signer, app, path and session.
  const base: WalletRecordContext = { env: env.ENV_NAME, signer: env.SIGNER_ACCOUNT, appId: app.id, scopeId: app.scope_id, path: req.path, sessionPublicKey: req.sessionPk, issuedAtMs: req.issuedAtMs };
  const addresses = {} as Record<WalletRecordChain, string>;
  for (const chain of ['stellar', 'evm'] as const) {
    const address = verifyWalletRecord(base, chain, req.wallets[chain]);
    if (address === null) return done(ctx, 400, { error: 'A wallet record does not verify', code: 'bad_wallet_record', chain });
    addresses[chain] = address;
  }
  lap(ctx, 'records');

  const user = await directoryUser(env, app.scope_id, root);
  if (!user) {
    noteDirectoryUnavailable({ requestId, endpoint: ctx.endpoint, appId: app.id });
    return reject(ctx, 503, 'directory_unavailable', 'The wallet directory is unavailable in this environment');
  }

  // The session: live, the app's scope, and on exactly this path (a session of another path is refused).
  const chain = await checkChainSession(env, ctx, app, req.sessionPk, now);
  if (!chain.ok) return chain.response;
  if (chain.session.path !== req.path) return reject(ctx, 403, 'session_mismatch', 'The session is for another path');
  lap(ctx, 'session');

  const written = await writeDirectory(
    env,
    [
      upsertUser(env.DB, user, app.scope_id, req.issuedAtMs),
      upsertWallet(env.DB, user.userId, { chain: 'stellar', address: addresses.stellar, keyIndex }, req.issuedAtMs),
      upsertWallet(env.DB, user.userId, { chain: 'evm', address: addresses.evm, keyIndex }, req.issuedAtMs),
      // The path's owner is the account root, as the chain's session says.
      upsertIdentity(env.DB, { scopeId: app.scope_id, identityKey: await identityKeyHex(app.scope_id, root), userId: user.userId, provider: root.provider, sub: root.sub, role: 'root', status: 'active', effectiveAt: null }, now),
    ],
    { requestId, endpoint: ctx.endpoint, appId: app.id },
  );
  if (!written) return reject(ctx, 503, 'directory_write_failed', 'Could not record the wallets, try again later');
  lap(ctx, 'insert');
  return done(ctx, 200, { recorded: true });
}
