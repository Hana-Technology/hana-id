// The mocked NEAR side: hana-signer's sessions, relayed transactions and a test MPC (real BLS12-381, so the vault's
// pairing check against the pinned network key runs exactly as on testnet), plus the NEAR JSON-RPC that the vault and
// the export window (`get_session`, `EXPERIMENTAL_tx_status`, and the vault's registry check at login: `get_scope` or
// `scope_for_client`) and apps/api's Worker (`get_session` for share creation, `get_scope` and `get_config` for GET
// /v1/app) read. Every scope allows shared login with the stack's shared Google client; no scope has a Google client of
// its own. Email login (batch 8a): every scope holds its email client `("email", "email:<scope>")` (GET /v1/app offers
// email only to an app whose D1 `login_methods` include it), and the email issuer's key is the active `email` key of
// signer `hana` (`get_issuer_keys` / `get_self_issued`), as on testnet after batch 6's setup.
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { base58 } from '@scure/base';
import { CKD_DST, base64Decode, base64Encode, ckdAppId, fromUtf8, identityKeyHex, toHex, utf8 } from '@hana-id/core';
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

/** An identity: its provider and `sub`. */
export interface IdentityRef {
  provider: string;
  sub: string;
}

/** A relayed transaction that carried ID tokens (Chain.relayed). */
export interface RelayedTx {
  method: string;
  tokens: { provider: string; sub: string; claims: string[] }[];
}

/** A member of an account (contract v3 `Member`, plus its `sub` for the mock's own use). */
interface Member {
  key: string;
  provider: string;
  sub: string;
  effective_at_ms: number;
  active: boolean;
  auto: boolean;
}

interface Account {
  root: IdentityRef;
  members: Member[];
  epoch: number;
  unlinked: string[];
}

/** A pending link's wait in the stack (sandbox-dev's `change_delay_ms` is 24 h too). */
export const CHANGE_DELAY_MS = 24 * 3_600_000;

export class Chain {
  /** The email issuer's active key (`get_issuer_keys("email")`), or none: no email issuer on chain. */
  emailKey: { kid: string; n: string; e: string } | null = null;
  /**
   * The kid of the stack's Google signing key (google-backend.ts), active on chain (`get_issuer("google")`): the
   * Worker's own POST /v1/home/login refuses a token whose kid the chain doesn't list (`issuer_key_pending`).
   */
  googleKid: string | null = null;
  /**
   * Contract v3's accounts and links (build plan batches 7 and 8b), as packages/web's vault test harness models them:
   * identity keys whose own path was derived (`opened`, D130) and accounts by root identity key.
   */
  readonly opened = new Set<string>();
  readonly accounts = new Map<string, Account>();

  /** The account an identity key is in (as root or member). */
  accountOf(key: string): { rootKey: string; account: Account } | null {
    for (const [rootKey, account] of this.accounts) if (rootKey === key || account.members.some((m) => m.key === key)) return { rootKey, account };
    return null;
  }

  /** `get_identity` as the contract answers it (lazy activation of a pending member past its time included). */
  identityView(scopeId: string, provider: string, sub: string): Record<string, unknown> {
    const key = identityKeyHex(scopeId, provider, sub);
    const found = this.accountOf(key);
    const m = found?.account.members.find((x) => x.key === key);
    if (found && m) {
      return { key, status: m.active ? 'member' : 'pending', opened: this.opened.has(key), root: found.account.root, effective_at_ms: m.effective_at_ms, account_epoch: found.account.epoch };
    }
    return { key, status: 'own', opened: this.opened.has(key), account_epoch: found?.account.epoch ?? 0 };
  }

  accountView(scopeId: string, provider: string, sub: string): Record<string, unknown> | null {
    const found = this.accountOf(identityKeyHex(scopeId, provider, sub));
    if (!found) return null;
    const a = found.account;
    return { root: a.root, members: a.members.map((m) => ({ key: m.key, provider: m.provider, effective_at_ms: m.effective_at_ms, active: m.active, auto: m.auto })), epoch: a.epoch, unlinked: a.unlinked };
  }

  /** Adds `member` to `root`'s account (creating it), bumping its epoch. */
  link(scopeId: string, root: IdentityRef, member: IdentityRef, o: { active: boolean; effectiveAtMs: number; auto: boolean }): void {
    const rootKey = identityKeyHex(scopeId, root.provider, root.sub);
    const a = this.accounts.get(rootKey) ?? { root, members: [], epoch: 0, unlinked: [] };
    a.members.push({ key: identityKeyHex(scopeId, member.provider, member.sub), provider: member.provider, sub: member.sub, effective_at_ms: o.effectiveAtMs, active: o.active, auto: o.auto });
    a.epoch += 1;
    this.accounts.set(rootKey, a);
  }

  /** Removes a member (cancel_link, unlink_identity); false when there is none. */
  unlink(memberKey: string, mark: boolean): boolean {
    for (const a of this.accounts.values()) {
      const i = a.members.findIndex((m) => m.key === memberKey);
      if (i < 0) continue;
      a.members.splice(i, 1);
      a.epoch += 1;
      if (mark) a.unlinked.push(memberKey);
      return true;
    }
    return false;
  }

  /** Lazy activation (sessions.rs): a pending member past its time becomes active at its next session. */
  private activate(key: string): void {
    const m = this.accountOf(key)?.account.members.find((x) => x.key === key);
    if (m && !m.active && m.effective_at_ms <= Date.now()) m.active = true;
  }

  /** The path identity of a session of `who` (an active member opens its root's path), or 'pending'. */
  pathIdentity(scopeId: string, who: IdentityRef): IdentityRef | 'pending' {
    this.activate(identityKeyHex(scopeId, who.provider, who.sub));
    const v = this.identityView(scopeId, who.provider, who.sub);
    if (v.status === 'pending') return 'pending';
    return v.status === 'member' ? (v.root as IdentityRef) : who;
  }

  /**
   * `auto_link` in `create_session_and_derive` (links.rs, the four cases as the contract judges them, simplified): the
   * link identity has a wallet (case A) → the session identity joins its account at once (immediate only); else the
   * link identity joins the session identity's account, at once or after CHANGE_DELAY_MS. A reason when refused.
   */
  autoLink(scopeId: string, x: IdentityRef, e: IdentityRef, immediate: boolean): string | null {
    const xKey = identityKeyHex(scopeId, x.provider, x.sub);
    const eKey = identityKeyHex(scopeId, e.provider, e.sub);
    if (xKey === eKey) return 'same_identity';
    const xFound = this.accountOf(xKey);
    const eFound = this.accountOf(eKey);
    if (xFound && eFound && xFound.rootKey === eFound.rootKey) return 'already_linked';
    const reaches = (key: string, found: typeof xFound) => (found !== null && found.rootKey !== key && found.account.members.some((m) => m.key === key && m.active)) || this.opened.has(key);
    const xHas = reaches(xKey, xFound);
    const eHas = reaches(eKey, eFound);
    if (xHas && eHas) return 'both_wallets';
    if (eHas) {
      if (!immediate) return 'link_mismatch';
      if (xFound) return 'already_linked';
      this.link(scopeId, eFound ? eFound.account.root : e, x, { active: true, effectiveAtMs: Date.now(), auto: true });
      return null;
    }
    if (eFound) return 'already_linked';
    this.link(scopeId, xFound ? xFound.account.root : x, e, immediate ? { active: true, effectiveAtMs: Date.now(), auto: true } : { active: false, effectiveAtMs: Date.now() + CHANGE_DELAY_MS, auto: true });
    return null;
  }

  /** By session public key (hex). */
  readonly sessions = new Map<string, ChainSession>();
  /** Relayed transactions by hash: the CKD result of a login or derive. */
  readonly txs = new Map<string, unknown>();
  /**
   * Every transaction the relayer sent to hana-signer that carried an ID token, in order: the method and, per token,
   * its identity and claim names (never the token). What "reached the chain" means for the tests (`GET /__e2e/chain`).
   */
  readonly relayed: RelayedTx[] = [];

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
      case 'session_key_in_use':
        return { value: Array.isArray(args.session_public_key) && this.session(Uint8Array.from(args.session_public_key as number[])) !== null };
      case 'get_issuer':
        return { value: args.provider === 'google' && this.googleKid ? { kids: [this.googleKid] } : null };
      case 'get_scope':
        return {
          value:
            typeof args.scope_id === 'string'
              ? { id: args.scope_id, owners: [], clients: this.emailKey ? [['email', `email:${args.scope_id}`]] : [], pending: [], action_nonce: 0, allow_shared: true }
              : null,
        };
      case 'scope_for_client':
        return { value: this.emailKey && args.provider === 'email' && typeof args.aud === 'string' && args.aud.startsWith('email:') ? args.aud.slice('email:'.length) : null };
      case 'get_issuer_keys':
        return { value: args.provider === 'email' ? (this.emailKey ? [this.emailKey] : null) : null };
      case 'get_self_issued':
        return { value: args.provider === 'email' && this.emailKey ? { provider: 'email', signers: [{ id: 'hana', kids: [this.emailKey.kid] }], required: 1, overlap_until_ms: null } : null };
      case 'get_config':
        // A v3 contract created with `new` (or after `accept_unrecorded_wallets`): links are open (D135).
        return { value: { console_audiences: [], shared_clients: [['google', GOOGLE_CLIENT_ID]], pending_shared_clients: [], unrecorded_wallets: false } };
      case 'get_identity':
        return typeof args.scope_id === 'string' && typeof args.provider === 'string' && typeof args.sub === 'string' ? { value: this.identityView(args.scope_id, args.provider, args.sub) } : undefined;
      case 'get_account':
        return typeof args.scope_id === 'string' && typeof args.provider === 'string' && typeof args.sub === 'string' ? { value: this.accountView(args.scope_id, args.provider, args.sub) } : undefined;
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
