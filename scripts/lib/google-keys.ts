// post-google-keys' plan: Google's JWKS against the contract's active and pending issuer keys
// (docs/governance-spec.md "Issuer key changes", "Rotation and logins"). On the governance contract keys are never
// installed at once: the updater proposes adds (set_issuer_key) and removals (propose_issuer_key_removal), a watchdog
// confirms matching ones early, and anyone executes a change once it is due (execute_issuer_key_change). A v1
// contract (no get_key_changes) still takes set_issuer_key / remove_issuer_key directly.
import { type Manifest, loadEnv } from '@hana-id/env';
import { actionCreators } from '@near-js/transactions';
import { CliError, parseCli } from './cli.ts';
import { GOOGLE_PROVIDER, type KeyChangeView, normaliseIssuer, tryView } from './contract.ts';
import { diffJwks, fetchGoogleJwks, type JwksDiff, usableKeys } from './jwks.ts';
import { readKeysUpdater } from './keys.ts';
import { explorerTx, type NearRpc, TGAS } from './near.ts';

export const POST_KEYS_USAGE = `Usage: post-google-keys.ts <env> [--dry-run] [--execute]
  Compares Google's JWKS with the contract and sends the difference with the keys-updater key
  (.secrets/<env>/keys-updater.json). On the governance contract new kids are proposed (set_issuer_key) and
  retired ones proposed for removal (propose_issuer_key_removal); they take effect when a watchdog confirms them or
  once issuer_key_delay_ms passed.
  --dry-run    print the plan only
  --execute    also run execute_issuer_key_change for every due change that matches Google's JWKS`;

export interface PostKeysDeps {
  rpc: (url: string) => Pick<NearRpc, 'chainId' | 'view' | 'sendTx'>;
  log: (line: string) => void;
  fetchJwks?: () => Promise<{ keys?: unknown }>;
  secretsRoot?: string;
  loadManifest?: (name: string) => Manifest;
  now?: () => number;
}

/** Runs post-google-keys with argv (without node and script path). */
export async function postGoogleKeysMain(argv: readonly string[], deps: PostKeysDeps): Promise<void> {
  const { log } = deps;
  const args = parseCli(argv, { booleans: ['dry-run', 'execute', 'help'] });
  if (args.flag('help')) return void log(POST_KEYS_USAGE);
  const envName = args.positionals[0];
  if (!envName || args.positionals.length > 1) throw new CliError('Expected exactly one <env>');
  const m = (deps.loadManifest ?? loadEnv)(envName);
  const rpc = deps.rpc(m.rpc);
  if ((await rpc.chainId()) !== 'testnet') throw new Error(`${m.rpc} is not a testnet RPC`);

  const issuer = normaliseIssuer(await tryView<unknown>(rpc, m.signer, 'get_issuer', { provider: GOOGLE_PROVIDER }));
  if (!issuer) throw new Error(`${m.signer} has no "${GOOGLE_PROVIDER}" issuer (run deploy-contract.ts first)`);
  const changes = await tryView<KeyChangeView[]>(rpc, m.signer, 'get_key_changes');
  const jwks = await (deps.fetchJwks ?? fetchGoogleJwks)();
  const plan = changes === null ? planV1KeySync(diffJwks(issuer.kids, jwks)) : planKeySync(GOOGLE_PROVIDER, issuer.kids, changes, jwks, (deps.now ?? Date.now)(), args.flag('execute'));

  log(`On chain: ${issuer.kids.length ? issuer.kids.join(', ') : '(none)'}${changes === null ? ' (v1 contract: keys apply at once)' : `; pending: ${changes.filter((c) => c.provider === GOOGLE_PROVIDER).map((c) => `#${c.id} ${c.op} ${c.kid}`).join(', ') || 'none'}`}`);
  for (const a of plan.actions) log(`  ${describeKeySync(a)}`);
  for (const n of plan.notes) log(`  ! ${n}`);
  if (!plan.actions.length) return void log('In sync.');
  if (args.flag('dry-run')) return void log('Dry run: nothing changed.');

  const signer = readKeysUpdater(m.name, deps.secretsRoot);
  if (!signer) throw new Error(`No .secrets/${m.name}/keys-updater.json (deploy-contract.ts creates it)`);
  if (signer.accountId !== m.signer) throw new Error(`keys-updater.json is for ${signer.accountId}, not ${m.signer}`);
  const tx = { accountId: signer.accountId, keyPair: signer.keyPair };
  const call = async (method: string, callArgs: object, gasTgas: bigint) => (await rpc.sendTx(tx, m.signer, [actionCreators.functionCall(method, callArgs, gasTgas * TGAS, 0n)])).hash;
  // Adds before removals, so a token signed by either key verifies throughout.
  for (const a of plan.actions) {
    switch (a.kind) {
      case 'propose-add':
      case 'v1-set':
        log(`  set ${a.kid}: ${explorerTx(await call('set_issuer_key', { provider: GOOGLE_PROVIDER, kid: a.kid, n: a.n, e: a.e }, 50n))}`);
        break;
      case 'propose-removal':
        log(`  proposed removal of ${a.kid}: ${explorerTx(await call('propose_issuer_key_removal', { provider: GOOGLE_PROVIDER, kid: a.kid }, 30n))}`);
        break;
      case 'execute':
        log(`  executed #${a.id} (${a.op} ${a.kid}): ${explorerTx(await call('execute_issuer_key_change', { id: a.id }, 30n))}`);
        break;
      case 'v1-remove':
        log(`  removed ${a.kid}: ${explorerTx(await call('remove_issuer_key', { provider: GOOGLE_PROVIDER, kid: a.kid }, 30n))}`);
        break;
    }
  }
  log('Done.');
}

export type KeySyncAction =
  | { kind: 'propose-add'; kid: string; n: string; e: string }
  | { kind: 'propose-removal'; kid: string }
  | { kind: 'execute'; id: number; kid: string; op: 'Add' | 'Remove' }
  | { kind: 'v1-set'; kid: string; n: string; e: string }
  | { kind: 'v1-remove'; kid: string };

export interface KeySyncPlan {
  actions: KeySyncAction[];
  notes: string[];
}

/** Leading-zero-stripped base64url, the form get_key_changes reports (for comparing n with the JWKS). */
export function normB64url(v: string): string {
  const bytes = Buffer.from(v.replace(/-/gu, '+').replace(/_/gu, '/'), 'base64');
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  return bytes.subarray(i).toString('base64url');
}

/**
 * The governance-contract sync for one provider: propose adds for published kids that are neither active nor
 * pending, propose removals for active kids Google no longer publishes (never the last key: active minus pending
 * removals stays ≥ 1), and with `execute` run every change that is due. Pending adds Google doesn't publish (or with
 * other key material) are reported, not touched: the watchdog or the owner cancels them.
 */
export function planKeySync(provider: string, activeKids: readonly string[], changes: readonly KeyChangeView[], jwks: { keys?: unknown }, nowMs: number, execute: boolean): KeySyncPlan {
  const keys = usableKeys(jwks);
  if (keys.length === 0) throw new Error('Google JWKS has no usable RS256 keys; refusing to sync');
  const mine = changes.filter((c) => c.provider === provider);
  const pendingKids = new Set(mine.map((c) => c.kid));
  const published = new Map(keys.map((k) => [k.kid, k]));
  const actions: KeySyncAction[] = [];
  const notes: string[] = [];

  for (const k of keys) if (!activeKids.includes(k.kid) && !pendingKids.has(k.kid)) actions.push({ kind: 'propose-add', kid: k.kid, n: k.n, e: k.e });
  let remaining = activeKids.length - mine.filter((c) => c.op === 'Remove').length;
  for (const kid of activeKids) {
    if (published.has(kid) || pendingKids.has(kid)) continue;
    if (remaining <= 1) {
      notes.push(`${kid} is no longer published but is the last active key: not proposing its removal (the contract refuses it).`);
      continue;
    }
    actions.push({ kind: 'propose-removal', kid });
    remaining--;
  }
  for (const c of mine) {
    const jwk = published.get(c.kid);
    if (c.op === 'Add' && (!jwk || normB64url(jwk.n) !== normB64url(c.n ?? '') || normB64url(jwk.e) !== normB64url(c.e ?? ''))) {
      notes.push(`Pending add #${c.id} (${c.kid}, by ${c.by}) is ${jwk ? 'other key material than' : 'not in'} Google's JWKS: not executing it; the watchdog or the owner cancels it (cancel_issuer_key_change).`);
      continue;
    }
    if (c.op === 'Remove' && jwk) {
      notes.push(`Pending removal #${c.id} of ${c.kid} (by ${c.by}): Google still publishes it; not executing it (the owner decides, D82).`);
      continue;
    }
    if (nowMs < c.executable_at_ms) notes.push(`#${c.id} ${c.op} ${c.kid} is due at ${new Date(c.executable_at_ms).toISOString()} (a watchdog may confirm it earlier).`);
    else if (execute) actions.push({ kind: 'execute', id: c.id, kid: c.kid, op: c.op });
    else notes.push(`#${c.id} ${c.op} ${c.kid} is due: pass --execute to run execute_issuer_key_change(${c.id}).`);
  }
  // Due additions execute before due removals, so a token signed by either key verifies throughout.
  const rank = (a: KeySyncAction) => (a.kind === 'execute' ? (a.op === 'Add' ? 1 : 2) : 0);
  actions.sort((a, b) => rank(a) - rank(b));
  return { actions, notes };
}

/** The v1 contract's direct sync (no delays): set new kids, then remove retired ones. */
export function planV1KeySync(diff: JwksDiff): KeySyncPlan {
  return { actions: [...diff.set.map((k) => ({ kind: 'v1-set' as const, ...k })), ...diff.remove.map((kid) => ({ kind: 'v1-remove' as const, kid }))], notes: [] };
}

export function describeKeySync(a: KeySyncAction): string {
  switch (a.kind) {
    case 'propose-add':
      return `+ set_issuer_key ${a.kid} (queued: active after issuer_key_delay_ms, or when a watchdog confirms)`;
    case 'propose-removal':
      return `- propose_issuer_key_removal ${a.kid} (queued)`;
    case 'execute':
      return `→ execute_issuer_key_change ${a.id} (${a.op} ${a.kid})`;
    case 'v1-set':
      return `+ set_issuer_key ${a.kid} (v1 contract: active at once)`;
    case 'v1-remove':
      return `- remove_issuer_key ${a.kid} (v1 contract)`;
  }
}
