// Manifest `evm.sponsor` (D834–D836): EVM gas sponsorship's schema, its rules and bounds, the pinned-delegate check
// and the vault build's table. sandbox-dev carries no such block: every case adds the fixture to a copy in memory.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checksumEvmAddress,
  EVM_SPONSOR_BOUNDS,
  evmSponsorDelegateProblems,
  evmSponsorPageChains,
  evmSponsorProblems,
  LOCAL_EVM_CHAIN_IDS,
  loadEnv,
  manifestPath,
  manifestSchema,
  OP_STACK_TEST_CHAIN_IDS,
  sponsorDecimalUnits,
  SPONSOR_TEST_EVM_CHAIN_IDS,
  type EvmSponsor,
} from './index.ts';
import { CHECK_IN_SELECTOR, FIXTURE_APP, FIXTURE_CHECK_IN, FIXTURE_DELEGATE, FIXTURE_PINNED_DELEGATES, FIXTURE_RELAYER, fixtureAddress, sponsorFixture } from './evm-sponsor.fixture.ts';

const raw = (): Record<string, unknown> => JSON.parse(readFileSync(manifestPath('sandbox-dev'), 'utf8')) as Record<string, unknown>;
const withSponsor = (sponsor: unknown, base: Record<string, unknown> = raw()) => ({ ...base, evm: { sponsor } });
const messages = (m: unknown): string[] => {
  const r = manifestSchema.safeParse(m);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};
const refused = (sponsor: unknown): boolean => !manifestSchema.safeParse(withSponsor(sponsor)).success;

type Chain = EvmSponsor['chains'][string];
/** The fixture with chain 84532's fields replaced. */
const chain = (fields: Partial<Record<keyof Chain, unknown>> & Record<string, unknown>): Record<string, unknown> => {
  const s = sponsorFixture();
  return { ...s, chains: { '84532': { ...s.chains['84532'], ...fields } } };
};
/** The fixture with the app's 84532 targets replaced. */
const targets = (list: unknown[]): Record<string, unknown> => ({ ...sponsorFixture(), apps: { [FIXTURE_APP]: { '84532': list } } });
const target = (fields: Record<string, unknown>) => ({ address: FIXTURE_CHECK_IN, selectors: [CHECK_IN_SELECTOR], maxDataBytes: 36, label: 'Check-in', ...fields });
/** evmSponsorProblems' messages for a manifest-like value (rules beyond the shape, any env name or network). */
const problems = (sponsor: EvmSponsor, name = 'sandbox-dev', network = 'testnet') => evmSponsorProblems({ name, network, evm: { sponsor } }).map((p) => p.message);

describe('evm.sponsor: optional, off when absent (D834)', () => {
  it('sandbox-dev has no evm block, so sponsorship is off there', () => {
    expect(loadEnv('sandbox-dev').evm).toBeUndefined();
    expect(raw()).not.toHaveProperty('evm');
  });

  it('accepts no block, an empty evm block, and the spec’s block', () => {
    expect(manifestSchema.safeParse(raw()).success).toBe(true);
    expect(manifestSchema.parse({ ...raw(), evm: {} }).evm).toEqual({});
    expect(messages(withSponsor(sponsorFixture()))).toEqual([]);
    expect(manifestSchema.parse(withSponsor(sponsorFixture())).evm?.sponsor).toEqual(sponsorFixture());
    expect(evmSponsorProblems({ name: 'sandbox-dev', network: 'testnet' })).toEqual([]);
  });

  it('accepts an empty allowlist (sponsorship configured, nothing sponsored) and optional fields left out', () => {
    expect(messages(withSponsor({ ...sponsorFixture(), apps: {} }))).toEqual([]);
    const { requireKnownAccount: _r, ...bare } = sponsorFixture().chains['84532']!;
    expect(messages(withSponsor({ ...sponsorFixture(), chains: { '84532': bare } }))).toEqual([]);
  });

  it('requires rpcFallback outside local* envs: the vault signs the one-time setup only when two providers agree (D855)', () => {
    const { rpcFallback: _f, ...noFallback } = sponsorFixture().chains['84532']!;
    expect(problems({ ...sponsorFixture(), chains: { '84532': noFallback } })).toContain(
      'evm.sponsor.chains.84532.rpcFallback is required outside local* envs: the vault reads the account from two providers before it signs the one-time setup',
    );
    const s = sponsorFixture();
    const local: EvmSponsor = { ...s, chains: { '31337': { ...s.chains['84532']!, opStack: false, rpc: 'http://127.0.0.1:8545', rpcFallback: undefined } }, apps: {} };
    expect(problems(local, 'local-dev')).toEqual([]);
  });

  it('refuses null for the optional fields', () => {
    expect(refused(chain({ requireKnownAccount: null }))).toBe(true);
    expect(refused(chain({ rpcFallback: null }))).toBe(true);
  });

  it('refuses __proto__, constructor and prototype keys anywhere in the block (as JSON.parse reads a manifest)', () => {
    const json = JSON.stringify(withSponsor(sponsorFixture()));
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      for (const [from, to] of [
        ['"chains":{', `"chains":{"${key}":{},`],
        ['"apps":{', `"apps":{"${key}":{"84532":[]},`],
        [`"${FIXTURE_APP}":{`, `"${FIXTURE_APP}":{"${key}":[],`],
        ['"rpc":"https://sepolia.base.org"', `"${key}":1,"rpc":"https://sepolia.base.org"`],
        ['"label":', `"${key}":1,"label":`],
      ] as const) {
        const m = JSON.parse(json.replace(from, to)) as unknown;
        expect(messages(m).join(' '), `${key} ${from}`).toMatch(new RegExp(`forbidden key ${key}`, 'u'));
      }
    }
  });

  it('refuses unknown fields at every level, and missing required ones', () => {
    expect(refused({ ...sponsorFixture(), relayerKey: 'x' })).toBe(true);
    expect(manifestSchema.safeParse({ ...raw(), evm: { sponsor: sponsorFixture(), other: 1 } }).success).toBe(false);
    expect(refused(chain({ gasPrice: 1 }))).toBe(true);
    expect(refused(targets([target({ value: '1' })]))).toBe(true);
    for (const field of ['rpc', 'delegate', 'opStack', 'maxGasPerTx', 'maxFeePerGasGwei', 'maxPriorityFeePerGasGwei', 'maxCallsPerBatch', 'deadlineMaxS', 'minGas', 'dailyBudgetEth', 'appDailyBudgetEth', 'lowBalanceEth', 'perUserPerDay', 'perAppPerDay', 'sendsPerDay', 'sendsPerMinute'] as const) {
      expect(refused(chain({ [field]: undefined })), field).toBe(true);
    }
    for (const field of ['relayerAddress', 'chains', 'apps']) {
      const s: Record<string, unknown> = sponsorFixture();
      delete s[field];
      expect(refused(s), field).toBe(true);
    }
  });
});

describe('evm.sponsor: testnet only', () => {
  it('refuses the block on any network but testnet (the manifest itself is testnet-only today)', () => {
    expect(problems(sponsorFixture(), 'prod', 'mainnet')).toContain('evm.sponsor is testnet only (network mainnet)');
    expect(manifestSchema.safeParse({ ...withSponsor(sponsorFixture()), network: 'mainnet' }).success).toBe(false);
  });

  it('requireKnownAccount: a boolean, default on; false only in local* envs', () => {
    const msg = 'evm.sponsor.chains.84532.requireKnownAccount false is only for local* envs (the relayer then pays for anyone holding a publishable key)';
    expect(messages(withSponsor(chain({ requireKnownAccount: false }))).some((m) => m.includes('false is only for local* envs'))).toBe(true);
    expect(refused(chain({ requireKnownAccount: 'no' }))).toBe(true);
    const off = chain({ requireKnownAccount: false }) as EvmSponsor;
    expect(problems(off, 'prod', 'mainnet')).toContain(msg);
    expect(problems(off, 'local-dev', 'testnet')).not.toContain(msg);
  });
});

describe('evm.sponsor: chains', () => {
  it('lists the same test chain IDs as core’s TEST_EVM_CHAINS (checked against core in packages/web), local ones and OP Stack ones among them', () => {
    expect(SPONSOR_TEST_EVM_CHAIN_IDS).toContain(84532);
    expect(LOCAL_EVM_CHAIN_IDS.every((id) => SPONSOR_TEST_EVM_CHAIN_IDS.includes(id))).toBe(true);
    expect(OP_STACK_TEST_CHAIN_IDS.every((id) => SPONSOR_TEST_EVM_CHAIN_IDS.includes(id))).toBe(true);
    for (const mainnet of [1, 10, 56, 137, 146, 8453, 42161, 43114]) expect(SPONSOR_TEST_EVM_CHAIN_IDS).not.toContain(mainnet);
  });

  it('refuses a chain that is not a known EVM test chain: mainnets and unknown chains', () => {
    for (const id of ['1', '8453', '10', '999999']) {
      const s = sponsorFixture();
      const sponsor = { ...s, chains: { [id]: { ...s.chains['84532']!, opStack: false } }, apps: {} };
      expect(messages(withSponsor(sponsor)), id).toContain(`evm.sponsor.chains.${id}: evm.sponsor.chains: ${id} is not a known EVM test chain (TEST_EVM_CHAINS)`);
    }
  });

  it('allows a local dev chain (31337, 1337) only in local* envs', () => {
    for (const id of ['31337', '1337']) {
      const s = sponsorFixture();
      const sponsor: EvmSponsor = { ...s, chains: { [id]: { ...s.chains['84532']!, opStack: false, rpc: 'http://127.0.0.1:8545', rpcFallback: undefined } }, apps: {} };
      expect(problems(sponsor, 'sandbox-dev'), id).toContain(`evm.sponsor.chains: the local dev chain ${id} is only for local* envs`);
      expect(problems(sponsor, 'local-dev'), id).toEqual([]);
    }
  });

  it('refuses chain keys that are not decimal chain IDs', () => {
    for (const key of ['0x14a34', '084532', '-1', '0', 'base', '99999999999999999']) {
      const s = sponsorFixture();
      expect(refused({ ...s, chains: { [key]: s.chains['84532'] }, apps: {} }), key).toBe(true);
    }
  });

  it('takes 1 to 4 chains', () => {
    expect(problems({ ...sponsorFixture(), chains: {}, apps: {} })).toContain(`evm.sponsor.chains has 1 to ${EVM_SPONSOR_BOUNDS.chains} chains`);
    const c = sponsorFixture().chains['84532']!;
    const five = Object.fromEntries(['11155111', '17000', '421614', '11155420', '84532'].map((id) => [id, { ...c, opStack: OP_STACK_TEST_CHAIN_IDS.includes(Number(id)) }]));
    expect(problems({ ...sponsorFixture(), chains: five })).toContain(`evm.sponsor.chains has 1 to ${EVM_SPONSOR_BOUNDS.chains} chains`);
    expect(problems({ ...sponsorFixture(), chains: { '84532': five['84532']!, '11155111': five['11155111']!, '17000': five['17000']!, '421614': five['421614']! } })).toEqual([]);
  });

  it('opStack must be true on OP Stack chains (Base Sepolia, OP Sepolia) and false elsewhere', () => {
    expect(messages(withSponsor(chain({ opStack: false })))).toContain('evm.sponsor.chains.84532.opStack: evm.sponsor.chains.84532.opStack must be true for chain 84532');
    const s = sponsorFixture();
    expect(problems({ ...s, chains: { '11155111': { ...s.chains['84532']!, opStack: true } }, apps: {} })).toContain('evm.sponsor.chains.11155111.opStack must be false for chain 11155111');
    expect(refused(chain({ opStack: 'yes' }))).toBe(true);
  });
});

describe('evm.sponsor: endpoints', () => {
  it('rpc and rpcFallback: https, no credentials; http only for a loopback host in local* envs', () => {
    expect(messages(withSponsor(chain({ rpc: 'http://sepolia.base.org' })))).toContain('evm.sponsor.chains.84532.rpc: evm.sponsor.chains.84532.rpc must be an https URL (http only for a loopback host in local* envs)');
    for (const rpc of ['http://127.0.0.1:8545', 'https://127.0.0.1', 'https://[::1]', 'https://localhost.', 'https://a_b.localhost', 'https://[::ffff:127.0.0.1]']) {
      expect(messages(withSponsor(chain({ rpc }))).join(' '), rpc).toMatch(/rpc must not be a loopback host outside local\* envs/u);
    }
    for (const rpc of ['https://169.254.1.1', 'https://[fe80::1]', 'https://10.0.0.1']) expect(messages(withSponsor(chain({ rpc }))).join(' '), rpc).toMatch(/rpc must be a DNS name, not an IP address/u);
    expect(messages(withSponsor(chain({ rpc: 'https://node.local' }))).join(' ')).toMatch(/must not be a link-local \(\.local\) name/u);
    // No API keys in manifest URLs: no path, query or fragment (a keyed RPC goes in a secret).
    for (const rpc of ['https://rpc.example.org/v2/abc', 'https://rpc.example.org/?key=abc', 'https://rpc.example.org/#k']) expect(messages(withSponsor(chain({ rpc }))).join(' '), rpc).toMatch(/a keyed RPC goes in a secret/u);
    expect(messages(withSponsor(chain({ rpc: 'https://sepolia.base.org/' })))).toEqual([]);
    expect(messages(withSponsor(chain({ rpc: 'https://user:pw@sepolia.base.org' }))).join(' ')).toMatch(/rpc must not carry credentials/u);
    expect(messages(withSponsor(chain({ rpcFallback: 'ftp://x.example' }))).join(' ')).toMatch(/rpcFallback must be an https URL/u);
    expect(refused(chain({ rpc: 'not a url' }))).toBe(true);
    const local = chain({ rpc: 'http://127.0.0.1:8545', rpcFallback: 'http://localhost:8546' }) as EvmSponsor;
    expect(problems(local, 'local-dev')).toEqual([]);
    for (const rpc of ['http://localhost.:8545', 'http://[::ffff:127.0.0.1]:8545', 'http://a_b.localhost:8545']) expect(problems(chain({ rpc }) as EvmSponsor, 'local-dev'), rpc).toEqual([]);
  });

  it('rpcFallback is another endpoint, of another provider outside local* envs', () => {
    expect(messages(withSponsor(chain({ rpcFallback: 'https://sepolia.base.org' }))).join(' ')).toMatch(/rpcFallback must be a different endpoint from rpc/u);
    expect(messages(withSponsor(chain({ rpcFallback: 'https://other.base.org' }))).join(' ')).toMatch(/rpcFallback must be another provider \(registrable domain\) than rpc/u);
    expect(problems(chain({ rpc: 'http://127.0.0.1:8545', rpcFallback: 'http://127.0.0.1:8546' }) as EvmSponsor, 'local-dev')).toEqual([]);
  });
});

describe('evm.sponsor: limits (D836)', () => {
  it('refuses each per-app value at or above the env’s', () => {
    for (const [fields, msg] of [
      [{ appDailyBudgetEth: 0.02 }, 'appDailyBudgetEth (0.02) must be below dailyBudgetEth (0.02)'],
      [{ appDailyBudgetEth: 0.03 }, 'appDailyBudgetEth (0.03) must be below dailyBudgetEth (0.02)'],
      [{ perAppPerDay: 5000 }, 'perAppPerDay (5000) must be below sendsPerDay (5000)'],
      [{ perAppPerDay: 6000 }, 'perAppPerDay (6000) must be below sendsPerDay (5000)'],
    ] as const) {
      expect(messages(withSponsor(chain(fields))).join(' '), msg).toContain(`evm.sponsor.chains.84532.${msg}`);
    }
    expect(messages(withSponsor(chain({ appDailyBudgetEth: 0.019999999, perAppPerDay: 4999 })))).toEqual([]);
  });

  it('keeps gas and fees consistent: minGas below maxGasPerTx, priority fee at most the fee cap', () => {
    expect(messages(withSponsor(chain({ minGas: 300_000 }))).join(' ')).toMatch(/minGas \(300000\) must be below maxGasPerTx \(300000\)/u);
    expect(messages(withSponsor(chain({ maxPriorityFeePerGasGwei: 1.5 }))).join(' ')).toMatch(/maxPriorityFeePerGasGwei \(1\.5\) must not exceed maxFeePerGasGwei \(1\)/u);
    expect(messages(withSponsor(chain({ maxPriorityFeePerGasGwei: 1 })))).toEqual([]);
    // The tip cap must leave a starting tip of at least 1 wei after the relayer's two bumps: 3 wei or more.
    for (const tiny of [0, 0.000000002]) expect(messages(withSponsor(chain({ maxPriorityFeePerGasGwei: tiny }))).join(' ')).toMatch(/maxPriorityFeePerGasGwei is too small: after the two fee bumps/u);
    expect(messages(withSponsor(chain({ maxPriorityFeePerGasGwei: 0.000000003 })))).toEqual([]);
  });

  it('deadlineMaxS at most 300; maxCallsPerBatch × the largest target maxDataBytes at most 30 KiB (the relayer\'s calldata limit)', () => {
    expect(refused(chain({ deadlineMaxS: 301 }))).toBe(true);
    expect(messages(withSponsor(chain({ deadlineMaxS: 300 })))).toEqual([]);
    const big = (maxCallsPerBatch: number, maxDataBytes: number) => ({ ...chain({ maxCallsPerBatch }), apps: { [FIXTURE_APP]: { '84532': [target({ maxDataBytes })] } } });
    expect(messages(withSponsor(big(4, 7680)))).toEqual([]);
    expect(messages(withSponsor(big(4, 7681))).join(' ')).toMatch(/maxCallsPerBatch × the largest target maxDataBytes is 30724 bytes; the relayer sends at most 30720 bytes/u);
    expect(messages(withSponsor(big(8, 8192))).join(' ')).toMatch(/is 65536 bytes/u);
  });

  it('one transaction’s worst case (maxGasPerTx × maxFeePerGasGwei) must fit in the app’s day', () => {
    // 1 000 000 gas × 20 gwei = 0.02 ETH > 0.01.
    expect(messages(withSponsor(chain({ maxGasPerTx: 1_000_000, maxFeePerGasGwei: 20 }))).join(' ')).toMatch(/one transaction's worst case\) must fit in appDailyBudgetEth \(0\.01\)/u);
    // 1 000 000 gas × 10 gwei = 0.01 ETH: exactly fits.
    expect(messages(withSponsor(chain({ maxGasPerTx: 1_000_000, maxFeePerGasGwei: 10 })))).toEqual([]);
  });

  it('bounds every number (hard upper and lower bounds, integers where counts)', () => {
    const b = EVM_SPONSOR_BOUNDS;
    const bad: Partial<Record<keyof Chain, unknown>>[] = [
      { maxGasPerTx: b.maxGasPerTx.min - 1 },
      { maxGasPerTx: b.maxGasPerTx.max + 1 },
      { maxGasPerTx: 300_000.5 },
      { minGas: b.minGas.min - 1 },
      { minGas: b.minGas.max + 1 },
      { maxFeePerGasGwei: 0 },
      { maxFeePerGasGwei: -1 },
      { maxFeePerGasGwei: b.maxFeePerGasGwei + 1 },
      { maxFeePerGasGwei: 1.0000000001 },
      { maxPriorityFeePerGasGwei: -0.01 },
      { maxPriorityFeePerGasGwei: 0.0000000001 },
      { maxCallsPerBatch: 0 },
      { maxCallsPerBatch: b.maxCallsPerBatch + 1 },
      { deadlineMaxS: b.deadlineMaxS.min - 1 },
      { deadlineMaxS: b.deadlineMaxS.max + 1 },
      { dailyBudgetEth: 0 },
      { dailyBudgetEth: b.dailyBudgetEth + 0.1 },
      { dailyBudgetEth: 0.0200000001 },
      { appDailyBudgetEth: 0 },
      { appDailyBudgetEth: 0.0000000001 },
      { lowBalanceEth: 0 },
      { lowBalanceEth: b.lowBalanceEth + 1 },
      { perUserPerDay: 0 },
      { perUserPerDay: b.perUserPerDay + 1 },
      { perAppPerDay: 0 },
      { perAppPerDay: 1.5 },
      { sendsPerDay: b.sendsPerDay + 1 },
      { sendsPerMinute: 0 },
      { sendsPerMinute: b.sendsPerMinute + 1 },
      { maxGasPerTx: Number.POSITIVE_INFINITY },
      { dailyBudgetEth: Number.NaN },
      { perUserPerDay: '30' },
    ];
    for (const fields of bad) expect(refused(chain(fields)), JSON.stringify(fields)).toBe(true);
    // The bounds themselves are accepted (with the rules between fields kept).
    const edge = { maxGasPerTx: b.maxGasPerTx.max, minGas: b.minGas.max, maxFeePerGasGwei: 0.000000003, maxPriorityFeePerGasGwei: 0.000000003, maxCallsPerBatch: b.maxCallsPerBatch, deadlineMaxS: b.deadlineMaxS.max, dailyBudgetEth: b.dailyBudgetEth, appDailyBudgetEth: 0.999999999, lowBalanceEth: b.lowBalanceEth, perUserPerDay: b.perUserPerDay, perAppPerDay: b.perAppPerDay, sendsPerDay: b.sendsPerDay, sendsPerMinute: b.sendsPerMinute };
    expect(messages(withSponsor(chain(edge)))).toEqual([]);
    expect(messages(withSponsor(chain({ maxGasPerTx: b.maxGasPerTx.min, minGas: b.minGas.min, maxCallsPerBatch: 1, deadlineMaxS: b.deadlineMaxS.min, perUserPerDay: 1, perAppPerDay: 1, sendsPerDay: 2, sendsPerMinute: 1, appDailyBudgetEth: 0.001 })))).toEqual([]);
  });
});

describe('evm.sponsor: amounts by exact decimal arithmetic', () => {
  it('takes every value with at most 9 decimals, including the ones a float conversion refused', () => {
    expect(sponsorDecimalUnits(33.999997859, 9)).toBe(33_999_997_859n);
    expect(sponsorDecimalUnits(64.999995906, 9)).toBe(64_999_995_906n);
    expect(sponsorDecimalUnits(1e-9, 9)).toBe(1n);
    expect(sponsorDecimalUnits(2.5e-8, 9)).toBe(25n);
    expect(sponsorDecimalUnits(0.02, 9)).toBe(20_000_000n);
    expect(sponsorDecimalUnits(0, 9)).toBe(0n);
    for (const bad of [1e-10, 1.0000000001, 0.0000000015, -0.5, Number.NaN, Number.NEGATIVE_INFINITY, '1', undefined]) expect(sponsorDecimalUnits(bad, 9), String(bad)).toBeNull();
    for (let i = 0; i < 2000; i++) {
      const n = Math.floor(Math.random() * 1e11);
      expect(sponsorDecimalUnits(n / 1e9, 9), String(n)).toBe(BigInt(n));
    }
    for (const fee of [33.999997859, 64.999995906]) expect(messages(withSponsor(chain({ maxFeePerGasGwei: fee, maxGasPerTx: 100_000, minGas: 50_000 }))), String(fee)).toEqual([]);
    expect(messages(withSponsor(chain({ appDailyBudgetEth: 0.009999999, dailyBudgetEth: 0.019999999 })))).toEqual([]);
  });
});

describe('evm.sponsor: addresses', () => {
  it('computes EIP-55 checksums (the EIP’s own vectors)', () => {
    for (const a of ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb']) {
      expect(checksumEvmAddress(a.toLowerCase())).toBe(a);
      expect(checksumEvmAddress(a.toUpperCase().replace('0X', '0x'))).toBe(a);
    }
  });

  it('takes addresses only in their EIP-55 form: not all-lowercase, not a broken checksum, never zero', () => {
    const lower = FIXTURE_RELAYER.toLowerCase();
    expect(lower).not.toBe(FIXTURE_RELAYER);
    // One letter's case flipped: a typo the checksum catches.
    const i = FIXTURE_RELAYER.slice(2).search(/[a-fA-F]/u) + 2;
    const c = FIXTURE_RELAYER[i]!;
    const broken = FIXTURE_RELAYER.slice(0, i) + (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()) + FIXTURE_RELAYER.slice(i + 1);
    for (const bad of [lower, broken, `0x${'0'.repeat(40)}`, FIXTURE_RELAYER.slice(0, -2), `${FIXTURE_RELAYER}00`, FIXTURE_RELAYER.slice(2), 'relayer.testnet', 7]) {
      expect(refused({ ...sponsorFixture(), relayerAddress: bad }), String(bad)).toBe(true);
      expect(refused(chain({ delegate: bad })), String(bad)).toBe(true);
      expect(refused(targets([target({ address: bad })])), String(bad)).toBe(true);
    }
    // An address with no letters is its own checksummed form.
    expect(messages(withSponsor({ ...sponsorFixture(), relayerAddress: `0x${'12'.repeat(20)}` }))).toEqual([]);
  });

  it('keeps the relayer, the delegates and the targets apart', () => {
    expect(messages(withSponsor(chain({ delegate: FIXTURE_RELAYER }))).join(' ')).toMatch(/delegate must not be relayerAddress/u);
    expect(messages(withSponsor(targets([target({ address: FIXTURE_RELAYER })]))).join(' ')).toMatch(/must not be relayerAddress/u);
    expect(messages(withSponsor(targets([target({ address: FIXTURE_DELEGATE })]))).join(' ')).toMatch(/must not be a delegate contract/u);
  });
});

describe('evm.sponsor: the staff-only allowlist (D835)', () => {
  it('selectors: exactly 4 bytes, lowercase 0x hex, 1 to 8, each once', () => {
    for (const bad of [[], ['0x183FF085'], ['183ff085'], ['0x183ff0'], ['0x183ff08500'], ['0xzzzzzzzz'], [CHECK_IN_SELECTOR, '0x'], Array.from({ length: 9 }, (_, i) => `0x0000000${i}`), [7]]) {
      expect(refused(targets([target({ selectors: bad })])), JSON.stringify(bad)).toBe(true);
    }
    expect(messages(withSponsor(targets([target({ selectors: [CHECK_IN_SELECTOR, CHECK_IN_SELECTOR] })]))).join(' ')).toMatch(/lists a selector twice/u);
    expect(messages(withSponsor(targets([target({ selectors: Array.from({ length: 8 }, (_, i) => `0x0000000${i}`) })])))).toEqual([]);
  });

  it('maxDataBytes: required, an integer from 4 to 8192', () => {
    expect(refused(targets([target({ maxDataBytes: undefined })]))).toBe(true);
    for (const bad of [3, 8193, 4.5, '36', null]) expect(refused(targets([target({ maxDataBytes: bad })])), String(bad)).toBe(true);
    // 8192 itself, within the batch-size rule (maxCallsPerBatch 3 × 8192 ≤ 30 KiB).
    for (const ok of [4, 7680]) expect(messages(withSponsor(targets([target({ maxDataBytes: ok })]))), String(ok)).toEqual([]);
    expect(messages(withSponsor({ ...targets([target({ maxDataBytes: 8192 })]), chains: chain({ maxCallsPerBatch: 3 }).chains }))).toEqual([]);
  });

  it('exactCalldata: 1 to 8 distinct lowercase whole-byte entries of 4 to 2048 bytes, each starting with a listed selector, none longer than maxDataBytes', () => {
    const tranfer = `0xa9059cbb${'00'.repeat(64)}`;
    expect(messages(withSponsor(targets([target({ selectors: [CHECK_IN_SELECTOR, '0xa9059cbb'], exactCalldata: [CHECK_IN_SELECTOR, tranfer], maxDataBytes: 68 })])))).toEqual([]);
    expect(messages(withSponsor(targets([target({ exactCalldata: [`0x${'ab'.repeat(2048)}`.replace(/^0xabababab/u, CHECK_IN_SELECTOR)], maxDataBytes: 2048 })])))).toEqual([]);
    const bad: [unknown, RegExp][] = [
      [[], /exactCalldata lists 1 to 8 entries/u],
      [Array.from({ length: 9 }, (_, i) => `${CHECK_IN_SELECTOR}${i.toString(16).padStart(2, '0')}`), /exactCalldata lists 1 to 8 entries/u],
      [['0x183FF085'], /whole bytes, 4 to 2048 bytes/u],
      [[`${CHECK_IN_SELECTOR}0`], /whole bytes, 4 to 2048 bytes/u],
      [['0x183ff0'], /whole bytes, 4 to 2048 bytes/u],
      [[`${CHECK_IN_SELECTOR}${'00'.repeat(2045)}`], /whole bytes, 4 to 2048 bytes/u],
      [['183ff085'], /whole bytes, 4 to 2048 bytes/u],
      [[CHECK_IN_SELECTOR, CHECK_IN_SELECTOR], /exactCalldata lists an entry twice/u],
      [['0xa9059cbb'], /first 4 bytes are not one of selectors/u],
      [[`${CHECK_IN_SELECTOR}${'00'.repeat(33)}`], /longer than maxDataBytes/u],
    ];
    expect(refused(targets([target({ exactCalldata: [7] })]))).toBe(true);
    expect(refused(targets([target({ exactCalldata: null })]))).toBe(true);
    for (const [exactCalldata, re] of bad) {
      expect(messages(withSponsor(targets([target({ exactCalldata })]))).join(' '), JSON.stringify(exactCalldata).slice(0, 60)).toMatch(re);
    }
  });

  it('at most 8 apps, with valid app ids', () => {
    const one = sponsorFixture().apps[FIXTURE_APP]!;
    const apps = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`app_Fixture${i}`, one]));
    expect(messages(withSponsor({ ...sponsorFixture(), apps: apps(8) }))).toEqual([]);
    expect(messages(withSponsor({ ...sponsorFixture(), apps: apps(9) })).join(' ')).toMatch(/evm\.sponsor\.apps lists at most 8 apps/u);
    for (const id of ['app_', 'app-x', 'pk_test_x', 'app_x y', `app_${'a'.repeat(65)}`]) expect(refused({ ...sponsorFixture(), apps: { [id]: one } }), id).toBe(true);
  });

  it('at most 8 targets per app, counted across its chains, each target once per chain', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => target({ address: fixtureAddress(`${i + 1}b`) }));
    expect(messages(withSponsor(targets(many(8))))).toEqual([]);
    expect(refused(targets(many(9)))).toBe(true);
    const s = sponsorFixture();
    const twoChains: EvmSponsor = {
      ...s,
      chains: { ...s.chains, '11155420': { ...s.chains['84532']!, rpc: 'https://sepolia.optimism.io', rpcFallback: undefined } },
      apps: { [FIXTURE_APP]: { '84532': many(5) as EvmSponsor['apps'][string][string], '11155420': many(4) as EvmSponsor['apps'][string][string] } },
    };
    expect(problems(twoChains)).toContain(`evm.sponsor.apps.${FIXTURE_APP} has 9 targets; at most 8`);
    expect(messages(withSponsor(targets([target({}), target({ label: 'Again' })]))).join(' ')).toMatch(/lists .* again: one entry per target/u);
    expect(messages(withSponsor(targets([target({}), target({ address: FIXTURE_CHECK_IN.toLowerCase() })]))).length).toBeGreaterThan(0);
  });

  it('an app names at least one chain, each a configured one with at least one target', () => {
    expect(messages(withSponsor({ ...sponsorFixture(), apps: { [FIXTURE_APP]: {} } })).join(' ')).toMatch(/names no chain/u);
    expect(refused(targets([]))).toBe(true);
    expect(messages(withSponsor({ ...sponsorFixture(), apps: { [FIXTURE_APP]: { '11155111': [target({})] } } })).join(' ')).toMatch(/chain 11155111 is not in evm\.sponsor\.chains/u);
  });

  it('labels: 1 to 64 plain characters, no control or formatting characters, no outer spaces', () => {
    for (const bad of ['', 'x'.repeat(65), ' padded', 'padded ', 'line\nbreak', 'bidi‮override', 'zero​width', 'tab\there']) expect(refused(targets([target({ label: bad })])), JSON.stringify(bad)).toBe(true);
    for (const ok of ['Journear demo check-in', 'x'.repeat(64), 'Café stamps (v2)']) expect(messages(withSponsor(targets([target({ label: ok })]))), ok).toEqual([]);
  });
});

describe('evmSponsorDelegateProblems: placeholder entries', () => {
  it('refuses a delegate the table marks as a placeholder outside local* envs', () => {
    const table = { 84532: { address: FIXTURE_DELEGATE, placeholder: true } };
    expect(evmSponsorDelegateProblems(sponsorFixture(), table, 'sandbox-dev')).toEqual([`evm.sponsor.chains.84532.delegate ${FIXTURE_DELEGATE} is a placeholder entry of the pinned table, only for local* envs`]);
    expect(evmSponsorDelegateProblems(sponsorFixture(), table, 'local-dev')).toEqual([]);
    expect(evmSponsorDelegateProblems(sponsorFixture(), { 84532: { address: FIXTURE_DELEGATE, placeholder: false } }, 'sandbox-dev')).toEqual([]);
  });
});

describe('evmSponsorDelegateProblems: the pinned delegate table (D834)', () => {
  it('passes when every chain’s delegate is the pinned one (any case in the table)', () => {
    expect(evmSponsorDelegateProblems(sponsorFixture(), FIXTURE_PINNED_DELEGATES, 'sandbox-dev')).toEqual([]);
    expect(evmSponsorDelegateProblems(sponsorFixture(), { 84532: { address: FIXTURE_DELEGATE.toLowerCase() } }, 'sandbox-dev')).toEqual([]);
  });

  it('refuses a chain without a pinned entry, and a delegate that differs from it', () => {
    expect(evmSponsorDelegateProblems(sponsorFixture(), {}, 'sandbox-dev')).toEqual(['evm.sponsor.chains.84532: no pinned delegate for chain 84532: sponsorship needs a reviewed delegate there first']);
    expect(evmSponsorDelegateProblems(sponsorFixture(), { 31337: { address: FIXTURE_DELEGATE } }, 'sandbox-dev')).toHaveLength(1);
    const other = fixtureAddress('0bad');
    expect(evmSponsorDelegateProblems(sponsorFixture(), { 84532: { address: other } }, 'sandbox-dev')).toEqual([`evm.sponsor.chains.84532.delegate ${FIXTURE_DELEGATE} is not the pinned delegate ${other}`]);
  });

  it('reads only own entries of the table (no prototype lookups)', () => {
    const s = sponsorFixture();
    const sponsor = { chains: { toString: s.chains['84532']! } } as unknown as EvmSponsor;
    expect(evmSponsorDelegateProblems(sponsor, {}, 'sandbox-dev')).toHaveLength(1);
  });
});

describe('evmSponsorPageChains: what the vault build gets', () => {
  it('is { chainId: { delegate, relayer, rpc, rpcFallback? } } for each chain (the public manifest URLs, read by the vault, D855)', () => {
    expect(evmSponsorPageChains(sponsorFixture())).toEqual({
      '84532': { delegate: FIXTURE_DELEGATE, relayer: FIXTURE_RELAYER, rpc: 'https://sepolia.base.org', rpcFallback: 'https://base-sepolia-rpc.publicnode.com' },
    });
  });

  it('leaves rpcFallback out when the chain has none', () => {
    const s = sponsorFixture();
    const c = { ...s.chains['84532']! };
    delete (c as { rpcFallback?: string }).rpcFallback;
    expect(evmSponsorPageChains({ ...s, chains: { '84532': c } })).toEqual({ '84532': { delegate: FIXTURE_DELEGATE, relayer: FIXTURE_RELAYER, rpc: 'https://sepolia.base.org' } });
  });
});
