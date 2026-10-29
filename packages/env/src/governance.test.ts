// Manifest governance fields (docs/governance-spec.md, D80, D81, D86).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv, manifestPath, manifestSchema } from './index.ts';

const raw = () => JSON.parse(readFileSync(manifestPath('sandbox-dev'), 'utf8')) as Record<string, unknown>;
const issues = (m: Record<string, unknown>) => manifestSchema.safeParse(m).error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [];
const council = { factory: 'sputnikv2.testnet', dao: 'c.sputnikv2.testnet', members: ['a.testnet', 'b.testnet', 'cc.testnet'] };

describe('manifestSchema: governance fields', () => {
  it('all optional (absent ownerKind = an account owner, absent watchdogs = none)', () => {
    const { ownerKind: _o, watchdogs: _w, council: _c, allowSignerFullAccessKey: _a, issuerKeyDelayMs: _i, governanceDelayMs: _g, ...rest } = raw();
    const m = manifestSchema.parse(rest);
    expect(m.ownerKind).toBeUndefined();
    expect(m.watchdogs).toBeUndefined();
    expect(m.council).toBeUndefined();
  });

  it('sandbox-dev declares its council, watchdog and delays (D80) and keeps the signer full-access key (D86)', () => {
    const env = loadEnv('sandbox-dev');
    expect(env.council?.members).toHaveLength(3);
    expect(env.council?.dao.endsWith(`.${env.council.factory}`)).toBe(true);
    expect(env.watchdogs).toHaveLength(1);
    expect(env.ownerKind).toBe('account'); // until the DAO accepts ownership (migration step 6)
    expect(env.issuerKeyDelayMs).toBe(120_000);
    expect(env.governanceDelayMs).toBe(60_000);
    expect(env.allowSignerFullAccessKey).toBe(true);
  });

  it('a council DAO is one label under its factory, with three distinct members that are not env accounts', () => {
    expect(issues({ ...raw(), council })).toEqual([]);
    expect(issues({ ...raw(), council: { ...council, dao: 'c.other.testnet' } })).toEqual([expect.stringMatching(/^council\.dao: council\.dao must be <name>\.sputnikv2\.testnet/u)]);
    expect(issues({ ...raw(), council: { ...council, dao: 'x.c.sputnikv2.testnet' } })).toHaveLength(1);
    expect(issues({ ...raw(), council: { ...council, members: ['a.testnet', 'b.testnet'] } })).toHaveLength(1);
    expect(issues({ ...raw(), council: { ...council, members: ['a.testnet', 'a.testnet', 'b.testnet'] } })).toEqual(['council.members: council.members must be distinct']);
    const signer = raw().signer as string;
    expect(issues({ ...raw(), council: { ...council, members: ['a.testnet', 'b.testnet', signer] } })).toEqual([expect.stringMatching(/must not be the DAO, the signer/u)]);
    expect(issues({ ...raw(), council: { ...council, dao: `${signer.split('.')[0]}.sputnikv2.testnet` } })).toEqual([]);
  });

  it('ownerKind sputnik needs a council whose DAO is the owner', () => {
    const { council: _c, ...noCouncil } = raw();
    expect(issues({ ...noCouncil, ownerKind: 'sputnik' })).toEqual(['ownerKind: ownerKind "sputnik" needs a council']);
    expect(issues({ ...raw(), council, ownerKind: 'sputnik' })).toEqual([`owner: ownerKind "sputnik": owner must be council.dao (${council.dao})`]);
    expect(issues({ ...raw(), council, ownerKind: 'sputnik', owner: council.dao })).toEqual([]);
    expect(issues({ ...raw(), ownerKind: 'multisig2' })).toHaveLength(1);
  });

  it('watchdogs: at most 3, distinct, never an env or council account', () => {
    expect(issues({ ...raw(), watchdogs: ['w1.testnet', 'w2.testnet', 'w3.testnet'] })).toEqual([]);
    expect(issues({ ...raw(), watchdogs: ['w1.testnet', 'w2.testnet', 'w3.testnet', 'w4.testnet'] })).toHaveLength(1);
    expect(issues({ ...raw(), watchdogs: ['w1.testnet', 'w1.testnet'] })).toEqual(['watchdogs: watchdogs must be distinct']);
    expect(issues({ ...raw(), watchdogs: [raw().owner] })).toEqual([expect.stringMatching(/^watchdogs: watchdog .* must be its own account/u)]);
    const members = (raw().council as { members: string[] }).members;
    expect(issues({ ...raw(), watchdogs: [members[0]] })).toHaveLength(1);
  });

  it('delays are bounded like the contract (issuer key ≤ 7 days, governance ≤ 30 days)', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(issues({ ...raw(), issuerKeyDelayMs: 7 * day, governanceDelayMs: 30 * day })).toEqual([]);
    expect(issues({ ...raw(), issuerKeyDelayMs: 7 * day + 1 })).toHaveLength(1);
    expect(issues({ ...raw(), governanceDelayMs: 30 * day + 1 })).toHaveLength(1);
    expect(issues({ ...raw(), governanceDelayMs: -1 })).toHaveLength(1);
  });

  it('allowSignerFullAccessKey is a boolean, refused on any network but testnet (D86; the dev-env rule is deploy-contract’s)', () => {
    expect(issues({ ...raw(), allowSignerFullAccessKey: true })).toEqual([]);
    expect(issues({ ...raw(), allowSignerFullAccessKey: 'yes' })).toHaveLength(1);
    // A mainnet manifest is refused outright today (the network is testnet-only), with or without the flag.
    expect(issues({ ...raw(), network: 'mainnet', allowSignerFullAccessKey: true }).length).toBeGreaterThan(0);
  });

  it('no committed manifest other than sandbox-dev sets allowSignerFullAccessKey', () => {
    const dir = dirname(manifestPath('sandbox-dev'));
    const setting = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .filter((f) => (JSON.parse(readFileSync(join(dir, f), 'utf8')) as { allowSignerFullAccessKey?: unknown }).allowSignerFullAccessKey !== undefined);
    expect(setting).toEqual(['sandbox-dev.json']);
  });
});
