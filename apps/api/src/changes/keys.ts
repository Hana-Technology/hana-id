// Publishable keys (docs/batch-c-spec.md "Keys"): `pk_test_`/`pk_live_` + base58(24 random bytes), the prefix the
// scope's environment (the app_keys insert trigger checks it too). Rotate issues a new key and gives the old one
// `revoked_at = now + 24 h` (the fixed grace). Revoke sets `revoked_at = now` and may revoke the last key (a kill
// switch): the gate, GET /v1/app, the relays and new vault page loads answer 401 unknown_app at once; the vault
// endpoints (unlock, touch, revoke, share creation) cache the app per isolate and see it within 30 s (app-cache.ts,
// D78, D208). No step-up: keys are public and origins gate them.
//
// Two counts, on purpose (D227): the 5-key limit counts keys with `revoked_at` NULL (a rotating key is already
// revoked, so rotation never hits the limit), while "the last valid key" and what revoke accepts count keys still
// valid now (`revoked_at` NULL or in the future: a rotating key still logs users in).
//
// The legacy column `apps.publishable_key` (never read by the API) is kept pointing at a key that is valid with no end
// in sight: the app's oldest key with `revoked_at` NULL (by creation, then insertion), or, when it has none, a tombstone no client can send. Readers
// that still find apps by that column (apps/email-issuer on feat/email-login-4, D206) then never accept a revoked,
// rotating or deleted app's key; they refuse a rotating key at once instead of after the grace (D225).
import { type Environment, base58, newId, newPublishableKey, randomBytes } from '@hana-id/console-core';
import { planApp } from './apps.ts';
import { type Writer, actorId, commitOnApp, committed, refuse, runWrite, expectReplay } from './cas.ts';
import type { HotDb } from './db.ts';
import { type Q, q } from './sql.ts';
import { type KeyRow, keyView } from './views.ts';

export const MAX_UNREVOKED_KEYS = 5;
export const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * A value for `apps.publishable_key` that is no key: the scope's prefix (so the 0006 triggers, which compare the prefix
 * when a scope moves org, accept it) followed by `0` (not in base58: no generated key and no PUBLISHABLE_KEY_RE match)
 * and random base58 (unique, unguessable).
 */
export const legacyKeyTombstone = (environment: Environment): string => `pk_${environment}_0revoked${base58(randomBytes(16))}`;

/** Points `apps.publishable_key` at the oldest key with no revocation, or a tombstone. Writes the column, never reads it. */
export function syncLegacyKey(appId: string, environment: Environment, requestId: string): Q {
  return q`UPDATE apps SET publishable_key = COALESCE(
             (SELECT key FROM app_keys WHERE app_id = ${appId} AND revoked_at IS NULL ORDER BY created_at, rowid LIMIT 1), ${legacyKeyTombstone(environment)})
            WHERE id = ${appId} AND ${committed(requestId)}`;
}

const unrevoked = (now: number) => (k: KeyRow) => k.revoked_at === null || k.revoked_at > now;

function newKeyRow(appId: string, environment: Environment, w: Writer): KeyRow {
  return { id: newId('key'), app_id: appId, key: newPublishableKey(environment), created_by: actorId(w.actor), created_at: w.now, revoked_at: null };
}

const insertKey = (k: KeyRow, requestId: string): Q =>
  q`INSERT INTO app_keys (id, app_id, key, created_by, created_at) SELECT ${k.id}, ${k.app_id}, ${k.key}, ${k.created_by}, ${k.created_at} WHERE ${committed(requestId)}`;

export async function createKey(db: HotDb, w: Writer, i: { orgId: string | null; appId: string }) {
  expectReplay(w, ['key.created']);
  const plan = await planApp(db, { appId: i.appId, orgId: i.orgId, w, with: { keys: true } });
  if (plan.keys.filter((k) => k.revoked_at === null).length >= MAX_UNREVOKED_KEYS) refuse('key_limit', `At most ${MAX_UNREVOKED_KEYS} unrevoked keys per app: revoke one first`);
  const k = newKeyRow(i.appId, plan.app.environment, w);
  await runWrite(db, w, [
    commitOnApp(
      w,
      { kind: 'key.created', detail: { keyId: k.id, prefix: `pk_${plan.app.environment}_` } },
      i.appId,
      i.orgId,
      q`a.deleted_at IS NULL AND (SELECT COUNT(*) FROM app_keys WHERE app_id = a.id AND revoked_at IS NULL) < ${MAX_UNREVOKED_KEYS}`,
    ),
    insertKey(k, w.requestId),
    syncLegacyKey(i.appId, plan.app.environment, w.requestId),
  ]);
  return { key: keyView(k) };
}

/** Rotate: a new key, and the old one (unrevoked) revoked at now + 24 h. The old key keeps working for exactly the grace. */
export async function rotateKey(db: HotDb, w: Writer, i: { orgId: string | null; appId: string; keyId: string }) {
  expectReplay(w, ['key.rotated']);
  const plan = await planApp(db, { appId: i.appId, orgId: i.orgId, w, with: { keys: true } });
  const old = plan.keys.find((k) => k.id === i.keyId);
  if (!old) return refuse('not_found', 'No such key');
  if (old.revoked_at !== null) refuse('conflict', old.revoked_at > w.now ? 'The key is already being rotated' : 'The key is revoked');
  const k = newKeyRow(i.appId, plan.app.environment, w);
  const revokedAt = w.now + ROTATION_GRACE_MS;
  await runWrite(db, w, [
    commitOnApp(
      w,
      { kind: 'key.rotated', detail: { keyId: old.id, newKeyId: k.id, oldKeyRevokedAt: revokedAt } },
      i.appId,
      i.orgId,
      q`a.deleted_at IS NULL AND EXISTS (SELECT 1 FROM app_keys WHERE id = ${old.id} AND app_id = a.id AND revoked_at IS NULL)`,
    ),
    q`UPDATE app_keys SET revoked_at = ${revokedAt}, revoked_by = ${actorId(w.actor)} WHERE id = ${old.id} AND app_id = ${i.appId} AND revoked_at IS NULL AND ${committed(w.requestId)}`,
    insertKey(k, w.requestId),
    syncLegacyKey(i.appId, plan.app.environment, w.requestId),
  ]);
  return { key: keyView(k), oldKeyRevokedAt: revokedAt };
}

/** Revoke: immediate, also for a key in its rotation grace. Revoking the last valid key is allowed and warned about. */
export async function revokeKey(db: HotDb, w: Writer, i: { orgId: string | null; appId: string; keyId: string }) {
  expectReplay(w, ['key.revoked']);
  const plan = await planApp(db, { appId: i.appId, orgId: i.orgId, w, with: { keys: true } });
  const key = plan.keys.find((k) => k.id === i.keyId);
  if (!key) return refuse('not_found', 'No such key');
  if (!unrevoked(w.now)(key)) refuse('conflict', 'The key is already revoked');
  const last = plan.keys.filter(unrevoked(w.now)).length === 1;
  await runWrite(db, w, [
    commitOnApp(
      w,
      { kind: 'key.revoked', detail: { keyId: key.id, lastKey: last } },
      i.appId,
      i.orgId,
      q`a.deleted_at IS NULL AND EXISTS (SELECT 1 FROM app_keys WHERE id = ${key.id} AND app_id = a.id AND (revoked_at IS NULL OR revoked_at > ${w.now}))`,
    ),
    q`UPDATE app_keys SET revoked_at = ${w.now}, revoked_by = ${actorId(w.actor)} WHERE id = ${key.id} AND app_id = ${i.appId} AND (revoked_at IS NULL OR revoked_at > ${w.now}) AND ${committed(w.requestId)}`,
    syncLegacyKey(i.appId, plan.app.environment, w.requestId),
  ]);
  return last ? { warning: 'last_key' as const } : {};
}
