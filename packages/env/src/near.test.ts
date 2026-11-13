// Manifest `near` block (D740, D797): the hackathon demo contracts' accounts.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadEnv, manifestPath, manifestSchema } from './index.ts';

const raw = (): Record<string, unknown> => JSON.parse(readFileSync(manifestPath('sandbox-dev'), 'utf8')) as Record<string, unknown>;
const issues = (m: Record<string, unknown>) => manifestSchema.safeParse(m).error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [];
const withBook = (demoGuestbook: unknown, base: Record<string, unknown> = raw()) => ({ ...base, near: { demoGuestbook } });
type Near = { demoGuestbook?: string; demoStamps?: string; relay: { account: string; receivers: string[] } };
/** sandbox-dev's near block with demoStamps set to `demoStamps` (and, unless `listed` is false, in the receivers). */
const withStamps = (demoStamps: unknown, listed = true) => {
  const m = raw();
  const near = m.near as Near;
  const receivers = listed ? [near.demoGuestbook!, demoStamps as string] : [near.demoGuestbook!];
  return { ...m, near: { ...near, demoStamps, relay: { ...near.relay, receivers } } };
};

describe('manifestSchema: near.demoGuestbook (D740)', () => {
  it('sandbox-dev names its guestbook after its other accounts', () => {
    const env = loadEnv('sandbox-dev');
    expect(env.near?.demoGuestbook).toBe('hana-id-guestbook-dev1.testnet');
    expect(env.signer).toBe('hana-id-signer-dev1.testnet');
  });

  it('is optional, and so is the block', () => {
    const { near: _, ...rest } = raw();
    expect(manifestSchema.parse(rest).near).toBeUndefined();
    expect(manifestSchema.parse({ ...rest, near: {} }).near).toEqual({});
  });

  it('accepts a top-level or sub-account ending in .testnet', () => {
    for (const ok of ['guestbook.testnet', 'hana-id-guestbook-dev2.testnet', 'book.hana-id.testnet']) expect(issues(withBook(ok)), ok).toEqual([]);
  });

  it('refuses an account that is not .testnet on testnet: implicit, .near, other suffixes', () => {
    for (const bad of ['a'.repeat(64), 'guestbook.near', 'guestbook.testnet.near', 'testnet', 'guestbook.sputnikv2']) {
      expect(issues(withBook(bad)), bad).toEqual([`near.demoGuestbook: near.demoGuestbook ${bad} must be a .testnet account on testnet`]);
    }
  });

  it('refuses an invalid account id', () => {
    for (const bad of ['Guestbook.testnet', 'guest book.testnet', '', 'x', 7, null]) expect(manifestSchema.safeParse(withBook(bad)).success, String(bad)).toBe(false);
  });

  it('refuses unknown keys in the block', () => {
    expect(manifestSchema.safeParse({ ...raw(), near: { demoGuestbook: 'guestbook.testnet', relayer: 'x.testnet' } }).success).toBe(false);
  });

  it('must be its own account: never the signer, relayer, owner, MPC or a governance account', () => {
    const m = raw();
    const council = m.council as { factory: string; dao: string; members: string[] };
    const watchdog = m.watchdog as { account: string };
    const taken: [string, string][] = [
      ['signer', m.signer as string],
      ['relayer', m.relayer as string],
      ['owner', m.owner as string],
      ['council.factory', council.factory],
      ['council.dao', council.dao],
      ['a council member', council.members[1]!],
      ['a watchdog', (m.watchdogs as string[])[0]!],
      ['watchdog.account', watchdog.account],
    ];
    for (const [role, account] of taken) {
      expect(issues(withBook(account)), role).toContain(`near.demoGuestbook: near.demoGuestbook must be its own account, not ${role} (${account}): deploy-guestbook deploys code to it`);
    }
    // The MPC is v1.signer-prod.testnet on sandbox-dev (a .testnet sub-account): the suffix rule alone would let it through.
    expect(issues(withBook(m.mpc))).toEqual([`near.demoGuestbook: near.demoGuestbook must be its own account, not mpc (${String(m.mpc)}): deploy-guestbook deploys code to it`]);
  });
});

describe('manifestSchema: near.demoStamps (D797)', () => {
  it('sandbox-dev names its stamps contract after its other accounts and relays to it', () => {
    const env = loadEnv('sandbox-dev');
    expect(env.near?.demoStamps).toBe('hana-id-stamps-dev1.testnet');
    expect(env.near?.relay?.receivers).toContain('hana-id-stamps-dev1.testnet');
    expect(env.near?.relay?.receivers).toContain(env.near?.demoGuestbook);
  });

  it('is optional', () => {
    const m = raw();
    const { demoStamps: _, ...near } = m.near as Near;
    expect(issues({ ...m, near })).toEqual([]);
  });

  it('accepts a top-level or sub-account ending in .testnet that the relay lists', () => {
    for (const ok of ['stamps.testnet', 'hana-id-stamps-dev2.testnet', 'stamps.hana-id.testnet']) expect(issues(withStamps(ok)), ok).toEqual([]);
  });

  it('must be one of near.relay.receivers, and needs the relay', () => {
    expect(issues(withStamps('stamps.testnet', false))).toEqual(['near.demoStamps: near.demoStamps stamps.testnet must be one of near.relay.receivers: its stamps are relayed meta transactions']);
    const m = raw();
    const { relay: _, ...near } = m.near as Near;
    expect(issues({ ...m, near: { ...near, demoStamps: 'stamps.testnet' } })).toEqual(['near.demoStamps: near.demoStamps stamps.testnet must be one of near.relay.receivers: its stamps are relayed meta transactions']);
  });

  it('refuses an account that is not .testnet on testnet', () => {
    for (const bad of ['a'.repeat(64), 'stamps.near', 'stamps.testnet.near', 'testnet']) {
      expect(issues(withStamps(bad)), bad).toContain(`near.demoStamps: near.demoStamps ${bad} must be a .testnet account on testnet`);
    }
  });

  it('refuses an invalid account id', () => {
    for (const bad of ['Stamps.testnet', 'st amps.testnet', '', 7, null]) expect(manifestSchema.safeParse(withStamps(bad)).success, String(bad)).toBe(false);
  });

  it('must be its own account: never the guestbook, the relay account, the signer or another named account', () => {
    const m = raw();
    const near = m.near as Near;
    expect(issues(withStamps(near.demoGuestbook))).toContain(`near.demoStamps: near.demoStamps must be its own account, not near.demoGuestbook (${near.demoGuestbook}): deploy-stamps deploys code to it`);
    for (const [role, account] of [
      ['signer', m.signer as string],
      ['relayer', m.relayer as string],
      ['owner', m.owner as string],
      ['mpc', m.mpc as string],
      ['a watchdog', (m.watchdogs as string[])[0]!],
    ] as const) {
      expect(issues(withStamps(account)), role).toContain(`near.demoStamps: near.demoStamps must be its own account, not ${role} (${account}): deploy-stamps deploys code to it`);
    }
    // The relay account may not be the stamps contract (its keys pay for every relay).
    expect(issues({ ...m, near: { ...near, demoStamps: near.relay.account, relay: { ...near.relay, receivers: [near.demoGuestbook!] } } }).join(' ')).toContain('near.relay.account must be its own account, not the near.demoStamps');
  });
});
