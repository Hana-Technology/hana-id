// The mocked NEAR side: hana-signer's sessions, relayed transactions and a test MPC (real BLS12-381, so the vault's
// pairing check against the pinned network key runs exactly as on testnet), plus the NEAR JSON-RPC that the vault and
// the export window (`get_session`, `EXPERIMENTAL_tx_status`) and apps/api's Worker (`get_session` for share
// creation, `get_scope` and `get_config` for GET /v1/app) read. Every scope allows shared login with the stack's
// shared Google client.
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { base58 } from '@scure/base';
import { CKD_DST, base64Decode, base64Encode, ckdAppId, fromUtf8, toHex, utf8 } from '@hana-id/core';
import { E2E_ENV, GOOGLE_CLIENT_ID, TEST_MPC_MSK } from '../stack.ts';
import { type Handler, json } from './http.ts';

const G1 = bls.G1.ProjectivePoint;
const G2 = bls.G2.ProjectivePoint;
const NETWORK_KEY_BYTES = G2.BASE.multiply(TEST_MPC_MSK).toRawBytes(true);

const g1 = (p: InstanceType<typeof G1>): string => `bls12381g1:${base58.encode(p.toRawBytes(true))}`;

/** The MPC's CKD answer: (Y, C) = (y·G1, msk·H(pk ‖ app_id) + y·A), for the app key `pk1` and the session's path. */
export function mpcAnswer(pk1: string, path: string, signer: string = E2E_ENV.signer): { big_y: string; big_c: string } {
  const appId = ckdAppId(signer, path);
  const h = G1.fromAffine(bls.G1.hashToCurve(Uint8Array.from([...NETWORK_KEY_BYTES, ...appId]), { DST: CKD_DST }).toAffine());
  const y = bls.G1.normPrivateKeyToScalar(bls.utils.randomPrivateKey());
  const a = G1.fromHex(base58.decode(pk1.slice('bls12381g1:'.length)));
  return { big_y: g1(G1.BASE.multiply(y)), big_c: g1(h.multiply(TEST_MPC_MSK).add(a.multiply(y))) };
}

export interface ChainSession {
  path: string;
  scope_id: string;
  expires_at_ms: number;
  max_uses: number;
  used: number;
}

export class Chain {
  /** By session public key (hex). */
  readonly sessions = new Map<string, ChainSession>();
  /** Relayed transactions by hash: the CKD result of a login or derive. */
  readonly txs = new Map<string, unknown>();

  newTxHash(): string {
    return base58.encode(crypto.getRandomValues(new Uint8Array(32)));
  }

  session(sessionPublicKey: Uint8Array): ChainSession | null {
    const s = this.sessions.get(toHex(sessionPublicKey));
    return s && s.expires_at_ms > Date.now() ? s : null;
  }

  /** The contract's view methods the stack's callers use, or undefined for any other. */
  private view(method: unknown, args: Record<string, unknown>): { value: unknown } | undefined {
    switch (method) {
      case 'get_session':
        return { value: Array.isArray(args.session_public_key) ? this.session(Uint8Array.from(args.session_public_key as number[])) : null };
      case 'get_scope':
        return { value: typeof args.scope_id === 'string' ? { id: args.scope_id, owners: [], clients: [], pending: [], action_nonce: 0, allow_shared: true } : null };
      case 'get_config':
        return { value: { console_audiences: [], shared_clients: [['google', GOOGLE_CLIENT_ID]], pending_shared_clients: [] } };
      default:
        return undefined;
    }
  }

  /** NEAR JSON-RPC (only what the Hana pages and the API call). */
  rpc(body: unknown): Response {
    const req = body as { id?: unknown; method?: unknown; params?: Record<string, unknown> } | null;
    const id = req?.id ?? null;
    const ok = (result: unknown) => json(200, { jsonrpc: '2.0', id, result });
    const err = (name: string) => json(200, { jsonrpc: '2.0', id, error: { name, cause: { name }, code: -32000, message: name } });
    if (req?.method === 'query' && req.params?.request_type === 'call_function') {
      if (req.params.account_id !== E2E_ENV.signer) return err('UNKNOWN_ACCOUNT');
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(fromUtf8(base64Decode(String(req.params.args_base64)))) as Record<string, unknown>;
      } catch {
        return err('PARSE_ERROR');
      }
      const v = this.view(req.params.method_name, args ?? {});
      if (!v) return err('MethodResolveError');
      return ok({ result: Array.from(utf8(JSON.stringify(v.value))), logs: [], block_height: 1, block_hash: '11111111111111111111111111111111' });
    }
    if (req?.method === 'EXPERIMENTAL_tx_status') {
      if (req.params?.sender_account_id !== E2E_ENV.relayer) return err('UNKNOWN_TRANSACTION');
      const v = this.txs.get(String(req.params?.tx_hash));
      if (v === undefined) return err('UNKNOWN_TRANSACTION');
      return ok({ status: { SuccessValue: base64Encode(utf8(JSON.stringify(v))) }, receipts_outcome: [] });
    }
    return json(200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  }

  /** The RPC over HTTP, with CORS for the pages. */
  handler(): Handler {
    return async (request) => {
      const cors = { 'access-control-allow-origin': request.headers.get('origin') ?? '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      const res = this.rpc(await request.json().catch(() => null));
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    };
  }
}
