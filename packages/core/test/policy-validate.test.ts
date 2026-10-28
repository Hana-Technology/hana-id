import { describe, expect, it } from 'vitest';
import {
  MAX_SESSION_TTL_MS,
  POLICY_ID_DOMAIN,
  PROTOCOL_DECODERS,
  type ProtocolDecoder,
  canonicalJson,
  functionSelector,
  isExecutionStyleFunctionName,
  isValueMovingFunctionName,
  parseAutoApprovePolicy,
  policyId,
  protocolDecoderRegistry,
  validateAutoApprovePolicy,
} from './entries.ts';
import { CHAIN, EVM_USDC, EVM_VAULT, policyJson } from './policy-fixtures.ts';
import { POOL, TOKEN } from './stellar-fixtures.ts';

type Json = ReturnType<typeof policyJson>;
// Loosely typed so tests can patch fixtures into invalid policies.
type Mutable = Record<string, any>;

const problems = (p: unknown, opts = {}) => {
  const r = validateAutoApprovePolicy(p, opts);
  return r.ok ? [] : r.problems;
};

const patch = (f: (p: Mutable) => void): Json => {
  const p = structuredClone(policyJson()) as Mutable;
  f(p);
  return p as Json;
};

const fakeDecoder = (id: string, chain: 'stellar' | 'evm'): ProtocolDecoder => ({
  id,
  chain,
  matches: () => true,
  decode: () => ({ ok: true, effects: { recipients: [], targets: [], tokens: [] } }),
});

describe('validateAutoApprovePolicy: accepts and normalizes', () => {
  it('accepts the pilot policy and fills defaults', () => {
    const r = validateAutoApprovePolicy(policyJson());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.policy.stellar?.contracts[0]?.functions[0]).toEqual({ name: 'swap', addressArgs: 'self-or-listed' });
    expect(r.policy.evm?.chains[0]?.contracts[1]?.selectors[0]).toEqual({
      selector: functionSelector('deposit(uint256)'),
      signature: 'deposit(uint256)',
      addressArgs: 'self-or-listed',
    });
    expect(Object.isFrozen(r.policy)).toBe(true);
    expect(Object.isFrozen(r.policy.stellar?.contracts[0]?.functions)).toBe(true);
  });

  it('normalizes EVM addresses to EIP-55 and selectors to lowercase', () => {
    const p = patch((x) => {
      x.evm.chains[0].contracts[0].address = EVM_USDC.toLowerCase();
      x.evm.chains[0].contracts[0].selectors[0].selector = '0x095EA7B3';
    });
    const r = validateAutoApprovePolicy(p);
    expect(r.ok && r.policy.evm?.chains[0]?.contracts[0]).toMatchObject({
      address: EVM_USDC,
      selectors: [{ selector: '0x095ea7b3' }],
    });
  });

  it('accepts a single-chain policy, an EVM typedData-only chain and a changeTrust-only Stellar section', () => {
    expect(problems(patch((x) => delete x.evm))).toEqual([]);
    expect(problems(patch((x) => delete x.stellar))).toEqual([]);
    expect(problems(patch((x) => (x.evm.chains[0].contracts = [])))).toEqual([]);
    expect(problems(patch((x) => (x.stellar.contracts = [])))).toEqual([]);
  });

  it('accepts limits at their bounds', () => {
    expect(problems(patch((x) => (x.limits.perDayCount = 1)))).toEqual([]);
    expect(problems(patch((x) => (x.limits.perDayCount = 500)))).toEqual([]);
    expect(problems(patch((x) => (x.maxConsentMs = 60_000)))).toEqual([]);
    expect(problems(patch((x) => (x.maxConsentMs = MAX_SESSION_TTL_MS)))).toEqual([]);
    expect(problems(patch((x) => (x.label = 'x'.repeat(80))))).toEqual([]);
    expect(problems(patch((x) => (x.stellar.maxFeeStroops = '4294967295')))).toEqual([]);
    expect(problems(patch((x) => (x.evm.chains[0].maxValueWei = '0')))).toEqual([]);
  });
});

describe('validateAutoApprovePolicy: refusals', () => {
  it.each([
    ['ERC-20 approve', (x: Mutable) => (x.evm.chains[0].contracts[0].selectors[0].addressArgs = 'any')],
    [
      'ERC-20 transfer',
      (x: Mutable) =>
        (x.evm.chains[0].contracts[0].selectors = [
          { selector: '0xa9059cbb', signature: 'transfer(address,uint256)', addressArgs: 'any' },
        ]),
    ],
    [
      'ERC-20 transferFrom',
      (x: Mutable) =>
        (x.evm.chains[0].contracts[0].selectors = [
          { selector: '0x23b872dd', signature: 'transferFrom(address,address,uint256)', addressArgs: 'any' },
        ]),
    ],
    [
      'Sodax AssetManager.transfer',
      (x: Mutable) =>
        (x.evm.chains[0].contracts[0].selectors = [
          {
            selector: functionSelector('transfer(address,bytes,uint256,bytes)'),
            signature: 'transfer(address,bytes,uint256,bytes)',
            addressArgs: 'any',
          },
        ]),
    ],
    [
      'Sodax Connection.sendMessage',
      (x: Mutable) =>
        (x.evm.chains[0].contracts[0].selectors = [
          {
            selector: functionSelector('sendMessage(uint256,bytes,bytes)'),
            signature: 'sendMessage(uint256,bytes,bytes)',
            addressArgs: 'any',
          },
        ]),
    ],
    ['SAC transfer', (x: Mutable) => (x.stellar.contracts[1].functions[0].addressArgs = 'any')],
    ['SAC approve', (x: Mutable) => (x.stellar.contracts[1].functions[1].addressArgs = 'any')],
    [
      'Soroban transfer_from',
      (x: Mutable) => x.stellar.contracts[1].functions.push({ name: 'transfer_from', addressArgs: 'any' }),
    ],
    [
      'Sodax send_message',
      (x: Mutable) => x.stellar.contracts[0].functions.push({ name: 'send_message', addressArgs: 'any' }),
    ],
    [
      'Soroban transfer_and_call',
      (x: Mutable) => x.stellar.contracts[1].functions.push({ name: 'transfer_and_call', addressArgs: 'any' }),
    ],
    ['SAC set_admin', (x: Mutable) => x.stellar.contracts[1].functions.push({ name: 'set_admin', addressArgs: 'any' })],
  ])("refuses addressArgs 'any' on %s", (_, f) => {
    expect(problems(patch(f)).join()).toMatch(/moves or approves assets/u);
  });

  it.each([
    ['ERC-677/1363 transferAndCall', 'transferAndCall(address,uint256,bytes)'],
    ['ERC-1363 approveAndCall', 'approveAndCall(address,uint256,bytes)'],
    ['ERC-777 send', 'send(address,uint256,bytes)'],
    ['ERC-777 operatorSend', 'operatorSend(address,address,uint256,bytes,bytes)'],
    ['ERC-777 authorizeOperator', 'authorizeOperator(address)'],
    [
      'EIP-3009 transferWithAuthorization',
      'transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)',
    ],
    ['Ownable transferOwnership', 'transferOwnership(address)'],
    [
      'Permit2 permitTransferFrom',
      'permitTransferFrom(((address,uint256),uint256,uint256),(address,uint256),address,bytes)',
    ],
    ['decreaseAllowance', 'decreaseAllowance(address,uint256)'],
    ['an OFT sendFrom', 'sendFrom(address,uint16,bytes,uint256,address,address,bytes)'],
    ['setOwner', 'setOwner(address)'],
  ])("refuses addressArgs 'any' on %s", (_, signature) => {
    const p = patch(
      (x) =>
        (x.evm.chains[0].contracts[0].selectors = [
          { selector: functionSelector(signature), signature, addressArgs: 'any' },
        ]),
    );
    expect(problems(p).join()).toMatch(/moves or approves assets/u);
  });

  it('refuses a missing addressArgs on an EVM function that takes an address, at any depth', () => {
    expect(problems(patch((x) => delete x.evm.chains[0].contracts[1].selectors[1].addressArgs)).join()).toMatch(
      /takes an address/u,
    );
    expect(problems(patch((x) => delete x.evm.chains[0].contracts[1].selectors[2].addressArgs)).join()).toMatch(
      /takes an address/u,
    );
  });

  const withSelector = (signature: string, addressArgs?: 'self-or-listed' | 'any') =>
    patch(
      (x) =>
        (x.evm.chains[0].contracts[1].selectors = [
          { selector: functionSelector(signature), signature, ...(addressArgs ? { addressArgs } : {}) },
        ]),
    );

  it.each([
    // Wormhole TokenBridge: the recipient is a bytes32.
    ['a bytes32 recipient (Wormhole transferTokens)', 'transferTokens(address,uint256,uint16,bytes32,uint256,uint32)'],
    // Axelar Gateway: the destination address is a string.
    ['a string recipient (Axelar sendToken)', 'sendToken(string,string,string,uint256)'],
    ['a bytes20 argument', 'bridge(address,bytes20,uint256)'],
    ['a bytes32 inside a tuple array', 'bridge((uint256,bytes32)[])'],
    ['a string inside a tuple', 'register((address,string))'],
  ])("refuses 'self-or-listed' on a function with %s", (_, signature) => {
    expect(problems(withSelector(signature, 'self-or-listed')).join()).toMatch(/opaque arguments/u);
  });

  it.each([
    // Names chosen so that only the argument check applies (the name checks would refuse `execute`, `transferTokens`,
    // `sendToken`, `multicall` and `aggregate` on their own).
    ['opaque bytes', 'run(address,bytes)'],
    ['a bytes32 recipient (Wormhole-shaped)', 'lockTokens(address,uint256,uint16,bytes32,uint256,uint32)'],
    ['a string recipient (Axelar-shaped)', 'bridgeToken(string,string,string,uint256)'],
    ['a router path in bytes', 'exactInput((bytes,address,uint256,uint256,uint256))'],
    ['a bytes array', 'many(bytes[])'],
    ['calls in a tuple array', 'group((address,bytes)[])'],
    ['a bytes20 argument', 'bridge(address,bytes20,uint256)'],
    ['a string inside a tuple', 'register((address,string))'],
    ['a uint160 argument', 'stake(uint160,uint256)'],
    ['an int160 inside a tuple array', 'stake((int160,uint256)[])'],
  ])("refuses addressArgs 'any' on a function with %s: it needs a protocol decoder", (_, signature) => {
    expect(problems(withSelector(signature, 'any')).join()).toMatch(/opaque arguments.*needs a protocol decoder/u);
  });

  it.each([
    'execute(address,uint256,bytes)',
    'multicall(bytes[])',
    'multicall(uint256,bytes[])',
    'aggregate((address,bytes)[])',
    'transferTokens(address,uint256,uint16,bytes32,uint256,uint32)',
    'sendToken(string,string,string,uint256)',
  ])("refuses addressArgs 'any' and 'self-or-listed' on %s", (signature) => {
    expect(problems(withSelector(signature, 'any'))).not.toEqual([]);
    expect(problems(withSelector(signature, 'self-or-listed'))).not.toEqual([]);
  });

  it.each([
    ['a uint160', 'stake(uint160,uint256)'],
    ['an int160', 'stake(address,int160)'],
    ['a uint160 inside a tuple array', 'stake((uint160,uint256)[])'],
  ])("refuses 'self-or-listed' and the default on a function with %s (an address as an integer)", (_, signature) => {
    expect(problems(withSelector(signature, 'self-or-listed')).join()).toMatch(/160-bit integer/u);
    if (!signature.includes('address')) expect(problems(withSelector(signature)).join()).toMatch(/opaque arguments/u);
  });

  it('accepts integers of other widths, uint256 included, as amounts', () => {
    for (const sig of ['stake(uint256,int256)', 'stake(uint152,uint168)', 'stake(uint8,int128)', 'stake(uint256[])']) {
      expect(problems(withSelector(sig)), sig).toEqual([]);
    }
  });

  it.each([
    ['execute', 'execute(address,uint256)'],
    ['executeBatch', 'executeBatch(address[],uint256[])'],
    ['execTransaction', 'execTransaction(address,uint256,uint8)'],
    ['tryAggregate', 'tryAggregate(bool,uint256)'],
    ['aggregate3', 'aggregate3(address[])'],
    ['delegateCall', 'delegateCall(address)'],
    ['call', 'call(address,uint256)'],
    ['callContract', 'callContract(address)'],
    ['batchCall', 'batchCall(address[])'],
    ['invoke', 'invoke(address,uint256)'],
    ['forward', 'forward(address,uint256)'],
    ['relay', 'relay(address)'],
    ['dispatch', 'dispatch(address,uint256)'],
    ['upgradeTo', 'upgradeTo(address)'],
    ['proxyCall', 'proxyCall(address)'],
  ])("refuses addressArgs 'any' on the execute-style %s (no opaque arguments)", (_, signature) => {
    expect(problems(withSelector(signature, 'any')).join()).toMatch(/executes calls.*needs a protocol decoder/u);
    // The address rule is still allowed: every argument is typed, so it can check them.
    expect(problems(withSelector(signature, 'self-or-listed'))).toEqual([]);
  });

  it.each([
    ['execute', 'execute'],
    ['invoke_contract', 'invoke_contract'],
    ['multicall', 'multicall'],
    ['exec_batch', 'exec_batch'],
    ['upgrade', 'upgrade'],
  ])("refuses addressArgs 'any' on the Soroban execute-style %s", (_, name) => {
    const p = patch((x) => x.stellar.contracts[0].functions.push({ name, addressArgs: 'any' }));
    expect(problems(p).join()).toMatch(/executes calls/u);
    const ok = patch((x) => x.stellar.contracts[0].functions.push({ name, addressArgs: 'self-or-listed' }));
    expect(problems(ok)).toEqual([]);
  });

  it("accepts addressArgs 'any' on a typed function whose name is neither value-moving nor execute-style", () => {
    expect(problems(withSelector('vote(address,uint256)', 'any'))).toEqual([]);
    expect(problems(withSelector('register(address,bytes4)', 'any'))).toEqual([]);
  });

  it('refuses the defaulted addressArgs on a function with only a string or bytes32 argument', () => {
    expect(problems(withSelector('setRecipient(string)')).join()).toMatch(/opaque arguments/u);
    expect(problems(withSelector('claim(bytes32)')).join()).toMatch(/opaque arguments/u);
  });

  it("accepts fixed bytes too short to hold an address (bytes4 to bytes19) under 'self-or-listed'", () => {
    expect(problems(withSelector('call(address,bytes4,bytes19)', 'self-or-listed'))).toEqual([]);
    expect(problems(withSelector('ping(bytes1)'))).toEqual([]);
  });

  it.each([
    ['raw signing', (x: Mutable) => (x.raw = true)],
    ['personal_sign', (x: Mutable) => (x.evm.chains[0].personalSign = true)],
    ['stellar_signMessage', (x: Mutable) => (x.stellar.messages = true)],
    ['a classic operation', (x: Mutable) => (x.stellar.payments = ['native'])],
    ['an unknown function key', (x: Mutable) => (x.stellar.contracts[0].functions[0].maxAmount = '1')],
  ])('refuses %s entries (unknown keys)', (_, f) => {
    expect(problems(patch(f)).join()).toMatch(/unknown key/u);
  });

  it.each([
    ['an empty address', ''],
    ['0x', '0x'],
    ['the zero address', `0x${'00'.repeat(20)}`],
  ])('refuses contract creation via %s', (_, address) => {
    expect(problems(patch((x) => (x.evm.chains[0].contracts[0].address = address)))).not.toEqual([]);
  });

  it.each([
    ['perDayCount 0', (x: Mutable) => (x.limits.perDayCount = 0)],
    ['perDayCount 501', (x: Mutable) => (x.limits.perDayCount = 501)],
    ['perDayCount fractional', (x: Mutable) => (x.limits.perDayCount = 1.5)],
    ['maxConsentMs below a minute', (x: Mutable) => (x.maxConsentMs = 59_999)],
    ['maxConsentMs over 23 h 50 min', (x: Mutable) => (x.maxConsentMs = MAX_SESSION_TTL_MS + 1)],
    ['maxFeeStroops 0', (x: Mutable) => (x.stellar.maxFeeStroops = '0')],
    ['maxFeeStroops over u32', (x: Mutable) => (x.stellar.maxFeeStroops = '4294967296')],
    ['maxFeeStroops as a number', (x: Mutable) => (x.stellar.maxFeeStroops = 100)],
    ['maxFeeStroops with a leading zero', (x: Mutable) => (x.stellar.maxFeeStroops = '0100')],
    ['maxValueWei over maxValueWeiPerDay', (x: Mutable) => (x.evm.chains[0].maxValueWei = '301501')],
    ['no maxFeeWei', (x: Mutable) => delete x.evm.chains[0].maxFeeWei],
    ['maxFeeWei 0', (x: Mutable) => (x.evm.chains[0].maxFeeWei = '0')],
    ['maxFeeWei as a number', (x: Mutable) => (x.evm.chains[0].maxFeeWei = 100000)],
    ['maxFeeWei over 2^256', (x: Mutable) => (x.evm.chains[0].maxFeeWei = (2n ** 256n).toString())],
    ['a negative maxFeeWei', (x: Mutable) => (x.evm.chains[0].maxFeeWei = '-1')],
    ['maxValueWeiPerDay over 2^256', (x: Mutable) => (x.evm.chains[0].maxValueWeiPerDay = (2n ** 256n).toString())],
    ['a negative value', (x: Mutable) => (x.evm.chains[0].maxValueWei = '-1')],
    ['chainId 0', (x: Mutable) => (x.evm.chains[0].chainId = 0)],
    ['a label over 80 characters', (x: Mutable) => (x.label = 'x'.repeat(81))],
    ['an empty label', (x: Mutable) => (x.label = '')],
    ['a label with a bidi override', (x: Mutable) => (x.label = `Swaps${String.fromCodePoint(0x202e)}`)],
    ['a label with padding', (x: Mutable) => (x.label = ' Swaps')],
    ['a contract name with a newline', (x: Mutable) => (x.stellar.contracts[0].name = 'Pool\nOfficial')],
    ['version 2', (x: Mutable) => (x.v = 2)],
    ['no chain section', (x: Mutable) => (delete x.stellar, delete x.evm)],
    ['no passphrase', (x: Mutable) => (x.stellar.networkPassphrases = [])],
    ['no EVM chains', (x: Mutable) => (x.evm.chains = [])],
    ['an empty Stellar section', (x: Mutable) => ((x.stellar.contracts = []), (x.stellar.changeTrustAssets = []))],
    ['an empty EVM chain', (x: Mutable) => ((x.evm.chains[0].contracts = []), (x.evm.chains[0].typedData = []))],
    ['a function list that is empty', (x: Mutable) => (x.stellar.contracts[0].functions = [])],
  ])('refuses %s', (_, f) => {
    expect(problems(patch(f))).not.toEqual([]);
  });

  it('caps maxConsentMs at the app session TTL', () => {
    expect(problems(policyJson(), { sessionTtlMs: 12 * 3_600_000 })).toEqual([]);
    expect(problems(policyJson(), { sessionTtlMs: 12 * 3_600_000 - 1 })).not.toEqual([]);
  });

  it.each([
    [
      'a selector that does not match the signature',
      (x: Mutable) => (x.evm.chains[0].contracts[0].selectors[0].selector = '0xa9059cbb'),
    ],
    [
      'a non-canonical signature',
      (x: Mutable) => (x.evm.chains[0].contracts[0].selectors[0].signature = 'approve(address, uint256)'),
    ],
    ['a uint alias', (x: Mutable) => (x.evm.chains[0].contracts[0].selectors[0].signature = 'approve(address,uint)')],
    ['a bad selector format', (x: Mutable) => (x.evm.chains[0].contracts[0].selectors[0].selector = '0x095ea7b')],
    ['a bad Stellar contract id', (x: Mutable) => (x.stellar.contracts[0].id = 'GABC')],
    [
      'a G… address as a contract',
      (x: Mutable) => (x.stellar.contracts[0].id = x.stellar.changeTrustAssets[0].split(':')[1]),
    ],
    [
      'a contract id with a bad checksum',
      (x: Mutable) => (x.stellar.contracts[0].id = `${POOL.slice(0, -1)}${POOL.endsWith('A') ? 'B' : 'A'}`),
    ],
    ['a bad function name', (x: Mutable) => (x.stellar.contracts[0].functions[0].name = 'swap-now')],
    ['a bad change-trust asset', (x: Mutable) => (x.stellar.changeTrustAssets = ['USDC'])],
    ['a native change-trust asset', (x: Mutable) => (x.stellar.changeTrustAssets = ['native'])],
    ['a bad EVM checksum', (x: Mutable) => (x.evm.chains[0].contracts[0].address = EVM_USDC.replace('A0b8', 'a0B8'))],
    [
      'an M… address',
      (x: Mutable) => (x.stellar.addresses = ['MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUQ']),
    ],
    [
      'a typedData primaryType of EIP712Domain',
      (x: Mutable) => (x.evm.chains[0].typedData[0].primaryType = 'EIP712Domain'),
    ],
    ['an unknown addressArgs value', (x: Mutable) => (x.stellar.contracts[0].functions[0].addressArgs = 'self')],
  ])('refuses %s', (_, f) => {
    expect(problems(patch(f))).not.toEqual([]);
  });

  it('refuses both addressArgs and a decoder on one function', () => {
    const both = patch(
      (x) => (x.stellar.contracts[0].functions[0] = { name: 'swap', addressArgs: 'self-or-listed', decoder: 'd1' }),
    );
    const decoders = protocolDecoderRegistry([fakeDecoder('d1', 'stellar')]);
    expect(problems(both, { decoders }).join()).toMatch(/either "addressArgs" or "decoder"/u);
  });

  it.each([
    ['contracts', (x: Mutable) => x.stellar.contracts.push(structuredClone(x.stellar.contracts[0]))],
    ['functions', (x: Mutable) => x.stellar.contracts[0].functions.push({ name: 'swap' })],
    ['passphrases', (x: Mutable) => x.stellar.networkPassphrases.push(x.stellar.networkPassphrases[0])],
    ['assets', (x: Mutable) => x.stellar.changeTrustAssets.push(x.stellar.changeTrustAssets[0])],
    [
      'EVM contracts (any case)',
      (x: Mutable) =>
        x.evm.chains[0].contracts.push({
          ...structuredClone(x.evm.chains[0].contracts[0]),
          address: EVM_USDC.toLowerCase(),
        }),
    ],
    [
      'selectors',
      (x: Mutable) =>
        x.evm.chains[0].contracts[0].selectors.push(structuredClone(x.evm.chains[0].contracts[0].selectors[0])),
    ],
    ['chains', (x: Mutable) => x.evm.chains.push(structuredClone(x.evm.chains[0]))],
    ['typedData', (x: Mutable) => x.evm.chains[0].typedData.push(structuredClone(x.evm.chains[0].typedData[0]))],
  ])('refuses duplicate %s', (_, f) => {
    expect(problems(patch(f)).join()).toMatch(/duplicate/u);
  });

  it('refuses a decoder id the bundle does not ship (the batch B registry is empty)', () => {
    expect(PROTOCOL_DECODERS.size).toBe(0);
    const withDecoder = patch(
      (x) => (x.stellar.contracts[0].functions[0] = { name: 'swap', decoder: 'sodax-intent-v1' }),
    );
    expect(problems(withDecoder).join()).toMatch(/unknown protocol decoder/u);
    const registry = protocolDecoderRegistry([fakeDecoder('sodax-intent-v1', 'stellar')]);
    expect(problems(withDecoder, { decoders: registry })).toEqual([]);
    // A decoder for the other chain is refused, and a decoder entry may cover a value-moving function.
    expect(
      problems(withDecoder, { decoders: protocolDecoderRegistry([fakeDecoder('sodax-intent-v1', 'evm')]) }).join(),
    ).toMatch(/not for stellar/u);
    const transferDecoder = patch(
      (x) => (x.stellar.contracts[1].functions[0] = { name: 'transfer', decoder: 'sodax-intent-v1' }),
    );
    expect(problems(transferDecoder, { decoders: registry })).toEqual([]);
    expect(() => protocolDecoderRegistry([fakeDecoder('a', 'evm'), fakeDecoder('a', 'evm')])).toThrow();
  });

  it('refuses non-object input and reports every problem with its path', () => {
    expect(problems(null)).toEqual(['policy: must be an object']);
    expect(problems([])).toEqual(['policy: must be an object']);
    const many = problems(
      patch((x) => {
        x.limits.perDayCount = 0;
        x.stellar.maxFeeStroops = '0';
      }),
    );
    expect(many).toEqual([
      'policy.limits.perDayCount: must be between 1 and 500',
      'stellar.maxFeeStroops: must be between 1 and 4294967295',
    ]);
  });

  it('caps the canonical size', () => {
    const big = patch((x) => {
      x.stellar.addresses = [];
      x.evm.chains[0].addresses = [];
      x.evm.chains[0].contracts = Array.from({ length: 32 }, (_, i) => ({
        address: `0x${'ab'.repeat(19)}${i.toString(16).padStart(2, '0')}`,
        name: 'n'.repeat(64),
        selectors: Array.from({ length: 8 }, (_, j) => ({
          selector: functionSelector(`f${j}()`),
          signature: `f${j}()`,
        })),
      }));
    });
    expect(problems(big).join()).toMatch(/over 16384 bytes/u);
  });
});

describe('isValueMovingFunctionName', () => {
  it('matches camelCase and snake_case forms', () => {
    for (const n of [
      'approve',
      'transfer',
      'transferFrom',
      'transfer_from',
      'safeTransferFrom',
      'setApprovalForAll',
      'permit',
      'sendMessage',
      'send_message',
      'increaseAllowance',
      'decrease_allowance',
      'transferAndCall',
      'transfer_and_call',
      'approveAndCall',
      'send',
      'sendToken',
      'operatorSend',
      'authorizeOperator',
      'transferWithAuthorization',
      'transferOwnership',
      'acceptOwnership',
      'renounceOwnership',
      'permitTransferFrom',
      'safeBatchTransferFrom',
      'set_admin',
      'setOwner',
      'TRANSFER',
    ]) {
      expect(isValueMovingFunctionName(n)).toBe(true);
    }
    for (const n of ['swap', 'deposit', 'withdraw', 'balance', 'mint', 'stake', 'claim', 'route', 'execute']) {
      expect(isValueMovingFunctionName(n)).toBe(false);
    }
  });
});

describe('isExecutionStyleFunctionName', () => {
  it('matches camelCase and snake_case forms', () => {
    for (const n of [
      'execute',
      'executeBatch',
      'execute_call',
      'execTransaction',
      'multicall',
      'tryMulticall',
      'aggregate',
      'aggregate3',
      'tryAggregate',
      'blockAndAggregate',
      'delegatecall',
      'call',
      'callContract',
      'batch',
      'batchExecute',
      'invoke',
      'forward',
      'relay',
      'dispatch',
      'handleOps',
      'upgradeTo',
      'upgradeToAndCall',
      'proxyCall',
      'EXECUTE',
    ]) {
      expect(isExecutionStyleFunctionName(n), n).toBe(true);
    }
    for (const n of ['swap', 'deposit', 'withdraw', 'mint', 'stake', 'claim', 'route', 'vote', 'register']) {
      expect(isExecutionStyleFunctionName(n), n).toBe(false);
    }
  });
});

describe('parseAutoApprovePolicy', () => {
  it('parses strictly: duplicate keys and big numbers are refused', () => {
    expect(parseAutoApprovePolicy(JSON.stringify(policyJson())).ok).toBe(true);
    const dup = JSON.stringify(policyJson()).replace('"perDayCount":3', '"perDayCount":3,"perDayCount":500');
    expect(parseAutoApprovePolicy(dup)).toMatchObject({
      ok: false,
      problems: [expect.stringMatching(/Duplicate JSON key/u)],
    });
    const big = JSON.stringify(policyJson()).replace('"perDayCount":3', '"perDayCount":9007199254740993');
    expect(parseAutoApprovePolicy(big).ok).toBe(false);
    expect(parseAutoApprovePolicy('{').ok).toBe(false);
  });
});

describe('policyId', () => {
  const reorder = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(reorder);
    if (typeof v === 'object' && v !== null) {
      return Object.fromEntries(
        Object.entries(v)
          .reverse()
          .map(([k, x]) => [k, reorder(x)]),
      );
    }
    return v;
  };

  it('is a 64-hex sha256 over the domain and the canonical JSON', async () => {
    const id = policyId(policyJson());
    expect(id).toMatch(/^[0-9a-f]{64}$/u);
    const r = validateAutoApprovePolicy(policyJson());
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256')
      .update(POLICY_ID_DOMAIN)
      .update(canonicalJson(r.ok ? r.policy : null))
      .digest('hex');
    expect(id).toBe(expected);
  });

  it('is stable under key reordering, address case and a defaulted addressArgs', () => {
    const id = policyId(policyJson());
    expect(policyId(reorder(policyJson()))).toBe(id);
    expect(policyId(patch((x) => (x.evm.chains[0].contracts[1].address = EVM_VAULT.toLowerCase())))).toBe(id);
    expect(policyId(patch((x) => (x.stellar.contracts[0].functions[0].addressArgs = 'self-or-listed')))).toBe(id);
  });

  it('changes with any change of meaning', () => {
    const id = policyId(policyJson());
    const changes: ((x: Mutable) => void)[] = [
      (x) => (x.label = 'Other'),
      (x) => (x.limits.perDayCount = 4),
      (x) => (x.maxConsentMs += 1),
      (x) => (x.stellar.maxFeeStroops = '100001'),
      (x) => (x.stellar.contracts[0].functions[0].addressArgs = 'any'),
      (x) => (x.stellar.contracts[0].name = 'Other pool'),
      (x) => x.stellar.contracts.reverse(),
      (x) => (x.evm.chains[0].chainId = CHAIN + 1),
      (x) => (x.evm.chains[0].maxValueWei = '100999'),
      (x) => (x.evm.chains[0].maxFeeWei = '99999'),
      (x) => (x.stellar.addresses = [TOKEN]),
    ];
    const ids = changes.map((f) => policyId(patch(f)));
    expect(new Set([id, ...ids]).size).toBe(changes.length + 1);
  });

  it('throws for an invalid policy', () => {
    expect(() => policyId(patch((x) => (x.limits.perDayCount = 0)))).toThrow(/Invalid auto-approve policy/u);
  });
});

describe('canonicalJson', () => {
  it('sorts keys, drops undefined and has no whitespace', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x"y'], c: undefined, A: { z: 0, y: -1 } })).toBe(
      '{"A":{"y":-1,"z":0},"a":[true,null,"x\\"y"],"b":1}',
    );
    expect(() => canonicalJson(1.5)).toThrow();
    expect(() => canonicalJson(1n)).toThrow();
  });
});
