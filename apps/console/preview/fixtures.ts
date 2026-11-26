// Fake data for the console's local preview harness (preview/mock-api.ts): realistic answers for every SPA screen, in
// the exact shapes the console's `/api/*` routes answer (scripts/test/preview.test.ts checks them against
// console-core's schemas). Dev only: nothing here is built into dist/ or deployed. Every name, address, key and hash is
// invented; none is a real account, key or person.
import type { AppEmailAnswer } from '@hana-id/console-core';
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

/** D931: Coffee Club's internationalised web address (its punycode form is what the browser sends). */
const CAFE_DISPLAY = 'https://cafè.coffeeclub.example';
const CAFE = idnOrigin(CAFE_DISPLAY);
/** D931: the request id of Coffee Club's three-address platform request. */
const REQ_COFFEE = 'pf_coffee_request';

export function me(scenario: { multi: boolean; users: boolean; role: 'owner' | 'viewer'; frozen: boolean }): MeAnswer {
  return {
    user: { id: 'usr_Ak3Pz8Qw2n', email: 'aiko.tanaka@examplelabs.example' },
    memberships: [
      { orgId: ORG_ID, orgName: 'Example Labs', status: scenario.frozen ? 'frozen' : 'active', role: scenario.role },
      ...(scenario.multi ? [{ orgId: ORG2_ID, orgName: 'Kestrel Games', status: 'active' as const, role: 'viewer' as const }] : []),
    ],
    features: { users: scenario.users },
    // The env's name, as the console answers it (the Getting started snippet shows it).
    envName: 'sandbox-dev',
  };
}

export function org(orgId: string, role: 'owner' | 'viewer', frozen: boolean): OrgAnswer {
  if (orgId === ORG2_ID) return { org: { id: ORG2_ID, name: 'Kestrel Games', status: 'active' }, role: 'viewer' };
  return { org: { id: ORG_ID, name: 'Example Labs', status: frozen ? 'frozen' : 'active', requiredHd: 'examplelabs.example' }, role };
}

/** The working platform key's id (D930: the creator of the apps the backend made). */
const WORKING_PKC = 'pkc_Wk7Hq2Lm9Xc4Pz';

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
      pendingChanges: 1,
      createdAt: now - 52 * D,
      orgId: ORG_ID,
      originsVersion: 4,
      settingsVersion: 4,
      origins: [
        { origin: 'https://staging.lumenpay.io', display: 'https://staging.lumenpay.io', idn: false, activeFrom: now - 50 * D },
        { origin: 'http://localhost:5173', display: 'http://localhost:5173', idn: false, activeFrom: now - 50 * D },
        { origin: 'https://shop.partner-one.example', display: 'https://shop.partner-one.example', idn: false, activeFrom: null, changeId: 'gc_Pf3Lk8Wd2' },
      ],
      settings: { persistence: 'session', sessionTtlMs: 12 * H, idleTtlMs: 2 * H, googleWebClientId: null, rawSign: 'off', policy: null },
      // D916: a change proposed by the org's platform key (D930: named by its label, the working key's).
      changes: [
        {
          id: 'gc_Pf3Lk8Wd2',
          appId: 'app_Ts6Ry1Hn8b',
          kind: 'origin_add',
          origin: 'https://shop.partner-one.example',
          display: 'https://shop.partner-one.example',
          idn: false,
          status: 'pending',
          proposedByKind: 'platform',
          proposedBy: 'pkc_Wk7Hq2Lm9Xc4Pz',
          proposedAt: now - 20 * 60_000,
          notifiedAt: now - 17 * 60_000,
          activeFrom: now + 24 * H - 17 * 60_000,
          requestId: 'pf_staging_request',
        },
      ],
      keys: [{ id: 'key_Tq1Wv6Ms3', prefix: 'pk_test_', key: `pk_test_${hex('t1', 32)}`, createdBy: 'hana', createdAt: now - 52 * D }],
    },
    {
      id: 'app_Rw2Bt7Kd5c',
      name: 'Rewards beta',
      scopeId: 's_rewards_test',
      environment: 'test',
      suspendedBy: 0,
      deleted: false,
      activeOrigins: 1,
      pendingChanges: 1,
      createdAt: now - 3 * H,
      orgId: ORG_ID,
      originsVersion: 2,
      settingsVersion: 0,
      origins: [
        { origin: 'https://beta.rewards.example', display: 'https://beta.rewards.example', idn: false, activeFrom: now - D - 20 * H, changeId: 'gc_Hs6Cn2Wd9' },
        { origin: 'https://rewards-beta.example', display: 'https://rewards-beta.example', idn: false, activeFrom: now + 24 * H - 45 * 60_000, changeId: 'gc_Hs4Rb8Tq2' },
      ],
      settings: { persistence: 'session', sessionTtlMs: 12 * H, idleTtlMs: 2 * H, googleWebClientId: null, rawSign: 'off', policy: null },
      // D915: a new partner app on a scope Journear marked as shared by several partners' apps: no auto-approve.
      sharedScope: true,
      createdByKind: 'hana',
      sharedWallet: true,
      // D931: on a shared wallet a web address Journear staff add waits for a second person (an owner here, or another
      // staff member); one waits, one a second staff member confirmed.
      changes: [
        { id: 'gc_Hs4Rb8Tq2', appId: 'app_Rw2Bt7Kd5c', kind: 'origin_add', origin: 'https://rewards-beta.example', display: 'https://rewards-beta.example', idn: false, status: 'pending', proposedByKind: 'hana', proposedBy: 'hana', proposedAt: now - 50 * 60_000, notifiedAt: now - 45 * 60_000, activeFrom: now + 24 * H - 45 * 60_000, requestId: 'rq_hs4rb8tq2', secondPerson: true },
        { id: 'gc_Hs6Cn2Wd9', appId: 'app_Rw2Bt7Kd5c', kind: 'origin_add', origin: 'https://beta.rewards.example', display: 'https://beta.rewards.example', idn: false, status: 'active', proposedByKind: 'hana', proposedBy: 'hana', proposedAt: now - 2 * D, notifiedAt: now - 2 * D + 5 * 60_000, activeFrom: now - D - 20 * H, requestId: 'rq_hs6cn2wd9', secondPerson: true, confirmedAt: now - D - 20 * H, confirmedByKind: 'hana' },
      ],
      keys: [{ id: 'key_Rb9Xc2Lp7', prefix: 'pk_test_', key: `pk_test_${hex('r1', 32)}`, createdBy: 'hana', createdAt: now - 3 * H }],
    },
    // D930: an app the org's backend made with its platform key on the shared wallet: one web address working, one an
    // owner confirmed (D931), a request of three it asked for (two waiting after their email, one an IDN, and one
    // cancelled), and a later request whose email hasn't gone out yet; its own User IDs.
    {
      id: 'app_Pk3Cf8Ld2w',
      name: 'Coffee Club',
      scopeId: 's_rewards_test',
      environment: 'test',
      suspendedBy: 0,
      deleted: false,
      activeOrigins: 2,
      pendingChanges: 5,
      createdAt: now - 2 * D,
      orgId: ORG_ID,
      originsVersion: 6,
      settingsVersion: 0,
      origins: [
        { origin: 'https://coffeeclub.example', display: 'https://coffeeclub.example', idn: false, activeFrom: now - D, changeId: 'gc_Pk1Hd3Vc8' },
        { origin: 'https://menu.coffeeclub.example', display: 'https://menu.coffeeclub.example', idn: false, activeFrom: now - 2 * H, changeId: 'gc_Pk9Cf4Mn3' },
        { origin: 'https://order.coffeeclub.example', display: 'https://order.coffeeclub.example', idn: false, activeFrom: now + 24 * H - 12 * 60_000, changeId: 'gc_Pk4Ws9Ra1' },
        { origin: CAFE, display: CAFE_DISPLAY, idn: true, activeFrom: now + 24 * H - 12 * 60_000, changeId: 'gc_Pk6Id3Ka7' },
        { origin: 'https://gift.coffeeclub.example', display: 'https://gift.coffeeclub.example', idn: false, activeFrom: null, changeId: 'gc_Pk5Tq2Nb6' },
        // D934: the network's widget, asked for only inside Coffee Club's other web addresses, with a kiosk page.
        { origin: 'https://widget.lumenpay.example', display: 'https://widget.lumenpay.example', idn: false, activeFrom: now + 24 * H - 9 * 60_000, changeId: 'gc_Pk2Wg7Fr5', frameOnly: true },
        { origin: 'https://kiosk.coffeeclub.example', display: 'https://kiosk.coffeeclub.example', idn: false, activeFrom: now + 24 * H - 9 * 60_000, changeId: 'gc_Pk3Ks5Kd8' },
      ],
      settings: { persistence: 'session', sessionTtlMs: 12 * H, idleTtlMs: 2 * H, googleWebClientId: null, rawSign: 'off', policy: null },
      sharedScope: true,
      createdByKind: 'platform',
      sharedWallet: true,
      userIds: 'app',
      createdByKey: WORKING_PKC,
      changes: [
        { id: 'gc_Pk4Ws9Ra1', appId: 'app_Pk3Cf8Ld2w', kind: 'origin_add', origin: 'https://order.coffeeclub.example', display: 'https://order.coffeeclub.example', idn: false, status: 'pending', proposedByKind: 'platform', proposedBy: 'pkc_Wk7Hq2Lm9Xc4Pz', proposedAt: now - 15 * 60_000, notifiedAt: now - 12 * 60_000, activeFrom: now + 24 * H - 12 * 60_000, requestId: REQ_COFFEE },
        { id: 'gc_Pk6Id3Ka7', appId: 'app_Pk3Cf8Ld2w', kind: 'origin_add', origin: CAFE, display: CAFE_DISPLAY, idn: true, status: 'pending', proposedByKind: 'platform', proposedBy: 'pkc_Wk7Hq2Lm9Xc4Pz', proposedAt: now - 15 * 60_000, notifiedAt: now - 12 * 60_000, activeFrom: now + 24 * H - 12 * 60_000, requestId: REQ_COFFEE },
        { id: 'gc_Pk7Lt8Wq2', appId: 'app_Pk3Cf8Ld2w', kind: 'origin_add', origin: 'https://loyalty.coffeeclub.example', display: 'https://loyalty.coffeeclub.example', idn: false, status: 'cancelled', proposedByKind: 'platform', proposedBy: 'pkc_Wk7Hq2Lm9Xc4Pz', proposedAt: now - 15 * 60_000, notifiedAt: now - 12 * 60_000, cancelledBy: 'usr_Dm7Vx2Kp4r', cancelledAt: now - 8 * 60_000, requestId: REQ_COFFEE },
        { id: 'gc_Pk2Wg7Fr5', appId: 'app_Pk3Cf8Ld2w', kind: 'origin_add', origin: 'https://widget.lumenpay.example', display: 'https://widget.lumenpay.example', idn: false, status: 'pending', proposedByKind: 'platform', proposedBy: 'pkc_Wk7Hq2Lm9Xc4Pz', proposedAt: now - 11 * 60_000, notifiedAt: now - 9 * 60_000, activeFrom: now + 24 * H - 9 * 60_000, requestId: 'pf_widget_request', frameOnly: true },
        { id: 'gc_Pk3Ks5Kd8', appId: 'app_Pk3Cf8Ld2w', kind: 'origin_add', origin: 'https://kiosk.coffeeclub.example', display: 'https://kiosk.coffeeclub.example', idn: false, status: 'pending', proposedByKind: 'platform', proposedBy: 'pkc_Wk7Hq2Lm9Xc4Pz', proposedAt: now - 11 * 60_000, notifiedAt: now - 9 * 60_000, activeFrom: now + 24 * H - 9 * 60_000, requestId: 'pf_widget_request' },
        { id: 'gc_Pk5Tq2Nb6', appId: 'app_Pk3Cf8Ld2w', kind: 'origin_add', origin: 'https://gift.coffeeclub.example', display: 'https://gift.coffeeclub.example', idn: false, status: 'pending', proposedByKind: 'platform', proposedBy: 'pkc_Wk7Hq2Lm9Xc4Pz', proposedAt: now - 3 * 60_000, requestId: 'pf_gift_request' },
        { id: 'gc_Pk9Cf4Mn3', appId: 'app_Pk3Cf8Ld2w', kind: 'origin_add', origin: 'https://menu.coffeeclub.example', display: 'https://menu.coffeeclub.example', idn: false, status: 'active', proposedByKind: 'platform', proposedBy: 'pkc_Wk7Hq2Lm9Xc4Pz', proposedAt: now - 3 * H, notifiedAt: now - 3 * H + 4 * 60_000, activeFrom: now - 2 * H, requestId: 'pf_menu_request', confirmedAt: now - 2 * H, confirmedByKind: 'member' },
      ],
      keys: [{ id: 'key_Pk7Rt3Wm1', prefix: 'pk_test_', key: `pk_test_${hex('cc1', 32)}`, createdBy: 'pkc_Wk7Hq2Lm9Xc4Pz', createdAt: now - 2 * D }],
    },
    // D930: another app the backend made, which the backend suspended (it may resume only its own suspension).
    {
      id: 'app_Pk9Sr4Mx7q',
      name: 'Stamp Rally',
      scopeId: 's_rewards_test',
      environment: 'test',
      suspendedBy: 4,
      deleted: false,
      activeOrigins: 1,
      pendingChanges: 0,
      createdAt: now - 6 * D,
      orgId: ORG_ID,
      originsVersion: 1,
      settingsVersion: 0,
      origins: [{ origin: 'https://stamprally.example', display: 'https://stamprally.example', idn: false, activeFrom: now - 5 * D, changeId: 'gc_Pk8Lm2Qs4' }],
      settings: { persistence: 'session', sessionTtlMs: 12 * H, idleTtlMs: 2 * H, googleWebClientId: null, rawSign: 'off', policy: null },
      sharedScope: true,
      createdByKind: 'platform',
      sharedWallet: true,
      userIds: 'app',
      createdByKey: WORKING_PKC,
      partnerBitBy: 'platform',
      changes: [],
      keys: [{ id: 'key_Pk2Vb6Tn9', prefix: 'pk_test_', key: `pk_test_${hex('sr1', 32)}`, createdBy: 'pkc_Wk7Hq2Lm9Xc4Pz', createdAt: now - 6 * D }],
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
  // D925: the list says which apps share a wallet (the Users screen's search across apps).
  ...(a.sharedScope !== undefined ? { sharedScope: a.sharedScope } : {}),
  // D930: the list marks an app the org's backend made with its platform key.
  ...(a.createdByKind !== undefined ? { createdByKind: a.createdByKind } : {}),
  createdAt: a.createdAt,
});

export function members(now: number): MembersAnswer {
  return {
    members: [
      { userId: 'usr_Ak3Pz8Qw2n', email: 'aiko.tanaka@examplelabs.example', role: 'owner', roleSince: now - 60 * D, addedBy: 'hana', addedAt: now - 60 * D, disabled: false },
      { userId: 'usr_Dm7Vx2Kp4r', email: 'dmitri.volkov@examplelabs.example', role: 'owner', roleSince: now - 44 * D, addedBy: 'usr_Ak3Pz8Qw2n', addedAt: now - 58 * D, disabled: false },
      { userId: 'usr_Pr4Gh6Tn1s', email: 'priya.raman@examplelabs.example', role: 'viewer', roleSince: now - 20 * D, addedBy: 'usr_Ak3Pz8Qw2n', addedAt: now - 20 * D, disabled: false, pendingOwnerFrom: now + 19 * H },
      { userId: 'usr_Sm9Lk2Vb7q', email: 'sam.okafor@examplelabs.example', role: 'viewer', roleSince: now - 33 * D, addedBy: 'usr_Dm7Vx2Kp4r', addedAt: now - 33 * D, disabled: true },
    ],
    invites: [
      { id: 'inv_Nr5Qz1Wm3', email: 'noor.haddad@examplelabs.example', role: 'viewer', createdByKind: 'member', createdBy: 'usr_Ak3Pz8Qw2n', notified: true, createdAt: now - D, expiresAt: now + 6 * D },
      { id: 'inv_Le8Tx4Kp6', email: 'lee.jung@examplelabs.example', role: 'owner', createdByKind: 'hana', createdBy: 'hana', notified: false, createdAt: now - 20 * 60_000, expiresAt: now + 7 * D - 20 * 60_000 },
    ],
    grants: [
      { id: 'og_Pr2Hm7Lq4', userId: 'usr_Pr4Gh6Tn1s', grantedByKind: 'member', createdAt: now - 5 * H, notifiedAt: now - 5 * H, ownerFrom: now + 19 * H },
      { id: 'og_Le3Wn9Kv1', inviteId: 'inv_Le8Tx4Kp6', grantedByKind: 'hana', createdAt: now - 20 * 60_000 },
    ],
  };
}

/** The scope page's answer; `mine` false: the signed-in owner (Aiko) isn't an on-chain owner, Dmitri is. */
export function scope(now: number, mine = true) {
  if (!mine) {
    return {
      scope: {
        id: 's_lumen_live',
        actionNonce: 6,
        allowShared: true,
        clients: [{ provider: 'google', aud: '204871935513-k2v9mq8d0w7hj1n3s6e4c5t0b8a2f9xg.apps.googleusercontent.com' }],
        owners: [{ kind: 'member', userId: 'usr_Dm7Vx2Kp4r', email: 'dmitri.volkov@examplelabs.example', orgOwner: true }],
        pending: [],
      },
      drift: { hasDrift: true, missingOnChain: [{ userId: 'usr_Ak3Pz8Qw2n', email: 'aiko.tanaka@examplelabs.example' }], notOrgOwners: [], unknownOnChain: 0 },
      youAreOnChainOwner: false,
      now,
    };
  }
  return {
    scope: {
      id: 's_lumen_live',
      actionNonce: 6,
      allowShared: true,
      clients: [{ provider: 'google', aud: '204871935513-k2v9mq8d0w7hj1n3s6e4c5t0b8a2f9xg.apps.googleusercontent.com' }],
      owners: [{ kind: 'member', userId: 'usr_Ak3Pz8Qw2n', email: 'aiko.tanaka@examplelabs.example', orgOwner: true }, { kind: 'other_google' }],
      pending: [{ id: 3, change: { kind: 'SetOwners', owners: [{ kind: 'member', userId: 'usr_Ak3Pz8Qw2n', email: 'aiko.tanaka@examplelabs.example', orgOwner: true }, { kind: 'member', userId: 'usr_Dm7Vx2Kp4r', email: 'dmitri.volkov@examplelabs.example', orgOwner: true }] }, unlockAt: now + 21 * H, executable: false }],
    },
    drift: { hasDrift: true, missingOnChain: [{ userId: 'usr_Dm7Vx2Kp4r', email: 'dmitri.volkov@examplelabs.example' }], notOrgOwners: [], unknownOnChain: 1 },
    youAreOnChainOwner: true,
    now,
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
    title: `Journear Passport usage statement ${s.month}`,
    header: [
      ['Organisation', `Example Labs (${ORG_ID})`],
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
  const u = (n: number, sup: string, kinds: { kind: string; status: 'active' | 'pending' }[], evm: string, stellar: string, seen: number, email: string | null = null, near: string | null = null) => ({
    userId: `u1_${hex(`user${n}`, 22).replace(/[0-9]/gu, (c) => 'AbCdEfGhIj'[Number(c)]!)}`,
    supportId: sup,
    scopeId: 's_lumen_live',
    createdAt: now - (30 - n) * D,
    lastSeenAt: now - seen,
    accounts: kinds,
    // The API's order: Stellar, EVM, then NEAR (only for a user who signed in through an SDK of 0.4.0 or later).
    wallets: [
      { chain: 'stellar' as const, address: stellar, firstSeenAt: now - (30 - n) * D, lastUsedAt: now - seen },
      { chain: 'evm' as const, address: evm, firstSeenAt: now - (30 - n) * D, lastUsedAt: now - seen },
      ...(near ? [{ chain: 'near' as const, address: near, firstSeenAt: now - seen, lastUsedAt: now - seen }] : []),
    ],
    email,
    sharedScope: false,
  });
  // D925: a person on the shared wallet of "Rewards beta" (a scope Journear marked), with that scope's IDs.
  const shared = { ...u(4, 'HANA-1K8D-W3QA', [{ kind: 'google', status: 'active' }], '0x7d2E9a4B1c6F3e8A5b0D7c2F9e4A1b6C3d8E5f20', 'GA4D7F0H3K6M9P2R5T8V1X4Z7B0D3F6H9K2M5P8R1T4V7X0Z3B6D9F', 40 * 60_000), userId: 'u1_Jt4wN8pR2xK6mB9qZ3vL7a', scopeId: 's_rewards_test', sharedScope: true };
  return [
    shared,
    u(1, 'HANA-7KQ2-M4XD', [{ kind: 'google', status: 'active' }], '0x4E2a9c1B7d3F6e8A0b5C9d2E7f1A3b6C8d0E2f41', 'GBX4K7QWZ2M5N8P3R6T9V2Y5B8E1H4K7N0Q3S6U9W2Z5C8F1J4L7P2', 14 * 60_000, null, 'a8f3c2d17e4b9056c1d2e3f40718293a4b5c6d7e8f9012a3b4c5d6e7f8091a2b'),
    u(2, 'HANA-9TPL-2WRN', [{ kind: 'google', status: 'active' }, { kind: 'email', status: 'active' }], '0x91bD3e7F0a2C4d6E8f1A3b5C7d9E0f2A4b6C8d1E', 'GCQ7M2P5R8T1V4X7Z0B3D6F9H2K5M8P1R4T7V0X3Z6B9D2F5H8K1M4', 3 * H, null, '3c9e7a1b5d2f4086e9a1b3c5d7e9f1023a4b5c6d7e8f90a1b2c3d4e5f6a7b8c9'),
    u(3, 'HANA-4HJS-8BQC', [{ kind: 'email', status: 'active' }, { kind: 'google', status: 'pending' }], '0x0c7A2e9B4d1F6a3C8e5B0d7F2a9C4e1B6d3F8a51', 'GDA2C5E8G1J4L7N0Q3S6U9W2Y5A8C1E4G7J0L3N6Q9S2U5W8Y1A4C7', 2 * D, 'mei.lin@example.com'),
  ];
}

/** D925: the shared wallet's person across the org's apps (`POST /api/orgs/:org/users/link`), as an owner sees it. */
export function userLink(now: number, query: string) {
  const code = query.replace(/[\s-]/gu, '').toUpperCase();
  const ownStamps = { appId: 'app_Rw2Bt7Kd5c', appName: 'Rewards beta', userId: 'u1_Hx2cV6nT9bQ4wK8mR3zP5g', supportId: 'HANA-7Q2M-K4XP', firstSeenAt: now - 4 * D, lastSeenAt: now - 40 * 60_000 };
  const before = { appId: 'app_Bf1Kd8Mn3x', appName: 'Rewards (first site)', userId: 'u1_Jt4wN8pR2xK6mB9qZ3vL7a', supportId: 'HANA-1K8D-W3QA', firstSeenAt: now - 20 * D, lastSeenAt: now - 5 * D };
  const byOwn = code === 'HANA7Q2MK4XP' || query === ownStamps.userId;
  if (!byOwn && query !== before.userId && code !== 'HANA1K8DW3QA') return undefined;
  return {
    userId: before.userId,
    supportId: before.supportId,
    scopeId: 's_rewards_test',
    match: byOwn ? { kind: query.startsWith('u1_') ? 'userId' : 'supportId', of: 'app', appId: ownStamps.appId } : { kind: query.startsWith('u1_') ? 'userId' : 'supportId', of: 'scope', appId: null },
    apps: [ownStamps, before],
    truncated: false,
  };
}

/** One user's detail (`GET /api/orgs/:org/users/:userId`): the list's fields and each app's shared address. */
export function userDetail(now: number, userId: string) {
  const user = users(now).find((x) => x.userId === userId);
  if (!user) return undefined;
  const emails = user.email ? [{ appId: 'app_Lm4Pq9Zs2v', appName: 'Lumen Wallet', email: user.email, sharedAt: now - 5 * D }] : [];
  return { ...user, emails };
}

export function audit(now: number): AuditAnswer {
  const c = (seq: number, at: number, action: string, extra: Record<string, unknown>) => ({ source: 'console' as const, seq, at, actorKind: 'member' as const, actorId: 'usr_Ak3Pz8Qw2n', actorEmail: 'aiko.tanaka@examplelabs.example', requestId: `${hex(`rq${seq}`, 16)}-SIN`, outcome: 'ok' as const, action, details: {}, ...extra });
  return {
    entries: [
      // D930: an owner took the backend's suspension over.
      c(213, now - 4 * 60_000, 'app.suspended', { appId: 'app_Pk9Sr4Mx7q', target: 'app_Pk9Sr4Mx7q', details: { suspendedBy: 4, takenOver: true } }),
      c(212, now - 9 * 60_000, 'step_up.confirmed', { appId: 'app_Lm4Pq9Zs2v', details: { kind: 'origin.add' } }),
      // D916: a row written by the org's platform key.
      { source: 'api', seq: 985, at: now - 20 * 60_000, appId: 'app_Ts6Ry1Hn8b', kind: 'origin.proposed', detail: { changeId: 'gc_Pf3Lk8Wd2', origin: 'https://shop.partner-one.example' }, actorKind: 'platform', actorId: 'pkc_Wk7Hq2Lm9Xc4Pz', requestId: `pf_${hex('rq985', 29)}` },
      // D930: the backend made an app with its platform key, and suspended another.
      { source: 'api', seq: 986, at: now - 15 * 60_000, appId: 'app_Pk3Cf8Ld2w', kind: 'app.created', detail: { name: 'Coffee Club', plan: 'free', environment: 'test', keyId: 'key_Pk7Rt3Wm1', scopeCreated: false, waiver: null, userIds: 'app', createdBy: 'platform', origins: [{ changeId: 'gc_Pk4Ws9Ra1', origin: 'https://order.coffeeclub.example' }, { changeId: 'gc_Pk6Id3Ka7', origin: CAFE }, { changeId: 'gc_Pk7Lt8Wq2', origin: 'https://loyalty.coffeeclub.example' }] }, actorKind: 'platform', actorId: 'pkc_Wk7Hq2Lm9Xc4Pz', requestId: `pf_${hex('rq986', 29)}` },
      { source: 'api', seq: 987, at: now - 6 * 60_000, appId: 'app_Pk9Sr4Mx7q', kind: 'suspension.set', detail: { bit: 4 }, actorKind: 'platform', actorId: 'pkc_Wk7Hq2Lm9Xc4Pz', requestId: `pf_${hex('rq987', 29)}` },
      // A staff-created app's first origin: announced with the no_session waiver, then recorded by the hourly job.
      { source: 'api', seq: 984, at: now - 40 * 60_000, appId: 'app_Rw2Bt7Kd5c', kind: 'origin.activated', detail: { changeId: 'gc_Rw7Lh2Qa9', kind: 'origin_add', origin: 'http://localhost:5173', policyId: null, activeFrom: now - 3 * H + 4 * 60_000 }, actorKind: 'system', actorId: 'cron', requestId: `${hex('rq984', 16)}-SIN` },
      { source: 'api', seq: 981, at: now - 2 * H, appId: 'app_Lm4Pq9Zs2v', kind: 'key.created', detail: { prefix: 'pk_live_' }, actorKind: 'member', actorId: 'usr_Ak3Pz8Qw2n', requestId: `${hex('rq981', 16)}-SIN` },
      { source: 'api', seq: 980, at: now - 2 * H, appId: 'app_Lm4Pq9Zs2v', kind: 'key.rotated', detail: { oldKeyRevokedAt: now + 22 * H }, actorKind: 'member', actorId: 'usr_Ak3Pz8Qw2n', requestId: `${hex('rq980', 16)}-SIN` },
      { source: 'api', seq: 983, at: now - 3 * H + 4 * 60_000, appId: 'app_Rw2Bt7Kd5c', kind: 'change.announced', detail: { changeId: 'gc_Rw7Lh2Qa9', kind: 'origin_add', origin: 'http://localhost:5173', policyId: null, activeFrom: now - 3 * H + 4 * 60_000, waiver: 'no_session', channel: 'email' }, actorKind: 'system', actorId: 'admin', requestId: `${hex('rq983', 16)}-AMS` },
      { source: 'api', seq: 982, at: now - 3 * H, appId: 'app_Rw2Bt7Kd5c', kind: 'app.created', detail: { name: 'Rewards beta', plan: 'free', environment: 'test', keyId: 'key_Rb9Xc2Lp7', scopeCreated: true, waiver: 'no_session', origins: [{ changeId: 'gc_Rw7Lh2Qa9', origin: 'http://localhost:5173' }] }, actorKind: 'hana', actorId: 'hana', requestId: `${hex('rq982', 16)}-AMS` },
      c(211, now - 5 * H, 'member.role', { target: 'usr_Pr4Gh6Tn1s', details: { role: 'owner' } }),
      { ...c(210, now - 6 * H, 'app.logo_set', { appId: 'app_Ts6Ry1Hn8b', details: { code: 'logo_type' } }), outcome: 'failed' as const },
      { source: 'console', seq: 209, at: now - D, actorKind: 'hana', actorId: 'hana', action: 'invite.issued', target: 'inv_Le8Tx4Kp6', details: { role: 'owner' }, requestId: `${hex('rq209', 16)}-AMS`, outcome: 'ok' },
      c(208, now - 2 * D, 'session.signed_in', { details: { invite: false } }),
    ],
    next: '208.979',
  };
}

/**
 * The Email login page's answer in each state (`?email=off|stuck|waiting|unlocking|ready|on|nochain|…`; a screenshot
 * script opens each). `unlocking` is proposed `since` the state was picked and unlocks 60 s later (sandbox-dev's
 * timelock), so the page's one re-read at that time can be watched.
 */
export function emailStatus(a: { id: string; scopeId: string; settings: { loginMethods?: string | undefined } }, now: number, state: string, since = now): AppEmailAnswer {
  const days = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ day: new Date(now - d * 86_400_000).toISOString().slice(0, 10), sent: 180 - d * 17, bounced: d === 2 ? 4 : 1, complained: d === 4 ? 1 : 0, refused: d === 1 ? 12 : 2 }));
  const deliverability: AppEmailAnswer['deliverability'] = state === 'empty' ? { days: [] } : state === 'nochain' ? { unavailable: true } : { days };
  const scope: AppEmailAnswer['scope'] =
    state === 'nochain' ? { unavailable: true }
    : state === 'on' ? { clientOnChain: true, pending: null, youAreOnChainOwner: true }
    : state === 'waiting' ? { clientOnChain: false, pending: { changeId: 12, unlockAt: now + 3 * 3_600_000, executable: false }, youAreOnChainOwner: true }
    : state === 'ready' ? { clientOnChain: false, pending: { changeId: 12, unlockAt: now - 600_000, executable: true }, youAreOnChainOwner: true }
    : state === 'unlocking' ? { clientOnChain: false, pending: { changeId: 12, unlockAt: since + 60_000, executable: since + 60_000 <= now }, youAreOnChainOwner: true }
    : state === 'stuck' ? { clientOnChain: false, pending: null, youAreOnChainOwner: true }
    : state === 'stuck-other' ? { clientOnChain: false, pending: null, youAreOnChainOwner: false }
    : { clientOnChain: state === 'off-with-client', pending: null, youAreOnChainOwner: state !== 'not-owner' };
  return { emailOn: ['on', 'waiting', 'unlocking', 'ready', 'stuck', 'stuck-other', 'nochain'].includes(state), scopeId: a.scopeId, scope, otherAppsEmailOn: state === 'waiting' ? 1 : 0, available: state !== 'unavailable', deliverability, now };
}

// ---- platform keys (D918) ----

const THUMB = (s: string) => (s.repeat(43)).slice(0, 43);

/** The org's platform keys: one working, one waiting for another owner (a real-money setup, registered by you), one awaiting your acceptance, one stopped. */
export function platformKeys(now: number): import('@hana-id/console-core').PlatformKeyView[] {
  return [
    { id: 'pkc_Wk7Hq2Lm9Xc4Pz', orgId: ORG_ID, label: 'Production backend', thumbprint: THUMB('Nq3vTz8kLm2Xb7Wp_'), scopes: ['s_lumen_test'], status: 'active', state: 'in_force', fourEyes: false, proposedByKind: 'member', proposedBy: 'usr_Dm7Vx2Kp4r', proposedAt: now - 40 * D, notifiedAt: now - 40 * D + 5 * 60_000, activeFrom: now - 40 * D + 20 * 60_000, expiresAt: now + 325 * D, confirmedKind: 'confirm', confirmedBy: 'usr_Ak3Pz8Qw2n', confirmedAt: now - 40 * D + 20 * 60_000, lastUsedAt: now - 6 * 60_000 },
    { id: 'pkc_Ws4Bn8Rt5Wp1Qa', orgId: ORG_ID, label: 'Standby key', thumbprint: THUMB('Hc2Rk9Vd4Jt7Mx1-'), scopes: ['s_lumen_test', 's_rewards_test'], status: 'pending', state: 'waiting', fourEyes: true, proposedByKind: 'member', proposedBy: 'usr_Ak3Pz8Qw2n', proposedAt: now - 2 * H, notifiedAt: now - 2 * H + 4 * 60_000, activeFrom: now + 22 * H },
    { id: 'pkc_Wa9Gh6Tn1sLk2V', orgId: ORG_ID, label: 'Key sent by email', thumbprint: THUMB('Pz5Lq8Wc3Nb6Vt0_'), scopes: ['s_rewards_test'], status: 'awaiting_acceptance', state: 'awaiting_acceptance', fourEyes: false, proposedByKind: 'hana', proposedBy: 'hana', proposedAt: now - 30 * 60_000 },
    { id: 'pkc_Wr2Sm9Lk2Vb7qX', orgId: ORG_ID, label: 'Old laptop key', thumbprint: THUMB('Ty6Mn1Qx4Kc9Rb2-'), scopes: ['s_lumen_test'], status: 'revoked', state: 'revoked', fourEyes: false, proposedByKind: 'member', proposedBy: 'usr_Ak3Pz8Qw2n', proposedAt: now - 90 * D, activeFrom: now - 89 * D, expiresAt: now + 275 * D, revokedAt: now - 41 * D, revokedByKind: 'member', revokeReason: 'Laptop lost' },
  ];
}

export const PLATFORM_PEOPLE: Record<string, string> = { usr_Ak3Pz8Qw2n: 'aiko.tanaka@examplelabs.example', usr_Dm7Vx2Kp4r: 'dmitri.volkov@examplelabs.example' };

/** Why you can or can't accept or confirm each key, as the console's server answers it. */
export function platformKeyAbilities(id: string, role: 'owner' | 'viewer', frozen: boolean): { accept: { allowed: boolean; reason?: string }; confirm: { allowed: boolean; reason?: string } } {
  const no = (reason: string) => ({ allowed: false as const, reason });
  if (role !== 'owner') return { accept: no('Only an owner of your organisation can do this.'), confirm: no('Only an owner of your organisation can do this.') };
  if (frozen) return { accept: no('Journear has frozen your organisation, so keys can’t be accepted or confirmed.'), confirm: no('Journear has frozen your organisation, so keys can’t be accepted or confirmed.') };
  if (id === 'pkc_Ws4Bn8Rt5Wp1Qa') return { accept: no('This key isn’t waiting for an acceptance.'), confirm: no('You registered this key, so another owner must confirm it. If nobody does, it starts working when its wait ends.') };
  if (id === 'pkc_Wa9Gh6Tn1sLk2V') return { accept: { allowed: true }, confirm: no('This key isn’t waiting.') };
  return { accept: no('This key isn’t waiting for an acceptance.'), confirm: no('This key isn’t waiting.') };
}

// ---- platform activity (D930) ----

/** The org's platform calls, newest first (what the backend did with its keys), as `GET …/platform-activity` answers them. */
export function platformCalls(now: number): import('@hana-id/console-core').PlatformCallView[] {
  const k = 'pkc_Wk7Hq2Lm9Xc4Pz';
  const c = (seq: number, ago: number, method: 'GET' | 'POST', route: string, status: number, appId?: string, code?: string) => ({ seq, at: now - ago, keyId: k, method, route, status, requestId: `pf_${hex(`call${seq}`, 29)}`, ...(appId ? { appId } : {}), ...(code ? { code } : {}) });
  return [
    c(412, 6 * 60_000, 'POST', '/v1/platform/apps/:appId/suspend', 200, 'app_Pk9Sr4Mx7q'),
    c(411, 9 * 60_000, 'GET', '/v1/platform/apps/:appId', 200, 'app_Pk3Cf8Ld2w'),
    c(410, 14 * 60_000, 'POST', '/v1/platform/apps', 429, undefined, 'rate_limited'),
    c(409, 15 * 60_000, 'POST', '/v1/platform/apps', 201, 'app_Pk3Cf8Ld2w'),
    c(408, 20 * 60_000, 'POST', '/v1/platform/apps/:appId/origins', 202, 'app_Ts6Ry1Hn8b'),
    c(407, 2 * H, 'POST', '/v1/platform/apps/:appId/origins', 400, 'app_Pk9Sr4Mx7q', 'origin_refused'),
    c(406, 3 * H, 'GET', '/v1/platform/credential', 200),
  ];
}

// ---- an owner's confirmation of web addresses (D931) ----

/**
 * The confirmation page's view of each request (`GET …/confirmations/:changeId`), built from the app fixtures above so
 * the two agree: every web address of the change's request on its app, its state on the server's clock, the key's label
 * or staff, and the other apps of the wallet. Undefined for a change no confirmation page shows (a member's own).
 */
export function confirmationView(now: number, changeId: string): import('@hana-id/console-core').ConfirmationView | undefined {
  const apps = appDetails(now);
  const app = apps.find((a) => a.changes.some((c) => c.id === changeId));
  const first = app?.changes.find((c) => c.id === changeId);
  if (!app || !first || first.kind !== 'origin_add' || !first.requestId || !(first.proposedByKind === 'platform' || first.secondPerson)) return undefined;
  const others = apps.filter((a) => a.scopeId === app.scopeId && a.id !== app.id && !a.deleted).map((a) => a.name).sort();
  const labels = Object.fromEntries(platformKeys(now).map((k) => [k.id, k.label]));
  const changes = app.changes
    .filter((c) => c.kind === 'origin_add' && c.requestId === first.requestId)
    .sort((x, y) => (x.origin! < y.origin! ? -1 : 1))
    .map((c) => {
      const inForce = c.status === 'active' || (c.status === 'pending' && typeof c.activeFrom === 'number' && c.activeFrom <= now);
      const state = c.status === 'cancelled' ? 'cancelled' : c.status === 'ended' ? 'ended' : inForce ? 'in_force' : c.notifiedAt === undefined ? 'waiting_announcement' : 'waiting';
      return { changeId: c.id, origin: c.origin!, display: c.display!, idn: c.idn ?? false, state, activeFrom: c.confirmedAt ?? c.activeFrom ?? null, ...(c.confirmedAt !== undefined ? { confirmedAt: c.confirmedAt } : {}), confirmable: state === 'waiting' && c.confirmedAt === undefined } as const;
    });
  return {
    app: { id: app.id, name: app.name, scopeId: app.scopeId, environment: app.environment, sharedScope: app.sharedScope ?? false, otherApps: others.slice(0, 5), otherAppsTotal: others.length },
    requestId: first.requestId,
    proposedByKind: first.proposedByKind === 'platform' ? 'platform' : 'hana',
    ...(first.proposedByKind === 'platform' ? { keyId: first.proposedBy, keyLabel: labels[first.proposedBy] ?? null } : {}),
    proposedAt: first.proposedAt,
    changes,
  };
}

/** Whether this member may confirm now, as the console's server answers it (apps/console/src/confirmations.ts). */
export function confirmAbility(view: import('@hana-id/console-core').ConfirmationView, s: { role: 'owner' | 'viewer'; frozen: boolean; chainOwner: boolean }): { allowed: true } | { allowed: false; reason: string; code: string } {
  if (s.role !== 'owner') return { allowed: false, code: 'forbidden', reason: 'Only an owner of your organisation can confirm.' };
  if (s.frozen) return { allowed: false, code: 'forbidden', reason: 'Journear has frozen your organisation, so web addresses can’t be confirmed.' };
  if (view.sameAsProposer) return { allowed: false, code: 'forbidden', reason: 'You added these web addresses, so a second person must confirm them.' };
  if (!view.changes.some((c) => c.confirmable))
    return { allowed: false, code: 'not_pending', reason: view.changes.some((c) => c.state === 'waiting_announcement') ? 'Its email hasn’t gone out yet, so it can’t be confirmed yet. Try again in a few minutes.' : 'Nothing here is waiting to be confirmed.' };
  if (!s.chainOwner) return { allowed: false, code: 'not_owner', reason: 'Only an owner of this wallet’s settings can confirm.' };
  return { allowed: true };
}

/**
 * The removal link's page (`POST /api/remove/preview`): Coffee Club's confirmed menu web address (removable), and one
 * already removed through its link. The confirmer is a member by address; staff are "Journear staff".
 */
export function removalPreview(now: number, changeId: string) {
  if (changeId === 'gc_Pk9Cf4Mn3')
    return { changeId, appName: 'Coffee Club', origin: 'https://menu.coffeeclub.example', display: 'https://menu.coffeeclub.example', idn: false, confirmedAt: now - 2 * H, confirmedByKind: 'member' as const, confirmedBy: 'aiko.tanaka@examplelabs.example', until: now - 2 * H + 7 * D, removable: true };
  if (changeId === 'gc_Rm2Xp7Lk4')
    return { changeId, appName: 'Coffee Club', origin: CAFE, display: CAFE_DISPLAY, idn: true, confirmedAt: now - 3 * D, confirmedByKind: 'hana' as const, confirmedBy: 'Journear staff', until: now + 4 * D, removable: false };
  return undefined;
}
