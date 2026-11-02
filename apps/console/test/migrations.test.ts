import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  ACTOR_KINDS,
  AUDIT_OUTCOMES,
  AUTH_FLOW_PURPOSES,
  AUTH_FLOW_SCOPES,
  GRANTOR_KINDS,
  LEGACY_ORG_ID,
  ORG_KINDS,
  ORG_STATUSES,
  ROLES,
  STEP_UP_KINDS,
} from '@hana-id/console-core';
import { beforeAll, describe, expect, it } from 'vitest';

const db = env.CONSOLE_DB;
const MONTH_MS = 30 * 24 * 60 * 60_000;
const now = Date.now();
const h32 = (fill: number) => new Uint8Array(32).fill(fill);

/** Whether SQLite accepts the statement. */
const accepted = (sql: string, ...binds: unknown[]): Promise<boolean> =>
  db
    .prepare(sql)
    .bind(...binds)
    .run()
    .then(
      () => true,
      () => false,
    );

/** The values of `CHECK (<column> IN (…))` in a table's CREATE statement. */
async function checkList(table: string, column: string): Promise<string[]> {
  const row = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table).first<{ sql: string }>();
  const m = new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)\\)`, 'u').exec(row!.sql);
  if (!m) throw new Error(`No IN-list CHECK on ${table}.${column}`);
  return [...m[1]!.matchAll(/'([^']*)'/gu)].map((x) => x[1]!);
}

beforeAll(async () => {
  expect(env.TEST_MIGRATIONS.map((m) => m.name)).toEqual(['0001_init.sql', '0002_invites_kind_audit_request.sql']);
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
});

/** A request id of its own per audit row (0002's one row per request id and action). */
let ridSeq = 0;
const rid = () => `req-${String(++ridSeq).padStart(8, '0')}-${Math.random().toString(36).slice(2)}`;

describe('CONSOLE_DB 0001', () => {
  it('creates every table of the spec', async () => {
    const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%' ORDER BY name").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(['audit_log', 'auth_flows', 'console_sessions', 'console_users', 'handoff_codes', 'invites', 'logo_objects', 'members', 'orgs', 'owner_grants', 'pending_actions']);
  });

  it('creates org_legacy (internal, active)', async () => {
    expect(await db.prepare('SELECT id, kind, status, required_hd FROM orgs WHERE id = ?').bind(LEGACY_ORG_ID).first()).toEqual({ id: LEGACY_ORG_ID, kind: 'internal', status: 'active', required_hd: null });
  });

  it('CHECK lists are the console-core enums', async () => {
    expect(await checkList('orgs', 'kind')).toEqual([...ORG_KINDS]);
    expect(await checkList('orgs', 'status')).toEqual([...ORG_STATUSES]);
    expect(await checkList('members', 'role')).toEqual([...ROLES]);
    expect(await checkList('invites', 'role')).toEqual([...ROLES]);
    expect(await checkList('invites', 'created_by_kind')).toEqual([...GRANTOR_KINDS]);
    expect(await checkList('owner_grants', 'granted_by_kind')).toEqual([...GRANTOR_KINDS]);
    expect(await checkList('auth_flows', 'purpose')).toEqual([...AUTH_FLOW_PURPOSES]);
    expect(await checkList('auth_flows', 'scope')).toEqual([...AUTH_FLOW_SCOPES]);
    expect(await checkList('pending_actions', 'kind')).toEqual([...STEP_UP_KINDS]);
    expect(await checkList('audit_log', 'actor_kind')).toEqual([...ACTOR_KINDS]);
    expect(await checkList('audit_log', 'outcome')).toEqual([...AUDIT_OUTCOMES]);
  });
});

describe('console_users and members', () => {
  it('one user per (provider, sub); emails are lowercased', async () => {
    const insert = (id: string, sub: string, email = 'a@partner.example') =>
      accepted('INSERT INTO console_users (id, provider, sub, email, created_at) VALUES (?, ?, ?, ?, ?)', id, 'google', sub, email, now);
    expect(await insert('usr_a', '111')).toBe(true);
    expect(await insert('usr_b', '111')).toBe(false);
    expect(await insert('usr_c', '222', 'A@partner.example')).toBe(false);
  });

  it('roles are owner or viewer, one row per org and user', async () => {
    const add = (user: string, role: string) => accepted('INSERT INTO members (org_id, user_id, role, role_since, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)', 'org_m', user, role, now, 'hana', now);
    expect(await add('usr_a', 'owner')).toBe(true);
    expect(await add('usr_a', 'viewer')).toBe(false);
    expect(await add('usr_x', 'developer')).toBe(false);
  });
});

describe('invites', () => {
  const insert = (o: Record<string, unknown>) => {
    const row = { id: `inv_${Math.random()}`, token_hash: null, email_norm: 'new@partner.example', org_id: 'org_i', new_org_name: null, role: 'viewer', created_by_kind: 'hana', created_by: 'staff-sub', step_up_id: null, notified_at: null, created_at: now, expires_at: now + 7 * 86_400_000, accepted_at: null, accepted_user_id: null, accepted_by_sub: null, ...o };
    const cols = Object.keys(row);
    return accepted(`INSERT INTO invites (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...Object.values(row));
  };

  it('targets exactly one of an org and a new org; only staff create orgs', async () => {
    expect(await insert({})).toBe(true);
    expect(await insert({ org_id: null, new_org_name: 'Acme', new_org_kind: 'partner' })).toBe(true);
    expect(await insert({ org_id: null })).toBe(false);
    expect(await insert({ new_org_name: 'Acme', new_org_kind: 'partner' })).toBe(false);
    expect(await insert({ org_id: null, new_org_name: 'Acme', new_org_kind: 'partner', created_by_kind: 'member', step_up_id: 'act_x', created_by: 'usr_a' })).toBe(false);
  });

  it('0002: a new-org invite carries the new org\'s kind, and only it (D242)', async () => {
    expect(await insert({ org_id: null, new_org_name: 'Acme', new_org_kind: 'internal' })).toBe(true);
    expect(await insert({ org_id: null, new_org_name: 'Acme' })).toBe(false);
    expect(await insert({ new_org_kind: 'partner' })).toBe(false);
    expect(await insert({ org_id: null, new_org_name: 'Acme', new_org_kind: 'reseller' })).toBe(false);
    const id = `inv_${Math.random()}`;
    expect(await insert({ id, org_id: null, new_org_name: 'Acme', new_org_kind: 'partner' })).toBe(true);
    expect(await accepted('UPDATE invites SET new_org_kind = NULL WHERE id = ?', id)).toBe(false);
  });

  it('member invites carry their step-up; staff invites none', async () => {
    expect(await insert({ created_by_kind: 'member', created_by: 'usr_a', step_up_id: 'act_1' })).toBe(true);
    expect(await insert({ created_by_kind: 'member', created_by: 'usr_a' })).toBe(false);
    expect(await insert({ step_up_id: 'act_2' })).toBe(false);
  });

  it('no token before the notice is accepted; one invite per token', async () => {
    expect(await insert({ token_hash: h32(1) })).toBe(false); // a token without notified_at
    expect(await insert({ notified_at: now })).toBe(false); // notified without its token
    expect(await insert({ token_hash: h32(1), notified_at: now })).toBe(true);
    expect(await insert({ token_hash: h32(1), notified_at: now })).toBe(false);
    expect(await insert({ token_hash: new Uint8Array(31), notified_at: now })).toBe(false);
  });

  it('lowercased email, expiry after creation, acceptance recorded in full', async () => {
    expect(await insert({ email_norm: 'New@partner.example' })).toBe(false);
    expect(await insert({ expires_at: now })).toBe(false);
    expect(await insert({ accepted_at: now, accepted_user_id: 'usr_a', accepted_by_sub: '111' })).toBe(true);
    expect(await insert({ accepted_at: now, accepted_user_id: 'usr_a' })).toBe(false);
    expect(await insert({ role: 'admin' })).toBe(false);
  });
});

describe('owner_grants', () => {
  const insert = (o: Record<string, unknown>) => {
    const row = { id: `og_${Math.random()}`, org_id: 'org_g', user_id: null, invite_id: null, granted_by_kind: 'hana', granted_by: 'staff-sub', step_up_id: null, created_at: now, ...o };
    const cols = Object.keys(row);
    return accepted(`INSERT INTO owner_grants (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...Object.values(row));
  };

  it('a grant names its invite or (a promotion) its user', async () => {
    expect(await insert({ invite_id: 'inv_g1' })).toBe(true);
    expect(await insert({ user_id: 'usr_g' })).toBe(true);
    expect(await insert({})).toBe(false);
    expect(await insert({ invite_id: 'inv_g1' })).toBe(false); // one grant per invite
  });

  it('member grants carry their step-up; owner_from only with a user; never both cancelled and applied', async () => {
    expect(await insert({ user_id: 'usr_g', granted_by_kind: 'member', granted_by: 'usr_o', step_up_id: 'act_g' })).toBe(true);
    expect(await insert({ user_id: 'usr_g', granted_by_kind: 'member', granted_by: 'usr_o' })).toBe(false);
    expect(await insert({ invite_id: 'inv_g2', owner_from: now })).toBe(false);
    expect(await insert({ user_id: 'usr_g', owner_from: now, cancelled_at: now, applied_at: now })).toBe(false);
    expect(await insert({ user_id: 'usr_g', cancel_token_hash: new Uint8Array(8) })).toBe(false);
  });
});

describe('auth_flows, handoff codes, sessions and pending actions', () => {
  const flow = (o: Record<string, unknown>) => {
    const row = { state_hash: crypto.getRandomValues(new Uint8Array(32)), start_hash: crypto.getRandomValues(new Uint8Array(32)), purpose: 'login', pre_cookie_hash: h32(9), pkce_verifier: 'v', nonce: 'n', scope: 'openid email', pending_action_id: null, created_at: now, expires_at: now + 300_000, ...o };
    const cols = Object.keys(row);
    return accepted(`INSERT INTO auth_flows (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...Object.values(row));
  };

  it('a login flow has the pre-flow cookie and the email scope; a step-up its action and openid only', async () => {
    expect(await flow({})).toBe(true);
    expect(await flow({ pre_cookie_hash: null })).toBe(false);
    expect(await flow({ scope: 'openid' })).toBe(false);
    expect(await flow({ purpose: 'step_up', pre_cookie_hash: null, pending_action_id: 'act_s', scope: 'openid' })).toBe(true);
    expect(await flow({ purpose: 'step_up', pre_cookie_hash: null, pending_action_id: 'act_s', scope: 'openid email' })).toBe(false);
    expect(await flow({ purpose: 'step_up', pre_cookie_hash: null, scope: 'openid' })).toBe(false);
    expect(await flow({ purpose: 'step_up', pre_cookie_hash: null, pending_action_id: 'act_s', scope: 'openid', invite_id: 'inv_x' })).toBe(false);
    expect(await flow({ invite_id: 'inv_x' })).toBe(true);
    expect(await flow({ used_at: now })).toBe(false); // used before it was started
    expect(await flow({ started_at: now, used_at: now })).toBe(true);
  });

  it('handoff results are JSON; sessions keep only hashes and coarse network data', async () => {
    expect(await accepted('INSERT INTO handoff_codes (code_hash, state_hash, result_json, expires_at) VALUES (?, ?, ?, ?)', h32(1), h32(2), '{"userId":"usr_a"}', now)).toBe(true);
    expect(await accepted('INSERT INTO handoff_codes (code_hash, state_hash, result_json, expires_at) VALUES (?, ?, ?, ?)', h32(3), h32(2), 'not json', now)).toBe(false);
    const session = (id: Uint8Array, abs: number) =>
      accepted('INSERT INTO console_sessions (id_hash, user_id, auth_at, last_seen_at, absolute_expires_at, ip_prefix) VALUES (?, ?, ?, ?, ?, ?)', id, 'usr_a', now, now, abs, '203.0.113.0/24');
    expect(await session(h32(4), now + 12 * 3_600_000)).toBe(true);
    expect(await session(h32(5), now)).toBe(false);
    expect(await session(new Uint8Array(16), now + 1)).toBe(false);
  });

  it('pending actions: known kinds only; owner actions carry scope, nonce and args', async () => {
    const action = (kind: string, extra: unknown[] = [null, null, null]) =>
      accepted(
        'INSERT INTO pending_actions (id, user_id, session_hash, org_id, kind, action_json, digest, google_nonce, scope_id, near_action_nonce, near_args, created_at, expires_at, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        `act_${Math.random()}`, 'usr_a', h32(1), 'org_p', kind, '{"v":1}', h32(2), 'nonce', ...extra, now, now + 300_000, 'req-00000001',
      );
    for (const kind of STEP_UP_KINDS.filter((k) => k !== 'owner_action')) expect(await action(kind), kind).toBe(true);
    expect(await action('member.delete')).toBe(false);
    expect(await action('owner_action')).toBe(false);
    expect(await action('owner_action', ['s1', 4, new Uint8Array([1, 2])])).toBe(true);
    expect(await action('member.role', ['s1', 4, new Uint8Array([1, 2])])).toBe(false);
  });
});

describe('audit_log is append-only (D90)', () => {
  const insert = (at: number, action = 'member.added') =>
    db
      .prepare("INSERT INTO audit_log (at, actor_kind, actor_id, org_id, action, details_json, request_id, outcome) VALUES (?, 'hana', 'staff-sub', 'org_a', ?, '{}', ?, 'ok') RETURNING seq")
      .bind(at, action, rid())
      .first<{ seq: number }>();

  it('refuses every update', async () => {
    const { seq } = (await insert(now))!;
    expect(await accepted("UPDATE audit_log SET action = 'x' WHERE seq = ?", seq)).toBe(false);
    expect(await accepted("UPDATE audit_log SET outcome = 'failed' WHERE seq = ?", seq)).toBe(false);
  });

  it('refuses deleting rows under 60 months old, allows older ones', async () => {
    const recent = (await insert(now))!.seq;
    const almost = (await insert(now - 59 * MONTH_MS))!.seq;
    const old = (await insert(now - 61 * 31 * 24 * 60 * 60_000))!.seq;
    expect(await accepted('DELETE FROM audit_log WHERE seq = ?', recent)).toBe(false);
    expect(await accepted('DELETE FROM audit_log WHERE seq = ?', almost)).toBe(false);
    expect(await accepted('DELETE FROM audit_log WHERE seq = ?', old)).toBe(true);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE seq = ?').bind(recent).first('n')).toBe(1);
  });

  it('refuses unknown actor kinds, outcomes and non-JSON details', async () => {
    const row = (actor: string, outcome: string, details: string) =>
      accepted('INSERT INTO audit_log (at, actor_kind, actor_id, action, details_json, request_id, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)', now, actor, 'x', 'a', details, rid(), outcome);
    expect(await row('member', 'ok', '{}')).toBe(true);
    expect(await row('root', 'ok', '{}')).toBe(false);
    expect(await row('member', 'maybe', '{}')).toBe(false);
    expect(await row('member', 'ok', '{oops')).toBe(false);
  });
});

describe('0002: one audit row per request id and action (D243)', () => {
  const row = (requestId: string, action: string) =>
    accepted("INSERT INTO audit_log (at, actor_kind, actor_id, action, details_json, request_id, outcome) VALUES (?, 'hana', 'staff-sub', ?, '{}', ?, 'ok')", now, action, requestId);

  it('refuses a second row of the same request and action, allows another action of the request', async () => {
    const r = rid();
    expect(await row(r, 'invite.issued')).toBe(true);
    expect(await row(r, 'invite.issued')).toBe(false);
    expect(await row(r, 'invite.revoked')).toBe(true);
  });
});
