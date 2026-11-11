// The partner Users screen's data (D310, D346; docs/batch-c-spec.md "What partners never see"): whatever the API's
// ConsoleRpc answers, the console's answer is rebuilt field by field from an allowlist, so no unshared email address,
// Google `sub`, identity key, directory key or internal `hu_…` id can reach a partner, by data shape, not just by what
// the UI renders; a shared address (D411) only in `email` and a detail's `emails`, a shared name (D714) only in `name`,
// each of the expected form. Off behind
// USERS_SCREEN until the wallet directory's reads land (D357).
import { newId } from '@hana-id/console-core';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env.ts';
import { type ConsoleUsersClient, type PartnerUserOut, UNNAMED_APP, partnerUserView, usersClient, usersRoute } from '../src/users.ts';
import { member, getAs } from './c10.ts';

const USER = 'u1_AbCdEfGhIjKlMnOpQrStUA';
const G = `G${'A'.repeat(55)}`;
const EVM = '0x52908400098527886E0F7030069857D2E4169EE7';

/** A row as a buggy or future API might send it: every partner field plus everything a partner must never see. */
const leaky = () => ({
  userId: USER,
  supportId: 'HANA-ABCD-EFGH',
  scopeId: 's1a2',
  createdAt: 1_800_000_000_000,
  lastSeenAt: 1_800_000_100_000,
  accounts: [
    { kind: 'google', status: 'active', sub: '110248495921238986420', email: 'person@gmail.com' },
    { kind: 'email', status: 'pending', address: 'person@example.com', identityKey: 'ab'.repeat(32) },
  ],
  wallets: [
    { chain: 'stellar', address: G, firstSeenAt: 1, lastUsedAt: 2, keyIndex: 0, sharedWith: 3 },
    { chain: 'evm', address: EVM, firstSeenAt: 1, lastUsedAt: 2 },
  ],
  email: null as string | null,
  identities: [{ provider: 'google', sub: '110248495921238986420', directoryKey: { provider: 'google', sub: '110248495921238986420' } }],
  internalId: 'hu_0123456789abcdefghjkmnpqrs',
});

const PII = ['@', '110248495921238986420', 'hu_', 'identityKey', 'directoryKey', 'sub', 'gmail', 'address":"person', 'sharedWith', 'keyIndex'];

describe('partnerUserView: the allowlist', () => {
  it('keeps exactly the partner fields: the User ID, the Support ID, times, account kinds and wallet addresses', () => {
    const v = partnerUserView(leaky())!;
    const expected: PartnerUserOut = {
      userId: USER,
      supportId: 'HANA-ABCD-EFGH',
      scopeId: 's1a2',
      createdAt: 1_800_000_000_000,
      lastSeenAt: 1_800_000_100_000,
      accounts: [
        { kind: 'google', status: 'active' },
        { kind: 'email', status: 'pending' },
      ],
      wallets: [
        { chain: 'stellar', address: G, firstSeenAt: 1, lastUsedAt: 2 },
        { chain: 'evm', address: EVM, firstSeenAt: 1, lastUsedAt: 2 },
      ],
      email: null,
      name: null,
    };
    expect(v).toEqual(expected);
    const text = JSON.stringify(v);
    for (const s of PII) expect(text, s).not.toContain(s);
  });

  it('drops a row that isn’t of the expected form rather than passing it on', () => {
    for (const edit of [
      { userId: 'hu_0123456789abcdefghjkmnpqrs' }, // the internal id is never a partner's User ID (D346)
      { userId: 'person@gmail.com' },
      { supportId: 'person@gmail.com' },
      { scopeId: 'S1' },
      { createdAt: -1 },
      { accounts: [{ kind: 'google' }] },
      { wallets: [{ chain: 'stellar', address: 'person@gmail.com', firstSeenAt: 1, lastUsedAt: 1 }] },
      { wallets: [{ chain: 'evm', address: G, firstSeenAt: 1, lastUsedAt: 1 }] },
      { wallets: 'x' },
      { email: undefined }, // always present: null when not shared
    ]) {
      expect(partnerUserView({ ...leaky(), ...edit }), JSON.stringify(edit)).toBeNull();
    }
    expect(partnerUserView(null)).toBeNull();
  });

  it('a shared address (D411) passes in `email`; the accounts’ own addresses and subs still never do', () => {
    const v = partnerUserView({ ...leaky(), email: 'ada@partner-user.example' })!;
    expect(v.email).toBe('ada@partner-user.example');
    expect('emails' in v).toBe(false); // a list row has no per-app list
    const text = JSON.stringify(v);
    for (const s of ['person@example.com', 'person@gmail.com', '110248495921238986420', 'hu_', 'identityKey', 'directoryKey']) expect(text, s).not.toContain(s);
  });

  it('a malformed `email` drops the row: not a string, no `@` or two, too short or long, whitespace, bidi or control characters', () => {
    for (const email of [42, {}, ['a@b.c'], '', 'a@', '@b', 'ab', 'nobody', 'a@b@c', 'a b@c.d', 'a@b.c\n', `a@${'b'.repeat(253)}`, 'a\u202e@b.c', 'a\u200b@b.c', 'a\u0000@b.c']) {
      expect(partnerUserView({ ...leaky(), email }), JSON.stringify(email)).toBeNull();
    }
    expect(partnerUserView({ ...leaky(), email: `a@${'b'.repeat(252)}` })!.email).toHaveLength(254);
  });

  it('a detail’s `emails` is rebuilt field by field: app id, app name, address, time; other keys dropped', () => {
    const share = { appId: 'app_one1', appName: 'Partner Wallet', email: 'ada@partner-user.example', sharedAt: 1_800_000_200_000 };
    const v = partnerUserView({ ...leaky(), email: share.email, emails: [{ ...share, userSub: USER, emailMac: 'ab'.repeat(32), scopeId: 's1a2', state: 'granted' }] })!;
    expect(v.emails).toEqual([share]);
    expect(Object.keys(v.emails![0]!).sort()).toEqual(['appId', 'appName', 'email', 'sharedAt']);
    expect(partnerUserView({ ...leaky(), emails: [] })!.emails).toEqual([]);
    for (const edit of [
      { appId: 'org_one1' },
      { appId: 'app_' },
      { appId: 'app_a-b' },
      { email: 'not-an-address' },
      { email: null },
      { sharedAt: -1 },
      { sharedAt: '1800000200000' },
    ]) {
      expect(partnerUserView({ ...leaky(), emails: [{ ...share, ...edit }] }), JSON.stringify(edit)).toBeNull();
    }
    // An app name that isn't one display-safe line is shown as a placeholder: the user and the share stay listed.
    for (const appName of ['', '   ', 'x'.repeat(65), 'Evil\u202eApp', 7, null, undefined]) {
      const bad = partnerUserView({ ...leaky(), emails: [{ ...share, appName }] });
      expect(bad, JSON.stringify(appName)).not.toBeNull();
      expect(bad!.emails, JSON.stringify(appName)).toEqual([{ ...share, appName: UNNAMED_APP }]);
    }
    expect(UNNAMED_APP).toBe('Unnamed app');
    expect(partnerUserView({ ...leaky(), emails: 'ada@partner-user.example' })).toBeNull();
    expect(partnerUserView({ ...leaky(), emails: [null] })).toBeNull();
  });

  it('a shared name (D714) passes in `name`, rebuilt to its two parts; absent (an older API) or null is "not shared"', () => {
    const v = partnerUserView({ ...leaky(), name: { givenName: 'Ada', familyName: 'Lovelace', provider: 'google', sub: '110248495921238986420', sharedAt: 5 } })!;
    expect(v.name).toEqual({ givenName: 'Ada', familyName: 'Lovelace' });
    expect(Object.keys(v.name!).sort()).toEqual(['familyName', 'givenName']);
    for (const s of PII) expect(JSON.stringify(v), s).not.toContain(s);
    // Either part alone; the stored form's characters as they are (NFC, inner single spaces, 50 code points).
    expect(partnerUserView({ ...leaky(), name: { givenName: null, familyName: 'Ōkubo' } })!.name).toEqual({ givenName: null, familyName: 'Ōkubo' });
    expect(partnerUserView({ ...leaky(), name: { givenName: 'Mary Ann', familyName: null } })!.name).toEqual({ givenName: 'Mary Ann', familyName: null });
    const fifty = '𝒜'.repeat(50);
    expect(partnerUserView({ ...leaky(), name: { givenName: fifty, familyName: null } })!.name!.givenName).toBe(fifty);
    expect(partnerUserView(leaky())!.name).toBeNull();
    expect(partnerUserView({ ...leaky(), name: null })!.name).toBeNull();
  });

  it('a malformed `name` drops the row: not an object, no part set, a part missing, or a part not in the stored form', () => {
    const bad: unknown[] = [
      'Ada Lovelace',
      42,
      ['Ada'],
      {},
      { givenName: null, familyName: null },
      { givenName: 'Ada' }, // each part present: null when not set
      { givenName: '', familyName: null },
      { givenName: ' Ada', familyName: null },
      { givenName: 'Ada ', familyName: null },
      { givenName: 'Mary  Ann', familyName: null },
      { givenName: 'Mary\tAnn', familyName: null },
      { givenName: 'e\u0301', familyName: null }, // not NFC
      { givenName: 'a'.repeat(51), familyName: null },
      { givenName: 42, familyName: null },
      { givenName: null, familyName: { text: 'Lovelace' } },
      { givenName: 'Ada\u202e', familyName: null },
      { givenName: 'A\u200bda', familyName: null },
      { givenName: 'Ada\nLovelace', familyName: null },
      { givenName: 'Ada\u0000', familyName: null },
    ];
    for (const name of bad) expect(partnerUserView({ ...leaky(), name }), JSON.stringify(name)).toBeNull();
  });

  it('shows an account kind it doesn’t know as "other", never its raw text', () => {
    const v = partnerUserView({ ...leaky(), accounts: [{ kind: 'person@gmail.com', status: 'active' }] })!;
    expect(v.accounts).toEqual([{ kind: 'other', status: 'active' }]);
  });
});

/** A ConsoleRpc stand-in that answers leaky rows. */
function fakeEnv(on: boolean, calls: unknown[] = []): Pick<Env, 'USERS_SCREEN' | 'API'> {
  const client: ConsoleUsersClient = {
    listUsers: async (c) => {
      calls.push(c);
      return { ok: true, users: [leaky() as never, { ...leaky(), userId: 'bad' } as never], nextCursor: `1800000100000:${USER}` };
    },
    getUser: async (c) => {
      calls.push(c);
      const shared = 'ada@partner-user.example';
      return { ok: true, user: { ...leaky(), email: shared, emails: [{ appId: 'app_one1', appName: 'Partner Wallet', email: shared, sharedAt: 5, emailMac: 'ab'.repeat(32) }], name: { givenName: 'Ada', familyName: null, sub: '110248495921238986420' } } as never };
    },
  };
  return { USERS_SCREEN: on ? '1' : undefined, API: client as unknown as Env['API'] };
}

const ctx = () => ({ actor: { kind: 'member' as const, id: newId('user'), sub: 'member-sub', email: 'owner@partner.example', sessionHash: 'A'.repeat(43) }, requestId: 'req_users_test', clientIp: '203.0.113.1', orgId: 'org_users1' });
const info = { requestId: 'req_users_test', clientIp: '203.0.113.1', country: null };

describe('the routes', () => {
  it('are 404 while USERS_SCREEN is off, and when the API has no user reads', async () => {
    expect(usersClient(fakeEnv(false))).toBeNull();
    expect(usersClient({ USERS_SCREEN: '1', API: {} as Env['API'] })).toBeNull();
    expect((await usersRoute(fakeEnv(false), new URL('https://console.test/api/orgs/org_users1/users'), info, ctx(), undefined)).status).toBe(404);
  });

  it('list: only allowlisted fields, malformed rows dropped, the org scoped by the caller; the cursor passed back', async () => {
    const calls: unknown[] = [];
    const res = await usersRoute(fakeEnv(true, calls), new URL('https://console.test/api/orgs/org_users1/users?search=GAAA'), info, ctx(), undefined);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: PartnerUserOut[]; next?: string };
    expect(body.users).toHaveLength(1);
    expect(Object.keys(body.users[0]!).sort()).toEqual(['accounts', 'createdAt', 'email', 'lastSeenAt', 'name', 'scopeId', 'supportId', 'userId', 'wallets']);
    expect([body.users[0]!.email, body.users[0]!.name]).toEqual([null, null]);
    expect(body.next).toBe(`1800000100000:${USER}`);
    for (const s of PII) expect(JSON.stringify(body), s).not.toContain(s);
    expect(calls[0]).toMatchObject({ orgId: 'org_users1', search: 'GAAA', limit: 50 });
  });

  it('one user by its User ID; a malformed id is 404 before any call; a bad cursor 400', async () => {
    const calls: unknown[] = [];
    const one = await usersRoute(fakeEnv(true, calls), new URL('https://console.test/x'), info, ctx(), USER);
    const user = ((await one.json()) as { user: PartnerUserOut }).user;
    expect(user.userId).toBe(USER);
    // The detail carries the shared address and its per-app list, rebuilt (no MAC, no account-level address).
    expect([user.email, user.emails]).toEqual(['ada@partner-user.example', [{ appId: 'app_one1', appName: 'Partner Wallet', email: 'ada@partner-user.example', sharedAt: 5 }]]);
    expect(JSON.stringify(user)).not.toContain('person@');
    // The shared name, rebuilt to its two parts (the sub beside it dropped).
    expect(user.name).toEqual({ givenName: 'Ada', familyName: null });
    expect(JSON.stringify(user)).not.toContain('110248495921238986420');
    expect((await usersRoute(fakeEnv(true, calls), new URL('https://console.test/x'), info, ctx(), 'hu_0123456789abcdefghjkmnpqrs')).status).toBe(404);
    expect(calls).toHaveLength(1);
    expect((await usersRoute(fakeEnv(true), new URL('https://console.test/x?cursor=%27--'), info, ctx(), undefined)).status).toBe(400);
  });

  it('with the flag on, the real ConsoleRpc answers through the binding (an org with no users: an empty page; an unknown user 404)', async () => {
    const { env } = await import('cloudflare:workers');
    const on = { USERS_SCREEN: '1', API: env.API };
    expect(usersClient(on)).not.toBeNull();
    const list = await usersRoute(on, new URL('https://console.test/api/orgs/org_users1/users'), info, ctx(), undefined);
    expect([list.status, await list.json()]).toEqual([200, { users: [] }]);
    expect((await usersRoute(on, new URL('https://console.test/x'), info, ctx(), USER)).status).toBe(404);
  });

  it('the tests’ config (the test manifest, no usersScreen) has the screen off: GET /api/orgs/:org/users is 404 for a member', async () => {
    const m = await member('viewer');
    expect((await getAs(m, `/api/orgs/${m.org}/users`)).status).toBe(404);
  });
});
