import { describe, expect, it } from 'vitest';
import {
  actor,
  appDetail,
  b64url,
  base58,
  CONSOLE_ERROR_STATUS,
  day,
  errorBody,
  fromB64url,
  guardedChange,
  isId,
  LEGACY_ORG_ID,
  newId,
  newPublishableKey,
  publishableKeyEnvironment,
  RPC_CODES,
  RPC_HTTP_STATUS,
  rpcResult,
  u64le,
  usageEventV1,
  type UsageEventV1,
} from '../src/index.ts';
import { z } from 'zod';

describe('RpcCode → HTTP', () => {
  it('maps every code, and console-only codes don’t shadow RPC codes except rate_limited (same status)', () => {
    expect(Object.keys(RPC_HTTP_STATUS).sort()).toEqual([...RPC_CODES].sort());
    for (const code of Object.keys(CONSOLE_ERROR_STATUS)) {
      if ((RPC_CODES as readonly string[]).includes(code)) expect(code).toBe('rate_limited');
    }
    expect(RPC_HTTP_STATUS.rate_limited).toBe(CONSOLE_ERROR_STATUS.rate_limited);
    expect(RPC_HTTP_STATUS.near_unavailable).toBe(503);
    expect(RPC_HTTP_STATUS.version_conflict).toBe(409);
  });

  it('result envelopes are ok with the shape or a known failure code', () => {
    const r = rpcResult({ version: z.number() });
    expect(r.safeParse({ ok: true, version: 1 }).success).toBe(true);
    expect(r.safeParse({ ok: false, code: 'version_conflict' }).success).toBe(true);
    expect(r.safeParse({ ok: false, code: 'nope' }).success).toBe(false);
    expect(r.safeParse({ ok: true, version: 1, extra: 1 }).success).toBe(false);
    expect(errorBody.safeParse({ error: { code: 'csrf', message: 'x' } }).success).toBe(true);
  });
});

describe('actor', () => {
  it('a member carries sub, email and the session hash; hana carries the Access sub', () => {
    const sessionHash = b64url(new Uint8Array(32));
    expect(actor.safeParse({ kind: 'member', id: 'usr_x', sub: '123', email: 'a@b.example', sessionHash }).success).toBe(true);
    expect(actor.safeParse({ kind: 'member', id: 'usr_x', sub: '123', email: 'a@b.example' }).success).toBe(false);
    expect(actor.safeParse({ kind: 'hana', id: 'access-sub', email: 'staff@hana.example' }).success).toBe(true);
    expect(actor.safeParse({ kind: 'link', id: 'gc_x' }).success).toBe(true);
    expect(actor.safeParse({ kind: 'root', id: 'x' }).success).toBe(false);
    expect(actor.safeParse({ kind: 'system', id: 'cron', extra: 1 }).success).toBe(false);
  });
});

describe('views', () => {
  const change = { id: 'gc_x', appId: 'app_x', kind: 'origin_add', origin: 'https://a.example', status: 'pending', proposedByKind: 'member', proposedBy: 'usr_x', proposedAt: 1 };

  it('a guarded change round-trips; unknown fields and kinds are refused', () => {
    expect(guardedChange.parse(change)).toEqual(change);
    expect(guardedChange.safeParse({ ...change, kind: 'origin_remove' }).success).toBe(false);
    expect(guardedChange.safeParse({ ...change, cancel_token_hash: 'x' }).success).toBe(false);
  });

  it('an app detail has no publishable_key column, only keys', () => {
    const detail = {
      id: 'app_x', name: 'A', scopeId: 's1', environment: 'test', suspendedBy: 0, deleted: false, activeOrigins: 1, pendingChanges: 0, createdAt: 1,
      orgId: 'org_x', originsVersion: 0, settingsVersion: 0,
      origins: [{ origin: 'https://a.example', display: 'https://a.example', idn: false, activeFrom: 0 }],
      settings: { persistence: 'session', sessionTtlMs: 43_200_000, idleTtlMs: 7_200_000, googleWebClientId: null, rawSign: 'off', policy: null },
      changes: [change],
      keys: [{ id: 'key_x', prefix: 'pk_test_', key: 'pk_test_x', createdBy: 'usr_x', createdAt: 1 }],
    };
    expect(appDetail.parse(detail)).toEqual(detail);
    expect(appDetail.safeParse({ ...detail, publishableKey: 'pk_test_x' }).success).toBe(false);
    expect(appDetail.safeParse({ ...detail, suspendedBy: 8 }).success).toBe(false);
    // D470: an unknown-typed key may be absent, as under zod 3 (zod 4 requires it unless `.optional()`).
    const policy = { policyId: 'a'.repeat(64), label: 'L' };
    expect(appDetail.safeParse({ ...detail, settings: { ...detail.settings, policy } }).success).toBe(true);
  });

  it('days are real UTC calendar dates', () => {
    expect(day.safeParse('2026-02-28').success).toBe(true);
    expect(day.safeParse('2026-02-29').success).toBe(false);
    expect(day.safeParse('2028-02-29').success).toBe(true);
    expect(day.safeParse('2026-13-01').success).toBe(false);
  });
});

describe('ids and keys', () => {
  it('ids are a prefix and base58 of 12 random bytes', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newId('invite')));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(/^inv_[1-9A-HJ-NP-Za-km-z]{12,17}$/u);
      expect(isId('invite', id)).toBe(true);
      expect(isId('ownerGrant', id)).toBe(false);
    }
    expect(isId('org', LEGACY_ORG_ID)).toBe(true);
    expect(isId('key', 'key_legacy_app_3vQb7Wk2Lm9Xp4Rz')).toBe(true);
    expect(isId('org', 'org_')).toBe(false);
  });

  it('base58 keeps leading zero bytes as 1s', () => {
    expect(base58(new Uint8Array([0, 0, 1]))).toBe('112');
    expect(base58(new Uint8Array([]))).toBe('');
  });

  it('publishable keys carry their scope’s environment', () => {
    expect(publishableKeyEnvironment(newPublishableKey('test'))).toBe('test');
    expect(publishableKeyEnvironment(newPublishableKey('live'))).toBe('live');
    expect(newPublishableKey('live')).toMatch(/^pk_live_[1-9A-HJ-NP-Za-km-z]{31,33}$/u);
    expect(publishableKeyEnvironment('sk_live_abc')).toBeNull();
  });

  it('b64url is strict', () => {
    expect(() => fromB64url('ab=')).toThrow();
    expect(() => fromB64url('a+b/')).toThrow();
    expect(() => fromB64url('AB')).toThrow(); // non-canonical trailing bits
    expect(fromB64url('AA')).toEqual(new Uint8Array([0]));
    expect(() => u64le(-1)).toThrow();
    expect(() => u64le(2 ** 64)).toThrow();
    expect(u64le(2n ** 64n - 1n)).toEqual(new Uint8Array(8).fill(255));
  });
});

describe('UsageEvent v1', () => {
  const ok: UsageEventV1 = {
    v: 1,
    request_id: '8f3b2c1d4e5f6a7b-SIN',
    at_ms: 1_793_000_000_000,
    org_id: 'org_legacy',
    app_id: 'app_x',
    scope_id: 's1',
    endpoint: 'login',
    outcome: 'ok',
    code: null,
    status: 200,
    latency_ms: 812,
    relayed: true,
    near_tx: 'FbqJmVBv3Wv9ghTkw3wFpoXvWZQJaKdZmpWxE4CRWwBF',
    relayer_pk: 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp',
    relayer_nonce: '193000000000001',
    relay_gas_burnt: '4174947687500',
    relay_tokens_burnt_yocto: '417494768750000000000',
    uid: b64url(new Uint8Array(16).fill(7)),
  };
  const refused = (patch: Partial<Record<keyof UsageEventV1, unknown>> & Record<string, unknown>) => usageEventV1.safeParse({ ...ok, ...patch }).success === false;

  it('accepts a relayed ok login with its uid and an owner action without an app', () => {
    expect(usageEventV1.parse(ok)).toEqual(ok);
    const { uid: _, ...owner } = ok;
    expect(usageEventV1.safeParse({ ...owner, endpoint: 'owner_action', app_id: null }).success).toBe(true);
  });

  it('refuses the shapes the ledger CHECKs refuse', () => {
    expect(refused({ near_tx: undefined })).toBe(true); // relayed without its tx
    expect(refused({ app_id: null })).toBe(true); // a login without an app
    expect(refused({ endpoint: 'owner_action' })).toBe(true); // an owner action with an app
    expect(refused({ outcome: 'rejected', code: 'contract_rejected' })).toBe(true); // uid on a rejected event
    expect(refused({ endpoint: 'revoke' })).toBe(true); // uid on a revoke
    expect(refused({ code: 'x' })).toBe(true); // ok with a code
    expect(refused({ outcome: 'error', code: null, uid: undefined })).toBe(true); // a failure without a code
    expect(refused({ uid: b64url(new Uint8Array(15)) })).toBe(true);
    expect(refused({ relayer_nonce: '9223372036854775808' })).toBe(true); // over i64
    expect(refused({ relayer_nonce: '01' })).toBe(true);
    expect(refused({ latency_ms: -1 })).toBe(true);
    expect(refused({ v: 2 })).toBe(true);
    expect(refused({ sub: '123' })).toBe(true); // never a sub (or any field not in v1)
    expect(refused({ endpoint: 'app' })).toBe(true);
  });
});
