// Hana Embed relayer: pays NEAR gas for hana-signer calls (`sign`, and the Google session methods). Runs as a Vercel function (api/embed-sign.ts) and,
// in `pnpm dev`, as Vite middleware (vite.config.ts).
//
// It holds one NEAR key, ideally a function-call access key limited to `sign` on the signer contract with a gas
// allowance. That key cannot sign for users: the contract only signs what a user's JWT authorises (its `fatxn`
// claim must equal the payload). A leaked key can only burn the allowance.
import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { actionCreators, createTransaction, encodeTransaction, Signature, SignedTransaction } from '@near-js/transactions';
import { baseDecode, baseEncode } from '@near-js/utils';

export interface RelayerEnv {
  NEAR_RELAYER_ACCOUNT_ID?: string;
  NEAR_RELAYER_PRIVATE_KEY?: string;
  EMBED_SIGNER_CONTRACT?: string;
  EMBED_GUARD_ID?: string;
  NEAR_RPC_URL?: string;
}

const DEFAULTS = {
  contract: 'hana-signer.testnet',
  guardId: 'jwt#https://login.testnet.fast-auth.com/',
  // FastNEAR answered ~3× faster than rpc.testnet.near.org when measured.
  rpc: 'https://test.rpc.fastnear.com',
};
const GAS = 300_000_000_000_000n;
const MAX_JWT = 7168;
/** Envelope size cap (a Stellar swap's signature base is well under this). */
const MAX_PAYLOAD = 4096;
/** How long to wait for the MPC (it answers a few blocks after the request). */
const SIGN_TIMEOUT_MS = 60_000;

interface RpcError {
  name?: string;
  cause?: { name?: string; info?: unknown };
  data?: unknown;
  message?: string;
}

class Rpc {
  constructor(private readonly url: string) {}

  async call<T>(method: string, params: unknown): Promise<T> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'relayer', method, params }),
    });
    const body = (await res.json()) as { result?: T; error?: RpcError };
    if (body.error) throw Object.assign(new Error(rpcErrorText(body.error)), { rpc: body.error });
    return body.result as T;
  }
}

function rpcErrorText(e: RpcError): string {
  return [e.cause?.name ?? e.name, typeof e.data === 'string' ? e.data : JSON.stringify(e.data ?? e.cause?.info ?? e.message)].filter(Boolean).join(': ');
}

const isTimeout = (err: unknown) => /TIMEOUT|UNKNOWN_TRANSACTION/u.test((err as Error).message);

interface FinalOutcome {
  status: { SuccessValue?: string; Failure?: unknown };
  receipts_outcome: { outcome: { logs: string[]; status: { Failure?: unknown } } }[];
  transaction: { hash: string };
}

/** The first failure anywhere in the receipt tree, as readable text. */
function failureText(outcome: FinalOutcome): string | null {
  const failed = outcome.receipts_outcome.find((r) => r.outcome.status.Failure);
  const failure = outcome.status.Failure ?? failed?.outcome.status.Failure;
  if (!failure) return null;
  const text = JSON.stringify(failure);
  const panic = /"panic_msg":"([^"]+)"/u.exec(text)?.[1] ?? /ExecutionError":"([^"]+)"/u.exec(text)?.[1];
  return panic ?? text;
}

export type RelayResult = { ok: true; result: unknown; nearTx: string } | { ok: false; status: number; error: string; nearTx?: string };

const isBytes = (v: unknown, min: number, max: number): v is number[] =>
  Array.isArray(v) && v.length >= min && v.length <= max && v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

/** Maps a request to one allowed contract call. The contract re-checks everything; this just rejects junk early. */
function toCall(input: unknown, env: RelayerEnv): { method: string; args: Record<string, unknown> } | string {
  const body = (input ?? {}) as Record<string, unknown>;
  const method = typeof body.method === 'string' ? body.method : 'sign';
  switch (method) {
    case 'sign': {
      // NEAR Auth: one token per envelope.
      const { jwt, signPayload } = body;
      if (typeof jwt !== 'string' || jwt.length === 0 || jwt.length > MAX_JWT) return 'jwt must be a NEAR Auth token';
      if (!isBytes(signPayload, 1, MAX_PAYLOAD)) return 'signPayload must be the envelope bytes';
      return { method, args: { guard_id: env.EMBED_GUARD_ID || DEFAULTS.guardId, jwt, sign_payload: signPayload } };
    }
    case 'create_session': {
      const { jwt, sessionPublicKey, expiresAtMs, salt, maxSignatures, scope } = body;
      if (typeof jwt !== 'string' || jwt.length === 0 || jwt.length > MAX_JWT) return 'jwt must be a Google ID token';
      if (!isBytes(sessionPublicKey, 32, 32) || !isBytes(salt, 16, 64) || !isCount(expiresAtMs) || !isCount(maxSignatures) || typeof scope !== 'string') return 'Malformed session request';
      return { method, args: { jwt, session_public_key: sessionPublicKey, expires_at_ms: expiresAtMs, salt, max_signatures: maxSignatures, scope } };
    }
    case 'sign_with_session': {
      const { sessionPublicKey, counter, signature, envelope } = body;
      if (!isBytes(sessionPublicKey, 32, 32) || !isCount(counter) || !isBytes(signature, 64, 64) || !isBytes(envelope, 1, MAX_PAYLOAD)) return 'Malformed signing request';
      return { method, args: { session_public_key: sessionPublicKey, counter, signature, envelope } };
    }
    case 'derive_key': {
      // Full-key mode: the MPC's CKD secret for the session's path, encrypted to the browser's BLS key.
      const { sessionPublicKey, counter, signature, pk1, pk2 } = body;
      const isPoint = (v: unknown, prefix: string): v is string => typeof v === 'string' && v.startsWith(prefix) && v.length < 300;
      if (!isBytes(sessionPublicKey, 32, 32) || !isCount(counter) || !isBytes(signature, 64, 64) || !isPoint(pk1, 'bls12381g1:') || !isPoint(pk2, 'bls12381g2:')) {
        return 'Malformed key request';
      }
      return { method, args: { session_public_key: sessionPublicKey, counter, signature, pk1, pk2 } };
    }
    case 'revoke_session': {
      const { sessionPublicKey, counter, signature } = body;
      if (!isBytes(sessionPublicKey, 32, 32) || !isCount(counter) || !isBytes(signature, 64, 64)) return 'Malformed revoke request';
      return { method, args: { session_public_key: sessionPublicKey, counter, signature } };
    }
    default:
      return `Unknown method ${method}`;
  }
}

export async function relaySign(env: RelayerEnv, input: unknown): Promise<RelayResult> {
  const accountId = env.NEAR_RELAYER_ACCOUNT_ID;
  const privateKey = env.NEAR_RELAYER_PRIVATE_KEY;
  if (!accountId || !privateKey) return { ok: false, status: 503, error: 'The signing relayer isn’t configured (NEAR_RELAYER_ACCOUNT_ID / NEAR_RELAYER_PRIVATE_KEY).' };

  const call = toCall(input, env);
  if (typeof call === 'string') return { ok: false, status: 400, error: call };

  const rpc = new Rpc(env.NEAR_RPC_URL || DEFAULTS.rpc);
  const contract = env.EMBED_SIGNER_CONTRACT || DEFAULTS.contract;
  const keyPair = KeyPair.fromString(privateKey as KeyPairString);
  const publicKey = keyPair.getPublicKey();

  const accessKey = await rpc.call<{ nonce: number; block_hash: string }>('query', {
    request_type: 'view_access_key',
    finality: 'final',
    account_id: accountId,
    public_key: publicKey.toString(),
  });
  const tx = createTransaction(accountId, publicKey, contract, BigInt(accessKey.nonce) + 1n, [actionCreators.functionCall(call.method, call.args, GAS, 0n)], baseDecode(accessKey.block_hash));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(encodeTransaction(tx))));
  const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: publicKey.keyType, data: keyPair.sign(hash).signature }) });
  const txHash = baseEncode(hash);

  let outcome: FinalOutcome | null = null;
  try {
    outcome = await rpc.call<FinalOutcome>('send_tx', { signed_tx_base64: Buffer.from(signed.encode()).toString('base64'), wait_until: 'EXECUTED' });
  } catch (err) {
    if (!isTimeout(err)) return { ok: false, status: 502, error: `NEAR rejected the request: ${(err as Error).message}`, nearTx: txHash };
  }
  // The MPC answers a few blocks later; poll if send_tx gave up first.
  const deadline = Date.now() + SIGN_TIMEOUT_MS;
  const settled = (o: FinalOutcome | null): o is FinalOutcome => !!o && ('SuccessValue' in o.status || 'Failure' in o.status);
  while (!settled(outcome)) {
    if (Date.now() > deadline) return { ok: false, status: 504, error: 'Timed out waiting for the MPC signature', nearTx: txHash };
    await new Promise((r) => setTimeout(r, 400));
    try {
      outcome = await rpc.call<FinalOutcome>('tx', { tx_hash: txHash, sender_account_id: accountId, wait_until: 'EXECUTED' });
    } catch (err) {
      if (!isTimeout(err)) return { ok: false, status: 502, error: (err as Error).message, nearTx: txHash };
    }
  }

  const failure = failureText(outcome);
  if (failure) return { ok: false, status: 422, error: failure, nearTx: txHash };
  const value: unknown = outcome.status.SuccessValue ? JSON.parse(Buffer.from(outcome.status.SuccessValue, 'base64').toString()) : null;
  if (!value && call.method !== 'revoke_session') return { ok: false, status: 502, error: 'The contract returned nothing', nearTx: txHash };
  return { ok: true, result: value, nearTx: txHash };
}

/** Fetch-style handler shared by the Vercel function and the dev middleware. */
export async function handleEmbedSign(request: Request, env: RelayerEnv): Promise<Response> {
  if (request.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400 });
  }
  try {
    const result = await relaySign(env, body);
    // `signature` kept for the NEAR Auth client; session calls read `result`.
    // `in` narrows even when compiled without strict mode (as Vercel may compile api/).
    if ('error' in result) return Response.json({ error: result.error, nearTx: result.nearTx }, { status: result.status });
    return Response.json({ result: result.result, signature: result.result, nearTx: result.nearTx });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
