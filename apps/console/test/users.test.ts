// The partner Users screen's data (D310, D346; docs/batch-c-spec.md "What partners never see"): whatever the API's
// ConsoleRpc answers, the console's answer is rebuilt field by field from an allowlist, so no email address, Google
// `sub`, identity key, directory key or internal `hu_…` id can reach a partner, by data shape, not just by what the UI
// renders. Off behind USERS_SCREEN until the wallet directory's reads land (D357).
import { newId } from '@hana-id/console-core';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env.ts';
import { type ConsoleUsersClient, type PartnerUserOut, partnerUserView, usersClient, usersRoute } from '../src/users.ts';
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
  email: 'person@gmail.com',
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
    ]) {
      expect(partnerUserView({ ...leaky(), ...edit }), JSON.stringify(edit)).toBeNull();
    }
    expect(partnerUserView(null)).toBeNull();
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
      return { ok: true, user: leaky() as never };
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
    expect(Object.keys(body.users[0]!).sort()).toEqual(['accounts', 'createdAt', 'lastSeenAt', 'scopeId', 'supportId', 'userId', 'wallets']);
    expect(body.next).toBe(`1800000100000:${USER}`);
    for (const s of PII) expect(JSON.stringify(body), s).not.toContain(s);
    expect(calls[0]).toMatchObject({ orgId: 'org_users1', search: 'GAAA', limit: 50 });
  });

  it('one user by its User ID; a malformed id is 404 before any call; a bad cursor 400', async () => {
    const calls: unknown[] = [];
    const one = await usersRoute(fakeEnv(true, calls), new URL('https://console.test/x'), info, ctx(), USER);
    expect(((await one.json()) as { user: PartnerUserOut }).user.userId).toBe(USER);
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

  it('the deployed config has the screen off: GET /api/orgs/:org/users is 404 for a member', async () => {
    const m = await member('viewer');
    expect((await getAs(m, `/api/orgs/${m.org}/users`)).status).toBe(404);
  });
});
