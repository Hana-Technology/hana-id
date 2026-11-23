// EVM gas sponsorship's Worker config (D834–D836): EVM_SPONSOR parsed again at run time with the manifest schema's
// bounds, failing closed to `unconfigured`; the allowlist lookup. gen-wrangler's tests check the generated var parses
// here and that these bounds and chain lists equal the schema's.
import { describe, expect, it } from 'vitest';
import { checksumEvmAddress, EVM_SPONSOR_BOUNDS, evmSponsorVar, parseEvmSponsorConfig, sponsorChain, sponsorDecimalUnits, sponsoredTarget, type EvmSponsorManifest, type EvmSponsorWhere } from '../src/evm/sponsor-config.ts';
import { CHECK_IN_SELECTOR, FIXTURE_APP, FIXTURE_CHECK_IN, FIXTURE_DELEGATE, FIXTURE_PINNED_DELEGATES, FIXTURE_RELAYER, fixtureAddress, sponsorFixture } from '../../../packages/env/src/evm-sponsor.fixture.ts';

const SANDBOX: EvmSponsorWhere = { network: 'testnet', envName: 'sandbox-test', pinnedDelegates: FIXTURE_PINNED_DELEGATES };
const LOCAL: EvmSponsorWhere = { ...SANDBOX, envName: 'local-dev', pinnedDelegates: { ...FIXTURE_PINNED_DELEGATES, 31337: { address: FIXTURE_DELEGATE } } };
const fixture = (): EvmSponsorManifest => sponsorFixture() as EvmSponsorManifest;
const parse = (v: unknown, where: EvmSponsorWhere = SANDBOX) => parseEvmSponsorConfig(typeof v === 'string' ? v : JSON.stringify(v), where);
const problem = (v: unknown, where?: EvmSponsorWhere): string | null => {
  const r = parse(v, where);
  return r.status === 'unconfigured' ? r.problem : null;
};
type ChainFields = Record<string, unknown>;
const chain = (fields: ChainFields): EvmSponsorManifest => {
  const s = fixture();
  return { ...s, chains: { '84532': { ...s.chains['84532']!, ...fields } as EvmSponsorManifest['chains'][string] } };
};
const withTargets = (list: unknown[]): unknown => ({ ...fixture(), apps: { [FIXTURE_APP]: { '84532': list } } });
const target = (fields: Record<string, unknown> = {}) => ({ address: FIXTURE_CHECK_IN, selectors: [CHECK_IN_SELECTOR], maxDataBytes: 36, label: 'Check-in', ...fields });

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
    expect(Object.keys(r.config.chains)).toEqual(['84532']);
    expect(sponsorChain(r.config, 84532)).toEqual({
      chainId: 84532,
      rpc: 'https://sepolia.base.org',
      rpcFallback: 'https://base-sepolia-rpc.publicnode.com',
      delegate: FIXTURE_DELEGATE,
      opStack: true,
      maxGasPerTx: 300_000n,
      maxFeePerGasWei: 1_000_000_000n,
      maxPriorityFeePerGasWei: 10_000_000n,
      maxCallsPerBatch: 4,
      deadlineMaxS: 300,
      minGas: 100_000n,
      dailyBudgetWei: 2n * 10n ** 16n,
      appDailyBudgetWei: 10n ** 16n,
      lowBalanceWei: 5n * 10n ** 16n,
      perUserPerDay: 30,
      perAppPerDay: 2000,
      sendsPerDay: 5000,
      sendsPerMinute: 60,
      requireKnownAccount: true,
      autoRestart: false,
    });
    expect(r.config.apps[FIXTURE_APP]?.['84532']).toEqual([{ address: FIXTURE_CHECK_IN, selectors: [CHECK_IN_SELECTOR], exactCalldata: [CHECK_IN_SELECTOR], maxDataBytes: 4, label: 'Journear demo check-in' }]);
  });

  it('is immutable all the way down: plain frozen objects and arrays, no Map or Set, no prototype', () => {
    const r = parse(evmSponsorVar(fixture()));
    if (r.status !== 'configured') throw new Error('expected configured');
    const c = r.config;
    const chainCfg = c.chains['84532']!;
    const targets = c.apps[FIXTURE_APP]!['84532']!;
    for (const v of [c, c.chains, chainCfg, c.apps, c.apps[FIXTURE_APP], targets, targets[0], targets[0]!.selectors]) {
      expect(Object.isFrozen(v)).toBe(true);
      expect(v instanceof Map || v instanceof Set).toBe(false);
    }
    expect(Object.getPrototypeOf(c.chains)).toBeNull();
    expect(Object.getPrototypeOf(c.apps)).toBeNull();
    expect(() => {
      (c.chains as Record<string, unknown>)['1'] = chainCfg;
    }).toThrow(TypeError);
    expect(() => {
      (targets as unknown as string[]).push('x');
    }).toThrow(TypeError);
    expect(() => {
      (targets[0]!.selectors as string[])[0] = '0x00000000';
    }).toThrow(TypeError);
    expect(sponsorChain(c, 1)).toBeNull();
    expect(sponsorChain(c, Number.NaN)).toBeNull();
  });

  it('D890: autoRestart defaults to false, takes a boolean, and is passed through by evmSponsorVar', () => {
    const on = parse(evmSponsorVar(chain({ autoRestart: true })));
    expect(on.status === 'configured' && sponsorChain(on.config, 84532)).toMatchObject({ autoRestart: true });
    expect(problem(chain({ autoRestart: 'yes' as never }))).toBe('chains.84532.autoRestart is not a boolean');
  });

  it('defaults requireKnownAccount to true; rpcFallback is required outside local* envs (D855), none in a local env', () => {
    const { requireKnownAccount: _r, ...bare } = fixture().chains['84532']!;
    const r = parse({ ...fixture(), chains: { '84532': bare } });
    expect(r.status === 'configured' && sponsorChain(r.config, 84532)).toMatchObject({ requireKnownAccount: true });
    const { rpcFallback: _f, ...noFallback } = fixture().chains['84532']!;
    expect(problem({ ...fixture(), chains: { '84532': noFallback } })).toBe('chains.84532.rpcFallback is required outside local* envs');
    const s = fixture();
    const local = parse({ ...s, chains: { '31337': { ...s.chains['84532'], opStack: false, rpc: 'http://127.0.0.1:8545', rpcFallback: undefined } }, apps: {} }, LOCAL);
    expect(local.status === 'configured' && sponsorChain(local.config, 31337)?.rpcFallback).toBeNull();
    // false only in local* envs (D836 as amended after the review).
    expect(problem(chain({ requireKnownAccount: false }))).toBe('chains.84532.requireKnownAccount false is only for local* envs');
    const off = parse(chain({ requireKnownAccount: false }), { ...SANDBOX, envName: 'local-dev' });
    expect(off.status === 'configured' && sponsorChain(off.config, 84532)?.requireKnownAccount).toBe(false);
  });

  it('refuses null for the optional fields (as the schema does), rather than taking the default', () => {
    expect(problem(chain({ requireKnownAccount: null }))).toBe('chains.84532.requireKnownAccount is not a boolean');
    expect(problem(chain({ rpcFallback: null }))).toBe('chains.84532.rpcFallback is not a URL');
  });

  it('refuses __proto__, constructor and prototype keys anywhere in the block, explicitly', () => {
    const text = evmSponsorVar(fixture());
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(problem(text.replace('"chains":{', `"chains":{"${key}":{},`)), key).toBe(`chains has a forbidden key ${key}`);
      expect(problem(text.replace('"apps":{', `"apps":{"${key}":{},`)), key).toBe(`apps has a forbidden key ${key}`);
      expect(problem(text.replace(`"${FIXTURE_APP}":{`, `"${FIXTURE_APP}":{"${key}":[],`)), key).toBe(`apps.${FIXTURE_APP} has a forbidden key ${key}`);
      expect(problem(text.replace('"rpc":', `"${key}":1,"rpc":`)), key).toBe(`chains.84532 has a forbidden key ${key}`);
      expect(problem(text.replace('"label":', `"${key}":1,"label":`)), key).toBe(`apps.${FIXTURE_APP}.84532[0] has a forbidden key ${key}`);
      expect(problem(text.replace('{"relayerAddress"', `{"${key}":{},"relayerAddress"`)), key).toBe(`EVM_SPONSOR has a forbidden key ${key}`);
    }
  });

  it('checks every chain’s delegate against the pinned table it is given, and is unconfigured without one', () => {
    const text = evmSponsorVar(fixture());
    expect(problem(text, { ...SANDBOX, pinnedDelegates: undefined })).toBe('no pinned delegate table to check the delegates against');
    expect(problem(text, { ...SANDBOX, pinnedDelegates: {} })).toBe('chains.84532.delegate: no pinned delegate for the chain');
    expect(problem(text, { ...SANDBOX, pinnedDelegates: { 84532: { address: fixtureAddress('0bad') } } })).toBe('chains.84532.delegate is not the pinned delegate');
    expect(parse(text, { ...SANDBOX, pinnedDelegates: { 84532: { address: FIXTURE_DELEGATE.toLowerCase() } } }).status).toBe('configured');
    // A placeholder entry (core's local test entry) only in local* envs.
    const placeholder = { 84532: { address: FIXTURE_DELEGATE, placeholder: true } };
    expect(problem(text, { ...SANDBOX, pinnedDelegates: placeholder })).toBe('chains.84532.delegate is a placeholder entry of the pinned table, only for local* envs');
    expect(parse(text, { ...SANDBOX, envName: 'local-dev', pinnedDelegates: placeholder }).status).toBe('configured');
    // Only own entries of the table count.
    expect(problem(text, { ...SANDBOX, pinnedDelegates: Object.create({ 84532: { address: FIXTURE_DELEGATE } }) as Record<number, { address: string }> })).toBe('chains.84532.delegate: no pinned delegate for the chain');
    // Absent stays absent, table or not.
    expect(parseEvmSponsorConfig(undefined, { ...SANDBOX, pinnedDelegates: undefined })).toEqual({ status: 'unconfigured', reason: 'absent', problem: null });
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
    for (const network of ['mainnet', undefined, '']) expect(problem(evmSponsorVar(fixture()), { ...SANDBOX, network }), String(network)).toBe('EVM sponsorship is testnet only');
  });

  it('refuses chains that aren’t known test chains, local dev chains outside local* envs, and a wrong opStack', () => {
    const s = fixture();
    for (const id of ['1', '8453', '999999']) expect(problem({ ...s, chains: { [id]: { ...s.chains['84532'], opStack: false } }, apps: {} }), id).toBe(`chains.${id}: not a known EVM test chain`);
    const local = { ...s, chains: { '31337': { ...s.chains['84532'], opStack: false, rpc: 'http://127.0.0.1:8545', rpcFallback: undefined } }, apps: {} };
    expect(problem(local)).toBe('chains.31337: a local dev chain outside a local* env');
    expect(parse(local, LOCAL).status).toBe('configured');
    expect(problem(chain({ opStack: false }))).toBe('chains.84532.opStack is wrong for the chain');
    for (const key of ['0x14a34', '084532', 'base']) expect(problem({ ...s, chains: { [key]: s.chains['84532'] }, apps: {} }), key).toBe('chains has a key that is not a chain ID');
    expect(problem({ ...s, chains: {}, apps: {} })).toBe('chains has 1 to 4 chains');
  });

  it('refuses RPCs that aren’t https DNS names with no path, query or credentials (loopback only in local* envs)', () => {
    expect(problem(chain({ rpc: 'http://sepolia.base.org' }))).toBe('chains.84532.rpc must be an https URL (http only for a loopback host in local* envs)');
    for (const rpc of ['http://127.0.0.1:8545', 'https://127.0.0.1', 'https://[::1]', 'https://localhost.', 'https://a_b.localhost', 'https://[::ffff:127.0.0.1]', 'https://0x7f.1']) {
      expect(problem(chain({ rpc })), rpc).toBe('chains.84532.rpc must not be a loopback host outside local* envs');
    }
    for (const rpc of ['https://169.254.1.1', 'https://[fe80::1]', 'https://10.0.0.1', 'https://8.8.8.8']) expect(problem(chain({ rpc })), rpc).toBe('chains.84532.rpc must be a DNS name, not an IP address');
    expect(problem(chain({ rpc: 'https://node.local' }))).toBe('chains.84532.rpc must not be a link-local (.local) name');
    expect(problem(chain({ rpc: 'https://rpc' }))).toBe('chains.84532.rpc must be a DNS name with a dot and no trailing dot');
    for (const rpc of ['https://rpc.example.org/v2/abc', 'https://rpc.example.org/x']) expect(problem(chain({ rpc })), rpc).toMatch(/^chains\.84532\.rpc must have no path .*a keyed RPC goes in a secret/u);
    for (const rpc of ['https://rpc.example.org/?key=abc', 'https://rpc.example.org/?', 'https://rpc.example.org/#x']) expect(problem(chain({ rpc })), rpc).toMatch(/must have no query or fragment/u);
    expect(parse(chain({ rpc: 'https://sepolia.base.org/' })).status).toBe('configured');
    for (const host of ['127.0.0.1:8545', 'localhost.:8545', '[::ffff:127.0.0.1]:8545', 'a_b.localhost:8545']) {
      expect(parse(chain({ rpc: `http://${host}`, rpcFallback: 'http://localhost:8546' }), { ...LOCAL, envName: 'local-x' }).status, host).toBe('configured');
    }
    expect(problem(chain({ rpc: 'https://u:p@sepolia.base.org' }))).toMatch(/^chains\.84532\.rpc must not carry credentials/u);
    expect(problem(chain({ rpcFallback: 'https://sepolia.base.org' }))).toBe('chains.84532.rpcFallback is rpc');
    expect(problem(chain({ rpc: 'nope' }))).toBe('chains.84532.rpc is not a URL');
  });

  it('converts amounts by exact decimal arithmetic: every 9-decimal value, nothing finer', () => {
    expect(sponsorDecimalUnits(33.999997859, 9)).toBe(33_999_997_859n);
    expect(sponsorDecimalUnits(64.999995906, 9)).toBe(64_999_995_906n);
    expect(sponsorDecimalUnits(1e-9, 9)).toBe(1n);
    expect(sponsorDecimalUnits(1.5e-7, 9)).toBe(150n);
    expect(sponsorDecimalUnits(0.01, 9)).toBe(10_000_000n);
    expect(sponsorDecimalUnits(100, 9)).toBe(100_000_000_000n);
    expect(sponsorDecimalUnits(0, 9)).toBe(0n);
    for (const bad of [1e-10, 1.0000000001, 0.0000000015, -1, Number.NaN, Number.POSITIVE_INFINITY, '1', null]) expect(sponsorDecimalUnits(bad, 9), String(bad)).toBeNull();
    for (let i = 0; i < 2000; i++) {
      const n = Math.floor(Math.random() * 1e11);
      expect(sponsorDecimalUnits(n / 1e9, 9), String(n)).toBe(BigInt(n));
    }
    // The values a float conversion refused, accepted (gas small enough for the worst case to fit the app's day).
    for (const fee of [33.999997859, 64.999995906]) {
      const r = parse(chain({ maxFeePerGasGwei: fee, maxGasPerTx: 100_000, minGas: 50_000 }));
      expect(r.status === 'configured' && sponsorChain(r.config, 84532)?.maxFeePerGasWei, String(fee)).toBe(BigInt(Math.round(fee * 1e9)));
    }
  });

  it('refuses per-app limits at or above the env’s, and inconsistent gas and fees', () => {
    expect(problem(chain({ appDailyBudgetEth: 0.02 }))).toBe('chains.84532.appDailyBudgetEth is not below dailyBudgetEth');
    expect(problem(chain({ perAppPerDay: 5000 }))).toBe('chains.84532.perAppPerDay is not below sendsPerDay');
    expect(problem(chain({ minGas: 300_000 }))).toBe('chains.84532.minGas is not below maxGasPerTx');
    expect(problem(chain({ maxPriorityFeePerGasGwei: 2 }))).toBe('chains.84532.maxPriorityFeePerGasGwei exceeds maxFeePerGasGwei');
    expect(problem(chain({ maxGasPerTx: 1_000_000, maxFeePerGasGwei: 20 }))).toBe("chains.84532: one transaction's worst case exceeds appDailyBudgetEth");
    expect(parse(chain({ maxGasPerTx: 1_000_000, maxFeePerGasGwei: 10 })).status).toBe('configured');
  });

  it('refuses a tip cap with no starting tip, deadlineMaxS above 300, and batches past the relayer\'s 30 KiB of calls', () => {
    expect(problem(chain({ maxPriorityFeePerGasGwei: 0.000000002 }))).toMatch(/^chains\.84532\.maxPriorityFeePerGasGwei is too small: after the two fee bumps/u);
    expect(parse(chain({ maxPriorityFeePerGasGwei: 0.000000003 })).status).toBe('configured');
    expect(problem(chain({ deadlineMaxS: 301 }))).toMatch(/deadlineMaxS/u);
    expect(parse(chain({ deadlineMaxS: 300 })).status).toBe('configured');
    const big = (maxCallsPerBatch: number, maxDataBytes: number) => evmSponsorVar({ ...chain({ maxCallsPerBatch }), apps: { [FIXTURE_APP]: { '84532': [target({ maxDataBytes })] } } } as EvmSponsorManifest);
    expect(parse(big(4, 7680)).status).toBe('configured');
    expect(parseEvmSponsorConfig(big(4, 7681), SANDBOX)).toMatchObject({ status: 'unconfigured', problem: 'chains.84532.maxCallsPerBatch × the largest target maxDataBytes is 30724 bytes; the relayer sends at most 30720 bytes of calls in one batch (30 KiB)' });
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
    for (const maxDataBytes of [undefined, 3, 8193, 4.5, '36', null]) expect(parse(withTargets([target({ maxDataBytes })])).status, String(maxDataBytes)).toBe('unconfigured');
    for (const exactCalldata of [[], ['0x183FF085'], [`${CHECK_IN_SELECTOR}0`], ['0xa9059cbb'], [CHECK_IN_SELECTOR, CHECK_IN_SELECTOR], [`${CHECK_IN_SELECTOR}${'00'.repeat(33)}`], null, 'x']) {
      expect(parse(withTargets([target({ exactCalldata })])).status, JSON.stringify(exactCalldata)).toBe('unconfigured');
    }
    expect(problem(withTargets([target({ exactCalldata: ['0xa9059cbb'] })]))).toBe(`apps.${FIXTURE_APP}.84532[0].exactCalldata: an entry's first 4 bytes are not one of selectors`);
  });
});

describe('sponsoredTarget: the allowlist lookup (D835)', () => {
  const r = parse(evmSponsorVar(fixture()));
  const config = r.status === 'configured' ? r.config : null;

  it('matches an exact-calldata target only on exactly that calldata (no trailing bytes the sponsor would pay for)', () => {
    expect(config).not.toBeNull();
    const hit = sponsoredTarget(config!, FIXTURE_APP, 84532, FIXTURE_CHECK_IN.toLowerCase(), `${CHECK_IN_SELECTOR}`);
    expect(hit?.label).toBe('Journear demo check-in');
    expect(sponsoredTarget(config!, FIXTURE_APP, 84532, FIXTURE_CHECK_IN, '0x183FF085')).not.toBeNull();
    for (const junk of [`${CHECK_IN_SELECTOR}00`, `${CHECK_IN_SELECTOR}${'00'.repeat(32)}`, `${CHECK_IN_SELECTOR}${'ff'.repeat(4)}`]) {
      expect(sponsoredTarget(config!, FIXTURE_APP, 84532, FIXTURE_CHECK_IN, junk), junk).toBeNull();
    }
  });

  it('matches a selector-only target by selector, within maxDataBytes; exact entries bind only their own selector', () => {
    const transfer = '0xa9059cbb';
    const s = fixture();
    const mixed = { ...s, apps: { [FIXTURE_APP]: { '84532': [{ address: FIXTURE_CHECK_IN, selectors: [CHECK_IN_SELECTOR, transfer], exactCalldata: [CHECK_IN_SELECTOR], maxDataBytes: 68, label: 'Mixed' }] } } };
    const m = parse(mixed);
    if (m.status !== 'configured') throw new Error(m.problem ?? 'unconfigured');
    const t = (data: string) => sponsoredTarget(m.config, FIXTURE_APP, 84532, FIXTURE_CHECK_IN, data);
    expect(t(`${transfer}${'00'.repeat(64)}`)).not.toBeNull();
    expect(t(transfer)).not.toBeNull();
    expect(t(`${transfer}${'00'.repeat(65)}`)).toBeNull();
    expect(t(CHECK_IN_SELECTOR)).not.toBeNull();
    expect(t(`${CHECK_IN_SELECTOR}00`)).toBeNull();
  });

  it('refuses another app, chain, address or selector, and data shorter than a selector', () => {
    expect(sponsoredTarget(config!, 'app_Other', 84532, FIXTURE_CHECK_IN, CHECK_IN_SELECTOR)).toBeNull();
    expect(sponsoredTarget(config!, '__proto__', 84532, FIXTURE_CHECK_IN, CHECK_IN_SELECTOR)).toBeNull();
    expect(sponsoredTarget(config!, FIXTURE_APP, 11155111, FIXTURE_CHECK_IN, CHECK_IN_SELECTOR)).toBeNull();
    expect(sponsoredTarget(config!, FIXTURE_APP, 84532, FIXTURE_DELEGATE, CHECK_IN_SELECTOR)).toBeNull();
    expect(sponsoredTarget(config!, FIXTURE_APP, 84532, FIXTURE_CHECK_IN, '0xa9059cbb')).toBeNull();
    for (const data of ['0x', '0x183ff0', '', '183ff085', `${CHECK_IN_SELECTOR}0`, `${CHECK_IN_SELECTOR}zz`, `${CHECK_IN_SELECTOR}0g`, `${CHECK_IN_SELECTOR} `]) {
      expect(sponsoredTarget(config!, FIXTURE_APP, 84532, FIXTURE_CHECK_IN, data), data).toBeNull();
    }
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
