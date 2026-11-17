// EVM gas sponsorship's Worker config (D834–D836): EVM_SPONSOR parsed again at run time with the manifest schema's
// bounds, failing closed to `unconfigured`; the allowlist lookup. gen-wrangler's tests check the generated var parses
// here and that these bounds and chain lists equal the schema's.
import { describe, expect, it } from 'vitest';
import { checksumEvmAddress, EVM_SPONSOR_BOUNDS, evmSponsorVar, parseEvmSponsorConfig, sponsoredTarget, type EvmSponsorManifest } from '../src/evm/sponsor-config.ts';
import { CHECK_IN_SELECTOR, FIXTURE_APP, FIXTURE_CHECK_IN, FIXTURE_DELEGATE, FIXTURE_RELAYER, fixtureAddress, sponsorFixture } from '../../../packages/env/src/evm-sponsor.fixture.ts';

const SANDBOX = { network: 'testnet', envName: 'sandbox-test' } as const;
const fixture = (): EvmSponsorManifest => sponsorFixture() as EvmSponsorManifest;
const parse = (v: unknown, where: { network: string | undefined; envName: string } = SANDBOX) => parseEvmSponsorConfig(typeof v === 'string' ? v : JSON.stringify(v), where);
const problem = (v: unknown, where?: { network: string | undefined; envName: string }): string | null => {
  const r = parse(v, where);
  return r.status === 'unconfigured' ? r.problem : null;
};
type ChainFields = Record<string, unknown>;
const chain = (fields: ChainFields): EvmSponsorManifest => {
  const s = fixture();
  return { ...s, chains: { '84532': { ...s.chains['84532']!, ...fields } as EvmSponsorManifest['chains'][string] } };
};
const withTargets = (list: unknown[]): unknown => ({ ...fixture(), apps: { [FIXTURE_APP]: { '84532': list } } });
const target = (fields: Record<string, unknown> = {}) => ({ address: FIXTURE_CHECK_IN, selectors: [CHECK_IN_SELECTOR], label: 'Check-in', ...fields });

describe('parseEvmSponsorConfig', () => {
  it('is unconfigured (absent) without the var: sponsorship off', () => {
    expect(parseEvmSponsorConfig(undefined, SANDBOX)).toEqual({ status: 'unconfigured', reason: 'absent', problem: null });
    expect(parseEvmSponsorConfig('', SANDBOX)).toEqual({ status: 'unconfigured', reason: 'absent', problem: null });
  });

  it('reads the spec’s block into exact integer units (wei, gas)', () => {
    const r = parse(evmSponsorVar(fixture()));
    expect(r.status).toBe('configured');
    if (r.status !== 'configured') return;
    expect(r.config.relayerAddress).toBe(FIXTURE_RELAYER);
    expect([...r.config.chains.keys()]).toEqual([84532]);
    expect(r.config.chains.get(84532)).toEqual({
      chainId: 84532,
      rpc: 'https://sepolia.base.org',
      rpcFallback: 'https://base-sepolia-rpc.publicnode.com',
      delegate: FIXTURE_DELEGATE,
      opStack: true,
      maxGasPerTx: 300_000n,
      maxFeePerGasWei: 1_000_000_000n,
      maxPriorityFeePerGasWei: 10_000_000n,
      maxCallsPerBatch: 4,
      deadlineMaxS: 600,
      minGas: 100_000n,
      dailyBudgetWei: 2n * 10n ** 16n,
      appDailyBudgetWei: 10n ** 16n,
      lowBalanceWei: 5n * 10n ** 16n,
      perUserPerDay: 30,
      perAppPerDay: 2000,
      sendsPerDay: 5000,
      sendsPerMinute: 60,
      requireKnownAccount: true,
    });
    expect(r.config.apps.get(FIXTURE_APP)?.get(84532)).toEqual([{ address: FIXTURE_CHECK_IN, selectors: [CHECK_IN_SELECTOR], label: 'Journear demo check-in' }]);
    expect(Object.isFrozen(r.config)).toBe(true);
    expect(Object.isFrozen(r.config.chains.get(84532))).toBe(true);
    expect(Object.isFrozen(r.config.apps.get(FIXTURE_APP)?.get(84532))).toBe(true);
  });

  it('defaults requireKnownAccount to true and rpcFallback to none', () => {
    const { requireKnownAccount: _r, rpcFallback: _f, ...bare } = fixture().chains['84532']!;
    const r = parse({ ...fixture(), chains: { '84532': bare } });
    expect(r.status === 'configured' && r.config.chains.get(84532)).toMatchObject({ requireKnownAccount: true, rpcFallback: null });
    const off = parse(chain({ requireKnownAccount: false }));
    expect(off.status === 'configured' && off.config.chains.get(84532)?.requireKnownAccount).toBe(false);
  });

  it('is unconfigured (invalid) for anything that isn’t the block: not JSON, not an object, unknown or missing fields', () => {
    for (const v of ['{', 'null', '[]', '"x"', '7', JSON.stringify({ ...fixture(), extra: 1 }), JSON.stringify({ relayerAddress: FIXTURE_RELAYER, chains: fixture().chains })]) {
      const r = parseEvmSponsorConfig(v, SANDBOX);
      expect(r.status, v).toBe('unconfigured');
      expect(r.status === 'unconfigured' && r.reason, v).toBe('invalid');
    }
    expect(problem(chain({ gasPrice: 1 }))).toBe('chains.84532 has an unknown field gasPrice');
    expect(problem(chain({ minGas: undefined }))).toBe('chains.84532.minGas is missing');
    expect(problem(withTargets([target({ value: '1' })]))).toBe('apps.app_SponsorFixture1.84532[0] has an unknown field value');
  });

  it('is unconfigured off testnet, whatever the var says', () => {
    for (const network of ['mainnet', undefined, '']) expect(problem(evmSponsorVar(fixture()), { network, envName: 'sandbox-test' }), String(network)).toBe('EVM sponsorship is testnet only');
  });

  it('refuses chains that aren’t known test chains, local dev chains outside local* envs, and a wrong opStack', () => {
    const s = fixture();
    for (const id of ['1', '8453', '999999']) expect(problem({ ...s, chains: { [id]: { ...s.chains['84532'], opStack: false } }, apps: {} }), id).toBe(`chains.${id}: not a known EVM test chain`);
    const local = { ...s, chains: { '31337': { ...s.chains['84532'], opStack: false, rpc: 'http://127.0.0.1:8545', rpcFallback: undefined } }, apps: {} };
    expect(problem(local)).toBe('chains.31337: a local dev chain outside a local* env');
    expect(parse(local, { network: 'testnet', envName: 'local-dev' }).status).toBe('configured');
    expect(problem(chain({ opStack: false }))).toBe('chains.84532.opStack is wrong for the chain');
    for (const key of ['0x14a34', '084532', 'base']) expect(problem({ ...s, chains: { [key]: s.chains['84532'] }, apps: {} }), key).toBe('chains has a key that is not a chain ID');
    expect(problem({ ...s, chains: {}, apps: {} })).toBe('chains has 1 to 4 chains');
  });

  it('refuses RPCs that aren’t https (loopback http in local* envs only) or carry credentials', () => {
    expect(problem(chain({ rpc: 'http://sepolia.base.org' }))).toBe('chains.84532.rpc must be https (http only for a loopback host in local* envs)');
    expect(problem(chain({ rpc: 'http://127.0.0.1:8545' }))).toBe('chains.84532.rpc must be https (http only for a loopback host in local* envs)');
    expect(parse(chain({ rpc: 'http://127.0.0.1:8545', rpcFallback: 'http://localhost:8546' }), { network: 'testnet', envName: 'local-x' }).status).toBe('configured');
    expect(problem(chain({ rpc: 'https://u:p@sepolia.base.org' }))).toBe('chains.84532.rpc carries credentials');
    expect(problem(chain({ rpcFallback: 'https://sepolia.base.org' }))).toBe('chains.84532.rpcFallback is rpc');
    expect(problem(chain({ rpc: 'nope' }))).toBe('chains.84532.rpc is not a URL');
  });

  it('refuses per-app limits at or above the env’s, and inconsistent gas and fees', () => {
    expect(problem(chain({ appDailyBudgetEth: 0.02 }))).toBe('chains.84532.appDailyBudgetEth is not below dailyBudgetEth');
    expect(problem(chain({ perAppPerDay: 5000 }))).toBe('chains.84532.perAppPerDay is not below sendsPerDay');
    expect(problem(chain({ minGas: 300_000 }))).toBe('chains.84532.minGas is not below maxGasPerTx');
    expect(problem(chain({ maxPriorityFeePerGasGwei: 2 }))).toBe('chains.84532.maxPriorityFeePerGasGwei exceeds maxFeePerGasGwei');
    expect(problem(chain({ maxGasPerTx: 1_000_000, maxFeePerGasGwei: 20 }))).toBe("chains.84532: one transaction's worst case exceeds appDailyBudgetEth");
    expect(parse(chain({ maxGasPerTx: 1_000_000, maxFeePerGasGwei: 10 })).status).toBe('configured');
  });

  it('enforces the hard bounds on every number', () => {
    const b = EVM_SPONSOR_BOUNDS;
    for (const fields of [
      { maxGasPerTx: b.maxGasPerTx.max + 1 },
      { maxGasPerTx: b.maxGasPerTx.min - 1 },
      { maxGasPerTx: 300_000.5 },
      { minGas: b.minGas.min - 1 },
      { maxFeePerGasGwei: 0 },
      { maxFeePerGasGwei: b.maxFeePerGasGwei + 1 },
      { maxFeePerGasGwei: 1.0000000001 },
      { maxPriorityFeePerGasGwei: -1 },
      { maxCallsPerBatch: 0 },
      { maxCallsPerBatch: b.maxCallsPerBatch + 1 },
      { deadlineMaxS: b.deadlineMaxS.min - 1 },
      { deadlineMaxS: b.deadlineMaxS.max + 1 },
      { dailyBudgetEth: b.dailyBudgetEth + 1 },
      { dailyBudgetEth: 0 },
      { appDailyBudgetEth: 0.0000000001 },
      { lowBalanceEth: b.lowBalanceEth + 1 },
      { perUserPerDay: 0 },
      { perUserPerDay: b.perUserPerDay + 1 },
      { perAppPerDay: b.perAppPerDay + 1 },
      { sendsPerDay: b.sendsPerDay + 1 },
      { sendsPerMinute: b.sendsPerMinute + 1 },
      { sendsPerMinute: '60' },
      { requireKnownAccount: 'yes' },
      { opStack: 1 },
    ]) {
      expect(parse(chain(fields)).status, JSON.stringify(fields)).toBe('unconfigured');
    }
  });

  it('takes only EIP-55, non-zero addresses, and keeps the relayer, delegates and targets apart', () => {
    for (const bad of [FIXTURE_RELAYER.toLowerCase(), `0x${'0'.repeat(40)}`, FIXTURE_RELAYER.slice(0, -1), 7]) {
      expect(parse({ ...fixture(), relayerAddress: bad }).status, String(bad)).toBe('unconfigured');
      expect(parse(chain({ delegate: bad })).status, String(bad)).toBe('unconfigured');
      expect(parse(withTargets([target({ address: bad })])).status, String(bad)).toBe('unconfigured');
    }
    expect(problem(chain({ delegate: FIXTURE_RELAYER }))).toBe('chains.84532.delegate is relayerAddress');
    expect(problem(withTargets([target({ address: FIXTURE_RELAYER })]))).toBe(`apps.${FIXTURE_APP}.84532: a target is relayerAddress`);
    expect(problem(withTargets([target({ address: FIXTURE_DELEGATE })]))).toBe(`apps.${FIXTURE_APP}.84532: a target is a delegate`);
    expect(checksumEvmAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')).toBe('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
  });

  it('bounds the allowlist: ≤ 8 apps, ≤ 8 targets each, selectors 4 bytes, labels plain', () => {
    const one = fixture().apps[FIXTURE_APP]!;
    const apps = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`app_F${i}`, one]));
    expect(parse({ ...fixture(), apps: apps(8) }).status).toBe('configured');
    expect(problem({ ...fixture(), apps: apps(9) })).toBe('apps lists more than 8 apps');
    expect(problem({ ...fixture(), apps: { 'pk_test_x': one } })).toBe('apps has a key that is not an app id');
    expect(problem({ ...fixture(), apps: { [FIXTURE_APP]: {} } })).toBe(`apps.${FIXTURE_APP} names no chain`);
    expect(problem({ ...fixture(), apps: { [FIXTURE_APP]: { '11155111': one['84532'] } } })).toBe(`apps.${FIXTURE_APP}.11155111 is not a configured chain`);
    expect(problem(withTargets([]))).toBe(`apps.${FIXTURE_APP}.84532 lists no target`);
    const many = (n: number) => Array.from({ length: n }, (_, i) => target({ address: fixtureAddress(`${i + 1}b`) }));
    expect(parse(withTargets(many(8))).status).toBe('configured');
    expect(problem(withTargets(many(9)))).toBe(`apps.${FIXTURE_APP} has more than 8 targets`);
    expect(problem(withTargets([target(), target()]))).toBe(`apps.${FIXTURE_APP}.84532 lists ${FIXTURE_CHECK_IN} twice`);
    for (const selectors of [[], ['0x183FF085'], ['0x183ff0'], ['183ff085'], [CHECK_IN_SELECTOR, CHECK_IN_SELECTOR], Array.from({ length: 9 }, (_, i) => `0x0000000${i}`)]) {
      expect(parse(withTargets([target({ selectors })])).status, JSON.stringify(selectors)).toBe('unconfigured');
    }
    for (const label of ['', ' x', 'x\n', 'a‮b', 'x'.repeat(65), 7]) expect(parse(withTargets([target({ label })])).status, JSON.stringify(label)).toBe('unconfigured');
  });
});

describe('sponsoredTarget: the allowlist lookup (D835)', () => {
  const r = parse(evmSponsorVar(fixture()));
  const config = r.status === 'configured' ? r.config : null;

  it('matches the app’s target on the chain by address (any case) and selector', () => {
    expect(config).not.toBeNull();
    const hit = sponsoredTarget(config!, FIXTURE_APP, 84532, FIXTURE_CHECK_IN.toLowerCase(), `${CHECK_IN_SELECTOR}`);
    expect(hit?.label).toBe('Journear demo check-in');
    expect(sponsoredTarget(config!, FIXTURE_APP, 84532, FIXTURE_CHECK_IN, `0x183FF085${'00'.repeat(32)}`)).not.toBeNull();
  });

  it('refuses another app, chain, address or selector, and data shorter than a selector', () => {
    expect(sponsoredTarget(config!, 'app_Other', 84532, FIXTURE_CHECK_IN, CHECK_IN_SELECTOR)).toBeNull();
    expect(sponsoredTarget(config!, FIXTURE_APP, 11155111, FIXTURE_CHECK_IN, CHECK_IN_SELECTOR)).toBeNull();
    expect(sponsoredTarget(config!, FIXTURE_APP, 84532, FIXTURE_DELEGATE, CHECK_IN_SELECTOR)).toBeNull();
    expect(sponsoredTarget(config!, FIXTURE_APP, 84532, FIXTURE_CHECK_IN, '0xa9059cbb')).toBeNull();
    for (const data of ['0x', '0x183ff0', '', '183ff085']) expect(sponsoredTarget(config!, FIXTURE_APP, 84532, FIXTURE_CHECK_IN, data), data).toBeNull();
  });
});

describe('evmSponsorVar', () => {
  it('writes the block’s fields in a fixed order and nothing else', () => {
    const extra = { ...fixture(), secret: 'x', chains: { '84532': { ...fixture().chains['84532']!, note: 'x' } } } as unknown as EvmSponsorManifest;
    const v = JSON.parse(evmSponsorVar(extra)) as Record<string, unknown>;
    expect(Object.keys(v)).toEqual(['relayerAddress', 'chains', 'apps']);
    expect(v).toEqual(JSON.parse(JSON.stringify(sponsorFixture())));
  });
});
