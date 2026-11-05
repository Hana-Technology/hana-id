// The admin crons' one budget of outbound calls (D280, D380): every outbound call of a run, in every job, is counted
// (the Hyperdrive connection, every RPC over the API and CONSOLE service bindings, every email, every NEAR read and
// rate fetch), a run never makes more than RUN_BUDGET of them (nor more than RPC_BUDGET service-binding calls), and a
// job out of calls stops cleanly and carries on next run. Worst-case ticks with every job due, counted independently
// of the budget: every fake below records each call it gets, and the network is a stub of the global fetch.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestDb } from '../../api/test-usage/db.ts';
import { STATEMENT_NOTICES_PER_RUN } from '../src/alerts.ts';
import { everyFiveMinutes } from '../src/cron.ts';
import type { Env } from '../src/env.ts';
import { outbound } from '../src/email/sender.ts';
import { FEED_CURSORS, feedChanges } from '../src/feed.ts';
import { type LedgerStore, ledgerSource } from '../src/ledger.ts';
import { everyFifteenMinutes } from '../src/ledger-cron.ts';
import { Budget, OutOfBudget, RPC_BUDGET, RUN_BUDGET, forgetAccepted, metered, meteredEnv } from '../src/mail.ts';
import { NOTICE_PAGE, runChangeNotices } from '../src/notices.ts';
import { type OpsStore, opsSource, sqlOps } from '../src/ops.ts';
import { RETENTION_MAX_CALLS } from '../src/retention.ts';
import { WATCH_CURSOR, runWatcher } from '../src/watcher.ts';
import { ALIAS, FakeEmail, PK_A, PK_B, RELAYER, SIGNER, insertEvent, ledgerDb } from './fakes.ts';

let db: TestDb;
let store: LedgerStore;
let ops: OpsStore;
beforeAll(async () => {
  ({ db, store } = await ledgerDb(['2031_02', '2031_03']));
  ops = sqlOps((sql, params) => db.asRole('usage_admin', () => db.query(sql, params)));
});
afterAll(async () => {
  await db.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const MIN = 60_000;
const NEAR_RPC = 'https://rpc.budget.test';
const KEY32 = (b: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(b)));
const OWNER = { Oidc: { provider: 'google', sub: 'owner-sub-1' } };

/** A fake binding whose every call is recorded (`rpc`) before it runs: the independent count of service-binding calls. */
function recorded<T extends object>(o: T, rpc: string[], prefix: string): T {
  return new Proxy(o, {
    get: (t, p) => {
      const v = (t as Record<string | symbol, unknown>)[p];
      if (typeof p !== 'string' || typeof v !== 'function') return v;
      return (...a: unknown[]) => {
        rpc.push(`${prefix}.${p}`);
        return (v as (...x: unknown[]) => unknown).apply(t, a);
      };
    },
  });
}

/** The network: NEAR's `tx`, `view_access_key` and `get_scope`, and CoinGecko; anything else fails the test. */
interface Net {
  tx: number;
  key: number;
  scope: number;
  rate: number;
  txs: Map<string, { pk: string; nonce: bigint }>;
  scopes: Map<string, unknown>;
}
function stubNetwork(): Net {
  const net: Net = { tx: 0, key: 0, scope: 0, rate: 0, txs: new Map(), scopes: new Map() };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://api.coingecko.com/')) {
      net.rate++;
      return Response.json({ market_data: { current_price: { usd: 2.5 } } });
    }
    if (url !== NEAR_RPC) throw new Error(`Unexpected fetch to ${url}`);
    const body = JSON.parse(String(init?.body)) as { method: string; params: Record<string, string> };
    if (body.method === 'tx') {
      net.tx++;
      const hash = body.params.tx_hash!;
      const t = net.txs.get(hash);
      if (!t) return Response.json({ jsonrpc: '2.0', id: 'admin', error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' } } });
      const outcome = { outcome: { gas_burnt: 3_000_000_000_000, tokens_burnt: '300000000000000000000' } };
      return Response.json({ jsonrpc: '2.0', id: 'admin', result: { final_execution_status: 'FINAL', transaction: { hash, signer_id: RELAYER, public_key: t.pk, nonce: Number(t.nonce), receiver_id: SIGNER }, transaction_outcome: outcome, receipts_outcome: [outcome] } });
    }
    if (body.params.request_type === 'view_access_key') {
      net.key++;
      return Response.json({ jsonrpc: '2.0', id: 'admin', result: { nonce: 5 } });
    }
    if (body.params.request_type === 'call_function' && body.params.method_name === 'get_scope') {
      net.scope++;
      const { scope_id } = JSON.parse(atob(body.params.args_base64!)) as { scope_id: string };
      const value = net.scopes.get(scope_id) ?? null;
      return Response.json({ jsonrpc: '2.0', id: 'admin', result: { result: [...new TextEncoder().encode(JSON.stringify(value))] } });
    }
    throw new Error(`Unexpected NEAR call ${body.method}`);
  });
  return net;
}

const countOf = (calls: string[], ...names: string[]) => calls.filter((c) => names.includes(c)).length;
/** The ledger alerts' subjects (after render's `[Hana ID <env>] ` prefix). */
const ALERT_SUBJECT = /^\[Hana ID [^\]]*\] (Relayer nonce|Rejection rate|Settlement refused)/u;

describe('the budget', () => {
  it('a metered binding takes one call of both counts per call, refuses (rejects, never calls) when either is spent, and is never metered twice', async () => {
    const calls: string[] = [];
    const fake = recorded({ ping: async () => ({ ok: true }) }, calls, 'api');
    const b = new Budget(3);
    const m = metered(fake, b);
    expect(metered(m, b)).toBe(m);
    expect(meteredEnv({ API: m, CONSOLE: m }, b).API).toBe(m);
    await m.ping();
    await m.ping();
    expect([b.remaining, b.rpcRemaining, b.spent]).toEqual([1, 1, 2]);
    b.take();
    await expect(m.ping()).rejects.toBeInstanceOf(OutOfBudget);
    expect(calls).toHaveLength(2);
    // RPC_BUDGET: the 32-invocation limit binds before RUN_BUDGET does.
    const big = new Budget();
    const n = metered(fake, big);
    for (let i = 0; i < RPC_BUDGET; i++) await n.ping();
    expect(big.fits(1)).toBe(true);
    expect(big.fits(1, 1)).toBe(false);
    await expect(n.ping()).rejects.toBeInstanceOf(OutOfBudget);
    expect(big.take()).toBe(true);
    expect(big.spent).toBe(RPC_BUDGET + 1);
  });

  it('records each call under the job running it', async () => {
    const b = new Budget();
    await b.as('a', async () => {
      b.take(2);
      await b.as('b', async () => b.take());
      b.take();
    });
    b.take();
    expect(b.used).toEqual({ a: 3, b: 1, run: 1 });
    expect(b.spent).toBe(5);
  });
});

describe('a worst-case 15-minute tick (D380): the 00:30 daily work, a due retention run, the alerts, a backlog of statement notices and of settlement', () => {
  // The 2nd of the month, 00:30 UTC: the daily tick, and the month's retention job is due (it has not run yet).
  const T0 = Date.UTC(2031, 2, 2, 0, 30);
  const SETTLE = 60;
  const STATEMENTS = STATEMENT_NOTICES_PER_RUN + 1;
  let net: Net;
  let rpc: string[];
  let email: FakeEmail;
  let opens: number;
  let deletedPages: number;
  beforeEach(() => {
    net = stubNetwork();
    rpc = [];
    email = new FakeEmail();
    opens = 0;
    vi.spyOn(outbound, 'email').mockReturnValue(email);
    vi.spyOn(ledgerSource, 'open').mockImplementation(async () => {
      opens++;
      return { ...store, close: async () => {} };
    });
  });

  const api = () =>
    recorded(
      {
        relayerKeys: async () => ({ ok: true as const, keys: [{ pool: 'session' as const, publicKey: PK_A }, { pool: 'owner' as const, publicKey: PK_B }] }),
        getSecurityContacts: async () => ({ ok: true as const, emails: ['sec@partner.example'] }),
        // 14 pages of deleted apps before the job's other RPCs: more than one run's RETENTION_MAX_CALLS.
        deletedApps: async () => ({ ok: true as const, appIds: [], next: `1:app_${++deletedPages}`, more: deletedPages < 14 }),
        purgeDirectory: async () => ({ ok: true as const, scopes: 0, users: 0, wallets: 0, identities: 0 }),
        purgeAudit: async () => ({ ok: true as const, appChanges: 0, guardedChanges: 0 }),
      },
      rpc,
      'api',
    );
  const consoleRpc = () =>
    recorded(
      {
        getOrg: async (c: { orgId: string }) => ({ ok: true as const, org: { id: c.orgId, name: `Org ${c.orgId}`, kind: 'partner' as const, status: 'active' as const, createdAt: 1, billingEmail: 'billing@partner.example' }, members: [], invites: [] }),
        purgeAudit: async () => ({ ok: true as const, auditLog: 0, ownerGrants: 0 }),
      },
      rpc,
      'console',
    );
  let apiFake: ReturnType<typeof api>;
  let consoleFake: ReturnType<typeof consoleRpc>;
  const env = () =>
    ({
      ENV_NAME: 'sandbox-test',
      CONSOLE_ORIGIN: 'https://console.test',
      SECURITY_ALIAS: ALIAS,
      EMAIL_FROM: 'Hana <no-reply@hana.example>',
      NEAR_RPC,
      RELAYER_ACCOUNT: RELAYER,
      SIGNER_ACCOUNT: SIGNER,
      // Bound, so the run's connection is charged (the store itself is the PGlite one above).
      USAGE_DB: { connectionString: 'postgres://unused' },
      API: apiFake,
      CONSOLE: consoleFake,
    }) as unknown as Env;

  /** One tick, every outbound call counted twice: by the budget (the summary) and by the fakes (independently). */
  async function tick(t: number) {
    const before = { rpc: rpc.length, sent: email.sent.length, tx: net.tx, key: net.key, rate: net.rate, opens };
    const sum = (await everyFifteenMinutes(env(), t))!;
    const mine = rpc.slice(before.rpc);
    const sent = email.sent.slice(before.sent);
    const counted = {
      ledger: opens - before.opens,
      relayer_keys: countOf(mine, 'api.relayerKeys'),
      nonce_check: net.key - before.key,
      retention: countOf(mine, 'api.deletedApps', 'api.purgeDirectory', 'api.purgeAudit', 'console.purgeAudit'),
      alerts: sent.filter((m) => ALERT_SUBJECT.test(m.subject)).length,
      statement_notices: countOf(mine, 'api.getSecurityContacts', 'console.getOrg') + sent.filter((m) => !ALERT_SUBJECT.test(m.subject) && !/\] Retention/u.test(m.subject)).length,
      rates: net.rate - before.rate,
      settlement: net.tx - before.tx,
    };
    const total = mine.length + sent.length + (net.tx - before.tx) + (net.key - before.key) + (net.rate - before.rate) + (opens - before.opens);
    // The two counts agree: nothing went out uncounted, and nothing was counted that didn't go out.
    expect(total).toBe(RUN_BUDGET - sum.budgetLeft);
    expect(Object.values(sum.calls).reduce((a, b) => a + b, 0)).toBe(total);
    expect(total).toBeLessThanOrEqual(RUN_BUDGET);
    expect(mine.length).toBeLessThanOrEqual(RPC_BUDGET);
    for (const [job, n] of Object.entries(counted)) expect(sum.calls[job] ?? 0, job).toBe(n);
    return { sum, total, counted };
  }

  it('stays within its 40 calls with each job’s share as documented, and every job carries on in the next runs', async () => {
    apiFake = api();
    consoleFake = consoleRpc();
    deletedPages = 0;
    // Settlement: a backlog larger than a run, each a real transaction of the relayer at FINAL.
    for (let i = 0; i < SETTLE; i++) {
      const e = await insertEvent(db, { at: T0 - 2 * 60 * MIN, relayed: true, pk: PK_A, nonce: BigInt(900_000 + i) });
      net.txs.set(e.tx!, { pk: PK_A, nonce: e.nonce! });
    }
    // An alert waiting (the nonce check adds the other: PK_A's nonce 5 has no ledger row).
    expect(await store.addRejectionAlert({ orgId: 'org_r', day: '2031-03-01', relayed: 200, rejected: 50 })).toBe(true);
    // More statements issued than one run's notices.
    for (let i = 0; i < STATEMENTS; i++) {
      expect(await store.insertStatement({ orgId: `org_s${i}`, month: '2031-01', asOf: Date.UTC(2031, 1, 3), csvKey: `statements/org_s${i}/2031-01.csv`, csvSha256: 'ab'.repeat(32), pdfKey: `statements/org_s${i}/2031-01.pdf`, pdfSha256: 'cd'.repeat(32), totals: {}, issuedBy: 'staff@hana.example' })).toBe('ok');
    }

    // The worst case: every job due at once.
    const first = await tick(T0);
    // The order is the priority: the connection, the pool keys, the daily nonce check, the retention job (at most 12),
    // the alerts, then the statement notices (2 RPCs and 3 emails each: the contacts, the billing email, the alias) as
    // far as they fit; the rates get what is left and settlement nothing this run.
    expect(first.sum.calls).toEqual({ ledger: 1, relayer_keys: 1, nonce_check: 2, retention: RETENTION_MAX_CALLS, alerts: 2, statement_notices: 4 * 5, rates: 2 });
    expect(first.total).toBe(RUN_BUDGET);
    expect(first.sum.retention).toMatchObject({ ran: true, status: 'partial', calls: RETENTION_MAX_CALLS });
    expect(first.sum.notices).toEqual({ sent: 4, failed: 0 });
    expect(first.sum.daily!.rates).toMatchObject({ missing: 10, fetched: 2 });
    expect(first.sum.settlement).toMatchObject({ read: 0 });

    // 15 minutes later: retention finishes, the last statement notices go out, settlement takes the rest.
    const second = await tick(T0 + 15 * MIN);
    expect(second.sum.calls).toEqual({ ledger: 1, relayer_keys: 1, retention: 5, statement_notices: 2 * 5, settlement: RUN_BUDGET - 17 });
    expect(second.sum.retention).toMatchObject({ ran: true, status: 'ok' });
    expect(await store.unnoticedStatements(100)).toEqual([]);
    expect(second.sum.settlement).toMatchObject({ read: RUN_BUDGET - 17, final: RUN_BUDGET - 17 });

    // Then settlement drains the backlog; the month's retention is done and takes nothing.
    const third = await tick(T0 + 30 * MIN);
    expect(third.sum.calls).toEqual({ ledger: 1, relayer_keys: 1, settlement: SETTLE - (RUN_BUDGET - 17) });
    expect(third.sum.retention).toMatchObject({ ran: false, why: 'done' });
    expect(await store.settlementBacklog()).toMatchObject({ pending: 0 });

    // The next day's 00:30 tick fills the rates the first one had no calls for.
    const daily = await tick(T0 + 24 * 60 * MIN);
    expect(daily.sum.calls).toEqual({ ledger: 1, relayer_keys: 1, nonce_check: 2, rates: 9 });
    expect((await store.ratesBetween('2031-02-22', '2031-03-03')).length).toBe(10);
    expect(email.sent.filter((m) => ALERT_SUBJECT.test(m.subject))).toHaveLength(2);
  });
});

describe('a worst-case 5-minute tick (D380): pages of blocking notices, a security feed backlog and scopes with pending changes', () => {
  const NOTICES = NOTICE_PAGE + 10;
  const INVITES = 25;
  const EVENTS = 60;
  const ROWS = 120;
  const SCOPES = 40;
  let net: Net;
  let rpc: string[];
  let email: FakeEmail;
  let opens: number;
  const acked = new Set<string>();
  const invitesAcked = new Set<string>();
  const notified = new Set<string>();
  beforeEach(() => {
    net = stubNetwork();
    rpc = [];
    email = new FakeEmail();
    opens = 0;
    vi.spyOn(outbound, 'email').mockReturnValue(email);
    vi.spyOn(opsSource, 'open').mockImplementation(async () => {
      opens++;
      return ops;
    });
  });

  const org = (i: number) => `org_f${i % 20}`;
  const changes = Array.from({ length: NOTICES }, (_, i) => ({
    change: { id: `gc_n${i}`, appId: `app_n${i}`, kind: 'origin_add' as const, origin: `https://n${i}.partner.example`, status: 'pending' as const, proposedByKind: 'hana' as const, proposedBy: 'staff@hana.example', proposedAt: 1 },
    contacts: [`a${i}@partner.example`, `b${i}@partner.example`],
    app: { id: `app_n${i}`, name: `gc_n${i}`, orgId: org(i), scopeId: 's_n', environment: 'live' as const },
  }));
  const invites = Array.from({ length: INVITES }, (_, i) => ({
    kind: 'invite' as const,
    invite: { id: `inv_${i}`, email: `new${i}@partner.example`, orgId: `org_i${i}`, role: 'viewer' as const, createdByKind: 'hana' as const, createdBy: 'staff@hana.example', createdAt: 1, expiresAt: Date.UTC(2040, 0, 1) },
    owners: [{ email: `owner${i}@partner.example` }],
  }));
  const events = Array.from({ length: EVENTS }, (_, i) => ({ id: `se_${i}`, detectedAt: 1, kind: 'drift' as const, orgId: org(i), detail: {} }));
  const appChanges = Array.from({ length: ROWS }, (_, i) => ({ seq: i + 1, at: 1, orgId: org(i), appId: `app_${i}`, kind: 'suspension.set', detail: {}, actorKind: 'hana' as const, actorId: 'staff', requestId: `req_${i}` }));
  const audit = Array.from({ length: ROWS }, (_, i) => ({ seq: i + 1, at: 1, actorKind: 'hana' as const, actorId: 'staff', orgId: org(i), action: 'org.renamed', details: {}, requestId: `req_${i}`, outcome: 'ok' as const }));
  const scopes = Array.from({ length: SCOPES }, (_, i) => ({ scopeId: `s_w${String(i).padStart(2, '0')}`, orgId: `org_w${i}`, environment: 'live' as const, assignedAt: 1 }));
  // Every fifth scope's pending change turns on shared login, so its notice reads the scope's apps (listApps, getApp).
  const sharedOn = (i: number) => i % 5 === 0;

  const env = () =>
    ({
      ENV_NAME: 'sandbox-test',
      CONSOLE_ORIGIN: 'https://console.test',
      SECURITY_ALIAS: ALIAS,
      EMAIL_FROM: 'Hana <no-reply@hana.example>',
      EMAIL_API_KEY: 're_test_suite_only',
      CANCEL_LINK_KEY: KEY32(1),
      INVITE_LINK_KEY: KEY32(2),
      NEAR_RPC,
      SIGNER_ACCOUNT: SIGNER,
      USAGE_DB: { connectionString: 'postgres://unused' },
      API: recorded(
        {
          pendingNotices: async (c: { limit: number }) => ({ ok: true as const, notices: changes.filter((n) => !acked.has(n.change.id)).slice(0, c.limit) }),
          ackNotice: async (c: { changeId: string }) => {
            acked.add(c.changeId);
            return { ok: true as const, change: changes.find((n) => n.change.id === c.changeId)!.change };
          },
          getSecurityContacts: async (c: { orgId: string }) => ({ ok: true as const, emails: [`sec-${c.orgId}@partner.example`] }),
          securityEvents: async (c: { limit: number }) => ({ ok: true as const, events: events.filter((e) => !notified.has(e.id)).slice(0, c.limit) }),
          markSecurityEventNotified: async (c: { ids: string[] }) => {
            for (const id of c.ids) notified.add(id);
            return { ok: true as const };
          },
          changesSince: async (c: { seq: number; limit: number }) => ({ ok: true as const, changes: appChanges.filter((r) => r.seq > c.seq).slice(0, c.limit) }),
          listScopes: async (c: { cursor?: string; limit: number }) => {
            const after = scopes.filter((s) => !c.cursor || s.scopeId > c.cursor);
            const page = after.slice(0, c.limit);
            return { ok: true as const, scopes: page, ...(after.length > c.limit ? { next: page[page.length - 1]!.scopeId } : {}) };
          },
          listApps: async (c: { orgId: string }) => ({ ok: true as const, apps: scopes.filter((s) => s.orgId === c.orgId).flatMap((s) => [1, 2].map((k) => ({ id: `app_${s.scopeId}_${k}`, name: `App ${k}`, scopeId: s.scopeId }))) }),
          getApp: async (c: { appId: string }) => ({ ok: true as const, app: { id: c.appId, name: c.appId, scopeId: 's', origins: [{ origin: `https://${c.appId}.example`, display: '', idn: false, activeFrom: 1 }] } }),
        },
        rpc,
        'api',
      ),
      CONSOLE: recorded(
        {
          pendingMemberNotices: async (c: { limit: number }) => ({ ok: true as const, notices: invites.filter((n) => !invitesAcked.has(n.invite.id)).slice(0, c.limit) }),
          getOrg: async (c: { orgId: string }) => ({ ok: true as const, org: { id: c.orgId, name: `Org ${c.orgId}`, kind: 'partner' as const, status: 'active' as const, createdAt: 1 }, members: [], invites: [] }),
          ackMemberNotice: async (c: { inviteId: string }) => {
            invitesAcked.add(c.inviteId);
            return { ok: true as const };
          },
          auditSince: async (c: { seq: number; limit: number }) => ({ ok: true as const, rows: audit.filter((r) => r.seq > c.seq).slice(0, c.limit) }),
        },
        rpc,
        'console',
      ),
    }) as unknown as Env;

  async function tick() {
    // Each run in a fresh isolate (the worst case for repeats): nothing remembered from the last one (D401).
    forgetAccepted();
    const before = { rpc: rpc.length, attempts: email.sent.length, scope: net.scope, opens, acked: new Set(acked) };
    const sum = await everyFiveMinutes(env(), Date.UTC(2031, 2, 2, 12, 0));
    const mine = rpc.slice(before.rpc);
    const sent = email.sent.slice(before.attempts);
    const total = mine.length + sent.length + (net.scope - before.scope) + (opens - before.opens);
    expect(total).toBe(RUN_BUDGET - sum.budgetLeft);
    expect(Object.values(sum.calls).reduce((a, b) => a + b, 0)).toBe(total);
    expect(total).toBeLessThanOrEqual(RUN_BUDGET);
    expect(mine.length).toBeLessThanOrEqual(RPC_BUDGET);
    // A blocking notice is never half-sent: each one emailed in this run was acked in this run.
    const emailedNotices = new Set(sent.flatMap((m) => /^\[Hana ID [^\]]*\] Pending change for (gc_n\d+)/u.exec(m.subject)?.[1] ?? []));
    if (sent.length) expect(sent.some((m) => m.subject.startsWith('[Hana ID '))).toBe(true);
    for (const id of emailedNotices) expect(acked.has(id) && !before.acked.has(id), id).toBe(true);
    return { sum, total, mine, sent };
  }

  it('stays within its 40 calls, blocking notices first and whole; every job drains its backlog over the next runs', async () => {
    for (let i = 0; i < SCOPES; i++) {
      const change = sharedOn(i) ? { SetAllowShared: { allow: true } } : { SetOwners: { owners: [OWNER, { Oidc: { provider: 'google', sub: `new-${i}` } }] } };
      net.scopes.set(scopes[i]!.scopeId, { owners: [OWNER], clients: [], allow_shared: false, pending: [{ id: 1, change, unlock_at_ms: Date.UTC(2031, 2, 3) }], action_nonce: 1, created_at_ms: 1 });
    }
    // The feed's cursors exist (past D344's silent first walk), so every row is emailed.
    await ops.setState(FEED_CURSORS.changes, '0');
    await ops.setState(FEED_CURSORS.audit, '0');

    // The worst case: a full page of change notices (alias and two contacts each: 3 emails and the ack) takes the run;
    // each notice is sent only with room for all its emails and its ack, so the 10th waits whole, and the steps after
    // it find too little for a page and its first unit (they read nothing rather than a page they can't act on).
    const first = await tick();
    expect(first.sum.calls).toEqual({ ops: 1, notices: 1 + 9 * 4 });
    expect(acked.size).toBe(9);
    expect(first.sum.budgetLeft).toBe(2);

    // The next runs carry on from where each job stopped, until every backlog is drained.
    let runs = 1;
    const watched = async () => Number((await db.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM ops.scope_watch WHERE notified_at IS NOT NULL'))[0]!.n);
    const cursor = async (k: string) => Number((await ops.getState([k])).get(k)?.value ?? 0);
    const shares: Record<string, number>[] = [first.sum.calls];
    while (runs < 60) {
      const done = acked.size === NOTICES && invitesAcked.size === INVITES && notified.size === EVENTS && (await cursor(FEED_CURSORS.changes)) === ROWS && (await cursor(FEED_CURSORS.audit)) === ROWS && (await watched()) === SCOPES;
      if (done) break;
      shares.push((await tick()).sum.calls);
      runs++;
    }
    expect(acked.size).toBe(NOTICES);
    expect(invitesAcked.size).toBe(INVITES);
    expect(notified.size).toBe(EVENTS);
    expect(await cursor(FEED_CURSORS.changes)).toBe(ROWS);
    expect(await cursor(FEED_CURSORS.audit)).toBe(ROWS);
    expect(await watched()).toBe(SCOPES);
    expect(runs).toBeLessThan(60);
    // Every job had its share in some run: the feed and the watcher once the notices left room.
    for (const job of ['ops', 'notices', 'feed', 'watcher']) expect(shares.some((s) => (s[job] ?? 0) > 0), job).toBe(true);
    // Each invite's notice and link went out once, each pending scope change once: no message (purpose and recipient)
    // was sent twice, though every run started with an empty memo (as a fresh isolate does; D401).
    for (const n of invites) expect(email.sent.filter((m) => m.to === n.invite.email), n.invite.id).toHaveLength(1);
    expect(new Set(email.sent.map((m) => m.messageKey)).size).toBe(email.sent.length);
  });

  it('a job given too little for a page reads nothing and moves no cursor', async () => {
    const b = new Budget(2);
    const e = env();
    const watchBefore = (await ops.getState([WATCH_CURSOR])).get(WATCH_CURSOR)?.value;
    const feedBefore = await ops.getState([FEED_CURSORS.changes]);
    expect(await runWatcher(e, ops, email, b)).toEqual({ scopes: 0, pendingNotified: 0, diffsNotified: 0, failed: 0 });
    expect(await feedChanges(e, ops, email, b)).toMatchObject({ read: 0, emailedGroups: 0 });
    expect(await runChangeNotices(e, email, b)).toEqual({ acked: 0, failed: 0, skipped: 0 });
    expect(rpc).toEqual([]);
    expect(email.sent).toEqual([]);
    expect(b.spent).toBe(0);
    expect((await ops.getState([WATCH_CURSOR])).get(WATCH_CURSOR)?.value).toBe(watchBefore);
    expect((await ops.getState([FEED_CURSORS.changes])).get(FEED_CURSORS.changes)?.value).toBe(feedBefore.get(FEED_CURSORS.changes)?.value);
  });
});
