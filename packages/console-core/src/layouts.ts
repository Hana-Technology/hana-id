// Every nonce and digest layout of docs/batch-c-spec.md "Nonce and digest layouts". `‖` is concatenation; a domain
// string is its raw UTF-8 bytes with no length prefix (as in the contract); borsh(String) is a u32 LE length then
// UTF-8; borsh(Vec<String>) a u32 LE count then the elements; b64url has no padding. The domains keep every purpose's
// tokens apart (login, step-up, origin change, settings change, owner action, client proof, links, uid). The owner
// action and client proof are the contract's own layouts (docs/contract-interface.md), checked against its
// test_fixture.json. An independent Node implementation (scripts/gen-vectors.mjs) produces test/vectors.json.
import { b64url, borshString, borshStringVec, bytesEqual, compareBytes, concatBytes, fromHex, hmacSha256, sha256, u64le, utf8 } from './bytes.ts';
import { canonicalize } from './jcs.ts';
import { normaliseOrigin } from './origins.ts';

export const DOMAINS = {
  consoleLogin: 'hana-console/login/v1',
  stepUp: 'hana-console/step-up/v1',
  originChange: 'hana-id/origin-change/v1',
  settingsChange: 'hana-id/settings-change/v1',
  /** D894: a partner label document proposed or removed. */
  labelChange: 'hana-id/label-change/v1',
  ownerAction: 'hana-id/owner-action/v1',
  clientProof: 'hana-id/client-proof/v1',
  cancelLink: 'hana-id/cancel-link/v1',
  invite: 'hana-console/invite/v1',
  ownerGrantCancel: 'hana-console/owner-grant-cancel/v1',
  uid: 'hana-id/uid/v1',
  /** D918: a platform key's registration, acceptance and confirmation step-ups (platform-keys.ts platformKeyDigest). */
  platformKeyAdd: 'hana-id/console-key-add/v1',
  platformKeyAccept: 'hana-id/console-key-accept/v1',
  platformKeyConfirm: 'hana-id/console-key-confirm/v1',
  /** D918: a platform key's emailed links: cancel a waiting key, revoke a confirmed one (key `CANCEL_LINK_KEY`, checked by the API). */
  platformKeyCancel: 'hana-id/platform-key-cancel/v1',
  platformKeyRevoke: 'hana-id/platform-key-revoke/v1',
  /** D931: an owner's confirmation of web addresses the platform (or staff, on a shared wallet) asked for (originConfirmDigest). */
  originConfirm: 'hana-id/console-origin-confirm/v1',
  /** D931: the confirmation notice's one-click removal link (key `CANCEL_LINK_KEY`, checked by the API). */
  originRemove: 'hana-id/origin-remove/v1',
  /** Reserved for second-owner approval (docs/batch-c-spec.md "Deferred"); nothing computes it. */
  changeApprove: 'hana-id/change-approve/v1',
} as const;

/** The Google nonce for a digest: b64url(d). */
export const nonceOf = (d: Uint8Array): string => b64url(d);

function exactly(bytes: Uint8Array, n: number, what: string): Uint8Array {
  if (bytes.length !== n) throw new RangeError(`${what} must be ${n} bytes`);
  return bytes;
}

/** Console login: b64url(sha256("hana-console/login/v1" ‖ random32)). The random part is server-held. */
export async function consoleLoginNonce(random32: Uint8Array): Promise<string> {
  return nonceOf(await sha256(concatBytes(utf8(DOMAINS.consoleLogin), exactly(random32, 32, 'The login random'))));
}

/** A generic step-up action: canonical JSON with `v: 1`, the manifest's `env` and the `org_id` it applies to. */
export interface StepUpAction {
  v: 1;
  env: string;
  org_id: string;
  kind: string;
  [field: string]: unknown;
}

/**
 * Generic step-up: d = sha256("hana-console/step-up/v1" ‖ sha256(session cookie) ‖ sha256(JCS(action))). The console
 * stores only sha256(cookie) (`console_sessions.id_hash`, `pending_actions.session_hash`), so that is the input.
 */
export async function stepUpDigest(i: { sessionHash: Uint8Array; action: StepUpAction }): Promise<Uint8Array> {
  const a = i.action;
  if (a.v !== 1 || typeof a.env !== 'string' || !a.env || typeof a.org_id !== 'string' || !a.org_id || typeof a.kind !== 'string' || !a.kind) {
    throw new TypeError('A step-up action needs v: 1, env, org_id and kind');
  }
  return sha256(concatBytes(utf8(DOMAINS.stepUp), exactly(i.sessionHash, 32, 'sessionHash'), await sha256(utf8(canonicalize(a)))));
}

/** Origins in the layouts: normalised (ASCII form), distinct, sorted by byte order. */
function sortedOrigins(list: readonly string[], what: string): string[] {
  for (const o of list) if (normaliseOrigin(o) !== o) throw new TypeError(`${what}: ${o} is not a normalised origin`);
  if (new Set(list).size !== list.length) throw new TypeError(`${what}: duplicate origin`);
  return [...list].sort((a, b) => compareBytes(utf8(a), utf8(b)));
}

/**
 * Origin change (adds, with any removes sent with them): d = sha256("hana-id/origin-change/v1" ‖ borsh(signer) ‖
 * borsh(app_id) ‖ borsh(sorted add) ‖ borsh(sorted remove) ‖ origins_version u64 LE). Checked by the console and the
 * API, which recomputes it from the request and the stored version.
 */
export async function originChangeDigest(i: { signer: string; appId: string; add: readonly string[]; remove: readonly string[]; originsVersion: number | bigint }): Promise<Uint8Array> {
  if (i.add.length === 0) throw new TypeError('An origin change adds at least one origin (removals alone need no step-up)');
  const add = sortedOrigins(i.add, 'add');
  const remove = sortedOrigins(i.remove, 'remove');
  if (add.some((o) => remove.includes(o))) throw new TypeError('An origin is both added and removed');
  return sha256(concatBytes(utf8(DOMAINS.originChange), borshString(i.signer), borshString(i.appId), borshStringVec(add), borshStringVec(remove), u64le(i.originsVersion)));
}

export type SettingsChangeKind = 'policy_set' | 'raw_sign_on';

/**
 * Settings change: d = sha256("hana-id/settings-change/v1" ‖ borsh(signer) ‖ borsh(app_id) ‖ borsh(kind) ‖ value(32)
 * ‖ settings_version u64 LE); value = the 32 policyId bytes for `policy_set`, 32 zero bytes for `raw_sign_on`.
 */
export async function settingsChangeDigest(i: { signer: string; appId: string; kind: SettingsChangeKind; policyId?: string; settingsVersion: number | bigint }): Promise<Uint8Array> {
  let value: Uint8Array;
  if (i.kind === 'policy_set') {
    if (!i.policyId || !/^[0-9a-f]{64}$/u.test(i.policyId)) throw new TypeError('policy_set needs the policyId (64 lowercase hex)');
    value = fromHex(i.policyId);
  } else if (i.kind === 'raw_sign_on') {
    if (i.policyId !== undefined) throw new TypeError('raw_sign_on takes no policyId');
    value = new Uint8Array(32);
  } else {
    throw new TypeError(`Unknown settings change kind ${String(i.kind)}`);
  }
  return sha256(concatBytes(utf8(DOMAINS.settingsChange), borshString(i.signer), borshString(i.appId), borshString(i.kind), value, u64le(i.settingsVersion)));
}

/** At most this many web addresses in one confirmation (one proposing request's: A15). */
export const ORIGIN_CONFIRM_MAX = 20;

/**
 * An owner's confirmation of web addresses (D931, docs/partner-platform-spec.md A15): d = sha256(
 * "hana-id/console-origin-confirm/v1" ‖ borsh(signer) ‖ borsh(env) ‖ borsh(org_id) ‖ borsh(app_id) ‖ borsh(scope_id) ‖
 * borsh(change ids sorted by byte order) ‖ borsh(their origins, in that order)). Its own domain, so no origin-change,
 * settings, label, key or owner-action token stands in for it; over the exact set, so a token for one set of web
 * addresses confirms no other, on no other app, scope, org or env. The console builds it from the API's view, and the
 * API recomputes it from the stored changes.
 */
export async function originConfirmDigest(i: { signer: string; env: string; orgId: string; appId: string; scopeId: string; changes: readonly { changeId: string; origin: string }[] }): Promise<Uint8Array> {
  if (!i.signer || !i.env || !i.orgId || !i.appId || !i.scopeId) throw new TypeError('A confirmation needs the signer, the env, the org, the app and the scope');
  if (i.changes.length < 1 || i.changes.length > ORIGIN_CONFIRM_MAX) throw new TypeError(`A confirmation names 1 to ${ORIGIN_CONFIRM_MAX} web addresses`);
  for (const c of i.changes) {
    if (!/^gc_[A-Za-z0-9]{1,64}$/u.test(c.changeId)) throw new TypeError(`${c.changeId} is not a change id`);
    if (normaliseOrigin(c.origin) !== c.origin) throw new TypeError(`${c.origin} is not a normalised origin`);
  }
  if (new Set(i.changes.map((c) => c.changeId)).size !== i.changes.length) throw new TypeError('A change is listed twice');
  const sorted = [...i.changes].sort((a, b) => compareBytes(utf8(a.changeId), utf8(b.changeId)));
  return sha256(
    concatBytes(
      utf8(DOMAINS.originConfirm),
      borshString(i.signer),
      borshString(i.env),
      borshString(i.orgId),
      borshString(i.appId),
      borshString(i.scopeId),
      borshStringVec(sorted.map((c) => c.changeId)),
      borshStringVec(sorted.map((c) => c.origin)),
    ),
  );
}

export type LabelChangeKind = 'labels_set' | 'labels_remove';

/**
 * Partner label change (D894): d = sha256("hana-id/label-change/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ borsh(kind) ‖
 * borsh(label_id) ‖ doc(32) ‖ borsh(sorted app ids) ‖ labels_version u64 LE). `label_id` is "" for a new entry; doc is
 * the document's sha256 for `labels_set`, 32 zero bytes for `labels_remove` (whose app list is empty). The console
 * builds it and the API recomputes it from the request and the scope's stored `labels_version`.
 */
export async function labelChangeDigest(i: { signer: string; scopeId: string; kind: LabelChangeKind; labelId: string; docSha256?: string; appIds: readonly string[]; labelsVersion: number | bigint }): Promise<Uint8Array> {
  let doc: Uint8Array;
  if (i.kind === 'labels_set') {
    if (!i.docSha256 || !/^[0-9a-f]{64}$/u.test(i.docSha256)) throw new TypeError('labels_set needs the document sha256 (64 lowercase hex)');
    if (i.appIds.length === 0) throw new TypeError('labels_set needs at least one app');
    doc = fromHex(i.docSha256);
  } else if (i.kind === 'labels_remove') {
    if (i.docSha256 !== undefined || i.appIds.length !== 0 || !i.labelId) throw new TypeError('labels_remove takes a label id, no document and no apps');
    doc = new Uint8Array(32);
  } else {
    throw new TypeError(`Unknown label change kind ${String(i.kind)}`);
  }
  if (new Set(i.appIds).size !== i.appIds.length) throw new TypeError('An app is listed twice');
  const apps = [...i.appIds].sort((a, b) => compareBytes(utf8(a), utf8(b)));
  return sha256(concatBytes(utf8(DOMAINS.labelChange), borshString(i.signer), borshString(i.scopeId), borshString(i.kind), borshString(i.labelId), doc, borshStringVec(apps), u64le(i.labelsVersion)));
}

/**
 * Owner action, the contract's layout: "hana-id/owner-action/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ borsh(method) ‖
 * borsh(args without auth) ‖ action_nonce u64 LE. The contract hashes it with sha256 and the nonce is b64url of that.
 * `argsBorsh` is the borsh encoding of the method's arguments without `auth` (built per method from batch C6 on).
 */
export async function ownerActionDigest(i: { signer: string; scopeId: string; method: string; argsBorsh: Uint8Array; actionNonce: number | bigint }): Promise<Uint8Array> {
  return sha256(concatBytes(utf8(DOMAINS.ownerAction), borshString(i.signer), borshString(i.scopeId), borshString(i.method), i.argsBorsh, u64le(i.actionNonce)));
}

/** Client proof, the contract's layout: "hana-id/client-proof/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ action_nonce u64 LE. */
export async function clientProofDigest(i: { signer: string; scopeId: string; actionNonce: number | bigint }): Promise<Uint8Array> {
  return sha256(concatBytes(utf8(DOMAINS.clientProof), borshString(i.signer), borshString(i.scopeId), u64le(i.actionNonce)));
}

/**
 * The emailed link tokens: T = HMAC-SHA256(key, domain ‖ borsh(id)). Deterministic per id, so a notice re-sent after
 * a failed ack carries the same working link; the databases store only sha256(T).
 * - cancel link (guarded change, key `CANCEL_LINK_KEY`, checked by the API),
 * - invite (key `INVITE_LINK_KEY`, checked by the console),
 * - owner-grant cancel (key `CANCEL_LINK_KEY`, checked by the console),
 * - a platform key's cancel and revoke links (key `CANCEL_LINK_KEY`, checked by the API; D918),
 * - a confirmed web address's removal link (key `CANCEL_LINK_KEY`, checked by the API; D931).
 */
export type LinkKind = 'cancelLink' | 'invite' | 'ownerGrantCancel' | 'platformKeyCancel' | 'platformKeyRevoke' | 'originRemove';

export async function linkToken(kind: LinkKind, key: Uint8Array, id: string): Promise<Uint8Array> {
  if (!id) throw new TypeError('A link token needs an id');
  return hmacSha256(exactly(key, 32, 'A link key'), concatBytes(utf8(DOMAINS[kind]), borshString(id)));
}

/** sha256(T): what `cancel_token_hash` and `invites.token_hash` hold. */
export const linkTokenHash = (token: Uint8Array): Promise<Uint8Array> => sha256(token);

/** Whether `presented` (from the emailed link) hashes to the stored hash. */
export async function linkTokenMatches(presented: Uint8Array, storedHash: Uint8Array): Promise<boolean> {
  return bytesEqual(await sha256(presented), storedHash);
}

/**
 * uid: HMAC-SHA256(USER_ID_KEY, "hana-id/uid/v1" ‖ borsh(scope_id) ‖ borsh(provider) ‖ borsh(sub))[0..16]. A
 * pseudonymous user id per scope, for MAU and new-user counts; `key_index` is not part of it (a rotated key is not a
 * new user).
 */
export async function uid(key: Uint8Array, i: { scopeId: string; provider: string; sub: string }): Promise<Uint8Array> {
  if (!i.scopeId || !i.provider || !i.sub) throw new TypeError('uid needs scope_id, provider and sub');
  const mac = await hmacSha256(exactly(key, 32, 'USER_ID_KEY'), concatBytes(utf8(DOMAINS.uid), borshString(i.scopeId), borshString(i.provider), borshString(i.sub)));
  return mac.slice(0, 16);
}

/**
 * The (provider, sub) of a derivation path `scope_id#provider#sub#key_index`, for the uid. The `${scope_id}#` prefix
 * must be the scope the request was for, and exactly three `#`-separated parts must follow; `key_index` is dropped.
 * Returns null for any other path (the caller records no uid).
 */
export function pathIdentity(scopeId: string, path: string): { provider: string; sub: string } | null {
  const prefix = `${scopeId}#`;
  if (!scopeId || !path.startsWith(prefix)) return null;
  const parts = path.slice(prefix.length).split('#');
  if (parts.length !== 3) return null;
  const [provider, sub, keyIndex] = parts as [string, string, string];
  if (!provider || !sub || !/^(0|[1-9]\d{0,9})$/u.test(keyIndex)) return null;
  return { provider, sub };
}

/** uid from a request's derivation path, or null when the path doesn't parse for this scope. */
export async function uidFromPath(key: Uint8Array, scopeId: string, path: string): Promise<Uint8Array | null> {
  const who = pathIdentity(scopeId, path);
  return who ? uid(key, { scopeId, ...who }) : null;
}
