// admin.ts scope:add-email-client --scope <id> [--yes]: adds a scope's email client ("email", "email:<scope>") on chain
// in a dev env (`local*`, `sandbox*`, testnet only), without the issuer's Cloudflare Access staff route (D253).
//
// 1. Reads the scope fresh (`get_scope`: its `action_nonce`, owners, clients, pending changes), the contract's config
//    (not paused) and the email issuer on chain (`get_issuer`, `get_self_issued`, `get_issuer_keys`). Refuses when the
//    client is already there, when the issuer or its active key isn't on chain, or when no `Owner::Near` of the scope
//    has a full-access key in ~/.near-credentials/<network>/ (on chain too).
// 2. Mints the client proof locally with the issuer's own code (apps/email-issuer/src/client-proof.ts: the claims and
//    nonce layout of its admin route, its Worker-secret signer and JWS JSON minting), signed with the manifest's active
//    key from .secrets/<env>/email-issuer-signing-key.json (never printed). Checks it against the contract's rules
//    (`clientProofProblems`, a replica of `verify_token` and `propose_change`'s AddClient checks) twice: with the
//    manifest's public key and with `get_issuer_keys("email")`.
// 3. Prints the plan; with --yes the owner sends `propose_change` (0.01 NEAR, PROPOSE_GAS), then
// 4. waits out the change's `unlock_at_ms` when it is ≤ 10 minutes away (sandbox-dev: 60 s), sends `execute_change`
//    (the owner signs; anyone may) and checks that `get_scope` lists the client. A change that unlocks later is left
//    pending: re-run the command with --yes once it is due (an AddClient already pending is executed, not re-proposed).
//
// In production the client proof comes from the issuer's staff route behind Cloudflare Access (docs/operations.md
// "Email issuer", "Staff calls"); this command refuses every env but `local*` and `sandbox*`.
import { createPublicKey, randomBytes, verify as rsaVerify } from 'node:crypto';
import { join } from 'node:path';
import { EMAIL_ISSUER_SECRET_FILES, type Manifest, isDevEnv, repoRoot } from '@hana-id/env';
import { actionCreators } from '@near-js/transactions';
import { CLIENT_PROOF_SUB, clientProofNonce, emailClient, emailClientAud, mintClientProof } from '../../apps/email-issuer/src/client-proof.ts';
import { isScopeId } from '../../apps/email-issuer/src/commitment.ts';
import { EMAIL_PROVIDER } from '../../apps/email-issuer/src/layouts.ts';
import { type PublicJwk, WorkerSecretSigner } from '../../apps/email-issuer/src/signer.ts';
import { type Args, CliError } from './cli.ts';
import { tryView } from './contract.ts';
import { publicEntry, readKeyFile } from './email-issuer.ts';
import { findLegacyCredential, type LoadedKey } from './keys.ts';
import { explorerTx, hasFullAccess, type NearRpc, TGAS } from './near.ts';
import { secretsDir } from './secrets.ts';

export const EMAIL_CLIENT_DRY_RUN_LINE = 'Dry run: re-run with --yes to send.';

/**
 * Gas for `propose_change` with a client proof: one RS256 verification, like `cancel_link` (19.8 Tgas burnt with a
 * 2048-bit key, 68.5 with a 4096-bit one, the largest `set_issuer_key` accepts; attached 150, D155;
 * docs/contract-interface.md "Gas of the email login calls"). Unused gas is refunded.
 */
export const PROPOSE_GAS = 150n * TGAS;
/** `execute_change` verifies nothing: the API's owner-pool default (apps/api/src/gas.ts). */
export const EXECUTE_GAS = 50n * TGAS;
/** What `propose_change(AddClient)` attaches (docs/contract-interface.md `propose_change`: ≈ 0.0016 NEAR needed). */
export const PROPOSE_DEPOSIT = 10n ** 22n;
/** The longest timelock the command waits out itself. */
export const MAX_WAIT_MS = 10 * 60_000;
/** After `unlock_at_ms`, so the block timestamp has passed it too. */
export const UNLOCK_MARGIN_MS = 3_000;
/** Retries of an `execute_change` that is still timelocked by the block's clock. */
const EXECUTE_RETRIES = 3;
const EXECUTE_RETRY_MS = 5_000;

/** The contract's limits (contracts/hana-signer/src/oidc.rs, lib.rs). */
const MAX_JWT_BYTES = 7168;
const MAX_JWS_SIGNATURES = 3;

export type ScopeOwner = { Near: { account_id: string } } | { Oidc: { provider: string; sub: string } };
export interface ScopeView {
  id: string;
  owners: ScopeOwner[];
  clients: [string, string][];
  allow_shared: boolean;
  pending: { id: number; change: unknown; unlock_at_ms: number }[];
  action_nonce: number;
}
export interface IssuerKeyView {
  kid: string;
  n: string;
  e: string;
}
export interface SelfIssuedView {
  provider: string;
  signers: { id: string; kids: string[] }[];
  required: number;
  overlap_until_ms?: number | null;
}

export interface EmailClientDeps {
  rpc: Pick<NearRpc, 'chainId' | 'view' | 'sendTx' | 'accessKeys'>;
  log: (line: string) => void;
  /** Home directory holding ~/.near-credentials (default: the user's home). */
  home?: string | undefined;
  /** Directory holding .secrets/ (default: the repo root). */
  secretsRoot?: string | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The proof's `jti` (default: 16 random bytes, b64url, as the issuer's route). */
  jti?: () => string;
}

/** The env refusal: dev envs (`local*`, `sandbox*`) on testnet only (D253). */
export function assertDevEnv(m: Pick<Manifest, 'name' | 'network'>): void {
  if (!isDevEnv(m.name)) throw new CliError(`scope:add-email-client mints a client proof locally, which is for dev envs (local*, sandbox*) only: on ${m.name} the proof comes from the issuer's staff route behind Cloudflare Access (D253)`);
  if (m.network !== 'testnet') throw new CliError(`envs/${m.name}.json is not a testnet env`);
}

const b64uToBig = (s: string): bigint => {
  const hex = Buffer.from(s, 'base64url').toString('hex');
  return hex ? BigInt(`0x${hex}`) : 0n;
};
/** Same RSA key (n and e as numbers: the contract strips leading zeros). */
export const sameRsaKey = (a: { n: string; e: string }, b: { n: string; e: string }): boolean => b64uToBig(a.n) === b64uToBig(b.n) && b64uToBig(a.e) === b64uToBig(b.e);

const B64URL = /^[A-Za-z0-9_-]*={0,2}$/u;
const b64uDecode = (s: string): Buffer | null => (B64URL.test(s) ? Buffer.from(s.replace(/=+$/u, ''), 'base64url') : null);
const jsonOf = (b: Buffer | null): unknown => {
  if (!b) return null;
  try {
    return JSON.parse(b.toString('utf8')) as unknown;
  } catch {
    return null;
  }
};
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).length === keys.length && keys.every((k) => k in o);

/** RSASSA-PKCS1-v1_5 SHA-256 as the contract checks it (`oidc::verify_rs256`: ≥ 2048-bit modulus, signature of its length). */
function rs256Ok(key: { n: string; e: string }, signed: Buffer, signature: Buffer): boolean {
  const nBytes = Buffer.from(key.n, 'base64url');
  let start = 0;
  while (start < nBytes.length && nBytes[start] === 0) start++;
  const k = nBytes.length - start;
  if (k < 256 || signature.length !== k) return false;
  try {
    return rsaVerify('sha256', signed, createPublicKey({ key: { kty: 'RSA', n: key.n, e: key.e }, format: 'jwk' }), signature);
  } catch {
    return false;
  }
}

export interface ClientProofRules {
  /** `get_issuer("email").iss_values`. */
  issValues: string[];
  /** The keys to check signatures with: `get_issuer_keys("email")`, or the manifest's public keys. */
  keys: IssuerKeyView[];
  /** `get_self_issued("email")`. */
  policy: SelfIssuedView;
  signerAccount: string;
  scopeId: string;
  actionNonce: number;
  nowMs: number;
}

/**
 * Why the contract would refuse `client_proof` in `propose_change(scope, _, AddClient("email", "email:<scope>"))`, in
 * its order (`oidc::parse_json`, `verify_self_issued_signatures`, `verify_token`, then `propose_change`), with its
 * panic messages; [] if it would accept it. The current signer policy only (an upgrade's overlap isn't in the view).
 */
export function clientProofProblems(token: string, r: ClientProofRules): string[] {
  if (Buffer.byteLength(token, 'utf8') > MAX_JWT_BYTES) return ['JWT too large'];
  if (!token.startsWith('{')) return ['Wrong token format for this issuer (not JWS JSON)'];
  let jws: unknown;
  try {
    jws = JSON.parse(token);
  } catch {
    return ['Malformed JWS'];
  }
  if (!isObj(jws) || !onlyKeys(jws, ['payload', 'signatures']) || typeof jws.payload !== 'string' || !Array.isArray(jws.signatures) || jws.signatures.length === 0) return ['Malformed JWS'];
  if (jws.signatures.length > MAX_JWS_SIGNATURES) return ['Too many signatures'];
  const payload = jws.payload;
  const claims = jsonOf(b64uDecode(payload));
  if (!isObj(claims) || typeof claims.iss !== 'string' || typeof claims.aud !== 'string' || typeof claims.sub !== 'string' || !Number.isSafeInteger(claims.exp) || (claims.exp as number) < 0) return ['Malformed JWT claims'];
  if (claims.nonce !== undefined && claims.nonce !== null && typeof claims.nonce !== 'string') return ['Malformed JWT claims'];
  const sigs: { kid: string; alg: string; signed: Buffer; signature: Buffer }[] = [];
  for (const s of jws.signatures as unknown[]) {
    if (!isObj(s) || !onlyKeys(s, ['protected', 'signature']) || typeof s.protected !== 'string' || typeof s.signature !== 'string') return ['Malformed JWS'];
    const header = jsonOf(b64uDecode(s.protected));
    if (!isObj(header) || typeof header.alg !== 'string' || typeof header.kid !== 'string') return ['Malformed JWS header'];
    if ('crit' in header && header.crit !== null) return ['Unsupported JWS header'];
    const signature = b64uDecode(s.signature);
    if (!signature) return ['Malformed base64url'];
    sigs.push({ kid: header.kid, alg: header.alg, signed: Buffer.from(`${s.protected}.${payload}`, 'ascii'), signature });
  }
  if (!r.issValues.includes(claims.iss)) return [`Unknown token issuer (iss ${claims.iss} is not one of get_issuer("email").iss_values)`];
  const seen = new Set<string>();
  for (const [i, s] of sigs.entries()) {
    if (sigs.slice(0, i).some((p) => p.kid === s.kid)) return ['Duplicate signature kid'];
    const key = r.keys.find((k) => k.kid === s.kid);
    const signer = r.policy.signers.find((p) => p.kids.includes(s.kid));
    if (!key || !signer) return [`Unknown signing key (${s.kid})`];
    if (s.alg !== 'RS256') return ['Unsupported JWT algorithm'];
    if (!rs256Ok(key, s.signed, s.signature)) return [`Invalid token signature (${s.kid})`];
    seen.add(signer.id);
  }
  if (seen.size < r.policy.required) return [`Not enough signatures (${seen.size} of ${r.policy.required} signers)`];
  const problems: string[] = [];
  if ((claims.exp as number) * 1000 <= r.nowMs) problems.push('Token expired');
  if (!claims.sub || claims.sub.length > 255 || claims.sub.includes('#')) problems.push('Invalid sub');
  if (!claims.aud || claims.aud.length > 256) problems.push('Invalid aud');
  if (claims.aud !== emailClientAud(r.scopeId)) problems.push(`Client proof is for another client (aud ${claims.aud})`);
  if (claims.nonce !== clientProofNonce(r.signerAccount, r.scopeId, r.actionNonce)) problems.push(`Client proof nonce doesn't match (not for ${r.scopeId} at action_nonce ${r.actionNonce})`);
  if (claims.sub !== CLIENT_PROOF_SUB) problems.push(`sub is not ${CLIENT_PROOF_SUB}`);
  return problems;
}

const isAddEmailClient = (change: unknown, scopeId: string): boolean => {
  const add = isObj(change) ? (change.AddClient as unknown) : undefined;
  return isObj(add) && add.provider === EMAIL_PROVIDER && add.aud === emailClientAud(scopeId);
};

const hasClient = (scope: ScopeView, scopeId: string): boolean => {
  const [p, a] = emailClient(scopeId);
  return scope.clients.some(([cp, ca]) => cp === p && ca === a);
};

/** The scope's first `Owner::Near` with a full-access key in the keychain and on chain, or why there is none. */
async function nearOwnerKey(m: Manifest, scope: ScopeView, deps: EmailClientDeps): Promise<LoadedKey> {
  const near = scope.owners.flatMap((o) => ('Near' in o ? [o.Near.account_id] : []));
  if (!near.length) throw new Error(`Scope ${scope.id} has no Owner::Near (its owners: ${JSON.stringify(scope.owners)}): this command signs as a NEAR owner`);
  const tried: string[] = [];
  for (const account of near) {
    const key = findLegacyCredential(account, m.network, deps.home);
    if (!key) {
      tried.push(`${account}: no key in ~/.near-credentials/${m.network}/`);
      continue;
    }
    if (!hasFullAccess(await deps.rpc.accessKeys(account), key.publicKey)) {
      tried.push(`${account}: ${key.publicKey} (from ${key.source}) is not a full-access key of the account on chain`);
      continue;
    }
    return key;
  }
  throw new Error(`No NEAR owner of scope ${scope.id} can sign: ${tried.join('; ')}`);
}

interface Minted {
  token: string;
  kid: string;
  exp: number;
  jti: string;
  nonce: string;
}

/** Mints the client proof with the manifest's active key and checks it against the manifest's and the chain's keys. */
async function mintChecked(m: Manifest, scope: ScopeView, chain: { issValues: string[]; keys: IssuerKeyView[]; policy: SelfIssuedView }, nowMs: number, deps: EmailClientDeps): Promise<Minted> {
  const t = m.emailIssuer!;
  if (t.signer.kind !== 'worker-secret') throw new Error(`emailIssuer.signer is ${t.signer.kind}: there is no local signing key (D253 is for Worker-secret envs)`);
  const activeKid = t.signer.activeKid;
  const published = t.publicKeys.find((k) => k.kid === activeKid);
  if (!published) throw new Error(`The active kid ${activeKid} is not in emailIssuer.publicKeys`);
  const onChain = chain.keys.find((k) => k.kid === activeKid);
  if (!onChain) throw new Error(`The manifest's active email key ${activeKid} is not active on chain (get_issuer_keys("email"): ${chain.keys.map((k) => k.kid).join(', ') || 'none'}): post and execute it first (docs/operations.md "Email login on sandbox-dev")`);
  if (!sameRsaKey(onChain, published)) throw new Error(`The chain's key ${activeKid} differs from emailIssuer.publicKeys' (n or e)`);
  if (!chain.policy.signers.some((s) => s.kids.includes(activeKid))) throw new Error(`The key ${activeKid} belongs to no signer of get_self_issued("email")`);
  if (!chain.issValues.includes(t.iss)) throw new Error(`emailIssuer.iss ${t.iss} is not one of get_issuer("email").iss_values (${chain.issValues.join(', ')})`);

  const file = join(secretsDir(m.name, deps.secretsRoot ?? repoRoot), EMAIL_ISSUER_SECRET_FILES.signingKey);
  const shown = `.secrets/${m.name}/${EMAIL_ISSUER_SECRET_FILES.signingKey}`;
  let jwk;
  try {
    jwk = readKeyFile(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(code === 'ENOENT' ? `${shown} doesn't exist (email-issuer ${m.name} init writes it)` : (err as Error).message);
  }
  const fileKid = publicEntry(jwk).kid;
  if (fileKid !== activeKid) throw new Error(`${shown} holds key ${fileKid}, not the manifest's active key ${activeKid}`);
  const signer = await WorkerSecretSigner.create(JSON.stringify(jwk), activeKid);
  const jti = deps.jti?.() ?? randomBytes(16).toString('base64url');
  const iat = Math.floor(nowMs / 1000);
  const input = { iss: t.iss, signerAccount: m.signer, scopeId: scope.id, actionNonce: scope.action_nonce, iat, jti };
  const pub: PublicJwk = { kty: 'RSA', n: published.n, e: published.e, kid: published.kid, use: 'sig', alg: 'RS256' };
  const token = await mintClientProof(input, [signer], [pub]);
  const rules = { issValues: chain.issValues, policy: chain.policy, signerAccount: m.signer, scopeId: scope.id, actionNonce: scope.action_nonce, nowMs };
  for (const [what, keys] of [['the manifest\'s public key', [published]], ['get_issuer_keys("email")', chain.keys]] as const) {
    const problems = clientProofProblems(token, { ...rules, keys: [...keys] });
    if (problems.length) throw new Error(`The minted client proof fails the contract's checks with ${what}: ${problems.join('; ')}`);
  }
  const exp = JSON.parse(Buffer.from((JSON.parse(token) as { payload: string }).payload, 'base64url').toString('utf8')) as { exp: number };
  return { token, kid: activeKid, exp: exp.exp, jti, nonce: clientProofNonce(m.signer, scope.id, scope.action_nonce) };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Runs `scope:add-email-client`. */
export async function scopeAddEmailClient(m: Manifest, args: Args, deps: EmailClientDeps): Promise<void> {
  assertDevEnv(m);
  const scopeId = args.required('scope');
  if (!isScopeId(scopeId)) throw new CliError('--scope must be a scope id (s1, s2, …)');
  if (!m.emailIssuer) throw new Error(`envs/${m.name}.json has no emailIssuer`);
  const { rpc, log } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if ((await rpc.chainId()) !== 'testnet') throw new Error(`${m.rpc} is not a testnet RPC`);

  // 1. Fresh reads.
  const config = await tryView<{ paused?: boolean; change_delay_ms?: number }>(rpc, m.signer, 'get_config');
  if (!config) throw new Error(`${m.signer} is not initialised`);
  if (config.paused) throw new Error(`${m.signer} is paused: propose_change with a client proof and execute_change refuse while paused`);
  const scope = await tryView<ScopeView>(rpc, m.signer, 'get_scope', { scope_id: scopeId });
  if (!scope) throw new Error(`No scope ${scopeId} on ${m.signer}`);
  const client = emailClient(scopeId);
  if (hasClient(scope, scopeId)) throw new Error(`Scope ${scopeId} already has the email client ${JSON.stringify(client)}: nothing to do`);
  const issuer = await tryView<{ iss_values?: string[]; kids?: string[] }>(rpc, m.signer, 'get_issuer', { provider: EMAIL_PROVIDER });
  if (!issuer) throw new Error(`The email issuer is not on ${m.signer} (get_issuer("email") is null): set it up first (docs/operations.md "Email login on sandbox-dev")`);
  const policy = await tryView<SelfIssuedView>(rpc, m.signer, 'get_self_issued', { provider: EMAIL_PROVIDER });
  if (!policy) throw new Error(`"email" is not self-issued on ${m.signer} (get_self_issued("email") is null): mark_self_issued first`);
  const keys = (await tryView<IssuerKeyView[]>(rpc, m.signer, 'get_issuer_keys', { provider: EMAIL_PROVIDER })) ?? [];
  const owner = await nearOwnerKey(m, scope, deps);
  const pending = scope.pending.find((p) => isAddEmailClient(p.change, scopeId));

  const head = `scope:add-email-client on ${m.name}: scope ${scopeId} on ${m.signer}, client ${JSON.stringify(client)}`;
  log(head);
  log(`  owner ${owner.accountId} (Owner::Near; full-access key ${owner.publicKey} from ${owner.source})`);
  log(`  scope: action_nonce ${scope.action_nonce}; clients ${JSON.stringify(scope.clients)}; ${scope.pending.length} pending change(s)`);
  log(`  issuer email: iss ${(issuer.iss_values ?? []).join(', ')}; signers ${policy.signers.map((s) => `${s.id} [${s.kids.join(', ')}]`).join(', ')}, ${policy.required} required`);

  let changeId: number;
  let unlockAt: number | null = null;
  if (pending) {
    changeId = pending.id;
    unlockAt = pending.unlock_at_ms;
    log(`  AddClient ${JSON.stringify(client)} is already pending as change #${changeId} (unlocks ${iso(unlockAt)}): not proposing it again`);
    log(`Plan:\n  1. execute_change({"scope_id":"${scopeId}","change_id":${changeId}}) once due, signed by ${owner.accountId}, ${EXECUTE_GAS / TGAS} Tgas\n  2. check get_scope lists ${JSON.stringify(client)}`);
    if (!args.flag('yes')) return void log(EMAIL_CLIENT_DRY_RUN_LINE);
  } else {
    // 2. The proof, minted and checked locally.
    const proof = await mintChecked(m, scope, { issValues: issuer.iss_values ?? [], keys, policy }, now(), deps);
    log(`  client proof: minted locally (D253) with ${`.secrets/${m.name}/${EMAIL_ISSUER_SECRET_FILES.signingKey}`} (kid ${proof.kid}); sub ${CLIENT_PROOF_SUB}, aud ${client[1]}, nonce ${proof.nonce} (action_nonce ${scope.action_nonce}), jti ${proof.jti}, exp ${iso(proof.exp * 1000)}`);
    log('  checked against the contract\'s rules with the manifest\'s public key and with get_issuer_keys("email"): OK');
    log(`  client_proof: ${proof.token}`);
    const callArgs = { scope_id: scopeId, auth: 'Near', change: { AddClient: { provider: client[0], aud: client[1] } }, client_proof: proof.token };
    const delay = config.change_delay_ms;
    log(
      `Plan:\n  1. propose_change({"scope_id":"${scopeId}","auth":"Near","change":${JSON.stringify(callArgs.change)},"client_proof":<above>}) signed by ${owner.accountId}, 0.01 NEAR, ${PROPOSE_GAS / TGAS} Tgas` +
        `\n  2. wait the scope's timelock (change_delay_ms ${delay ?? '?'} ms; waited here when ≤ ${MAX_WAIT_MS / 60_000} min), then execute_change(${scopeId}, ${scope.action_nonce}) signed by ${owner.accountId}, ${EXECUTE_GAS / TGAS} Tgas` +
        `\n  3. check get_scope lists ${JSON.stringify(client)}`,
    );
    if (!args.flag('yes')) return void log(EMAIL_CLIENT_DRY_RUN_LINE);
    // 3. Propose.
    const { hash, value } = await rpc.sendTx({ accountId: owner.accountId, keyPair: owner.keyPair }, m.signer, [actionCreators.functionCall('propose_change', callArgs, PROPOSE_GAS, PROPOSE_DEPOSIT)]);
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`propose_change returned ${JSON.stringify(value)}, not a change id (tx ${hash})`);
    changeId = value;
    log(`Proposed change #${changeId}: ${explorerTx(hash)}`);
    const after = await tryView<ScopeView>(rpc, m.signer, 'get_scope', { scope_id: scopeId });
    const mine = after?.pending.find((p) => p.id === changeId);
    if (!mine || !isAddEmailClient(mine.change, scopeId)) throw new Error(`Change #${changeId} isn't pending on scope ${scopeId} after the proposal (tx ${hash})`);
    unlockAt = mine.unlock_at_ms;
  }

  // 4. Execute once due.
  const wait = unlockAt + UNLOCK_MARGIN_MS - now();
  if (wait > MAX_WAIT_MS + UNLOCK_MARGIN_MS) {
    log(`Change #${changeId} unlocks at ${iso(unlockAt)}, more than ${MAX_WAIT_MS / 60_000} min away: not waiting. Re-run this command with --yes after then to execute it (anyone may call execute_change).`);
    return;
  }
  if (wait > 0) {
    log(`Waiting ${Math.ceil(wait / 1000)} s for change #${changeId}'s timelock (unlocks ${iso(unlockAt)})…`);
    await sleep(wait);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const { hash } = await rpc.sendTx({ accountId: owner.accountId, keyPair: owner.keyPair }, m.signer, [actionCreators.functionCall('execute_change', { scope_id: scopeId, change_id: changeId }, EXECUTE_GAS, 0n)]);
      log(`Executed change #${changeId}: ${explorerTx(hash)}`);
      break;
    } catch (err) {
      if (attempt >= EXECUTE_RETRIES || !/still timelocked/u.test((err as Error).message)) throw err;
      log(`  still timelocked by the block clock; retrying in ${EXECUTE_RETRY_MS / 1000} s`);
      await sleep(EXECUTE_RETRY_MS);
    }
  }
  const final = await tryView<ScopeView>(rpc, m.signer, 'get_scope', { scope_id: scopeId });
  if (!final || !hasClient(final, scopeId)) throw new Error(`get_scope(${scopeId}) doesn't list ${JSON.stringify(client)} after execute_change`);
  log(`Done: get_scope(${scopeId}) lists ${JSON.stringify(client)} (clients ${JSON.stringify(final.clients)}).`);
}
