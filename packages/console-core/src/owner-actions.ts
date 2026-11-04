// The on-chain owner actions' argument bytes (docs/batch-c-spec.md "On-chain owner actions", "Nonce and digest
// layouts"; docs/contract-interface.md "Owner actions"): `borsh(args without auth)` for each method, exactly as
// hana-signer's `borsh_args!` concatenates them (every argument but `auth`, in declaration order, each Borsh-encoded),
// and the owner-action and client-proof nonces over them. The console builds the action and its Google nonce with
// these; the API's precheck recomputes the same nonce from the body it is asked to relay and the scope's
// `action_nonce`, so a stale or altered action is refused before any gas is spent. Tested against the contract's
// test_fixture.json (layouts and the nonces its tokens carry).
import { borshString, concatBytes, u32le, u64le } from './bytes.ts';
import { clientProofDigest, nonceOf, ownerActionDigest } from './layouts.ts';

/** hana-signer `Owner` as JSON (externally tagged). */
export type OwnerJson = { Near: { account_id: string } } | { Oidc: { provider: string; sub: string } };
/** hana-signer `Change` as JSON. */
export type ChangeJson = { AddClient: { provider: string; aud: string } } | { SetOwners: { owners: OwnerJson[] } } | { SetAllowShared: { allow: boolean } };

/** The owner actions that carry `auth` (execute_change needs none and has no owner nonce). */
export const AUTHENTICATED_OWNER_METHODS = ['propose_change', 'cancel_change', 'remove_client', 'disable_shared_login'] as const;
export type AuthenticatedOwnerMethod = (typeof AUTHENTICATED_OWNER_METHODS)[number];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const only = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw new TypeError(`${what} must be a string`);
  return v;
};

const u8 = (n: number): Uint8Array => Uint8Array.of(n);
/** Borsh of an enum variant tag (u8). */
const tag = u8;

/** `Owner`: Near = 0 {account_id}, Oidc = 1 {provider, sub}. */
export function borshOwner(o: unknown): Uint8Array {
  if (isObj(o) && only(o, ['Near']) && isObj(o.Near) && only(o.Near, ['account_id'])) return concatBytes(tag(0), borshString(str(o.Near.account_id, 'account_id')));
  if (isObj(o) && only(o, ['Oidc']) && isObj(o.Oidc) && only(o.Oidc, ['provider', 'sub'])) {
    return concatBytes(tag(1), borshString(str(o.Oidc.provider, 'provider')), borshString(str(o.Oidc.sub, 'sub')));
  }
  throw new TypeError('An owner is {"Near":{account_id}} or {"Oidc":{provider, sub}}');
}

/** `Change`: AddClient = 0 {provider, aud}, SetOwners = 1 {owners: Vec<Owner>}, SetAllowShared = 2 {allow: bool}. */
export function borshChange(c: unknown): Uint8Array {
  if (isObj(c) && only(c, ['AddClient']) && isObj(c.AddClient) && only(c.AddClient, ['provider', 'aud'])) {
    return concatBytes(tag(0), borshString(str(c.AddClient.provider, 'provider')), borshString(str(c.AddClient.aud, 'aud')));
  }
  if (isObj(c) && only(c, ['SetOwners']) && isObj(c.SetOwners) && only(c.SetOwners, ['owners']) && Array.isArray(c.SetOwners.owners)) {
    const owners = c.SetOwners.owners;
    return concatBytes(tag(1), u32le(owners.length), ...owners.map(borshOwner));
  }
  if (isObj(c) && only(c, ['SetAllowShared']) && isObj(c.SetAllowShared) && only(c.SetAllowShared, ['allow']) && typeof c.SetAllowShared.allow === 'boolean') {
    return concatBytes(tag(2), u8(c.SetAllowShared.allow ? 1 : 0));
  }
  throw new TypeError('A change is {"AddClient":…}, {"SetOwners":…} or {"SetAllowShared":…}');
}

/** `Option<String>`: 0 for None (null or absent), 1 then the string for Some. */
export function borshOptionString(v: unknown): Uint8Array {
  if (v === null || v === undefined) return u8(0);
  return concatBytes(u8(1), borshString(str(v, 'An optional string')));
}

const u64Arg = (v: unknown, what: string): Uint8Array => {
  if (typeof v !== 'bigint' && !(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)) throw new TypeError(`${what} must be a u64`);
  return u64le(v);
};

/**
 * `borsh(args without auth)` of an authenticated owner action, from its contract JSON args (`auth` ignored, every other
 * argument required; `client_proof` null or absent is None). Throws TypeError for any other method or shape.
 */
export function ownerActionArgsBorsh(method: string, args: Record<string, unknown>): Uint8Array {
  const scope = borshString(str(args.scope_id, 'scope_id'));
  switch (method) {
    case 'propose_change':
      return concatBytes(scope, borshChange(args.change), borshOptionString(args.client_proof));
    case 'cancel_change':
      return concatBytes(scope, u64Arg(args.change_id, 'change_id'));
    case 'remove_client':
      return concatBytes(scope, borshString(str(args.provider, 'provider')), borshString(str(args.aud, 'aud')));
    case 'disable_shared_login':
      return scope;
    default:
      throw new TypeError(`${method} has no owner nonce`);
  }
}

/** The Google nonce an `OwnerAuth::Oidc` token must carry for this action at the scope's `action_nonce`. */
export async function ownerActionNonce(i: { signer: string; method: string; args: Record<string, unknown>; actionNonce: number | bigint }): Promise<string> {
  const scopeId = str(i.args.scope_id, 'scope_id');
  return nonceOf(await ownerActionDigest({ signer: i.signer, scopeId, method: i.method, argsBorsh: ownerActionArgsBorsh(i.method, i.args), actionNonce: i.actionNonce }));
}

/** The nonce an AddClient's client proof must carry at the scope's `action_nonce`. */
export async function clientProofNonce(i: { signer: string; scopeId: string; actionNonce: number | bigint }): Promise<string> {
  return nonceOf(await clientProofDigest(i));
}
