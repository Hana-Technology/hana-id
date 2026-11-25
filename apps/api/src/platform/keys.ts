// Platform keys (D918; docs/partner-platform-spec.md A3, A7): a network's backend's request-signing keys, their life
// and their records. Nothing authenticates with a key yet (piece P3); this is the credential's life cycle:
//
// - registration by an on-chain owner of each scope it names (ConsoleRpc.proposePlatformKey: the step-up of kind
//   `platform.key_add`, its nonce over the signer, env, org, scopes, thumbprint and label, `confirmStepUpScopes` once
//   per scope), or by staff (AdminRpc.registerPlatformKey: `awaiting_acceptance`, unusable until an owner of each scope
//   accepts it, ConsoleRpc.acceptPlatformKey, which counts as its confirmation, or a second staff member approves it,
//   AdminRpc.approvePlatformKey, never the registrant);
// - the announcement (AdminRpc.platformKeyNotices → the admin Worker's email to the alias, every security contact and
//   every owner → ackPlatformKeyNotice, `system` only), which starts the key's wait: in force at the greater of the
//   env's appChangeDelayMs and the platform minimum (24 h; `local*` test envs excepted) after it, unless an owner
//   confirms it sooner (ConsoleRpc.confirmPlatformKey, the step-up of kind `platform.key_confirm`; on a real-money
//   setup never the registrant: four eyes, held in the commit predicate and in the table's CHECK);
// - the cancel of a waiting key (an owner, staff, the emailed link) and the revocation of any key, at once (an owner,
//   staff, the confirmation notice's link, the key itself from P3); a revocation, an expiry, staff's switch-off and a
//   freeze cancel in the same batch every waiting web address the key (or the org's keys) proposed; the switch-off and
//   the freeze cancel the org's waiting keys too;
// - the org's platform switch (staff; turning it on names every key still in force or waiting: the review, L5) and the
//   mirror of a console freeze.
//
// Every write is one compare-and-swap batch whose first statement is its org-level `app_changes` row (cas.ts). Who may
// act is checked in code first and again in each commit predicate; the table's CHECKs and triggers (migration 0028)
// hold the rest against any writer. Never a platform actor: no route reaches these, and each member-only writer
// refuses any other actor kind itself.
import {
  type Actor,
  type PlatformCancelReason,
  type PlatformKeyNotice,
  type PlatformKeyState,
  type PlatformKeyStatus,
  type PlatformKeyView,
  type PlatformOrgView,
  PLATFORM_KEY_CONTACT_WAIT_MS,
  PLATFORM_UNFREEZE_GRACE_MS,
  mirrorUnfreeze,
  PLATFORM_KEY_LIFETIME_MS,
  PLATFORM_KEY_REVOKE_LINK_MS,
  PLATFORM_KEY_WORDS,
  PLATFORM_KEYS_PER_ORG,
  bytesEqual,
  fromB64url,
  hex,
  newId,
  nonceOf,
  parsePlatformPublicKey,
  personEmailKey,
  platformKeyDigest,
  platformKeyLabel,
  sha256,
  sortedScopes,
} from '@hana-id/console-core';
import type { Env } from '../env.ts';
import { fourEyesNetwork, platformMinDelayMs } from '../guarded/config.ts';
import { type Writer, actorId, commitOn, committed, expectReplay, refuse, refuseReplay, replayRow, runWrite } from '../changes/cas.ts';
import type { HotDb } from '../changes/db.ts';
import { requireChangeConfig } from '../changes/origins.ts';
import { type Q, q, raw } from '../changes/sql.ts';
import { type StepUpToken, confirmStepUpScopes, releaseStepUp, verifyStepUpToken } from '../changes/step-up.ts';

/** A stored key, as the writers and the views read it (never the hashes: only whether they are set). */
export interface PlatformKeyRow {
  id: string;
  org_id: string;
  label: string;
  thumbprint: string;
  scopes_json: string;
  status: PlatformKeyStatus;
  proposed_by_kind: 'hana' | 'member';
  proposed_by: string;
  proposer_sub: string | null;
  proposer_email_key: string | null;
  proposer_email: string | null;
  proposed_at: number;
  accepted_by_kind: 'hana' | 'member' | null;
  accepted_by: string | null;
  accepted_email: string | null;
  accepted_at: number | null;
  notified_at: number | null;
  unconfirmed_active_from: number | null;
  active_from: number | null;
  expires_at: number | null;
  four_eyes: number;
  min_delay_ms: number;
  confirmed_kind: 'confirm' | 'acceptance' | null;
  confirmed_by: string | null;
  confirmed_at: number | null;
  confirm_notified_at: number | null;
  revoke_link_until: number | null;
  cancelled_at: number | null;
  cancelled_by_kind: string | null;
  revoked_at: number | null;
  revoked_by_kind: string | null;
  revoke_reason: string | null;
  end_request_id: string | null;
  end_notified_at: number | null;
  expiry_notice_stage: number;
  last_used_at: number | null;
  notice_failures: number;
  notice_failed_at: number | null;
  cancel_hash_hex: string | null;
  revoke_hash_hex: string | null;
  /** The org's last change of its security contacts (the hold of M5), or null. */
  contacts_changed_at: number | null;
}

export const PLATFORM_KEY_COLUMNS = (k: string): Q =>
  raw(
    [
      'id', 'org_id', 'label', 'thumbprint', 'scopes_json', 'status', 'proposed_by_kind', 'proposed_by', 'proposer_sub', 'proposer_email_key', 'proposer_email', 'proposed_at',
      'accepted_by_kind', 'accepted_by', 'accepted_email', 'accepted_at', 'notified_at', 'unconfirmed_active_from', 'active_from', 'expires_at', 'four_eyes', 'min_delay_ms',
      'confirmed_kind', 'confirmed_by', 'confirmed_at', 'confirm_notified_at', 'revoke_link_until', 'cancelled_at', 'cancelled_by_kind', 'revoked_at', 'revoked_by_kind',
      'revoke_reason', 'end_request_id', 'end_notified_at', 'expiry_notice_stage', 'last_used_at', 'notice_failures', 'notice_failed_at',
    ]
      .map((c) => `${k}.${c}`)
      .join(', ') +
      `, hex(${k}.cancel_token_hash) AS cancel_hash_hex, hex(${k}.revoke_link_hash) AS revoke_hash_hex` +
      `, (SELECT MAX(pkcc.at) FROM app_changes pkcc WHERE pkcc.org_id = ${k}.org_id AND pkcc.kind = 'org.security_contacts') AS contacts_changed_at`,
  );

// ---- predicates over a key `k` ----

/** In force at `now`: announced, its date passed, not yet expired, not revoked (what P3's check 5 will read). */
export const KEY_IN_FORCE = (k: string, now: number): Q =>
  q`(${raw(k)}.status IN ('pending', 'active') AND ${raw(k)}.active_from IS NOT NULL AND ${raw(k)}.active_from <= ${now} AND ${raw(k)}.expires_at > ${now} AND ${raw(k)}.revoked_at IS NULL)`;
/** Still waiting: awaiting acceptance, or registered and not yet in force (what a cancel can still stop). */
export const KEY_WAITING = (k: string, now: number): Q =>
  q`(${raw(k)}.status = 'awaiting_acceptance' OR (${raw(k)}.status = 'pending' AND (${raw(k)}.active_from IS NULL OR ${raw(k)}.active_from > ${now})))`;
/** Counts towards the org's two keys (A5): in force, waiting or awaiting acceptance. */
export const KEY_COUNTS = (k: string, now: number): Q => q`(${raw(k)}.status IN ('awaiting_acceptance', 'pending', 'active') AND (${raw(k)}.expires_at IS NULL OR ${raw(k)}.expires_at > ${now}))`;

/** The org's security contacts changed less than 7 days ago (the latest `org.security_contacts` row; M5). */
const CONTACTS_CHANGED = (orgId: string, now: number): Q =>
  q`EXISTS (SELECT 1 FROM app_changes WHERE org_id = ${orgId} AND kind = 'org.security_contacts' AND at > ${now - PLATFORM_KEY_CONTACT_WAIT_MS})`;
/** The same rule for the key row `k`'s org (the notice page). */
const CONTACTS_CHANGED_K = (k: string, now: number): Q =>
  q`EXISTS (SELECT 1 FROM app_changes WHERE org_id = ${raw(k)}.org_id AND kind = 'org.security_contacts' AND at > ${now - PLATFORM_KEY_CONTACT_WAIT_MS})`;
const FROZEN = (orgId: string): Q => q`EXISTS (SELECT 1 FROM platform_orgs WHERE org_id = ${orgId} AND frozen = 1)`;

// ---- views ----

function stateOf(r: Pick<PlatformKeyRow, 'status' | 'active_from' | 'expires_at'>, now: number): PlatformKeyState {
  switch (r.status) {
    case 'awaiting_acceptance':
      return 'awaiting_acceptance';
    case 'pending':
    case 'active':
      if (r.expires_at !== null && r.expires_at <= now) return 'expired';
      return r.active_from !== null && r.active_from <= now ? 'in_force' : 'waiting';
    default:
      return r.status;
  }
}

/**
 * A key as a screen sees it. `staff` adds the staff identities (their Access subjects and emails); the partner view
 * names staff as `hana`. Never a Google `sub`, a hash or a token in either.
 */
export function platformKeyView(r: PlatformKeyRow, now: number, staff: boolean): PlatformKeyView {
  const who = (kind: string | null, id: string | null): string | undefined => (id === null ? undefined : kind === 'hana' && !staff ? 'hana' : id);
  const v: PlatformKeyView = {
    id: r.id,
    orgId: r.org_id,
    label: r.label,
    thumbprint: r.thumbprint,
    scopes: JSON.parse(r.scopes_json) as string[],
    status: r.status,
    state: stateOf(r, now),
    fourEyes: r.four_eyes === 1,
    proposedByKind: r.proposed_by_kind,
    proposedBy: who(r.proposed_by_kind, r.proposed_by)!,
    proposedAt: r.proposed_at,
  };
  if (staff && r.proposer_email !== null) v.proposedByEmail = r.proposer_email;
  if (r.accepted_by_kind !== null) {
    v.acceptedByKind = r.accepted_by_kind;
    v.acceptedBy = who(r.accepted_by_kind, r.accepted_by)!;
    v.acceptedAt = r.accepted_at!;
    if (staff && r.accepted_email !== null) v.acceptedByEmail = r.accepted_email;
  }
  if (r.notified_at !== null) v.notifiedAt = r.notified_at;
  // A waiting, announced key's date is when it comes into force if nobody confirms it.
  const activeFrom = r.active_from ?? r.unconfirmed_active_from;
  if (activeFrom !== null) v.activeFrom = activeFrom;
  if (r.expires_at !== null) v.expiresAt = r.expires_at;
  if (r.confirmed_kind !== null) {
    v.confirmedKind = r.confirmed_kind;
    v.confirmedBy = r.confirmed_by!;
    v.confirmedAt = r.confirmed_at!;
  }
  if (r.cancelled_at !== null) {
    v.cancelledAt = r.cancelled_at;
    if (r.cancelled_by_kind !== null) v.cancelledByKind = r.cancelled_by_kind;
  }
  if (r.revoked_at !== null) {
    v.revokedAt = r.revoked_at;
    if (r.revoked_by_kind !== null) v.revokedByKind = r.revoked_by_kind;
    if (r.revoke_reason !== null && (staff || r.revoked_by_kind !== 'hana')) v.revokeReason = r.revoke_reason;
  }
  if (r.last_used_at !== null) v.lastUsedAt = r.last_used_at;
  // Held after a security-contact change (M5): not announced or accepted before this date.
  const held = r.contacts_changed_at === null ? null : r.contacts_changed_at + PLATFORM_KEY_CONTACT_WAIT_MS;
  if (held !== null && held > now && (r.status === 'awaiting_acceptance' || (r.status === 'pending' && r.notified_at === null))) v.heldUntil = held;
  return v;
}

/** The env's wait for a key nobody confirms: the greater of appChangeDelayMs and the platform minimum. */
export function keyDelayMs(env: Env): number {
  return Math.max(requireChangeConfig(env).delayMs, platformMinDelayMs(env));
}

/** A real-money setup (`NETWORK = 'mainnet'`, the rule changeConfig already reads): four eyes on every key. */
export const fourEyesEnv = (env: Pick<Env, 'NETWORK'>): boolean => fourEyesNetwork(env.NETWORK);

// ---- reads ----

interface KeyPlan {
  replay: string | null;
  frozen: number;
  contacts_changed: number;
  key: string | null;
}

/** One read: the replay row, the org's freeze mirror and contact-change rule, and the key (in `orgId` when given). */
async function planKey(db: HotDb, w: Writer, keyId: string, orgId: string | null): Promise<{ plan: KeyPlan; key: PlatformKeyRow | null }> {
  const org = orgId === null ? raw('1') : q`k.org_id = ${orgId}`;
  const r = await db.first<KeyPlan & PlatformKeyRow & { found: string | null }>(
    q`SELECT ${replayRow(w.requestId)} AS replay, k.id AS found, ${PLATFORM_KEY_COLUMNS('k')},
             COALESCE((SELECT frozen FROM platform_orgs WHERE org_id = k.org_id), 0) AS frozen,
             EXISTS (SELECT 1 FROM app_changes c WHERE c.org_id = k.org_id AND c.kind = 'org.security_contacts' AND c.at > ${w.now - PLATFORM_KEY_CONTACT_WAIT_MS}) AS contacts_changed
        FROM (SELECT 1) LEFT JOIN platform_keys k ON k.id = ${keyId} AND ${org}`,
  );
  refuseReplay(r?.replay, w);
  if (!r || r.found === null) return { plan: { replay: null, frozen: 0, contacts_changed: 0, key: null }, key: null };
  return { plan: r, key: r };
}

/** ConsoleRpc.listPlatformKeys / AdminRpc.listPlatformKeys: every key of the org, newest first, and the org's switch. */
export async function listPlatformKeys(db: HotDb, orgId: string, now: number, staff: boolean): Promise<{ keys: PlatformKeyView[]; platform: PlatformOrgView }> {
  const rows = await db.all<PlatformKeyRow & { po_enabled: number | null; po_frozen: number | null; po_max_apps: number | null; po_creations: number | null; po_proposals: number | null; po_set_by: string | null; po_set_at: number | null }>(
    q`SELECT ${PLATFORM_KEY_COLUMNS('k')}, po.enabled AS po_enabled, po.frozen AS po_frozen, po.max_apps AS po_max_apps, po.creations_per_day AS po_creations,
             po.proposals_per_day AS po_proposals, po.set_by AS po_set_by, po.set_at AS po_set_at
        FROM (SELECT 1) LEFT JOIN platform_orgs po ON po.org_id = ${orgId} LEFT JOIN platform_keys k ON k.org_id = ${orgId}
       ORDER BY k.proposed_at DESC, k.id LIMIT 50`,
  );
  const head = rows[0];
  const platform: PlatformOrgView = {
    orgId,
    enabled: head?.po_enabled === 1,
    frozen: head?.po_frozen === 1,
    maxApps: head?.po_max_apps ?? 10,
    creationsPerDay: head?.po_creations ?? 5,
    proposalsPerDay: head?.po_proposals ?? 30,
    setBy: staff ? (head?.po_set_by ?? null) : head?.po_set_by ? 'hana' : null,
    setAt: head?.po_set_at ?? null,
  };
  return { keys: rows.filter((r) => r.id !== null).map((r) => platformKeyView(r, now, staff)), platform };
}

/** One key of the org (`not_found` for another org's or an unknown id: the same answer). */
export async function getPlatformKey(db: HotDb, orgId: string, keyId: string, now: number, staff: boolean, viewer?: Actor): Promise<PlatformKeyView> {
  const r = await db.first<PlatformKeyRow>(q`SELECT ${PLATFORM_KEY_COLUMNS('k')} FROM platform_keys k WHERE k.id = ${keyId} AND k.org_id = ${orgId}`);
  if (!r) return refuse('not_found', 'No such platform key in this organisation');
  const v = platformKeyView(r, now, staff);
  // For the console's screen (D918 after PR 149's review): whether this member counts as the registrant for four eyes,
  // so the page can say so before any sign-in. Computed here, where the registrant's sub and email key are.
  if (viewer?.kind === 'member') v.registeredByYou = r.proposed_by === viewer.id || r.proposer_sub === viewer.sub || r.proposer_email_key === personEmailKey(viewer.email);
  return v;
}

// ---- registration ----

interface RegisterPlan {
  replay: string | null;
  contacts: number;
  scopes: string;
  counted: number;
  frozen: number;
  contacts_changed: number;
  taken: number;
}

type Registrant = { kind: 'member'; stepUpJwt: string } | { kind: 'hana'; reason: string };

/**
 * Registration (A3): by an on-chain owner of each scope (a member, with the `platform.key_add` step-up) or by staff
 * (held until accepted). Refused: no security contact (`no_security_contact`: the announcement has nobody to reach), a
 * scope not a test scope of the org (`not_found` / `env_mismatch`), a frozen org (`forbidden`), a security-contact
 * change less than 7 days ago (`conflict`), two keys already in force, waiting or awaiting acceptance (`key_limit`),
 * a public key registered before anywhere (`conflict`), and any key text that isn't a P-256 public key (`bad_request`).
 */
export async function registerPlatformKey(db: HotDb, env: Env, w: Writer, i: { orgId: string; scopeIds: readonly string[]; label: string; publicKey: string; by: Registrant }) {
  expectReplay(w, ['platform.key_proposed']);
  if (i.by.kind !== w.actor.kind || (w.actor.kind !== 'member' && w.actor.kind !== 'hana')) return refuse('forbidden', 'Only an owner of the organisation or Journear staff register a platform key');
  const token: StepUpToken | null = i.by.kind === 'member' ? await verifyStepUpToken(env, i.by.stepUpJwt, w.actor, w.now) : null;
  const label = platformKeyLabel(i.label);
  if (!label.ok) return refuse('bad_request', label.problem);
  const parsed = await parsePlatformPublicKey(i.publicKey);
  if (!parsed.ok) return refuse('bad_request', parsed.problem);
  const key = parsed.key;
  // WebCrypto's own import as a second check of the point (it refuses one off the curve).
  try {
    await crypto.subtle.importKey('jwk', { ...key.jwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  } catch {
    return refuse('bad_request', 'This public key is not a point of the P-256 curve.');
  }
  let scopes: string[];
  try {
    scopes = sortedScopes(i.scopeIds);
  } catch {
    return refuse('bad_request', 'A scope is listed twice');
  }
  const delayMs = keyDelayMs(env);
  const scopesJson = JSON.stringify(scopes);
  const p = await db.first<RegisterPlan>(
    q`SELECT ${replayRow(w.requestId)} AS replay,
             (SELECT COUNT(*) FROM org_security_contacts WHERE org_id = ${i.orgId}) AS contacts,
             (SELECT json_group_array(json_object('id', s.scope_id, 'org', s.org_id, 'env', s.environment)) FROM scopes s WHERE s.scope_id IN (SELECT value FROM json_each(${scopesJson}))) AS scopes,
             (SELECT COUNT(*) FROM platform_keys k WHERE k.org_id = ${i.orgId} AND ${KEY_COUNTS('k', w.now)}) AS counted,
             ${FROZEN(i.orgId)} AS frozen, ${CONTACTS_CHANGED(i.orgId, w.now)} AS contacts_changed,
             EXISTS (SELECT 1 FROM platform_keys WHERE thumbprint = ${key.thumbprint}) AS taken`,
  );
  refuseReplay(p?.replay, w);
  if (!p || p.contacts === 0) return refuse('no_security_contact', 'The organisation has no security contact: Journear sets them first');
  const found = JSON.parse(p.scopes) as { id: string; org: string; env: string }[];
  for (const s of scopes) {
    const row = found.find((f) => f.id === s);
    if (!row || row.org !== i.orgId) refuse('not_found', `No such scope in this organisation: ${s}`);
    if (row!.env !== 'test') refuse('env_mismatch', `Platform keys are for test scopes only for now (${s} is live)`);
  }
  if (p.frozen) refuse('forbidden', 'Journear has frozen this organisation: platform keys can’t be registered');
  if (p.contacts_changed) refuse('conflict', PLATFORM_KEY_WORDS.contactWait);
  if (p.counted >= PLATFORM_KEYS_PER_ORG) refuse('key_limit', `An organisation has at most ${PLATFORM_KEYS_PER_ORG} platform keys in force, waiting or awaiting acceptance: stop or cancel one first`);
  if (p.taken) refuse('conflict', 'This public key is already registered. Make a new key pair for each key');
  const id = newId('platformKey');
  if (token) {
    // The registration's nonce, then an owner of each scope, then the single use (a refusal before leaves it unused).
    const expectedNonce = nonceOf(await platformKeyDigest({ kind: 'add', signer: env.SIGNER_ACCOUNT, env: env.ENV_NAME, orgId: i.orgId, keyId: '', thumbprint: key.thumbprint, scopes, label: label.label }));
    await confirmStepUpScopes(env, token, { expectedNonce, scopeIds: scopes });
    w.sub = token.sub;
  }
  const actor = w.actor as Extract<Actor, { kind: 'member' | 'hana' }>;
  const member = i.by.kind === 'member';
  const blob = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  const stmts: Q[] = [
    commitOn(
      w,
      { kind: 'platform.key_proposed', detail: { keyId: id, label: label.label, thumbprint: key.thumbprint, scopes, by: actor.kind, fourEyes: fourEyesEnv(env) } },
      { orgId: i.orgId },
      q`EXISTS (SELECT 1 FROM org_security_contacts WHERE org_id = ${i.orgId})
        AND (SELECT COUNT(*) FROM scopes s WHERE s.scope_id IN (SELECT value FROM json_each(${scopesJson})) AND s.org_id = ${i.orgId} AND s.environment = 'test') = ${scopes.length}
        AND NOT ${FROZEN(i.orgId)} AND NOT ${CONTACTS_CHANGED(i.orgId, w.now)}
        AND (SELECT COUNT(*) FROM platform_keys k WHERE k.org_id = ${i.orgId} AND ${KEY_COUNTS('k', w.now)}) < ${PLATFORM_KEYS_PER_ORG}
        AND NOT EXISTS (SELECT 1 FROM platform_keys WHERE thumbprint = ${key.thumbprint})`,
    ),
    q`INSERT INTO platform_keys (id, org_id, label, alg, public_key, thumbprint, scopes_json, status, proposed_by_kind, proposed_by, proposer_sub, proposer_email_key, proposer_email, proposal_note, proposed_at, four_eyes, min_delay_ms, request_id)
      SELECT ${id}, ${i.orgId}, ${label.label}, 'ES256', ${blob(key.raw)}, ${key.thumbprint}, ${scopesJson}, ${member ? 'pending' : 'awaiting_acceptance'}, ${actor.kind}, ${actorId(actor)},
             ${token?.sub ?? null}, ${personEmailKey(actor.email)}, ${member ? null : actor.email}, ${i.by.kind === 'hana' ? i.by.reason.trim() : null}, ${w.now}, ${fourEyesEnv(env) ? 1 : 0}, ${delayMs}, ${w.requestId}
       WHERE ${committed(w.requestId)}`,
  ];
  try {
    await runWrite(db, w, stmts);
  } catch (err) {
    if (token && !w.wrote) await releaseStepUp(env, token);
    throw err;
  }
  return { key: await getPlatformKey(db, i.orgId, id, w.now, actor.kind === 'hana') };
}

// ---- acceptance of a staff key ----

/**
 * ConsoleRpc.acceptPlatformKey: an on-chain owner of each scope accepts a staff-registered key (the `platform.key_accept`
 * step-up over the stored key). It then waits only for its announcement: the acceptance counts as its confirmation
 * (D917), so the ack puts it in force at once, after the security contacts and owners were told.
 */
export async function acceptPlatformKey(db: HotDb, env: Env, w: Writer, i: { orgId: string; keyId: string; stepUpJwt: string }) {
  expectReplay(w, ['platform.key_accepted']);
  if (w.actor.kind !== 'member') return refuse('forbidden', 'Only an owner of the organisation accepts a platform key');
  const token = await verifyStepUpToken(env, i.stepUpJwt, w.actor, w.now);
  const { plan, key } = await planKey(db, w, i.keyId, i.orgId);
  if (!key) return refuse('not_found', 'No such platform key in this organisation');
  if (key.status !== 'awaiting_acceptance') refuse('not_pending', 'This key isn’t waiting for an owner’s acceptance');
  if (plan.frozen) refuse('forbidden', 'Journear has frozen this organisation');
  if (plan.contacts_changed) refuse('conflict', PLATFORM_KEY_WORDS.contactWait);
  const emailKey = personEmailKey(w.actor.email);
  if (key.four_eyes === 1 && key.proposer_email_key === emailKey) refuse('forbidden', 'The person who registered this key can’t accept it: another owner must');
  const scopes = JSON.parse(key.scopes_json) as string[];
  const expectedNonce = nonceOf(await platformKeyDigest({ kind: 'accept', signer: env.SIGNER_ACCOUNT, env: env.ENV_NAME, orgId: i.orgId, keyId: key.id, thumbprint: key.thumbprint, scopes, label: key.label }));
  await confirmStepUpScopes(env, token, { expectedNonce, scopeIds: scopes });
  w.sub = token.sub;
  try {
    await runWrite(db, w, [
      commitOn(
        w,
        { kind: 'platform.key_accepted', detail: { keyId: key.id, by: 'member', countsAsConfirmation: true } },
        { orgId: i.orgId },
        q`EXISTS (SELECT 1 FROM platform_keys WHERE id = ${key.id} AND org_id = ${i.orgId} AND status = 'awaiting_acceptance' AND accepted_at IS NULL)
          AND NOT ${FROZEN(i.orgId)} AND NOT ${CONTACTS_CHANGED(i.orgId, w.now)}`,
      ),
      q`UPDATE platform_keys SET status = 'pending', accepted_by_kind = 'member', accepted_by = ${actorId(w.actor)}, accepted_sub = ${token.sub}, accepted_email_key = ${emailKey}, accepted_at = ${w.now},
               confirmed_kind = 'acceptance', confirmed_by = ${actorId(w.actor)}, confirmed_sub = ${token.sub}, confirmed_email_key = ${emailKey}, confirmed_at = ${w.now}
         WHERE id = ${key.id} AND status = 'awaiting_acceptance' AND ${committed(w.requestId)}`,
    ]);
  } catch (err) {
    if (!w.wrote) await releaseStepUp(env, token);
    throw err;
  }
  return { key: await getPlatformKey(db, i.orgId, key.id, w.now, false) };
}

/**
 * AdminRpc.approvePlatformKey: a second staff member approves a staff-registered key (never the one who registered
 * it: another Access subject and another email), with a reason. It then waits the full delay after its announcement,
 * unless an owner confirms it (any owner: none of them registered it).
 */
export async function approvePlatformKey(db: HotDb, w: Writer, i: { orgId: string; keyId: string; reason: string }) {
  expectReplay(w, ['platform.key_accepted']);
  if (w.actor.kind !== 'hana') return refuse('forbidden', 'Only Journear staff approve a staff-registered key');
  const { plan, key } = await planKey(db, w, i.keyId, i.orgId);
  if (!key) return refuse('not_found', 'No such platform key in this organisation');
  if (key.status !== 'awaiting_acceptance') refuse('not_pending', 'This key isn’t waiting for an acceptance');
  const emailKey = personEmailKey(w.actor.email);
  if (key.proposed_by === w.actor.id || key.proposer_email_key === emailKey) refuse('forbidden', 'The staff member who registered this key can’t approve it: a second staff member must');
  if (plan.frozen) refuse('forbidden', 'Journear has frozen this organisation');
  if (plan.contacts_changed) refuse('conflict', PLATFORM_KEY_WORDS.contactWait);
  await runWrite(db, w, [
    commitOn(
      w,
      { kind: 'platform.key_accepted', detail: { keyId: key.id, by: 'hana', reason: i.reason.trim() } },
      { orgId: i.orgId },
      q`EXISTS (SELECT 1 FROM platform_keys WHERE id = ${key.id} AND org_id = ${i.orgId} AND status = 'awaiting_acceptance' AND accepted_at IS NULL
                  AND proposed_by IS NOT ${w.actor.id} AND proposer_email_key IS NOT ${emailKey})
        AND NOT ${FROZEN(i.orgId)} AND NOT ${CONTACTS_CHANGED(i.orgId, w.now)}`,
    ),
    q`UPDATE platform_keys SET status = 'pending', accepted_by_kind = 'hana', accepted_by = ${w.actor.id}, accepted_email = ${w.actor.email}, accepted_email_key = ${emailKey}, accept_note = ${i.reason.trim()}, accepted_at = ${w.now}
       WHERE id = ${key.id} AND status = 'awaiting_acceptance' AND ${committed(w.requestId)}`,
  ]);
  return { key: await getPlatformKey(db, i.orgId, key.id, w.now, true) };
}

// ---- an owner's confirmation ----

/**
 * ConsoleRpc.confirmPlatformKey (A3, D914, D917): an owner of each scope confirms a waiting, announced key, which is in
 * force at once. Only a member actor (the platform, staff, the system and a link never confirm). On a real-money setup
 * (`four_eyes`) never the registrant: another console user, another Google `sub` and another email (dots and `+tags`
 * aside), held in this commit predicate and in the table's CHECK; that the confirmer was an owner before the key was
 * registered is the console's check (it holds the roles). Refused within 7 days of a security-contact change and while
 * the org is frozen. A cancel or a revocation that lands first wins: the predicate wants the key still waiting.
 */
export async function confirmPlatformKey(db: HotDb, env: Env, w: Writer, i: { orgId: string; keyId: string; stepUpJwt: string }) {
  expectReplay(w, ['platform.key_confirmed']);
  if (w.actor.kind !== 'member') return refuse('forbidden', 'Only an owner of the organisation confirms a platform key, in the partner portal');
  const token = await verifyStepUpToken(env, i.stepUpJwt, w.actor, w.now);
  const { plan, key } = await planKey(db, w, i.keyId, i.orgId);
  if (!key) return refuse('not_found', 'No such platform key in this organisation');
  if (key.status !== 'pending' || key.notified_at === null) refuse('not_pending', key.status === 'awaiting_acceptance' ? 'This key needs an owner’s acceptance first' : key.status === 'pending' ? 'This key hasn’t been announced yet: it can be confirmed once its email has gone out' : `This key is ${key.status}`);
  if (key.confirmed_at !== null) refuse('not_pending', 'This key is already confirmed');
  if (key.active_from !== null && key.active_from <= w.now) refuse('not_pending', 'This key is already in force');
  if (plan.frozen) refuse('forbidden', 'Journear has frozen this organisation');
  if (plan.contacts_changed) refuse('conflict', PLATFORM_KEY_WORDS.contactWait);
  const emailKey = personEmailKey(w.actor.email);
  const self = key.proposed_by === w.actor.id || key.proposer_sub === token.sub || key.proposer_email_key === emailKey;
  if (key.four_eyes === 1 && self) refuse('forbidden', 'The owner who registered this key can’t confirm it here: another owner must, or it starts working when its wait ends');
  const scopes = JSON.parse(key.scopes_json) as string[];
  const expectedNonce = nonceOf(await platformKeyDigest({ kind: 'confirm', signer: env.SIGNER_ACCOUNT, env: env.ENV_NAME, orgId: i.orgId, keyId: key.id, thumbprint: key.thumbprint, scopes, label: key.label }));
  await confirmStepUpScopes(env, token, { expectedNonce, scopeIds: scopes });
  w.sub = token.sub;
  const fourEyes = q`(four_eyes = 0 OR (proposed_by IS NOT ${w.actor.id} AND proposer_sub IS NOT ${token.sub} AND proposer_email_key IS NOT ${emailKey}))`;
  try {
    await runWrite(db, w, [
      commitOn(
        w,
        { kind: 'platform.key_confirmed', detail: { keyId: key.id, activeFrom: w.now, wouldHaveBeen: key.unconfirmed_active_from, fourEyes: key.four_eyes === 1 } },
        { orgId: i.orgId },
        q`EXISTS (SELECT 1 FROM platform_keys WHERE id = ${key.id} AND org_id = ${i.orgId} AND status = 'pending' AND notified_at IS NOT NULL AND confirmed_at IS NULL
                    AND revoked_at IS NULL AND cancelled_at IS NULL AND active_from > ${w.now} AND ${fourEyes})
          AND NOT ${FROZEN(i.orgId)} AND NOT ${CONTACTS_CHANGED(i.orgId, w.now)}`,
      ),
      q`UPDATE platform_keys SET confirmed_kind = 'confirm', confirmed_by = ${actorId(w.actor)}, confirmed_sub = ${token.sub}, confirmed_email_key = ${emailKey}, confirmed_at = ${w.now},
               active_from = ${w.now}, expires_at = ${w.now + PLATFORM_KEY_LIFETIME_MS}, status = 'active', activated_recorded_at = ${w.now}
         WHERE id = ${key.id} AND status = 'pending' AND ${committed(w.requestId)}`,
    ]);
  } catch (err) {
    if (!w.wrote) await releaseStepUp(env, token);
    throw err;
  }
  return { key: await getPlatformKey(db, i.orgId, key.id, w.now, false) };
}

// ---- cancel ----

/** A waiting key cancelled: by an owner, staff, the emailed link, or the hourly job's lapse (its reason). */
function cancelStatements(w: Writer, key: PlatformKeyRow, extra: Q, reason: string, byKind: string, by: string, ledgerActor?: { kind: 'link'; id: string }): Q[] {
  const cw: Writer = ledgerActor ? { ...w, actor: ledgerActor, sub: undefined } : w;
  return [
    commitOn(
      cw,
      { kind: 'platform.key_cancelled', detail: { keyId: key.id, label: key.label, by: byKind, reason } },
      { orgId: key.org_id },
      q`EXISTS (SELECT 1 FROM platform_keys k WHERE k.id = ${key.id} AND ${KEY_WAITING('k', w.now)} AND ${extra})`,
    ),
    q`UPDATE platform_keys SET status = 'cancelled', cancelled_at = ${w.now}, cancelled_by_kind = ${byKind}, cancelled_by = ${by}, cancel_reason = ${reason}
       WHERE id = ${key.id} AND status IN ('awaiting_acceptance', 'pending') AND ${committed(w.requestId)}`,
  ];
}

const isWaiting = (k: PlatformKeyRow, now: number): boolean => k.status === 'awaiting_acceptance' || (k.status === 'pending' && (k.active_from === null || k.active_from > now));

/** ConsoleRpc.cancelPlatformKey (an owner; no step-up: a cancel only stops a key) and AdminRpc.cancelPlatformKey (staff). */
export async function cancelPlatformKey(db: HotDb, w: Writer, i: { orgId: string; keyId: string }) {
  expectReplay(w, ['platform.key_cancelled']);
  if (w.actor.kind !== 'member' && w.actor.kind !== 'hana') return refuse('forbidden', 'Only an owner or Journear staff cancel a platform key');
  const { key } = await planKey(db, w, i.keyId, i.orgId);
  if (!key) return refuse('not_found', 'No such platform key in this organisation');
  if (!isWaiting(key, w.now)) refuse('not_pending', key.status === 'pending' || key.status === 'active' ? 'This key is in force: stop it instead' : `This key is ${key.status}`);
  await runWrite(db, w, cancelStatements(w, key, raw('1'), 'cancelled', w.actor.kind, actorId(w.actor)));
  return { key: await getPlatformKey(db, i.orgId, key.id, w.now, w.actor.kind === 'hana') };
}

/** The emailed links' token against the stored sha256 (constant time); a malformed token is refused like a wrong one. */
async function linkMatches(token: string, storedHex: string | null): Promise<{ ok: boolean; hashHex: string }> {
  let presented: Uint8Array;
  try {
    presented = await sha256(fromB64url(token));
  } catch {
    return { ok: false, hashHex: '' };
  }
  const hashHex = hex(presented).toUpperCase();
  if (storedHex === null || storedHex.length !== 64) return { ok: false, hashHex };
  const stored = new Uint8Array(32);
  for (let k = 0; k < 32; k++) stored[k] = Number.parseInt(storedHex.slice(2 * k, 2 * k + 2), 16);
  return { ok: bytesEqual(presented, stored), hashHex };
}

/** ConsoleRpc.cancelPlatformKeyByLink: the announcement's cancel link, while the key waits (the `link` actor). */
export async function cancelPlatformKeyByLink(db: HotDb, w: Writer, i: { keyId: string; token: string }) {
  expectReplay(w, ['platform.key_cancelled'], undefined, { kind: 'link', id: i.keyId });
  const { key } = await planKey(db, w, i.keyId, null);
  const m = await linkMatches(i.token, key?.cancel_hash_hex ?? null);
  if (!key || !m.ok) return refuse('forbidden', 'This cancel link is not valid for this key');
  if (!isWaiting(key, w.now)) refuse('not_pending', key.status === 'pending' || key.status === 'active' ? 'This key is already in force' : `This key is ${key.status}`);
  await runWrite(db, w, cancelStatements(w, key, q`hex(k.cancel_token_hash) = ${m.hashHex}`, 'cancelled', 'link', 'link', { kind: 'link', id: key.id }));
  return { key: { id: key.id, label: key.label, state: 'cancelled' as const } };
}

// ---- revocation, and what it cancels ----

/**
 * Cancels, in the caller's batch and only if it committed, every waiting `origin_add` the platform proposed that
 * `whose` names (one key's, or any key of the org), on the org's apps: one `change.cancelled` row listing them (request
 * id `<request id>:cancelled`, the actor the caller's, its `reason`), each app's origins version bumped, each change's
 * origin row removed, each change cancelled (A3, D917). An origin already in force stays.
 */
export function cancelPlatformProposals(w: Writer, i: { orgId: string; keyId: string | null; reason: PlatformCancelReason; ledgerActor?: { kind: string; id: string } }): Q[] {
  const now = w.now;
  const whose = i.keyId === null ? raw('1') : q`g.proposed_by = ${i.keyId}`;
  const waiting = q`g.kind = 'origin_add' AND g.proposed_by_kind = 'platform' AND g.status = 'pending' AND (g.active_from IS NULL OR g.active_from > ${now})
    AND g.app_id IN (SELECT id FROM apps WHERE org_id = ${i.orgId}) AND ${whose}`;
  const when = committed(w.requestId);
  const actor = i.ledgerActor ?? { kind: w.actor.kind, id: actorId(w.actor) };
  const sub = i.ledgerActor ? null : (w.sub ?? null);
  return [
    q`INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, actor_sub, request_id)
      SELECT ${now}, ${i.orgId}, NULL, NULL, 'change.cancelled',
             json_object('reason', ${i.reason}, 'keyId', ${i.keyId}, 'by', ${actor.kind},
                         'changes', (SELECT json_group_array(json_object('changeId', g.id, 'appId', g.app_id, 'origin', g.origin)) FROM guarded_changes g WHERE ${waiting})),
             ${actor.kind}, ${actor.id}, ${sub}, ${`${w.requestId}:cancelled`}
       WHERE ${when} AND EXISTS (SELECT 1 FROM guarded_changes g WHERE ${waiting})`,
    q`UPDATE apps SET origins_version = origins_version + 1 WHERE id IN (SELECT g.app_id FROM guarded_changes g WHERE ${waiting}) AND ${when}`,
    q`DELETE FROM app_origins WHERE change_id IN (SELECT g.id FROM guarded_changes g WHERE ${waiting}) AND (active_from IS NULL OR active_from > ${now}) AND ${when}`,
    q`UPDATE guarded_changes SET status = 'cancelled', cancelled_by = ${actor.kind === 'link' ? 'link' : actor.id}, cancelled_at = ${now} WHERE id IN (SELECT g.id FROM guarded_changes g WHERE ${waiting}) AND ${when}`,
  ];
}

type Revoker = 'member' | 'hana' | 'link' | 'platform';

/** The revocation's batch: the ledger row, the key revoked, and what it proposed that still waits cancelled. */
function revokeStatements(w: Writer, key: PlatformKeyRow, by: Revoker, reason: string | null, extra: Q): Q[] {
  const ledgerActor = by === 'link' ? { kind: 'link' as const, id: key.id } : undefined;
  const cw: Writer = ledgerActor ? { ...w, actor: ledgerActor, sub: undefined } : w;
  const revokedBy = by === 'link' ? 'link' : actorId(w.actor);
  return [
    commitOn(
      cw,
      { kind: 'platform.key_revoked', detail: { keyId: key.id, label: key.label, by, reason, wasInForce: key.active_from !== null && key.active_from <= w.now } },
      { orgId: key.org_id },
      q`EXISTS (SELECT 1 FROM platform_keys k WHERE k.id = ${key.id} AND k.status IN ('awaiting_acceptance', 'pending', 'active') AND k.revoked_at IS NULL AND ${extra})`,
    ),
    q`UPDATE platform_keys SET status = 'revoked', revoked_at = ${w.now}, revoked_by_kind = ${by}, revoked_by = ${revokedBy}, revoke_reason = ${reason}, end_request_id = ${w.requestId}
       WHERE id = ${key.id} AND status IN ('awaiting_acceptance', 'pending', 'active') AND ${committed(w.requestId)}`,
    ...cancelPlatformProposals(w, { orgId: key.org_id, keyId: key.id, reason: 'key_revoked', ...(ledgerActor ? { ledgerActor } : {}) }),
  ];
}

const revocable = (k: PlatformKeyRow): boolean => k.status === 'awaiting_acceptance' || k.status === 'pending' || k.status === 'active';

/**
 * Revocation, immediate, whatever the key's state (A3): an owner (ConsoleRpc.revokePlatformKey, a kill switch: no
 * fresh sign-in, allowed while the org is frozen), staff (AdminRpc.revokePlatformKey, with a reason), and the key itself
 * (`platform`, its own id only: piece P3's `POST /v1/platform/credential/revoke`, allowed while the switch is off).
 */
export async function revokePlatformKey(db: HotDb, w: Writer, i: { orgId: string; keyId: string; reason?: string | undefined }) {
  expectReplay(w, ['platform.key_revoked']);
  const kind = w.actor.kind as Actor['kind'] | 'platform';
  if (kind !== 'member' && kind !== 'hana' && kind !== 'platform') return refuse('forbidden', 'Only an owner, Journear staff or the key itself stop a platform key');
  if (kind === 'platform' && w.actor.id !== i.keyId) return refuse('not_found', 'No such platform key in this organisation');
  const { key } = await planKey(db, w, i.keyId, i.orgId);
  if (!key) return refuse('not_found', 'No such platform key in this organisation');
  if (!revocable(key)) refuse('conflict', `This key is already ${key.status}`);
  const reason = i.reason?.trim() ? i.reason.trim() : null;
  await runWrite(db, w, revokeStatements(w, key, kind, reason, raw('1')));
  return { key: await getPlatformKey(db, i.orgId, key.id, w.now, kind === 'hana') };
}

/**
 * ConsoleRpc.revokePlatformKeyByLink (A3, proposed): the confirmation notice's one-click link (for a key an owner
 * confirmed, or a staff key an owner accepted), valid 7 days, single use (a revoked key is not revoked again). The
 * `link` actor.
 */
export async function revokePlatformKeyByLink(db: HotDb, w: Writer, i: { keyId: string; token: string }) {
  expectReplay(w, ['platform.key_revoked'], undefined, { kind: 'link', id: i.keyId });
  const { key } = await planKey(db, w, i.keyId, null);
  const m = await linkMatches(i.token, key?.revoke_hash_hex ?? null);
  if (!key || !m.ok) return refuse('forbidden', 'This link is not valid for this key');
  if (key.revoke_link_until === null || key.revoke_link_until <= w.now) refuse('forbidden', 'This link has expired: an owner can stop the key in the partner portal');
  if (!revocable(key)) refuse('conflict', `This key is already ${key.status}`);
  await runWrite(db, w, revokeStatements(w, key, 'link', 'Stopped from the emailed link', q`hex(k.revoke_link_hash) = ${m.hashHex} AND k.revoke_link_until > ${w.now}`));
  return { key: { id: key.id, label: key.label, state: 'revoked' as const } };
}

// ---- the org's switch, and the freeze mirror ----

/** The org's waiting keys cancelled in the caller's batch (switch-off, freeze), only if it committed. */
function cancelWaitingKeys(w: Writer, orgId: string, reason: 'platform_off' | 'org_frozen'): Q {
  return q`UPDATE platform_keys SET status = 'cancelled', cancelled_at = ${w.now}, cancelled_by_kind = ${w.actor.kind}, cancelled_by = ${actorId(w.actor)}, cancel_reason = ${reason}
            WHERE org_id = ${orgId} AND (status = 'awaiting_acceptance' OR (status = 'pending' AND (active_from IS NULL OR active_from > ${w.now}))) AND ${committed(w.requestId)}`;
}

const WAITING_KEYS_JSON = (orgId: string, now: number): Q =>
  q`(SELECT json_group_array(id) FROM (SELECT id FROM platform_keys k WHERE k.org_id = ${orgId} AND ${KEY_WAITING('k', now)} ORDER BY id))`;
/** The keys a switch-on must name (L5): every key of the org in force, waiting or awaiting acceptance, sorted. */
const REVIEW_KEYS_JSON = (orgId: string, now: number): Q =>
  q`(SELECT json_group_array(id) FROM (SELECT id FROM platform_keys k WHERE k.org_id = ${orgId} AND ${KEY_COUNTS('k', now)} ORDER BY id))`;

/**
 * The org's switch row written in the caller's batch, only if it committed: inserted when missing (never with the switch
 * on: the table's insert trigger refuses it, and an existing row is never replaced), then updated. The switch-on carries
 * its review, which the table's trigger wants to be exactly the org's current keys.
 */
const writeOrg = (w: Writer, orgId: string, set: { enabled?: 0 | 1; frozen?: 0 | 1; review?: string | null }): Q[] => [
  q`INSERT INTO platform_orgs (org_id, enabled, frozen, set_by, set_at, version)
      SELECT ${orgId}, 0, 0, ${actorId(w.actor)}, ${w.now}, 0 WHERE ${committed(w.requestId)} AND NOT EXISTS (SELECT 1 FROM platform_orgs WHERE org_id = ${orgId})`,
  q`UPDATE platform_orgs SET ${raw(set.enabled !== undefined ? `enabled = ${set.enabled}, ` : '')}${raw(set.frozen !== undefined ? `frozen = ${set.frozen}, ` : '')}${
    set.frozen === 1 ? q`frozen_at = ${w.now}, ` : raw('')
  }${
    set.review !== undefined ? q`review_json = ${set.review}, ` : raw('')
  }set_by = ${actorId(w.actor)}, set_at = ${w.now}, version = version + 1 WHERE org_id = ${orgId} AND ${committed(w.requestId)}`,
];

/**
 * AdminRpc.setPlatformOrg (A3, L5): staff's switch. Off: at once, and in the same batch the org's waiting keys and
 * every waiting web address the platform proposed for its apps are cancelled. On: only with `reviewedKeys` naming every
 * key of the org in force, waiting or awaiting acceptance (staff confirmed each, or revoked it first), checked again in
 * the commit predicate; refused while the org is frozen.
 */
export async function setPlatformOrg(db: HotDb, w: Writer, i: { orgId: string; enabled: boolean; reason: string; reviewedKeys?: readonly string[] | undefined }) {
  expectReplay(w, ['platform.org_switch']);
  if (w.actor.kind !== 'hana') return refuse('forbidden', 'Only Journear staff switch the platform');
  const p = await db.first<{ replay: string | null; enabled: number | null; frozen: number | null; review: string; waiting: string }>(
    q`SELECT ${replayRow(w.requestId)} AS replay, po.enabled, po.frozen, ${REVIEW_KEYS_JSON(i.orgId, w.now)} AS review, ${WAITING_KEYS_JSON(i.orgId, w.now)} AS waiting
        FROM (SELECT 1) LEFT JOIN platform_orgs po ON po.org_id = ${i.orgId}`,
  );
  refuseReplay(p?.replay, w);
  const review = JSON.parse(p?.review ?? '[]') as string[];
  const reason = i.reason.trim();
  if (i.enabled) {
    if (p?.frozen === 1) refuse('conflict', 'The organisation is frozen: unfreeze it first');
    if (p?.enabled === 1) return { changed: false, platform: (await listPlatformKeys(db, i.orgId, w.now, true)).platform };
    const reviewed = [...new Set(i.reviewedKeys ?? [])].sort();
    if (JSON.stringify(reviewed) !== JSON.stringify(review)) refuse('conflict', `Review every key of the organisation first: confirm each one still in force or waiting, or stop it (${review.length} to review)`);
    await runWrite(db, w, [
      commitOn(
        w,
        { kind: 'platform.org_switch', detail: { enabled: true, reason, reviewedKeys: reviewed } },
        { orgId: i.orgId },
        q`NOT EXISTS (SELECT 1 FROM platform_orgs WHERE org_id = ${i.orgId} AND (enabled = 1 OR frozen = 1)) AND ${REVIEW_KEYS_JSON(i.orgId, w.now)} = ${JSON.stringify(reviewed)}`,
      ),
      ...writeOrg(w, i.orgId, { enabled: 1, review: JSON.stringify(reviewed) }),
    ]);
  } else {
    await runWrite(db, w, [
      commitOn(w, { kind: 'platform.org_switch', detail: q`json_object('enabled', json('false'), 'reason', ${reason}, 'cancelledKeys', json(${WAITING_KEYS_JSON(i.orgId, w.now)}))` }, { orgId: i.orgId }, raw('1')),
      cancelWaitingKeys(w, i.orgId, 'platform_off'),
      ...cancelPlatformProposals(w, { orgId: i.orgId, keyId: null, reason: 'platform_off' }),
      ...writeOrg(w, i.orgId, { enabled: 0, review: null }),
    ]);
  }
  return { changed: true, platform: (await listPlatformKeys(db, i.orgId, w.now, true)).platform };
}

/**
 * AdminRpc.setPlatformOrgFrozen: the admin Worker mirrors the console's freeze (and unfreeze) of an org. A freeze, in
 * one batch: `frozen` set, the org's waiting keys and the platform's waiting web addresses for its apps cancelled
 * (D917). Its keys in force stay (only the kill switches work for a frozen org); unfreezing changes nothing else.
 */
export async function setPlatformOrgFrozen(db: HotDb, w: Writer, i: { orgId: string; frozen: boolean; expectedVersion?: number | undefined }) {
  expectReplay(w, ['platform.org_frozen']);
  if (w.actor.kind !== 'hana' && w.actor.kind !== 'system') return refuse('forbidden', 'Only Journear staff (or the admin Worker’s mirror) freeze an organisation');
  const p = await db.first<{ replay: string | null; frozen: number | null; frozen_at: number | null; version: number | null; waiting: string; proposals: number }>(
    q`SELECT ${replayRow(w.requestId)} AS replay, po.frozen, po.frozen_at, po.version, ${WAITING_KEYS_JSON(i.orgId, w.now)} AS waiting,
             (SELECT COUNT(*) FROM guarded_changes g WHERE g.kind = 'origin_add' AND g.proposed_by_kind = 'platform' AND g.status = 'pending' AND (g.active_from IS NULL OR g.active_from > ${w.now})
                AND g.app_id IN (SELECT id FROM apps WHERE org_id = ${i.orgId})) AS proposals
        FROM (SELECT 1) LEFT JOIN platform_orgs po ON po.org_id = ${i.orgId}`,
  );
  refuseReplay(p?.replay, w);
  const waiting = JSON.parse(p?.waiting ?? '[]') as string[];
  // A freeze always writes (its `frozen_at`, even on a row already frozen: the grace runs from the latest freeze). An
  // unfreeze follows the mirror's one rule (console-core `mirrorUnfreeze`), in the plan and in the commit predicate.
  let guard: Q = raw('1');
  if (!i.frozen) {
    const rule = mirrorUnfreeze(p?.frozen === 1 ? { frozen: true, frozenAt: p.frozen_at } : null, w.now);
    if (rule === 'not_frozen') return { changed: false };
    if (rule === 'too_soon') refuse('conflict', 'The organisation’s platform keys were frozen less than 10 minutes ago: they stay frozen until the hourly check');
    guard = q`COALESCE((SELECT frozen_at FROM platform_orgs WHERE org_id = ${i.orgId}), 0) <= ${w.now - PLATFORM_UNFREEZE_GRACE_MS}`;
  }
  // A compare-and-swap on the row's version when asked (the hourly check's unfreeze: any write since its read wins).
  if (i.expectedVersion !== undefined && (p?.version ?? 0) !== i.expectedVersion) refuse('version_conflict', 'The organisation’s platform row changed since it was read');
  const cas = i.expectedVersion === undefined ? guard : q`${guard} AND COALESCE((SELECT version FROM platform_orgs WHERE org_id = ${i.orgId}), 0) = ${i.expectedVersion}`;
  const stmts: Q[] = [
    commitOn(w, { kind: 'platform.org_frozen', detail: { frozen: i.frozen, ...(i.frozen ? { cancelledKeys: waiting } : {}) } }, { orgId: i.orgId }, cas),
  ];
  if (i.frozen) stmts.push(cancelWaitingKeys(w, i.orgId, 'org_frozen'), ...cancelPlatformProposals(w, { orgId: i.orgId, keyId: null, reason: 'org_frozen' }));
  stmts.push(...writeOrg(w, i.orgId, { frozen: i.frozen ? 1 : 0 }));
  await runWrite(db, w, stmts);
  return { changed: (p?.frozen ?? 0) !== (i.frozen ? 1 : 0) || waiting.length > 0 || (p?.proposals ?? 0) > 0 };
}

/** AdminRpc.platformOrgs: the orgs with a switch row, in id order from after `cursor`, `next` while more remain (the admin Worker's freeze check pages through them all). */
export async function platformOrgs(db: HotDb, limit: number, cursor?: string): Promise<{ orgs: { orgId: string; enabled: boolean; frozen: boolean; version: number }[]; next?: string }> {
  const rows = await db.all<{ org_id: string; enabled: number; frozen: number; version: number }>(q`SELECT org_id, enabled, frozen, version FROM platform_orgs WHERE org_id > ${cursor ?? ''} ORDER BY org_id LIMIT ${limit + 1}`);
  const page = rows.slice(0, limit);
  return { orgs: page.map((r) => ({ orgId: r.org_id, enabled: r.enabled === 1, frozen: r.frozen === 1, version: r.version })), ...(rows.length > limit ? { next: page[page.length - 1]!.org_id } : {}) };
}

// ---- notices ----

const CONTACTS = (k: string): Q => raw(`(SELECT json_group_array(email) FROM (SELECT email FROM org_security_contacts WHERE org_id = ${k}.org_id ORDER BY email))`);

/**
 * AdminRpc.platformKeyNotices: what the admin Worker emails, oldest first, each with its org's security contacts (the
 * Worker adds every owner of the org and the alias): a key to announce; a key an owner confirmed (its revoke link); a
 * key revoked or expired after its announcement (what it cancelled, and the org's keys still waiting); a key in force
 * whose expiry is 30 or 7 days away. Staff identities are in it (the email names who registered and accepted).
 */
export async function platformKeyNotices(db: HotDb, env: Env, limit: number, now: number): Promise<PlatformKeyNotice[]> {
  const rows = await db.all<PlatformKeyRow & { notice: PlatformKeyNotice['kind']; contacts: string; cancelled_json: string | null; waiting_json: string }>(
    q`SELECT * FROM (
        SELECT 'announce' AS notice, ${PLATFORM_KEY_COLUMNS('k')}, ${CONTACTS('k')} AS contacts, NULL AS cancelled_json, '[]' AS waiting_json, k.proposed_at AS t
          FROM platform_keys k WHERE k.status = 'pending' AND k.notified_at IS NULL AND NOT ${CONTACTS_CHANGED_K('k', now)}
        UNION ALL
        SELECT 'confirmed', ${PLATFORM_KEY_COLUMNS('k')}, ${CONTACTS('k')}, NULL, '[]', k.confirmed_at
          FROM platform_keys k WHERE k.confirmed_kind = 'confirm' AND k.confirm_notified_at IS NULL AND k.status = 'active'
        UNION ALL
        SELECT 'ended', ${PLATFORM_KEY_COLUMNS('k')}, ${CONTACTS('k')},
               (SELECT json_extract(c.detail_json, '$.changes') FROM app_changes c WHERE c.request_id = k.end_request_id || ':cancelled'),
               (SELECT json_group_array(json_object('id', o.id, 'label', o.label, 'announced', json(CASE WHEN o.cancel_token_hash IS NOT NULL THEN 'true' ELSE 'false' END))) FROM platform_keys o WHERE o.org_id = k.org_id AND o.id != k.id AND ${KEY_WAITING('o', now)}),
               COALESCE(k.revoked_at, k.expires_at)
          FROM platform_keys k WHERE k.status IN ('revoked', 'expired') AND k.end_notified_at IS NULL AND k.notified_at IS NOT NULL
        UNION ALL
        SELECT 'expiring', ${PLATFORM_KEY_COLUMNS('k')}, ${CONTACTS('k')}, NULL, '[]', k.expires_at
          FROM platform_keys k WHERE ${KEY_IN_FORCE('k', now)}
           AND ((k.expires_at - ${now} <= ${7 * 86_400_000} AND k.expiry_notice_stage != 7) OR (k.expires_at - ${now} <= ${30 * 86_400_000} AND k.expiry_notice_stage = 0))
      )
      -- A notice whose sends failed waits longer after each failure (5 min times the failures, at most an hour) and comes
      -- after every other, so one recipient that always refuses can't hold the page back (D918 after PR 149's review).
      WHERE notice_failed_at IS NULL OR notice_failed_at <= ${now} - MIN(notice_failures, 12) * 300000
      ORDER BY notice_failures > 0, t, id LIMIT ${limit}`,
  );
  const appNames = new Map<string, string>();
  const cancelledIds = rows.flatMap((r) => (r.cancelled_json ? (JSON.parse(r.cancelled_json) as { appId: string }[]).map((c) => c.appId) : []));
  if (cancelledIds.length) {
    for (const a of await db.all<{ id: string; name: string }>(q`SELECT id, name FROM apps WHERE id IN (SELECT value FROM json_each(${JSON.stringify([...new Set(cancelledIds)])}))`)) appNames.set(a.id, a.name);
  }
  return rows.map((r) => {
    const n: PlatformKeyNotice = { kind: r.notice, key: platformKeyView(r, now, true), contacts: JSON.parse(r.contacts) as string[], failures: r.notice_failures };
    if (r.notice === 'announce') {
      n.inForceAtOnce = r.confirmed_kind === 'acceptance';
      n.waitMs = Math.max(keyDelayMs(env), r.min_delay_ms);
    }
    if (r.notice === 'expiring') n.stage = r.expires_at! - now <= 7 * 86_400_000 ? 7 : 30;
    if (r.notice === 'ended') {
      n.cancelledOrigins = (r.cancelled_json ? (JSON.parse(r.cancelled_json) as { appId: string; origin: string }[]) : []).map((c) => ({ appId: c.appId, appName: appNames.get(c.appId) ?? c.appId, origin: c.origin }));
      n.waitingKeys = JSON.parse(r.waiting_json) as { id: string; label: string; announced: boolean }[];
    }
    return n;
  });
}

const hashBlob = (b64: string): ArrayBuffer => {
  const b = fromB64url(b64);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

/**
 * AdminRpc.ackPlatformKeyNotice (`system` only): every recipient accepted the announcement. Starts the key's wait:
 * `unconfirmed_active_from` = now + the greater of the env's delay, the platform minimum and the key's own stored wait;
 * in force then unless confirmed. A staff key an owner accepted (`confirmed_kind = 'acceptance'`) is in force now: its
 * email carried the revoke link (`revokeTokenHash`, required then), stored here for 7 days.
 */
export async function ackPlatformKeyNotice(db: HotDb, env: Env, w: Writer, i: { keyId: string; cancelTokenHash: string; revokeTokenHash?: string | undefined }) {
  expectReplay(w, ['platform.key_announced']);
  const { plan, key } = await planKey(db, w, i.keyId, null);
  if (!key) return refuse('not_found', 'No such platform key');
  if (key.status !== 'pending' || key.notified_at !== null) refuse('not_pending', key.status === 'pending' ? 'The key is already announced' : `The key is ${key.status}`);
  // Held within 7 days of a security-contact change, as the registration is: a contact removed in between would never
  // hear of the key (the notice page leaves it out meanwhile, so nothing is mailed twice).
  if (plan.contacts_changed) refuse('conflict', PLATFORM_KEY_WORDS.contactWait);
  const atOnce = key.confirmed_kind === 'acceptance';
  if (atOnce && !i.revokeTokenHash) refuse('bad_request', 'A key in force at once needs its revoke link in the announcement');
  const unconfirmed = w.now + Math.max(keyDelayMs(env), key.min_delay_ms);
  const activeFrom = atOnce ? w.now : unconfirmed;
  await runWrite(db, w, [
    commitOn(
      w,
      { kind: 'platform.key_announced', detail: { keyId: key.id, activeFrom, unconfirmedActiveFrom: unconfirmed, inForceAtOnce: atOnce, channel: 'email' } },
      { orgId: key.org_id },
      q`EXISTS (SELECT 1 FROM platform_keys WHERE id = ${key.id} AND status = 'pending' AND notified_at IS NULL AND confirmed_kind IS ${key.confirmed_kind})
        AND NOT ${CONTACTS_CHANGED(key.org_id, w.now)}`,
    ),
    q`UPDATE platform_keys SET notice_failures = 0, notice_failed_at = NULL, notified_at = ${w.now}, unconfirmed_active_from = ${unconfirmed}, active_from = ${activeFrom}, expires_at = ${activeFrom + PLATFORM_KEY_LIFETIME_MS},
             cancel_token_hash = ${hashBlob(i.cancelTokenHash)}
             ${atOnce ? q`, status = 'active', activated_recorded_at = ${w.now}, revoke_link_hash = ${hashBlob(i.revokeTokenHash!)}, revoke_link_until = ${w.now + PLATFORM_KEY_REVOKE_LINK_MS}, confirm_notified_at = ${w.now}` : raw('')}
       WHERE id = ${key.id} AND status = 'pending' AND notified_at IS NULL AND ${committed(w.requestId)}`,
  ]);
  return { key: platformKeyView({ ...key, notified_at: w.now, unconfirmed_active_from: unconfirmed, active_from: activeFrom, expires_at: activeFrom + PLATFORM_KEY_LIFETIME_MS, status: atOnce ? 'active' : 'pending' }, w.now, true) };
}

/** A notice's ack that changes only when it was sent (no ledger row: the key's state doesn't change). True if it applied. */
async function markSent(db: HotDb, sql: Q): Promise<boolean> {
  const [r] = await db.batch([sql]);
  return (r?.meta.changes ?? 0) === 1;
}

/** AdminRpc.ackPlatformKeyConfirmNotice (`system`): the notice of an owner's confirmation went out with its revoke link (7 days). */
export async function ackPlatformKeyConfirmNotice(db: HotDb, w: Writer, i: { keyId: string; revokeTokenHash: string }) {
  const ok = await markSent(
    db,
    q`UPDATE platform_keys SET notice_failures = 0, notice_failed_at = NULL, confirm_notified_at = ${w.now}, revoke_link_hash = ${hashBlob(i.revokeTokenHash)}, revoke_link_until = ${w.now + PLATFORM_KEY_REVOKE_LINK_MS}
       WHERE id = ${i.keyId} AND confirmed_kind = 'confirm' AND confirm_notified_at IS NULL AND revoke_link_hash IS NULL`,
  );
  if (!ok) refuse('not_pending', 'No confirmation of this key is waiting for its notice');
  return {};
}

/** AdminRpc.ackPlatformKeyEndNotice (`system`): the notice that a key stopped (revoked or expired) went out. */
export async function ackPlatformKeyEndNotice(db: HotDb, w: Writer, i: { keyId: string }) {
  const ok = await markSent(db, q`UPDATE platform_keys SET notice_failures = 0, notice_failed_at = NULL, end_notified_at = ${w.now} WHERE id = ${i.keyId} AND status IN ('revoked', 'expired') AND end_notified_at IS NULL`);
  if (!ok) refuse('not_pending', 'No end of this key is waiting for its notice');
  return {};
}

/** AdminRpc.ackPlatformKeyExpiryNotice (`system`): the 30- or 7-day warning went out (a stage is never sent twice, nor the 30 after the 7). */
export async function ackPlatformKeyExpiryNotice(db: HotDb, w: Writer, i: { keyId: string; stage: 30 | 7 }) {
  const from = i.stage === 30 ? q`expiry_notice_stage = 0` : q`expiry_notice_stage IN (0, 30)`;
  const ok = await markSent(db, q`UPDATE platform_keys SET notice_failures = 0, notice_failed_at = NULL, expiry_notice_stage = ${i.stage} WHERE id = ${i.keyId} AND ${from} AND status IN ('pending', 'active')`);
  if (!ok) refuse('not_pending', 'This warning was already sent');
  return {};
}

/**
 * AdminRpc.notePlatformKeyNoticeFailure (`system`): a notice's sends failed (a recipient refused). The page then retries
 * it later and after every other notice; answers how many times in a row it failed, so the admin Worker reports a stuck
 * one. Nothing about the key's state changes.
 */
export async function notePlatformKeyNoticeFailure(db: HotDb, w: Writer, i: { keyId: string }): Promise<{ failures: number }> {
  const [r] = await db.batch([q`UPDATE platform_keys SET notice_failures = notice_failures + 1, notice_failed_at = ${w.now} WHERE id = ${i.keyId} RETURNING notice_failures`]);
  const row = (r?.results?.[0] ?? null) as { notice_failures: number } | null;
  if (!row) return refuse('not_found', 'No such platform key');
  return { failures: row.notice_failures };
}
