// Fake data for the console's local preview harness (preview/mock-api.ts): realistic answers for every SPA screen, in
// the exact shapes the console's `/api/*` routes answer (scripts/test/preview.test.ts checks them against
// console-core's schemas). Dev only: nothing here is built into dist/ or deployed. Every name, address, key and hash is
// invented; none is a real account, key or person.
import type { AppDetail, AppSummary, AuditAnswer, MeAnswer, MembersAnswer, OrgAnswer, PendingUpgradesView, StatementMeta, StatementView, UsageRow } from '@hana-id/console-core';
import { canonicalJson, policyId, validateAutoApprovePolicy } from '@hana-id/core/policy';
import { policyJson } from '../../../packages/core/test/policy-fixtures.ts';

const H = 3_600_000;
const D = 24 * H;

/** A fixed, made-up hex string of `n` characters (keys and hashes that look like the real ones). */
const hex = (seed: string, n: number): string => {
  let out = '';
  let x = 2166136261;
  while (out.length < n) {
    for (const c of seed + out.length) x = Math.imul(x ^ c.charCodeAt(0), 16777619) >>> 0;
    out += x.toString(16).padStart(8, '0');
  }
  return out.slice(0, n);
};

export const ORG_ID = 'org_7Hq2Lm9Xc4';
export const ORG2_ID = 'org_3Bn8Rt5Wp1';

/** The policy the live app runs, validated like the vault validates it (the consent preview renders it). */
export function livePolicy(): { policyId: string; label: string; json: unknown } {
  const opts = { sessionTtlMs: 12 * H };
  const v = validateAutoApprovePolicy({ ...policyJson(), label: 'Swaps on Lumen' }, opts);
  if (!v.ok) throw new Error(`fixture policy: ${v.problems.join('; ')}`);
  return { policyId: policyId(v.policy, opts), label: v.policy.label, json: JSON.parse(canonicalJson(v.policy)) as unknown };
}

const idnOrigin = (display: string): string => new URL(display).origin;

export function me(scenario: { multi: boolean; users: boolean; role: 'owner' | 'viewer'; frozen: boolean }): MeAnswer {
  return {
    user: { id: 'usr_Ak3Pz8Qw2n', email: 'aiko.tanaka@soralabs.io' },
    memberships: [
      { orgId: ORG_ID, orgName: 'Sora Labs', status: scenario.frozen ? 'frozen' : 'active', role: scenario.role },
      ...(scenario.multi ? [{ orgId: ORG2_ID, orgName: 'Kestrel Games', status: 'active' as const, role: 'viewer' as const }] : []),
    ],
    features: { users: scenario.users },
  };
}

export function org(orgId: string, role: 'owner' | 'viewer', frozen: boolean): OrgAnswer {
  if (orgId === ORG2_ID) return { org: { id: ORG2_ID, name: 'Kestrel Games', status: 'active' }, role: 'viewer' };
  return { org: { id: ORG_ID, name: 'Sora Labs', status: frozen ? 'frozen' : 'active', requiredHd: 'soralabs.io' }, role };
}

export function appDetails(now: number): AppDetail[] {
  const policy = livePolicy();
  const idn = 'https://lumènpay.io';
  return [
    {
      id: 'app_Lm4Pq9Zs2v',
      name: 'Lumen Pay',
      scopeId: 's_lumen_live',
      environment: 'live',
      suspendedBy: 0,
      deleted: false,
      activeOrigins: 2,
      pendingChanges: 2,
      createdAt: now - 41 * D,
      orgId: ORG_ID,
      originsVersion: 7,
      settingsVersion: 12,
      origins: [
        { origin: 'https://app.lumenpay.io', display: 'https://app.lumenpay.io', idn: false, activeFrom: now - 40 * D },
        { origin: 'https://pay.lumenpay.io', display: 'https://pay.lumenpay.io', idn: false, activeFrom: now - 12 * D },
        { origin: 'https://checkout.lumenpay.io', display: 'https://checkout.lumenpay.io', idn: false, activeFrom: null, changeId: 'gc_Ch4kq81Ns' },
        { origin: idnOrigin(idn), display: idn, idn: true, activeFrom: null, changeId: 'gc_Id9wz55Fo' },
      ],
      settings: { persistence: 'session', sessionTtlMs: 12 * H, idleTtlMs: 2 * H, googleWebClientId: null, rawSign: 'off', policy },
      changes: [
        {
          id: 'gc_Ch4kq81Ns',
          appId: 'app_Lm4Pq9Zs2v',
          kind: 'origin_add',
          origin: 'https://checkout.lumenpay.io',
          display: 'https://checkout.lumenpay.io',
          idn: false,
          status: 'pending',
          proposedByKind: 'member',
          proposedBy: 'usr_Ak3Pz8Qw2n',
          proposedAt: now - 5 * H - 12 * 60_000,
          requestCountry: 'SG',
          notifiedAt: now - 5 * H - 10 * 60_000,
          activeFrom: now + 18 * H + 50 * 60_000,
        },
        {
          id: 'gc_Id9wz55Fo',
          appId: 'app_Lm4Pq9Zs2v',
          kind: 'origin_add',
          origin: idnOrigin(idn),
          display: idn,
          idn: true,
          status: 'pending',
          proposedByKind: 'member',
          proposedBy: 'usr_Dm7Vx2Kp4r',
          proposedAt: now - 9 * 60_000,
          requestCountry: 'MY',
        },
        {
          id: 'gc_Po2mm71Lk',
          appId: 'app_Lm4Pq9Zs2v',
          kind: 'policy_set',
          policyId: policy.policyId,
          status: 'active',
          proposedByKind: 'member',
          proposedBy: 'usr_Ak3Pz8Qw2n',
          proposedAt: now - 9 * D,
          notifiedAt: now - 9 * D,
          activeFrom: now - 8 * D,
        },
      ],
      keys: [
        { id: 'key_Nw8Lt3Qa1', prefix: 'pk_live_', key: `pk_live_${hex('k1', 32)}`, createdBy: 'usr_Ak3Pz8Qw2n', createdAt: now - 2 * H },
        { id: 'key_Ow2Mz7Pb5', prefix: 'pk_live_', key: `pk_live_${hex('k0', 32)}`, createdBy: 'hana', createdAt: now - 41 * D, revokedAt: now + 22 * H },
        { id: 'key_Ox5Rr4Hc9', prefix: 'pk_live_', key: `pk_live_${hex('k-old', 32)}`, createdBy: 'hana', createdAt: now - 60 * D, revokedAt: now - 30 * D },
      ],
    },
    {
      id: 'app_Ts6Ry1Hn8b',
      name: 'Lumen Pay staging',
      scopeId: 's_lumen_test',
      environment: 'test',
      suspendedBy: 0,
      deleted: false,
      activeOrigins: 2,
      pendingChanges: 0,
      createdAt: now - 52 * D,
      orgId: ORG_ID,
      originsVersion: 3,
      settingsVersion: 4,
      origins: [
        { origin: 'https://staging.lumenpay.io', display: 'https://staging.lumenpay.io', idn: false, activeFrom: now - 50 * D },
        { origin: 'http://localhost:5173', display: 'http://localhost:5173', idn: false, activeFrom: now - 50 * D },
      ],
      settings: { persistence: 'session', sessionTtlMs: 12 * H, idleTtlMs: 2 * H, googleWebClientId: null, rawSign: 'off', policy: null },
      changes: [],
      keys: [{ id: 'key_Tq1Wv6Ms3', prefix: 'pk_test_', key: `pk_test_${hex('t1', 32)}`, createdBy: 'hana', createdAt: now - 52 * D }],
    },
    {
      id: 'app_Rw2Bt7Kd5c',
      name: 'Rewards beta',
      scopeId: 's_rewards_test',
      environment: 'test',
      suspendedBy: 0,
      deleted: false,
      activeOrigins: 0,
      pendingChanges: 0,
      createdAt: now - 3 * H,
      orgId: ORG_ID,
      originsVersion: 0,
      settingsVersion: 0,
      origins: [],
      settings: { persistence: 'session', sessionTtlMs: 12 * H, idleTtlMs: 2 * H, googleWebClientId: null, rawSign: 'off', policy: null },
      changes: [],
      keys: [{ id: 'key_Rb9Xc2Lp7', prefix: 'pk_test_', key: `pk_test_${hex('r1', 32)}`, createdBy: 'hana', createdAt: now - 3 * H }],
    },
    {
      id: 'app_Lg5Yn3Wq8d',
      name: 'Checkout widget (old)',
      scopeId: 's_widget_live',
      environment: 'live',
      suspendedBy: 5,
      deleted: false,
      activeOrigins: 1,
      pendingChanges: 0,
      createdAt: now - 120 * D,
      orgId: ORG_ID,
      originsVersion: 2,
      settingsVersion: 6,
      origins: [{ origin: 'https://widget.lumenpay.io', display: 'https://widget.lumenpay.io', idn: false, activeFrom: now - 118 * D }],
      settings: { persistence: 'none', sessionTtlMs: 4 * H, idleTtlMs: 30 * 60_000, googleWebClientId: '204871935513-k2v9mq8d0w7hj1n3s6e4c5t0b8a2f9xg.apps.googleusercontent.com', rawSign: 'approval', policy: null },
      changes: [],
      keys: [{ id: 'key_Lw3Dd8Zn6', prefix: 'pk_live_', key: `pk_live_${hex('w1', 32)}`, createdBy: 'hana', createdAt: now - 120 * D }],
    },
  ];
}

export const summaryOf = (a: AppDetail): AppSummary => ({
  id: a.id,
  name: a.name,
  scopeId: a.scopeId,
  environment: a.environment,
  suspendedBy: a.suspendedBy,
  deleted: a.deleted,
  activeOrigins: a.activeOrigins,
  pendingChanges: a.pendingChanges,
  ...(a.logoUrl ? { logoUrl: a.logoUrl } : {}),
  createdAt: a.createdAt,
});

export function members(now: number): MembersAnswer {
  return {
    members: [
      { userId: 'usr_Ak3Pz8Qw2n', email: 'aiko.tanaka@soralabs.io', role: 'owner', roleSince: now - 60 * D, addedBy: 'hana', addedAt: now - 60 * D, disabled: false },
      { userId: 'usr_Dm7Vx2Kp4r', email: 'dmitri.volkov@soralabs.io', role: 'owner', roleSince: now - 44 * D, addedBy: 'usr_Ak3Pz8Qw2n', addedAt: now - 58 * D, disabled: false },
      { userId: 'usr_Pr4Gh6Tn1s', email: 'priya.raman@soralabs.io', role: 'viewer', roleSince: now - 20 * D, addedBy: 'usr_Ak3Pz8Qw2n', addedAt: now - 20 * D, disabled: false, pendingOwnerFrom: now + 19 * H },
      { userId: 'usr_Sm9Lk2Vb7q', email: 'sam.okafor@soralabs.io', role: 'viewer', roleSince: now - 33 * D, addedBy: 'usr_Dm7Vx2Kp4r', addedAt: now - 33 * D, disabled: true },
    ],
    invites: [
      { id: 'inv_Nr5Qz1Wm3', email: 'noor.haddad@soralabs.io', role: 'viewer', createdByKind: 'member', createdBy: 'usr_Ak3Pz8Qw2n', notified: true, createdAt: now - D, expiresAt: now + 6 * D },
      { id: 'inv_Le8Tx4Kp6', email: 'lee.jung@soralabs.io', role: 'owner', createdByKind: 'hana', createdBy: 'hana', notified: false, createdAt: now - 20 * 60_000, expiresAt: now + 7 * D - 20 * 60_000 },
    ],
    grants: [
      { id: 'og_Pr2Hm7Lq4', userId: 'usr_Pr4Gh6Tn1s', grantedByKind: 'member', createdAt: now - 5 * H, notifiedAt: now - 5 * H, ownerFrom: now + 19 * H },
      { id: 'og_Le3Wn9Kv1', inviteId: 'inv_Le8Tx4Kp6', grantedByKind: 'hana', createdAt: now - 20 * 60_000 },
    ],
  };
}

export function scope(now: number) {
  return {
    scope: {
      id: 's_lumen_live',
      actionNonce: 6,
      allowShared: true,
      clients: [{ provider: 'google', aud: '204871935513-k2v9mq8d0w7hj1n3s6e4c5t0b8a2f9xg.apps.googleusercontent.com' }],
      owners: [{ kind: 'member', userId: 'usr_Ak3Pz8Qw2n', email: 'aiko.tanaka@soralabs.io', orgOwner: true }, { kind: 'other_google' }],
      pending: [{ id: 3, change: { kind: 'SetOwners', owners: [{ kind: 'member', userId: 'usr_Ak3Pz8Qw2n', email: 'aiko.tanaka@soralabs.io', orgOwner: true }, { kind: 'member', userId: 'usr_Dm7Vx2Kp4r', email: 'dmitri.volkov@soralabs.io', orgOwner: true }] }, unlockAt: now + 21 * H, executable: false }],
    },
    drift: { hasDrift: true, missingOnChain: [{ userId: 'usr_Dm7Vx2Kp4r', email: 'dmitri.volkov@soralabs.io' }], notOrgOwners: [], unknownOnChain: 1 },
    youAreOnChainOwner: true,
  };
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function usage(now: number, by: 'day' | 'month', apps: string[]): UsageRow[] {
  const rows: UsageRow[] = [];
  const want = (id: string) => apps.length === 0 || apps.includes(id);
  const periods = by === 'month' ? [day(now).slice(0, 7)] : [6, 5, 4, 3, 2, 1, 0].map((n) => day(now - n * D));
  periods.forEach((period, i) => {
    const k = i + 3;
    if (want('app_Lm4Pq9Zs2v'))
      rows.push({
        orgId: ORG_ID, appId: 'app_Lm4Pq9Zs2v', scopeId: 's_lumen_live', period,
        logins: 140 + k * 23, derives: 96 + k * 11, revokes: k, unlocks: 210 + k * 9, ownerActions: 0, linkActions: 4 + (k % 3), identityTokens: 320 + k * 17,
        activeUsers: 88 + k * 6, newUsers: 9 + (k % 4), failuresByCode: k % 2 ? { rate_limited: 2, popup_closed: 5 } : { popup_closed: 3 },
        tgas: `${(41.3 + k * 2.17).toFixed(2)}`, relayedRejectedTgas: '0.3', errorTgas: '0.08',
        burntYocto: `${4130 + k * 217}00000000000000000000`, relayedRejectedBurntYocto: '30000000000000000000',
        ...(i < periods.length - 1 ? { usdMicros: `${14455 + k * 760}`, relayedRejectedUsdMicros: '105' } : {}),
        p50: { login: 2310 + k * 12, derive: 1430 }, p95: { login: 4980, derive: 2875 }, unsettled: i === periods.length - 1 ? 7 : 0,
      });
    if (want('app_Ts6Ry1Hn8b'))
      rows.push({
        orgId: ORG_ID, appId: 'app_Ts6Ry1Hn8b', scopeId: 's_lumen_test', period,
        logins: 12 + k, derives: 8, revokes: 0, unlocks: 15, ownerActions: 0, linkActions: 0, identityTokens: 30 + k,
        activeUsers: 6, newUsers: 1, failuresByCode: {}, tgas: '3.92', relayedRejectedTgas: '0', errorTgas: '0',
        burntYocto: '392000000000000000000', ...(i < periods.length - 1 ? { usdMicros: '1372' } : {}),
        p50: { login: 2050 }, p95: { login: 3920 }, unsettled: 0,
      });
  });
  if (apps.length === 0)
    rows.push({
      orgId: ORG_ID, scopeId: 's_lumen_live', period: periods[periods.length - 2] ?? periods[0]!,
      logins: 0, derives: 0, revokes: 0, unlocks: 0, ownerActions: 1, newUsers: 0, failuresByCode: {}, tgas: '2.8', relayedRejectedTgas: '0', errorTgas: '0',
      burntYocto: '280000000000000000000', usdMicros: '980', p50: {}, p95: {}, unsettled: 0,
    });
  return rows;
}

export function statements(now: number): StatementMeta[] {
  const issued = (monthsBack: number) => {
    const d = new Date(now);
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - monthsBack, 1));
    const next = Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 3, 9, 14);
    return { month: m.toISOString().slice(0, 7), at: next };
  };
  const oct = issued(1);
  const sep = issued(2);
  return [
    { orgId: ORG_ID, month: oct.month, asOf: oct.at, csvSha256: hex('csv-oct', 64), pdfSha256: hex('pdf-oct', 64), issuedBy: 'hana', issuedAt: oct.at },
    { orgId: ORG_ID, month: sep.month, asOf: sep.at, csvSha256: hex('csv-sep', 64), issuedBy: 'hana', issuedAt: sep.at },
  ];
}

export function statementView(s: StatementMeta): StatementView {
  return {
    title: `Hana ID usage statement ${s.month}`,
    header: [
      ['Organisation', `Sora Labs (${ORG_ID})`],
      ['Month', s.month],
      ['Network', 'testnet'],
      ['Covers events received up to', new Date(s.asOf).toISOString()],
      ['Statement hash (SHA-256 of the CSV)', s.csvSha256],
    ],
    tableColumns: ['Logins', 'Derives', 'Owner actions', 'MAU', 'New users', 'Tgas', 'NEAR', 'USD', 'Unsettled'],
    table: [
      { label: 'Lumen Pay (app_Lm4Pq9Zs2v)', cells: ['6214', '3870', '0', '2391', '412', '1288.41', '0.128841', '0.450944', '0'] },
      { label: 'Lumen Pay staging (app_Ts6Ry1Hn8b)', cells: ['433', '241', '0', '38', '12', '96.2', '0.00962', '0.03367', '0'] },
      { label: 'Owner actions, scope s_lumen_live', cells: ['0', '0', '3', '', '0', '8.4', '0.00084', '0.00294', '0'] },
    ],
    summary: [
      ['Logins', '6647'],
      ['Link actions', '118'],
      ['Identity tokens', '9840'],
      ['Billed (USD)', '0.486711'],
      ['Relayed-then-rejected, not billed (USD)', '0.000842'],
    ],
    notes: ['Testnet usage, valued at the mainnet NEAR/USD price (D93).', 'Relayed-then-rejected gas is not billed by default (D91); it is shown on its own line.'],
  };
}

export function pendingUpgrades(now: number, paused = false): PendingUpgradesView {
  return {
    signer: 'hana-signer.sandbox-dev.testnet',
    env: 'sandbox-dev',
    readAtMs: now,
    paused,
    governanceDelayMs: 3 * D,
    upgrade: {
      codeHash: '9mXq3Tz7Lr2Bv8Nc4Hd6Ks1Pw5Yf0Ga3Ej7Uo2Ri9Zt',
      proposedAtMs: now - 22 * H,
      executableAtMs: now + 2 * D + 2 * H + 9 * 60_000,
      due: false,
      release: {
        version: '1.6.0',
        commit: hex('release-160', 40),
        buildCommand: 'cd contracts/hana-signer && cargo near build reproducible-wasm',
        previousCommit: hex('release-152', 40),
        diffCommand: `git diff ${hex('release-152', 40)}..${hex('release-160', 40)} -- contracts/hana-signer`,
      },
    },
    ownerTransfer: null,
    withdrawal: null,
    delayDecreases: [],
    consoleAudienceAdditions: [],
    anyPending: true,
  };
}

export function users(now: number) {
  const u = (n: number, sup: string, kinds: { kind: string; status: 'active' | 'pending' }[], evm: string, stellar: string, seen: number) => ({
    userId: `u1_${hex(`user${n}`, 22).replace(/[0-9]/gu, (c) => 'AbCdEfGhIj'[Number(c)]!)}`,
    supportId: sup,
    scopeId: 's_lumen_live',
    createdAt: now - (30 - n) * D,
    lastSeenAt: now - seen,
    accounts: kinds,
    wallets: [
      { chain: 'evm' as const, address: evm, firstSeenAt: now - (30 - n) * D, lastUsedAt: now - seen },
      { chain: 'stellar' as const, address: stellar, firstSeenAt: now - (30 - n) * D, lastUsedAt: now - seen },
    ],
  });
  return [
    u(1, 'HANA-7KQ2-M4XD', [{ kind: 'google', status: 'active' }], '0x4E2a9c1B7d3F6e8A0b5C9d2E7f1A3b6C8d0E2f41', 'GBX4K7QWZ2M5N8P3R6T9V2Y5B8E1H4K7N0Q3S6U9W2Z5C8F1J4L7P2', 14 * 60_000),
    u(2, 'HANA-9TPL-2WRN', [{ kind: 'google', status: 'active' }, { kind: 'email', status: 'active' }], '0x91bD3e7F0a2C4d6E8f1A3b5C7d9E0f2A4b6C8d1E', 'GCQ7M2P5R8T1V4X7Z0B3D6F9H2K5M8P1R4T7V0X3Z6B9D2F5H8K1M4', 3 * H),
    u(3, 'HANA-4HJS-8BQC', [{ kind: 'email', status: 'active' }, { kind: 'google', status: 'pending' }], '0x0c7A2e9B4d1F6a3C8e5B0d7F2a9C4e1B6d3F8a51', 'GDA2C5E8G1J4L7N0Q3S6U9W2Y5A8C1E4G7J0L3N6Q9S2U5W8Y1A4C7', 2 * D),
  ];
}

export function audit(now: number): AuditAnswer {
  const c = (seq: number, at: number, action: string, extra: Record<string, unknown>) => ({ source: 'console' as const, seq, at, actorKind: 'member' as const, actorId: 'usr_Ak3Pz8Qw2n', actorEmail: 'aiko.tanaka@soralabs.io', requestId: `${hex(`rq${seq}`, 16)}-SIN`, outcome: 'ok' as const, action, details: {}, ...extra });
  return {
    entries: [
      c(212, now - 9 * 60_000, 'step_up.confirmed', { appId: 'app_Lm4Pq9Zs2v', details: { kind: 'origin.add' } }),
      { source: 'api', seq: 981, at: now - 2 * H, appId: 'app_Lm4Pq9Zs2v', kind: 'key.created', detail: { prefix: 'pk_live_' }, actorKind: 'member', actorId: 'usr_Ak3Pz8Qw2n', requestId: `${hex('rq981', 16)}-SIN` },
      { source: 'api', seq: 980, at: now - 2 * H, appId: 'app_Lm4Pq9Zs2v', kind: 'key.rotated', detail: { oldKeyRevokedAt: now + 22 * H }, actorKind: 'member', actorId: 'usr_Ak3Pz8Qw2n', requestId: `${hex('rq980', 16)}-SIN` },
      c(211, now - 5 * H, 'member.role', { target: 'usr_Pr4Gh6Tn1s', details: { role: 'owner' } }),
      { ...c(210, now - 6 * H, 'app.logo_set', { appId: 'app_Ts6Ry1Hn8b', details: { code: 'logo_type' } }), outcome: 'failed' as const },
      { source: 'console', seq: 209, at: now - D, actorKind: 'hana', actorId: 'hana', action: 'invite.issued', target: 'inv_Le8Tx4Kp6', details: { role: 'owner' }, requestId: `${hex('rq209', 16)}-AMS`, outcome: 'ok' },
      c(208, now - 2 * D, 'session.signed_in', { details: { invite: false } }),
    ],
    next: '208.979',
  };
}
