// The approval window's plain summary (src/decode/summary.ts, D808–D812): for every request kind, the headline, lines,
// fee and network, the warnings for permissions to spend the user's tokens, and whether Journear can explain the
// request (the details start open when it can't; raw signing's can't be folded). Hostile inputs included: look-alike
// and invisible characters, huge values, the zero address, revokes, and typed data that imitates a permit.
import { Account, Address, Asset, Claimant, Keypair, LiquidityPoolAsset, MuxedAccount, Operation, TransactionBuilder, getLiquidityPoolId, xdr } from '@stellar/stellar-base';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type ApprovalSummary,
  type DecodedApproval,
  type NearAction,
  PERMIT2_ADDRESS,
  PRACTICALLY_UNLIMITED,
  UNEXPLAINED_SUMMARY,
  STELLAR_MAINNET_PASSPHRASE,
  type StellarOperation,
  type SummaryText,
  decodeApprovalRequest,
  encodeNearDelegateAction,
  encodeNearTransaction,
  encodeNep413Message,
  evmTxSigningPayload,
  formatTokenUnits,
  knownEvmToken,
  knownStellarToken,
  nearImplicitAccountId,
  nearPublicKeyString,
  parseEvmTxRequest,
  parseFunctionSignature,
  sha256,
  summarizeApproval as summarizeApprovalRaw,
  displayUnits,
  nearDisplay,
  MAX_GROUP_LINES,
  summaryString,
  utf8,
} from './entries.ts';
import { ATTACKER, ISSUER, OTHER, PASSPHRASE, TOKEN, ROUTER, USER, addSignerOp, addr, authPreimageBytes, feeBumpBytes, i128, invocation, invokeOp, mergeOp, paymentOp, sourceAuth, txBytes } from './stellar-fixtures.ts';

/** A public key computed here (never a literal in the source), for the full-key assertions. */
const KEY9 = nearPublicKeyString(new Uint8Array(32).fill(9));
const APP = 'Partner App';

/**
 * Every summary these tests build goes through this: the catch-all (UNEXPLAINED_SUMMARY) must never be what a valid
 * request gets, so a bug can't hide behind it (review 3). Only the test that feeds malformed shapes allows it.
 */
const fallbackHits: string[] = [];
let allowFallback = false;
const summarizeApproval: typeof summarizeApprovalRaw = (d, ctx) => {
  const s = summarizeApprovalRaw(d, ctx);
  if (s === UNEXPLAINED_SUMMARY && !allowFallback) fallbackHits.push(d.kind);
  return s;
};
afterAll(() => {
  expect(fallbackHits).toEqual([]);
});
const text = (t: SummaryText): string => summaryString(t, APP);
const headline = (s: ApprovalSummary) => text(s.headline);
const warnings = (s: ApprovalSummary) => s.warnings.map((w) => [w.level, w.code, text(w.text)] as const);
const codes = (s: ApprovalSummary) => s.warnings.map((w) => w.code);

// ---- EVM ----

const ME = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const TO = '0x000000000000000000000000000000000000dEaD';
const TOKEN_EVM = '0x1111111111111111111111111111111111111111';
const SPENDER = '0x3333333333333333333333333333333333333333';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_SODAX = '0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3';
const UINT256_MAX = 2n ** 256n - 1n;

const word = (v: bigint | string | boolean) => (typeof v === 'string' ? v.slice(2).toLowerCase().padStart(64, '0') : (typeof v === 'boolean' ? (v ? 1n : 0n) : v).toString(16).padStart(64, '0'));
const calldata = (sig: string, ...args: (bigint | string | boolean)[]) => `${parseFunctionSignature(sig).selector}${args.map(word).join('')}`;

function evm(over: { to?: string | null; value?: bigint; data?: string } = {}, chainId = 11155111): DecodedApproval {
  const tx = {
    chainId: `0x${chainId.toString(16)}`,
    nonce: '0x1',
    gas: '0x5208',
    maxFeePerGas: '0x77359400',
    maxPriorityFeePerGas: '0x1',
    ...(over.to === null ? {} : { to: over.to ?? TO }),
    value: `0x${(over.value ?? 10n ** 18n).toString(16)}`,
    data: over.data ?? '0x',
  };
  return decodeApprovalRequest({ kind: 'evm_tx', chain: 'evm', address: ME, context: { chainId }, bytes: evmTxSigningPayload(parseEvmTxRequest(tx)) });
}
const evmSummary = (over: Parameters<typeof evm>[0], chainId?: number) => summarizeApproval(evm(over, chainId), { address: ME });
const tokenCall = (data: string, chainId?: number, to = TOKEN_EVM) => evmSummary({ to, value: 0n, data }, chainId);

describe('EVM transactions', () => {
  it('a plain send: the amount and recipient, the fee, the network; details closed', () => {
    const s = evmSummary({});
    expect(headline(s)).toBe(`${APP} wants to send 1 ETH to ${TO}`);
    expect(text(s.fee!)).toBe('up to 0.000042 ETH');
    expect(text(s.network!)).toBe('Sepolia (testnet), chain 11155111');
    expect(s.warnings).toEqual([]);
    expect(s.explainable).toBe(true);
  });

  it('a send to the user’s own address says so; a chain Journear can’t name is said plainly, never given a coin', () => {
    expect(headline(evmSummary({ to: ME }))).toBe(`${APP} wants to send 1 ETH to your account`);
    const s = evmSummary({}, 987654321);
    expect(headline(s)).toBe(`${APP} wants to send 1 of this chain’s coin to ${TO}`);
    expect(text(s.network!)).toBe('chain 987654321, which Journear doesn’t know by name');
  });

  it('an ERC-20 transfer of a token Journear doesn’t know: "tokens of contract", the amount in smallest units, never a guessed symbol', () => {
    const s = tokenCall(calldata('transfer(address,uint256)', TO, 5_000_000n));
    expect(headline(s)).toBe(`${APP} wants to send tokens of contract ${TOKEN_EVM} to ${TO}`);
    expect(s.lines.map(text)).toEqual(['Amount: 5,000,000 in the token’s smallest units (Journear doesn’t know this token’s decimals).']);
    expect(s.explainable).toBe(true);
  });

  it('an ERC-20 transfer of a pinned token (Base USDC): its symbol and decimals', () => {
    expect(knownEvmToken(8453, BASE_USDC.toLowerCase())).toEqual(expect.objectContaining({ symbol: 'USDC', decimals: 6 }));
    expect(knownEvmToken(84532, BASE_USDC)).toBeNull();
    const s = tokenCall(calldata('transfer(address,uint256)', TO, 5_000_000n), 8453, BASE_USDC);
    expect(headline(s)).toBe(`${APP} wants to send 5 USDC to ${TO}`);
    // The contract stays in view next to the symbol.
    expect(s.lines.map(text)).toEqual([`USDC here is the token contract ${BASE_USDC}, on Journear’s reviewed list.`]);
    expect(text(s.fee!)).toBe('up to 0.000042 ETH');
  });

  it('approve of a bounded amount: an amber warning naming the unverified spender and the amount (or an NFT’s item)', () => {
    const s = tokenCall(calldata('approve(address,uint256)', SPENDER, 1000n));
    expect(headline(s)).toBe(`${APP} wants to let someone else spend your tokens of contract ${TOKEN_EVM}`);
    expect(warnings(s)).toEqual([
      [
        'warning',
        'spend_permission',
        `This lets ${SPENDER}, an address Journear hasn’t verified, spend up to 1,000 (in the token’s smallest units) of your tokens of contract ${TOKEN_EVM}, until it is used up or you take the permission back. If the contract is an NFT collection, it lets them take your item 1000 instead.`,
      ],
    ]);
  });

  it('approve of the max uint256, or of a practically unlimited amount: the red warning', () => {
    const max = tokenCall(calldata('approve(address,uint256)', SPENDER, UINT256_MAX));
    expect(warnings(max)).toEqual([['danger', 'unlimited_spend', `This lets ${SPENDER}, an address Journear hasn’t verified, spend all of your tokens of contract ${TOKEN_EVM}, with no limit, until you take the permission back. Approve only if you trust it completely.`]]);
    const huge = tokenCall(calldata('approve(address,uint256)', SPENDER, PRACTICALLY_UNLIMITED));
    expect(codes(huge)).toEqual(['unlimited_spend']);
    expect(text(huge.warnings[0]!.text)).toContain('with no practical limit');
    expect(codes(tokenCall(calldata('approve(address,uint256)', SPENDER, PRACTICALLY_UNLIMITED - 1n)))).toEqual(['spend_permission']);
  });

  it('approve of 0 to the zero address is a revoke: no warning', () => {
    const s = tokenCall(calldata('approve(address,uint256)', `0x${'0'.repeat(40)}`, 0n));
    expect(headline(s)).toBe(`${APP} wants to take back 0x${'0'.repeat(40)}’s permission to spend your tokens of contract ${TOKEN_EVM}`);
    expect(s.warnings).toEqual([]);
  });

  it('a verified spender is named; the zero address is called that; a pinned token is named with its decimals', () => {
    const v = tokenCall(calldata('approve(address,uint256)', BASE_SODAX, 2_500_000n), 8453, BASE_USDC);
    expect(text(v.warnings[0]!.text)).toBe(`This lets Sodax Asset Manager (${BASE_SODAX}, verified by Journear) spend up to 2.5 USDC from your account, until it is used up or you take the permission back.`);
    expect(headline(v)).toBe(`${APP} wants to let someone else spend your USDC`);
    // The same address on another chain isn't the verified contract.
    expect(text(tokenCall(calldata('approve(address,uint256)', BASE_SODAX, 1n)).warnings[0]!.text)).toContain('an address Journear hasn’t verified');
    const zero = tokenCall(calldata('approve(address,uint256)', `0x${'0'.repeat(40)}`, UINT256_MAX));
    expect(text(zero.warnings[0]!.text)).toContain(`0x${'0'.repeat(40)} (the zero address) spend all of`);
  });

  it('increaseAllowance warns (a further amount, or no limit); decreaseAllowance doesn’t', () => {
    const inc = tokenCall(calldata('increaseAllowance(address,uint256)', SPENDER, 7n));
    expect(text(inc.warnings[0]!.text)).toContain('spend a further 7 (in the token’s smallest units)');
    expect(codes(tokenCall(calldata('increaseAllowance(address,uint256)', SPENDER, UINT256_MAX)))).toEqual(['unlimited_spend']);
    const dec = tokenCall(calldata('decreaseAllowance(address,uint256)', SPENDER, 7n));
    expect(dec.warnings).toEqual([]);
    expect(headline(dec)).toContain('wants to lower');
  });

  it('setApprovalForAll(true) is red; (false) is a revoke', () => {
    const on = tokenCall(calldata('setApprovalForAll(address,bool)', SPENDER, true));
    expect(warnings(on)).toEqual([['danger', 'collection_operator', `This lets ${SPENDER}, an address Journear hasn’t verified, move every item you hold in collection ${TOKEN_EVM}, now and later, until you take the permission back. Approve only if you trust it completely.`]]);
    const off = tokenCall(calldata('setApprovalForAll(address,bool)', SPENDER, false));
    expect(off.warnings).toEqual([]);
    expect(headline(off)).toContain('take back');
  });

  it('permit as a transaction: the spend warning when the owner is the user', () => {
    const data = calldata('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)', ME, SPENDER, UINT256_MAX, 1n, 27n, 1n, 2n);
    expect(codes(tokenCall(data))).toEqual(['unlimited_spend']);
    const theirs = calldata('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)', TO, SPENDER, UINT256_MAX, 1n, 27n, 1n, 2n);
    expect(tokenCall(theirs).warnings).toEqual([]);
  });

  it('NFT transfers name the item and the collection', () => {
    expect(headline(tokenCall(calldata('safeTransferFrom(address,address,uint256)', ME, TO, 42n)))).toBe(`${APP} wants to send item 42 of collection ${TOKEN_EVM} from your account to ${TO}`);
  });

  it('an unknown function: Journear can’t tell what it does, in red (it could move value with no visible bound)', () => {
    const s = tokenCall('0xdeadbeef0000');
    expect(headline(s)).toBe(`${APP} wants to use contract ${TOKEN_EVM}`);
    expect(warnings(s)).toEqual([['danger', 'cannot_explain', `Journear can’t tell what this request does: it calls a function Journear doesn’t recognise. It could move your money or tokens. Only approve if you fully trust ${APP}. Technical details are below.`]]);
    expect(s.explainable).toBe(false);
    // Fewer than 4 bytes, and a known selector whose arguments don't decode: the same.
    expect(tokenCall('0x01').explainable).toBe(false);
    expect(tokenCall(parseFunctionSignature('transfer(address,uint256)').selector).explainable).toBe(false);
  });

  it('multicall bundles calls Journear can’t read: not explainable', () => {
    const data = `${parseFunctionSignature('multicall(bytes[])').selector}${word(32n)}${word(0n)}`;
    expect(tokenCall(data).explainable).toBe(false);
  });

  it('a value sent with a call is said; contract creation can’t be explained', () => {
    const s = evmSummary({ to: TOKEN_EVM, value: 10n ** 17n, data: parseFunctionSignature('deposit()').selector });
    expect(headline(s)).toBe(`${APP} wants to use contract ${TOKEN_EVM} (deposit), sending it 0.1 ETH`);
    expect(s.lines).toEqual([]);
    const c = evmSummary({ to: null, value: 0n, data: '0x6000' });
    expect(headline(c)).toBe(`${APP} wants to create a new contract`);
    expect(codes(c)).toEqual(['contract_creation']);
    expect(c.explainable).toBe(false);
  });
});

// ---- EIP-712 ----

const DOMAIN = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];
const PERMIT_TYPES = [
  { name: 'owner', type: 'address' },
  { name: 'spender', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
];

function typed(json: unknown): ApprovalSummary {
  const decoded = decodeApprovalRequest({ kind: 'eip712', chain: 'evm', address: ME, context: {}, bytes: utf8(JSON.stringify(json)) });
  return summarizeApproval(decoded, { address: ME });
}
const permit = (value: string, over: Record<string, unknown> = {}) => ({
  types: { EIP712Domain: DOMAIN, Permit: PERMIT_TYPES },
  primaryType: 'Permit',
  domain: { name: 'Token', version: '1', chainId: 11155111, verifyingContract: TOKEN_EVM },
  message: { owner: ME, spender: SPENDER, value, nonce: '0', deadline: '1900000000' },
  ...over,
});

const PERMIT2_DOMAIN = [
  { name: 'name', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];
const permitSingle = (amount: string, verifyingContract = PERMIT2_ADDRESS) => ({
  types: {
    EIP712Domain: PERMIT2_DOMAIN,
    PermitSingle: [
      { name: 'details', type: 'PermitDetails' },
      { name: 'spender', type: 'address' },
      { name: 'sigDeadline', type: 'uint256' },
    ],
    PermitDetails: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
  },
  primaryType: 'PermitSingle',
  domain: { name: 'Permit2', chainId: 8453, verifyingContract },
  message: { details: { token: BASE_USDC, amount, expiration: '1900000000', nonce: '0' }, spender: SPENDER, sigDeadline: '1900000000' },
});

describe('EIP-712 typed data', () => {
  it('EIP-2612 Permit: the spend warning, amount, chain; summarised, so the tree folds', () => {
    const s = typed(permit('1000'));
    expect(headline(s)).toBe(`${APP} wants your signature to let someone else spend your tokens of contract ${TOKEN_EVM}`);
    expect(codes(s)).toEqual(['spend_permission']);
    expect(text(s.network!)).toBe('Sepolia (testnet), chain 11155111');
    expect(s.explainable).toBe(true);
    expect(codes(typed(permit(UINT256_MAX.toString())))).toEqual(['unlimited_spend']);
    const revoke = typed(permit('0'));
    expect(revoke.warnings).toEqual([]);
    expect(headline(revoke)).toContain('take back');
  });

  it('a Permit for someone else’s tokens says whose', () => {
    const s = typed(permit('5', { message: { owner: TO, spender: SPENDER, value: '5', nonce: '0', deadline: '1' } }));
    expect(s.lines.map(text)).toEqual([`The tokens’ owner it names is ${TO}, not your account.`]);
  });

  it('DAI’s permit (allowed: true) has no limit', () => {
    const s = typed({
      types: { EIP712Domain: DOMAIN, Permit: [{ name: 'holder', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'expiry', type: 'uint256' }, { name: 'allowed', type: 'bool' }] },
      primaryType: 'Permit',
      domain: { name: 'Dai Stablecoin', version: '1', chainId: 1, verifyingContract: TOKEN_EVM },
      message: { holder: ME, spender: SPENDER, nonce: '0', expiry: '0', allowed: true },
    });
    expect(codes(s)).toEqual(['unlimited_spend']);
  });

  it('Permit2 PermitSingle: a pinned token’s amount, or no limit at uint160’s max', () => {
    const s = typed(permitSingle('2500000'));
    expect(headline(s)).toBe(`${APP} wants your signature to let someone else spend your tokens through Permit2`);
    expect(text(s.warnings[0]!.text)).toBe(`This lets ${SPENDER}, an address Journear hasn’t verified, spend up to 2.5 USDC from your account through Permit2, until it is used up or you take the permission back.`);
    const max = typed(permitSingle((2n ** 160n - 1n).toString()));
    expect(text(max.warnings[0]!.text)).toContain('spend all of your USDC through Permit2, with no limit');
  });

  it('Permit2 PermitTransferFrom: a one-time transfer permission', () => {
    const s = typed({
      types: {
        EIP712Domain: PERMIT2_DOMAIN,
        PermitTransferFrom: [
          { name: 'permitted', type: 'TokenPermissions' },
          { name: 'spender', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
        TokenPermissions: [
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
      },
      primaryType: 'PermitTransferFrom',
      domain: { name: 'Permit2', chainId: 11155111, verifyingContract: PERMIT2_ADDRESS },
      message: { permitted: { token: TOKEN_EVM, amount: '9' }, spender: SPENDER, nonce: '1', deadline: '1' },
    });
    expect(codes(s)).toEqual(['spend_permission']);
    expect(text(s.warnings[0]!.text)).toContain('through Permit2, once');
  });

  it('typed data that calls itself Permit2 for another contract: red, and not explained', () => {
    const s = typed(permitSingle('1', TOKEN_EVM));
    expect(codes(s)).toEqual(['cannot_explain', 'permit_lookalike']);
    expect(s.explainable).toBe(false);
  });

  it('malformed typed data that imitates a permit is never summarised as one', () => {
    // Fields reordered, an extra field, an extra type, a different primary type with Permit's fields.
    const reordered = permit('1', { types: { EIP712Domain: DOMAIN, Permit: [PERMIT_TYPES[1], PERMIT_TYPES[0], ...PERMIT_TYPES.slice(2)] } });
    const extraField = permit('1', { types: { EIP712Domain: DOMAIN, Permit: [...PERMIT_TYPES, { name: 'note', type: 'string' }] }, message: { owner: ME, spender: SPENDER, value: '1', nonce: '0', deadline: '1', note: 'x' } });
    const asOther = { ...permit('1'), types: { EIP712Domain: DOMAIN, Permission: PERMIT_TYPES }, primaryType: 'Permission' };
    const noContract = permit('1', { types: { EIP712Domain: DOMAIN.slice(0, 3), Permit: PERMIT_TYPES }, domain: { name: 'Token', version: '1', chainId: 11155111 } });
    for (const t of [reordered, extraField, asOther, noContract]) {
      const s = typed(t);
      expect(s.explainable).toBe(false);
      expect(codes(s)[0]).toBe('cannot_explain');
      // Each one is still flagged as a possible spend permission.
      expect(codes(s)).toContain('spend_permission');
      expect(headline(s)).toBe(`${APP} wants your signature on data Journear can’t explain`);
    }
    // A Permit2 domain with a version is not Permit2's.
    const versioned = permitSingle('1');
    versioned.types.EIP712Domain = [PERMIT2_DOMAIN[0]!, { name: 'version', type: 'string' }, ...PERMIT2_DOMAIN.slice(1)];
    (versioned.domain as Record<string, unknown>).version = '1';
    expect(typed(versioned).explainable).toBe(false);
  });

  it('other typed data: can’t be explained; nothing from it (its type names, its strings) reaches the summary', () => {
    const s = typed({
      types: { EIP712Domain: DOMAIN, SafeLogin: [{ name: 'note', type: 'string' }] },
      primaryType: 'SafeLogin',
      domain: { name: 'Totally safe, nothing moves', version: '1', chainId: 11155111, verifyingContract: TOKEN_EVM },
      message: { note: 'Sign to log in' },
    });
    expect(codes(s)).toEqual(['cannot_explain']);
    const all = [headline(s), ...s.lines.map(text), ...s.warnings.map((w) => text(w.text))].join(' ');
    expect(all).not.toMatch(/SafeLogin|Totally|Sign to log in/u);
  });
});

// ---- messages and raw ----

const msg = (kind: 'personal_sign' | 'stellar_message', s: string, parentOrigin?: string) =>
  summarizeApproval(decodeApprovalRequest({ kind, chain: kind === 'personal_sign' ? 'evm' : 'stellar', address: kind === 'personal_sign' ? ME : USER, context: {}, bytes: utf8(s) }), { address: ME, ...(parentOrigin ? { parentOrigin } : {}) });

describe('messages and raw signing', () => {
  it('a plain message: sign a message, explainable (the text itself stays on screen)', () => {
    const s = msg('personal_sign', 'Hello');
    expect(headline(s)).toBe(`${APP} wants you to sign a message`);
    expect(s.explainable).toBe(true);
    expect(s.fee).toBeNull();
    expect(headline(msg('stellar_message', 'Hello'))).toBe(`${APP} wants you to sign a message`);
  });

  it('a sign-in message (EIP-4361): the domain, and a warning when it isn’t the page’s', () => {
    const siwe = (domain: string) => `${domain} wants you to sign in with your Ethereum account:\n${ME}\n\nURI: https://${domain}\nVersion: 1`;
    const same = msg('personal_sign', siwe('app.example'), 'https://app.example');
    expect(headline(same)).toBe(`${APP} wants you to sign in to app.example`);
    expect(same.warnings).toEqual([]);
    const other = msg('personal_sign', siwe('bank.example'), 'https://app.example');
    expect(warnings(other)).toEqual([['warning', 'sign_in_mismatch', 'This app is at app.example, but the message signs you in to bank.example. Sign only if you mean to sign in to bank.example.']]);
    // Look-alike letters aren't a domain this reads: the message is summarised as a plain message.
    expect(headline(msg('personal_sign', siwe('bаnk.example'), 'https://app.example'))).toBe(`${APP} wants you to sign a message`);
    // A Stellar message is never read as one.
    expect(headline(msg('stellar_message', siwe('bank.example'), 'https://app.example'))).toBe(`${APP} wants you to sign a message`);
  });

  it('a message with bidi or invisible characters is shown as hex: not explainable', () => {
    for (const m of ['a‮b', 'zero​width', 'tag\u{E0041}']) {
      const s = msg('personal_sign', m);
      expect(s.explainable).toBe(false);
      expect(codes(s)).toEqual(['cannot_explain']);
    }
  });

  it('raw signing: a red line that says what it risks and to reject (the details fold like any others)', () => {
    const s = summarizeApproval(decodeApprovalRequest({ kind: 'raw', chain: 'evm', address: ME, context: {}, bytes: new Uint8Array(32) }), { address: ME });
    expect(headline(s)).toBe(`${APP} wants a raw signature that Journear can’t read`);
    expect(s.explainable).toBe(false);
    expect(warnings(s)).toEqual([['danger', 'raw_signing', 'This asks you to sign something Journear can’t read at all. On EVM chains it could give away control of your account or your funds. Reject unless you are certain.']]);
    expect('detailsMustStayOpen' in s).toBe(false);
  });
});

// ---- Stellar ----

const stellar = (ops: xdr.Operation[], bytes = txBytes(ops)) => summarizeApproval(decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes }), { address: USER });

describe('Stellar', () => {
  it('a native payment: amount, recipient, fee and network', () => {
    const s = stellar([paymentOp()]);
    expect(headline(s)).toBe(`${APP} wants to send 1 XLM to ${OTHER}`);
    expect(text(s.fee!)).toBe('up to 0.00001 XLM');
    expect(text(s.network!)).toBe('Stellar testnet');
    expect(s.explainable).toBe(true);
  });

  it('a credit asset is named by code and issuer (its code is its issuer’s choice)', () => {
    const s = stellar([Operation.payment({ destination: OTHER, asset: new Asset('USDC', ISSUER), amount: '2.5' })]);
    expect(headline(s)).toBe(`${APP} wants to send 2.5 of the asset USDC:${ISSUER} to ${OTHER}`);
  });


  it('a fee-bump paid by someone else names the payer; an operation on another account says so', () => {
    const fb = stellar([], feeBumpBytes(txBytes([paymentOp()]), OTHER));
    expect(fb.lines.map(text)).toEqual(['XLM leaving your account: up to 1 XLM, plus the network fee.', `The network fee is paid by ${OTHER}, not your account.`]);
    expect(fb.fee).toBeNull();
    const foreign = stellar([Operation.payment({ destination: USER, asset: Asset.native(), amount: '1', source: OTHER })]);
    expect(foreign.lines).toEqual([]);
    expect(headline(foreign)).toBe(`${APP} wants to send 1 XLM to your account (on the account ${OTHER})`);
  });

  it('a Soroban token transfer (SEP-41) is summarised; amounts of an unknown token in smallest units', () => {
    const s = stellar([invokeOp(TOKEN, 'transfer', [addr(USER), addr(OTHER), i128(15n)])]);
    expect(headline(s)).toBe(`${APP} wants to send 15 (in the token’s smallest units) of the token contract ${TOKEN} to ${OTHER}`);
    expect(s.explainable).toBe(true);
  });

  it('a Soroban approve warns; 0 revokes; the i128 max has no limit', () => {
    const approve = (n: bigint) => stellar([invokeOp(TOKEN, 'approve', [addr(USER), addr(OTHER), i128(n), xdr.ScVal.scvU32(5000)])]);
    expect(codes(approve(10n))).toEqual(['spend_permission']);
    expect(text(approve(10n).warnings[0]!.text)).toContain(`This lets ${OTHER}, an address Journear hasn’t verified, spend up to 10`);
    expect(approve(0n).warnings).toEqual([]);
    expect(headline(approve(0n))).toContain('take back');
    expect(text(approve(2n ** 127n - 1n).warnings[0]!.text)).toContain('with no limit');
  });

  it('any other Soroban call can’t be explained; an approval deep in its authorizations still warns', () => {
    const plain = stellar([invokeOp(ROUTER, 'swap', [i128(1n)])]);
    expect(headline(plain)).toBe(`${APP} wants to use contract ${ROUTER} (swap)`);
    expect(plain.explainable).toBe(false);
    expect(codes(plain)).toEqual(['cannot_explain']);
    const auth = sourceAuth(invocation(ROUTER, 'swap', [i128(1n)], [invocation(TOKEN, 'approve', [addr(USER), addr(OTHER), i128(2n ** 127n - 1n), xdr.ScVal.scvU32(1)])]));
    const deep = stellar([invokeOp(ROUTER, 'swap', [i128(1n)], [auth])]);
    expect(codes(deep)).toEqual(['cannot_explain', 'unlimited_spend']);
    // Any authorization beyond the call itself, even another token call, makes the request unexplainable (review H1).
    const t = stellar([invokeOp(TOKEN, 'transfer', [addr(USER), addr(OTHER), i128(1n)], [sourceAuth(invocation(TOKEN, 'transfer', [addr(USER), addr(OTHER), i128(1n)], [invocation(TOKEN, 'transfer', [addr(USER), addr(OTHER), i128(1n)])]))])]);
    expect(t.explainable).toBe(false);
  });

  it('a transfer with the wrong argument types is not read as one', () => {
    const s = stellar([invokeOp(TOKEN, 'transfer', [addr(USER), addr(OTHER), xdr.ScVal.scvU64(xdr.Uint64.fromString('1'))])]);
    expect(s.explainable).toBe(false);
  });

  it('an authorization entry on the public network for a pinned token (USDC’s asset contract): its symbol', () => {
    const usdc = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';
    expect(knownStellarToken(STELLAR_MAINNET_PASSPHRASE, usdc)?.symbol).toBe('USDC');
    expect(knownStellarToken(PASSPHRASE, usdc)).toBeNull();
    const bytes = authPreimageBytes(invocation(usdc, 'transfer', [addr(USER), addr(OTHER), i128(15_000_000n)]), STELLAR_MAINNET_PASSPHRASE);
    const s = summarizeApproval(decodeApprovalRequest({ kind: 'stellar_auth_entry', chain: 'stellar', address: USER, context: { networkPassphrase: STELLAR_MAINNET_PASSPHRASE }, bytes }), { address: USER });
    expect(headline(s)).toBe(`${APP} wants to authorize sending 1.5 USDC (token contract ${usdc}) to ${OTHER}`);
    expect(text(s.network!)).toBe('Stellar public network (real funds)');
    expect(s.fee).toBeNull();
    expect(s.explainable).toBe(true);
  });
});

// ---- NEAR ----

const PUB = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const NEAR_ME = nearImplicitAccountId(PUB);
const call = (methodName: string, args: string | Uint8Array, deposit = 0n): NearAction => ({ type: 'functionCall', methodName, args: typeof args === 'string' ? utf8(args) : Uint8Array.from(args), gas: 30_000_000_000_000n, deposit });
const near = (actions: NearAction[], receiverId = 'guestbook.testnet') =>
  summarizeApproval(
    decodeApprovalRequest({ kind: 'near_tx', chain: 'near', address: NEAR_ME, context: { nearNetwork: 'testnet' }, bytes: encodeNearTransaction({ signerId: NEAR_ME, publicKey: { type: 'ed25519', bytes: PUB }, nonce: 3n, receiverId, blockHash: sha256(utf8('b')), actions }) }),
    { address: NEAR_ME },
  );
const delegate = (actions: NearAction[], receiverId = 'stamps.testnet') =>
  summarizeApproval(
    decodeApprovalRequest({ kind: 'near_delegate', chain: 'near', address: NEAR_ME, context: { nearNetwork: 'testnet' }, bytes: encodeNearDelegateAction({ senderId: NEAR_ME, receiverId, actions, nonce: 7n, maxBlockHeight: 9n, publicKey: { type: 'ed25519', bytes: PUB } }) }),
    { address: NEAR_ME },
  );

describe('NEAR', () => {
  it('a transfer, and several: the total', () => {
    expect(headline(near([{ type: 'transfer', deposit: 10n ** 23n }], 'bob.testnet'))).toBe(`${APP} wants to send 0.1 NEAR to bob.testnet`);
    expect(headline(near([{ type: 'transfer', deposit: 10n ** 24n }, { type: 'transfer', deposit: 5n * 10n ** 23n }], 'bob.testnet'))).toBe(`${APP} wants to send 1.5 NEAR to bob.testnet in 2 transfers`);
    expect(text(near([{ type: 'transfer', deposit: 1n }]).fee!)).toBe('a small amount of NEAR for gas, from your account');
  });

  it('a relayed contract call (the stamps): contract and method; the relayer pays; explainable', () => {
    const s = delegate([call('collect', '{"stamp":"arrival"}')]);
    expect(headline(s)).toBe(`${APP} wants to use stamps.testnet (collect)`);
    expect(text(s.fee!)).toBe('paid for you by a relayer, not from your account');
    expect(s.explainable).toBe(true);
    expect(s.warnings).toEqual([]);
  });

  it('arguments that aren’t JSON, or a method name that can’t be shown: not explainable', () => {
    expect(near([call('add_message', Uint8Array.of(0xff, 1))]).explainable).toBe(false);
    const invisible = near([call('a​b', '')]);
    expect(invisible.explainable).toBe(false);
    expect(headline(invisible)).not.toContain('​');
  });

  it('NEP-141 ft_transfer: the amount and receiver from the arguments; malformed ones fall back to the method', () => {
    expect(headline(near([call('ft_transfer', '{"receiver_id":"bob.testnet","amount":"1000"}', 1n)], 'usdc.testnet'))).toBe(`${APP} wants to send 1,000 (smallest units) of the token usdc.testnet to bob.testnet`);
    for (const args of ['{"receiver_id":"BОB.testnet","amount":"1"}', '{"receiver_id":"bob.testnet","amount":"01"}', '{"receiver_id":"bob.testnet","amount":1}', '{"receiver_id":"bob.testnet"}']) {
      expect(headline(near([call('ft_transfer', args, 1n)], 'usdc.testnet'))).toBe(`${APP} wants to use usdc.testnet (ft_transfer)`);
    }
  });

  it('NEP-178 nft_approve warns; nft_transfer names the item', () => {
    const s = near([call('nft_approve', '{"token_id":"7","account_id":"market.testnet"}', 1n)], 'nft.testnet');
    expect(warnings(s)).toEqual([['warning', 'spend_permission', 'This lets market.testnet move your item 7 of collection nft.testnet, until it is used or you take the permission back.']]);
    expect(headline(near([call('nft_transfer', '{"receiver_id":"bob.testnet","token_id":"7"}', 1n)], 'nft.testnet'))).toBe(`${APP} wants to send item 7 of collection nft.testnet to bob.testnet`);
    // A token id with invisible characters isn't put in the summary.
    expect(headline(near([call('nft_transfer', '{"receiver_id":"bob.testnet","token_id":"7\\u202e"}', 1n)], 'nft.testnet'))).toBe(`${APP} wants to use nft.testnet (nft_transfer)`);
  });


  it('NEP-413: a message for its recipient; a message that isn’t plain text can’t be explained', () => {
    const m = (message: string) => summarizeApproval(decodeApprovalRequest({ kind: 'near_message', chain: 'near', address: NEAR_ME, context: {}, bytes: encodeNep413Message({ message, nonce: new Uint8Array(32), recipient: 'app.example', callbackUrl: null }) }), { address: NEAR_ME });
    expect(headline(m('Sign in'))).toBe(`${APP} wants you to sign a message for app.example`);
    expect(m('Sign in').explainable).toBe(true);
    expect(m('a‮b').explainable).toBe(false);
  });
});

describe('formatTokenUnits and the app placeholder', () => {
  it('formats any size exactly', () => {
    expect(formatTokenUnits(1_500_000n, 6)).toBe('1.5');
    expect(formatTokenUnits(UINT256_MAX, 18)).toBe('115792089237316195423570985008687907853269984665640564039457.584007913129639935');
    expect(formatTokenUnits(5n, 0)).toBe('5');
  });

  it('the app’s name is a placeholder the page fills in, never text in the summary', () => {
    const s = evmSummary({});
    expect(s.headline[0]).toEqual({ kind: 'app' });
    expect(summaryString(s.headline, '<b>x</b>')).toBe(`<b>x</b> wants to send 1 ETH to ${TO}`);
  });
});

// ---- the security review of 2026-11-17: whatever decides what the user gives up is in view, or the request isn't
// explainable (its details start open). ----

describe('review: Soroban authorizations (H1)', () => {
  const evilTransfer = [addr(USER), addr(OTHER), i128(1n)];
  const realTransfer = invocation(TOKEN, 'transfer', [addr(USER), addr(ATTACKER), i128(10n ** 15n)]);

  it('a token call whose authorization holds another call (a sub-invocation) is not explainable, and the nested send is said', () => {
    const s = stellar([invokeOp(ROUTER, 'transfer', evilTransfer, [sourceAuth(invocation(ROUTER, 'transfer', evilTransfer, [realTransfer]))])]);
    expect(s.explainable).toBe(false);
    expect(codes(s)[0]).toBe('cannot_explain');
    expect(s.lines.map(text)).toContain(`It also authorizes sending 1,000,000,000,000,000 (in the token’s smallest units) of the token contract ${TOKEN} to ${ATTACKER}.`);
  });

  it('a token call with a separate authorization root is not explainable', () => {
    const s = stellar([invokeOp(ROUTER, 'transfer', evilTransfer, [sourceAuth(realTransfer)])]);
    expect(s.explainable).toBe(false);
    expect(s.lines.map(text).join(' ')).toContain(ATTACKER);
  });

  it('an authorization root that names the same function with other arguments is not the call itself', () => {
    const s = stellar([invokeOp(TOKEN, 'transfer', evilTransfer, [sourceAuth(invocation(TOKEN, 'transfer', [addr(USER), addr(ATTACKER), i128(9n)]))])]);
    expect(s.explainable).toBe(false);
  });

  it('a token transfer authorized exactly as called, with nothing under it, stays explainable', () => {
    const s = stellar([invokeOp(TOKEN, 'transfer', evilTransfer, [sourceAuth(invocation(TOKEN, 'transfer', evilTransfer))])]);
    expect(s.explainable).toBe(true);
    expect(s.lines).toEqual([]);
  });

  it('an authorization entry with a sub-invocation is not explainable, and the nested send is said', () => {
    const bytes = authPreimageBytes(invocation(ROUTER, 'transfer', evilTransfer, [realTransfer]));
    const s = summarizeApproval(decodeApprovalRequest({ kind: 'stellar_auth_entry', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes }), { address: USER });
    expect(s.explainable).toBe(false);
    expect(s.lines.map(text).join(' ')).toContain(ATTACKER);
  });

  it('an approval for someone else’s tokens doesn’t call them yours', () => {
    const s = stellar([invokeOp(TOKEN, 'approve', [addr(OTHER), addr(ATTACKER), i128(5n), xdr.ScVal.scvU32(10)])]);
    expect(headline(s)).toBe(`${APP} wants to let ${ATTACKER} spend tokens of contract ${TOKEN} held by ${OTHER}`);
    expect(text(s.warnings[0]!.text)).toContain(`of the tokens of contract ${TOKEN} held by ${OTHER}`);
    expect(text(s.warnings[0]!.text)).not.toContain('your');
  });
});

describe('review: Stellar classic operations show their deciding terms (H2)', () => {
  const JUNK = new Asset('USDC', ATTACKER);
  it('a sell offer says the least it returns', () => {
    const s = stellar([Operation.manageSellOffer({ selling: Asset.native(), buying: JUNK, amount: '10000', price: { n: 1, d: 10000000 } })]);
    expect(headline(s)).toBe(`${APP} wants to offer to sell 10,000 XLM for at least 0.001 of the asset USDC:${ATTACKER}`);
    expect(s.explainable).toBe(true);
    const passive = stellar([Operation.createPassiveSellOffer({ selling: Asset.native(), buying: JUNK, amount: '10', price: { n: 2, d: 1 } })]);
    expect(headline(passive)).toContain('for at least 20 of the asset');
  });

  it('a buy offer says the most it costs', () => {
    const s = stellar([Operation.manageBuyOffer({ selling: Asset.native(), buying: JUNK, buyAmount: '1', price: { n: 10000000, d: 1 } })]);
    expect(headline(s)).toBe(`${APP} wants to offer to buy 1 of the asset USDC:${ATTACKER}, paying at most 10,000,000 XLM`);
  });

  it('a changed offer says so', () => {
    const s = stellar([Operation.manageSellOffer({ selling: Asset.native(), buying: JUNK, amount: '1', price: { n: 1, d: 1 }, offerId: '7' })]);
    expect(headline(s)).toContain('(it changes your offer 7)');
  });

  it('a claimable balance names who can claim it; conditions make it unexplainable', () => {
    const s = stellar([Operation.createClaimableBalance({ asset: Asset.native(), amount: '5000', claimants: [new Claimant(ATTACKER)] })]);
    expect(headline(s)).toBe(`${APP} wants to set aside 5,000 XLM that ${ATTACKER} can claim`);
    expect(s.explainable).toBe(true);
    const cond = stellar([Operation.createClaimableBalance({ asset: Asset.native(), amount: '1', claimants: [new Claimant(USER, Claimant.predicateBeforeRelativeTime('100'))] })]);
    expect(cond.explainable).toBe(false);
  });

  it('a liquidity pool deposit or withdrawal can’t be explained (the pool’s assets aren’t in the request); its amounts are said', () => {
    const pool = new LiquidityPoolAsset(Asset.native(), JUNK, 30);
    const id = getLiquidityPoolId('constant_product', pool.getLiquidityPoolParameters()).toString('hex');
    const dep = stellar([Operation.liquidityPoolDeposit({ liquidityPoolId: id, maxAmountA: '9000', maxAmountB: '0.0000001', minPrice: { n: 1, d: 10000000 }, maxPrice: { n: 10000000, d: 1 } })]);
    expect(dep.explainable).toBe(false);
    expect(headline(dep)).toContain('at most 9,000 of the pool’s first asset and less than 0.000001 of its second');
    const wd = stellar([Operation.liquidityPoolWithdraw({ liquidityPoolId: id, amount: '1', minAmountA: '0', minAmountB: '0' })]);
    expect(wd.explainable).toBe(false);
    expect(headline(wd)).toContain('at least 0 of the pool’s first asset and 0 of its second');
  });

  it('path payments keep the most paid and the least received in view', () => {
    const s = stellar([Operation.pathPaymentStrictSend({ sendAsset: Asset.native(), sendAmount: '5', destination: OTHER, destAsset: JUNK, destMin: '0.0000001', path: [] })]);
    expect(headline(s)).toContain('pay exactly 5 XLM');
    expect(headline(s)).toContain('receives at least a tiny amount (less than 0.000001) of the asset');
  });

  it('a fee-bump says who pays; the inner transaction’s source when it isn’t the user', () => {
    const fb = stellar([], feeBumpBytes(txBytes([paymentOp()], { source: OTHER }), USER));
    expect(fb.lines.map(text)).toContain(`Your account pays the network fee for a transaction from ${OTHER}.`);
  });

  it('a network passphrase that isn’t display-safe is shown as hex, cut short', () => {
    const odd = `Test‮${'x'.repeat(200)}`;
    const s = summarizeApproval(decodeApprovalRequest({ kind: 'stellar_auth_entry', chain: 'stellar', address: USER, context: { networkPassphrase: odd }, bytes: authPreimageBytes(invocation(TOKEN, 'transfer', [addr(USER), addr(OTHER), i128(1n)]), odd) }), { address: USER });
    const n = text(s.network!);
    expect(n).not.toContain('‮');
    expect(n).toContain('(shown as hex)');
    expect(n.length).toBeLessThan(140);
  });
});


describe('review: EVM and typed data (M1, L2, I1)', () => {
  it('approve(spender, 0) on a token Journear doesn’t know may give away an NFT’s item 0', () => {
    const s = tokenCall(calldata('approve(address,uint256)', SPENDER, 0n));
    expect(codes(s)).toEqual(['spend_permission']);
    expect(headline(s)).toBe(`${APP} wants to change ${SPENDER}’s permission for contract ${TOKEN_EVM}`);
    expect(text(s.warnings[0]!.text)).toContain('item 0');
    // The zero address as spender, or a pinned token: a plain revoke.
    expect(tokenCall(calldata('approve(address,uint256)', `0x${'0'.repeat(40)}`, 0n)).warnings).toEqual([]);
    expect(tokenCall(calldata('approve(address,uint256)', SPENDER, 0n), 8453, BASE_USDC).warnings).toEqual([]);
  });

  it('long raw amounts carry thousands separators; a pinned token over a trillion is no practical limit', () => {
    expect(text(tokenCall(calldata('approve(address,uint256)', SPENDER, 1234567n)).warnings[0]!.text)).toContain('1,234,567 (in the token’s smallest units)');
    expect(codes(tokenCall(calldata('approve(address,uint256)', SPENDER, 10n ** 27n)))).toEqual(['unlimited_spend']);
    expect(codes(tokenCall(calldata('approve(address,uint256)', SPENDER, 10n ** 27n - 1n)))).toEqual(['spend_permission']);
    expect(codes(tokenCall(calldata('approve(address,uint256)', BASE_SODAX, 10n ** 18n + 1n), 8453, BASE_USDC))).toEqual(['unlimited_spend']);
    expect(codes(tokenCall(calldata('approve(address,uint256)', BASE_SODAX, 10n ** 18n), 8453, BASE_USDC))).toEqual(['spend_permission']);
  });

  it('EIP-2612 needs exactly its two types', () => {
    const extra = permit('1', { types: { EIP712Domain: DOMAIN, Permit: PERMIT_TYPES, Other: [{ name: 'x', type: 'uint256' }] } });
    expect(typed(extra).explainable).toBe(false);
  });

  it('Permit2 witness transfers: a spend warning naming the token and amount, details open', () => {
    const s = typed({
      types: {
        EIP712Domain: PERMIT2_DOMAIN,
        PermitWitnessTransferFrom: [
          { name: 'permitted', type: 'TokenPermissions' },
          { name: 'spender', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'witness', type: 'Order' },
        ],
        TokenPermissions: [
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        Order: [{ name: 'note', type: 'string' }],
      },
      primaryType: 'PermitWitnessTransferFrom',
      domain: { name: 'Permit2', chainId: 11155111, verifyingContract: PERMIT2_ADDRESS },
      message: { permitted: { token: TOKEN_EVM, amount: '9000' }, spender: SPENDER, nonce: '1', deadline: '1', witness: { note: 'x' } },
    });
    expect(s.explainable).toBe(false);
    expect(codes(s)).toEqual(['cannot_explain', 'spend_permission']);
    expect(text(s.warnings[1]!.text)).toContain(`9,000 (in the token’s smallest units) of your tokens of contract ${TOKEN_EVM} through Permit2, once`);
  });
});

describe('review: NEP-413 (L3)', () => {
  it('a neutral headline naming the recipient', () => {
    const bytes = encodeNep413Message({ message: 'Sign in', nonce: new Uint8Array(32), recipient: 'app.example', callbackUrl: null });
    const s = summarizeApproval(decodeApprovalRequest({ kind: 'near_message', chain: 'near', address: NEAR_ME, context: {}, bytes }), { address: NEAR_ME });
    expect(headline(s)).toBe(`${APP} wants you to sign a message for app.example`);
  });
});

// ---- the second review of 2026-11-17 ----

/** A sell offer whose price is set in the XDR directly (the builder refuses malformed prices). */
function offerWithPrice(n: number, d: number): xdr.Operation {
  const op = Operation.manageSellOffer({ selling: Asset.native(), buying: new Asset('USDC', ATTACKER), amount: '100', price: { n: 1, d: 1 } });
  op.body().manageSellOfferOp().price(new xdr.Price({ n, d }));
  return op;
}

describe('review 2: malformed values never throw (N1)', () => {
  it('an offer price with d = 0 or n ≤ 0 is not divided by and not explained', () => {
    for (const [n, d] of [[1, 0], [-5, 1], [0, 1], [1, -1]] as const) {
      const s = stellar([offerWithPrice(n, d)]);
      expect(s.explainable).toBe(false);
      expect(headline(s)).toContain('at a price Journear can’t read');
      expect(headline(s)).not.toContain('-');
    }
  });

  it('summarizeApproval is total: odd decoded shapes give a result, the unexplained one when building fails', () => {
    allowFallback = true;
    const base = decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: txBytes([paymentOp()]) });
    if (base.kind !== 'stellar_tx') throw new Error('kind');
    const op = base.envelope.tx.operations[0] as Extract<StellarOperation, { type: 'payment' }>;
    const odd: unknown[] = ['abc', '', '-1', '1e9', '99999999999999999999999999999999999999999', ' 1', null, undefined, {}, [], Number.NaN];
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const shapes: DecodedApproval[] = [];
    for (let i = 0; i < 300; i++) {
      const mutated = { ...op, amount: odd[rnd(odd.length)], asset: rnd(2) ? 'native' : odd[rnd(odd.length)], destination: rnd(3) ? op.destination : odd[rnd(odd.length)], type: ['payment', 'manageSellOffer', 'manageBuyOffer', 'createClaimableBalance', 'pathPaymentStrictSend', 'liquidityPoolDeposit'][rnd(6)], price: { n: rnd(3) - 1, d: rnd(3) - 1 }, buyAmount: odd[rnd(odd.length)], claimants: rnd(2) ? [] : odd[rnd(odd.length)] };
      const ops = Array.from({ length: rnd(30) }, () => mutated);
      shapes.push({ ...base, envelope: { ...base.envelope, tx: { ...base.envelope.tx, operations: ops as never } } } as DecodedApproval);
    }
    shapes.push({ kind: 'evm_tx', chainId: 1, tx: { ...(evm({}) as Extract<DecodedApproval, { kind: 'evm_tx' }>).tx, call: { selector: '0x00', signature: 'safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)', name: 'x', args: [] } } } as DecodedApproval);
    shapes.push({ kind: 'eip712', chainId: null, typedData: { types: {}, primaryType: 'Permit', domain: {} as never, message: {} as never }, view: { domain: [], primaryType: 'Permit', message: { name: 'Permit', type: 'Permit', children: [] } } } as DecodedApproval);
    for (const d of shapes) {
      const s = summarizeApproval(d, { address: USER });
      expect(Array.isArray(s.headline)).toBe(true);
      expect(typeof s.explainable).toBe('boolean');
    }
    const broken = summarizeApproval({ ...base, envelope: { ...base.envelope, tx: { ...base.envelope.tx, operations: [{ ...op, amount: 'abc' }] as never } } } as DecodedApproval, { address: USER });
    expect(broken).toBe(UNEXPLAINED_SUMMARY);
    expect(broken.explainable).toBe(false);
    // Red, and says to reject (review 3).
    expect(warnings(broken)).toEqual([['danger', 'summary_failed', 'Journear couldn’t read this request. Reject it unless you are certain.']]);
    allowFallback = false;
  });
});

describe('review 2: steps that move value are always listed (N2)', () => {
  const bump = () => Operation.bumpSequence({ bumpTo: '99' });



  it('Stellar: the XLM leaving counts offers, path payments and claimable balances; a merge is all of it', () => {
    const s = stellar([
      Operation.manageSellOffer({ selling: Asset.native(), buying: new Asset('USDC', ISSUER), amount: '2', price: { n: 1, d: 1 } }),
      Operation.pathPaymentStrictReceive({ sendAsset: Asset.native(), sendMax: '3', destination: OTHER, destAsset: Asset.native(), destAmount: '1', path: [] }),
      Operation.createClaimableBalance({ asset: Asset.native(), amount: '4', claimants: [new Claimant(OTHER)] }),
    ]);
    expect(text(s.lines[0]!)).toBe('XLM leaving your account: up to 9 XLM, plus the network fee.');
    expect(text(stellar([paymentOp(), mergeOp()]).lines[0]!)).toBe('XLM leaving your account: all of it (the account is closed).');
  });

});

describe('review 2: ERC-1155 batches and withdraw (N3, N4)', () => {
  const batch = (n: number) => {
    const ids = Array.from({ length: n }, (_, i) => BigInt(i + 1));
    const words = [word(ME), word(TO), word(0xa0n), word(BigInt(0xa0 + 32 * (n + 1))), word(BigInt(0xa0 + 64 * (n + 1))), word(BigInt(n)), ...ids.map(word), word(BigInt(n)), ...ids.map(() => word(1234567n)), word(0n)];
    return `${parseFunctionSignature('safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)').selector}${words.join('')}`;
  };
  it('up to five kinds: each item and how many, item ids ungrouped, amounts grouped; more: not explainable', () => {
    const s = tokenCall(batch(2));
    expect(s.lines.map(text)).toEqual(['Item 1: 1,234,567', 'Item 2: 1,234,567']);
    expect(s.explainable).toBe(true);
    expect(tokenCall(batch(6)).explainable).toBe(false);
  });

  it('withdraw names its amount; deposit says what it sends in the headline', () => {
    expect(headline(tokenCall(calldata('withdraw(uint256)', 1000n)))).toBe(`${APP} wants to withdraw 1,000 (smallest units) from contract ${TOKEN_EVM}`);
    const dep = evmSummary({ to: TOKEN_EVM, value: 10n ** 17n, data: parseFunctionSignature('deposit()').selector });
    expect(headline(dep)).toBe(`${APP} wants to use contract ${TOKEN_EVM} (deposit), sending it 0.1 ETH`);
    expect(dep.lines).toEqual([]);
  });
});

// ---- the third review of 2026-11-17 ----

describe('review 3: the user’s account in muxed form is the user’s (1)', () => {
  const muxed = new MuxedAccount(new Account(USER, '41'), '7');
  const muxedTx = (ops: xdr.Operation[]) => {
    const b = new TransactionBuilder(muxed, { fee: '100', networkPassphrase: PASSPHRASE });
    for (const op of ops) b.addOperation(op);
    return new Uint8Array(b.setTimeout(0).build().toEnvelope().toXDR());
  };
  const bump = () => Operation.bumpSequence({ bumpTo: '99' });
  it('a transaction from the user’s muxed account counts its XLM and names it as the user’s', () => {
    const s = stellar([], muxedTx([Operation.payment({ destination: ATTACKER, asset: Asset.native(), amount: '1000000' }), bump()]));
    const lines = s.lines.map(text);
    expect(lines[0]).toBe('XLM leaving your account: up to 1,000,000 XLM, plus the network fee.');
    expect(lines).toContain('The transaction is from your account (muxed id 7).');
    expect(lines.join(' ')).not.toContain('from the account M');
  });


  it('a payment to the user’s muxed account is to the user; another account’s muxed form is not', () => {
    expect(headline(stellar([Operation.payment({ destination: muxed.accountId(), asset: Asset.native(), amount: '1' })]))).toBe(`${APP} wants to send 1 XLM to your account (muxed id 7)`);
    const theirs = new MuxedAccount(new Account(OTHER, '1'), '9').accountId();
    expect(headline(stellar([Operation.payment({ destination: theirs, asset: Asset.native(), amount: '1' })]))).toBe(`${APP} wants to send 1 XLM to ${theirs}`);
  });
});


// ---- the founder's decision of 2026-11-17 (D810): the details always start folded, so each case that used to open
// them states its risk in plain words, red where the unreadable part could move value or control with no visible bound.


// ---- the final review of 2026-11-17 ----

describe('final review: contract creation on Stellar lists its authorizations; NEAR keys say their fee allowance', () => {
  const steal = () => sourceAuth(invocation(TOKEN, 'transfer', [addr(USER), addr(ATTACKER), i128(10n ** 15n)]));
  it('a contract created with a constructor or with authorizations: red, every authorized call listed', () => {
    const s = stellar([Operation.createCustomContract({ address: new Address(USER), wasmHash: Buffer.alloc(32, 5), constructorArgs: [], salt: Buffer.alloc(32, 6), auth: [steal()] })]);
    expect(s.warnings.find((w) => w.code === 'cannot_explain')?.level).toBe('danger');
    expect(s.lines.map(text)).toContain(`It also authorizes sending 1,000,000,000,000,000 (in the token’s smallest units) of the token contract ${TOKEN} to ${ATTACKER}.`);
    expect(s.explainable).toBe(false);
    // A constructor alone (no authorizations) is red too.
    const ctor = stellar([Operation.createCustomContract({ address: new Address(USER), wasmHash: Buffer.alloc(32, 5), constructorArgs: [], salt: Buffer.alloc(32, 6) })]);
    expect(ctor.warnings.find((w) => w.code === 'cannot_explain')?.level).toBe('danger');
    expect(headline(ctor)).toBe(`${APP} wants to create a contract and run its constructor`);
  });

  it('uploading contract code alone stays amber', () => {
    const s = stellar([Operation.uploadContractWasm({ wasm: Buffer.from('00', 'hex') })]);
    expect(s.warnings.find((w) => w.code === 'cannot_explain')?.level).toBe('warning');
    expect(s.lines).toEqual([]);
  });

  it('a NEAR function-call key says what it may spend on fees', () => {
    const key = (allowance: bigint | null): NearAction => ({ type: 'addKey', publicKey: { type: 'ed25519', bytes: new Uint8Array(32).fill(9) }, accessKey: { nonce: 0n, permission: { type: 'functionCall', allowance, receiverId: 'app.testnet', methodNames: [] } } });
    expect(headline(near([key(null)], NEAR_ME))).toBe(`${APP} wants to add the key ${KEY9} to your account that can use app.testnet, with no limit on the NEAR it spends on fees`);
    expect(headline(near([key(25n * 10n ** 22n)], NEAR_ME))).toBe(`${APP} wants to add the key ${KEY9} to your account that can use app.testnet, spending up to 0.25 NEAR on fees`);
  });
});

// ---- the founder's decision of 2026-11-17 (D814): multi-step requests in at most four grouped lines, amounts shown
// conservatively. ----

describe('D814: amounts as shown', () => {
  it('exact up to six decimals; less than 0.000001 below; "about", up when leaving and down when received; never 0', () => {
    expect(displayUnits(15_000_000n, 7)).toBe('1.5');
    expect(displayUnits(1n, 7)).toBe('less than 0.000001');
    expect(displayUnits(1n, 7, 'in')).toBe('a tiny amount (less than 0.000001)');
    expect(nearDisplay(333333333333333333333333n)).toBe('about 0.333334 NEAR');
    expect(nearDisplay(333333333333333333333333n, 'in')).toBe('about 0.333333 NEAR');
    expect(displayUnits(12_345_678_901_234n, 7)).toBe('about 1,234,567.890124');
    expect(displayUnits(0n, 7)).toBe('0');
    for (const v of [1n, 9n, 10n, 11n, 999_999n, 1_000_001n]) {
      for (const dir of ['out', 'in'] as const) expect(displayUnits(v, 12, dir)).not.toMatch(/^(about )?0$/u);
    }
  });

  it('the EVM fee and a NEAR transfer follow it', () => {
    expect(text(evmSummary({}).fee!)).toBe('up to 0.000042 ETH');
    expect(displayUnits(42_000_000_000n, 18)).toBe('less than 0.000001');
    expect(headline(near([{ type: 'transfer', deposit: 5n }], 'bob.testnet'))).toBe(`${APP} wants to send less than 0.000001 NEAR to bob.testnet`);
  });
});

describe('D814: grouped lines', () => {
  const bump = () => Operation.bumpSequence({ bumpTo: '99' });
  const pay = (destination: string, amount: string, asset: Asset = Asset.native()) => Operation.payment({ destination, asset, amount });
  const fullKey = (fill: number): NearAction => ({ type: 'addKey', publicKey: { type: 'ed25519', bytes: new Uint8Array(32).fill(fill) }, accessKey: { nonce: 0n, permission: { type: 'fullAccess' } } });

  it('100 actions (99 self-transfers and a full-access key): two lines, control first', () => {
    const s = near([...Array.from({ length: 99 }, (): NearAction => ({ type: 'transfer', deposit: 1n })), fullKey(9)], NEAR_ME);
    expect(s.lines.map(text)).toEqual([`Add the full-access key ${KEY9} to your account`, 'Send NEAR to your account, 99 times (less than 0.000001 NEAR in total)']);
    expect(s.explainable).toBe(true);
  });

  it('mixed recipients: others before the user’s own account, contract calls between; totals per recipient', () => {
    const s = stellar([pay(OTHER, '1'), pay(USER, '0.5'), pay(OTHER, '2'), invokeOp(ROUTER, 'swap', [i128(1n)]), pay(USER, '0.25'), pay(OTHER, '3')]);
    const lines = s.lines.map(text);
    expect(lines[0]).toBe('XLM leaving your account: up to 6.75 XLM, plus what its contract calls or pool deposits take, plus the network fee.');
    expect(lines.slice(1)).toEqual([`Send 6 XLM to ${OTHER} in 3 payments`, `Use contract ${ROUTER} (swap)`, 'Send 0.75 XLM to your account in 2 payments']);
  });

  it('value to others by descending total; control changes first', () => {
    const s = stellar([pay(OTHER, '5'), pay(ATTACKER, '10'), addSignerOp()]);
    expect(s.lines.map(text).slice(1)).toEqual([`Add ${ATTACKER} as a signer with weight 255`, `Send 10 XLM to ${ATTACKER}`, `Send 5 XLM to ${OTHER}`]);
  });

  it('never merges different recipients, assets or methods', () => {
    const usdc = new Asset('USDC', ISSUER);
    const s = stellar([pay(OTHER, '1'), pay(OTHER, '1', usdc), pay(ATTACKER, '1')]);
    expect(s.lines.map(text).slice(1)).toEqual([`Send 1 XLM to ${OTHER}`, `Send 1 XLM to ${ATTACKER}`, `Send 1 of the asset USDC:${ISSUER} to ${OTHER}`]);
    const n = near([call('a', '{}'), call('b', '{}'), call('a', '{}', 10n ** 24n)], 'c.testnet');
    expect(n.lines.map(text)).toEqual(['Use c.testnet (a), 2 times (attaching 1 NEAR in total)', 'Use c.testnet (b)']);
  });

  it('more than four groups: three lines, "…and N other steps", a red line when a left-out step moves value', () => {
    const s = stellar([pay(OTHER, '1'), pay(ATTACKER, '2'), pay(USER, '3'), invokeOp(ROUTER, 'swap', [i128(1n)]), bump(), bump()]);
    expect(s.lines).toHaveLength(1 + MAX_GROUP_LINES);
    expect(text(s.lines.at(-1)!)).toBe('…and 3 other steps: see the details.');
    const w = s.warnings.find((x) => x.code === 'steps_not_listed')!;
    expect(w.level).toBe('warning');
    const v = stellar([invokeOp(ROUTER, 'a', []), invokeOp(ROUTER, 'b', []), invokeOp(ROUTER, 'c', []), invokeOp(ROUTER, 'd', []), bump()]);
    expect(v.warnings.find((x) => x.code === 'steps_not_listed')?.level).toBe('danger');
    expect(v.explainable).toBe(false);
  });

  it('the largest amount to others is never left out, even behind control changes (they stay in the red box)', () => {
    const s = near([fullKey(1), fullKey(2), fullKey(3), fullKey(4), { type: 'transfer', deposit: 10n ** 24n }], 'bob.testnet');
    expect(s.lines.map(text)).toContain('Send 1 NEAR to bob.testnet');
    expect(s.lines).toHaveLength(MAX_GROUP_LINES);
    expect(s.warnings.find((x) => x.code === 'steps_not_listed')?.level).toBe('danger');
  });

  it('a step on the user’s muxed account says so in its line', () => {
    const muxed = new MuxedAccount(new Account(USER, '41'), '7');
    const s = stellar([pay(ATTACKER, '500'), bump()].map((op, i) => (i === 0 ? Operation.payment({ destination: ATTACKER, asset: Asset.native(), amount: '500', source: muxed.accountId() }) : op)));
    expect(text(s.lines[1]!)).toBe(`Send 500 XLM to ${ATTACKER} (on your account (muxed id 7))`);
  });

  it('other value (sponsorship, trust lines) before neutral steps', () => {
    const s = stellar([bump(), bump(), Operation.revokeAccountSponsorship({ account: USER }), Operation.changeTrust({ asset: new Asset('USDC', ISSUER) })]);
    expect(s.lines.map(text)).toEqual(['End a reserve sponsorship', `Let your account hold the asset USDC:${ISSUER}`, '2 times: move the account’s sequence number forward']);
  });

  it('property: every (recipient, asset) is in a visible line with its exact total, or a warning says steps are left out', () => {
    let seed = 11;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const dests = [OTHER, ATTACKER, USER];
    const assets = [Asset.native(), new Asset('USDC', ISSUER), new Asset('EURC', ISSUER)];
    for (let round = 0; round < 60; round++) {
      const ops = Array.from({ length: 2 + rnd(10) }, () => ({ d: dests[rnd(3)]!, a: assets[rnd(3)]!, amt: BigInt(1 + rnd(5_000_000)) }));
      const s = stellar(ops.map((o) => Operation.payment({ destination: o.d, asset: o.a, amount: formatTokenUnits(o.amt, 7) })));
      const lines = s.lines.map(text);
      const sums = new Map<string, { d: string; a: Asset; total: bigint; n: number }>();
      for (const o of ops) {
        const k = `${o.d}|${o.a.toString()}`;
        const e = sums.get(k) ?? { d: o.d, a: o.a, total: 0n, n: 0 };
        e.total += o.amt;
        e.n++;
        sums.set(k, e);
      }
      const leftOut = s.warnings.some((w) => w.code === 'steps_not_listed');
      let missing = 0;
      let missingOthers = 0;
      for (const e of sums.values()) {
        const who = e.d === USER ? 'your account' : e.d;
        const what = e.a.isNative() ? `${displayUnits(e.total, 7)} XLM` : `${displayUnits(e.total, 7)} of the asset ${e.a.getCode()}:${ISSUER}`;
        const line = lines.find((l) => l.startsWith(`Send ${what} to ${who}`) && (e.n === 1 ? l === `Send ${what} to ${who}` : l === `Send ${what} to ${who} in ${e.n} payments`));
        if (!line) {
          missing++;
          if (e.d !== USER) missingOthers++;
        }
      }
      // Only what a "…and N other steps" line and its warning cover is missing, and never a group to others while one
      // to the user's own account is shown.
      if (missing > 0) expect(leftOut).toBe(true);
      expect(missing).toBeLessThanOrEqual(Math.max(0, sums.size - (MAX_GROUP_LINES - 1)));
      const firstOwn = lines.findIndex((l) => / to your account/u.test(l));
      const lastOther = lines.map((l, i) => (/^Send .* to G/u.test(l) ? i : -1)).reduce((m, i) => Math.max(m, i), -1);
      if (firstOwn >= 0 && lastOther >= 0) expect(lastOther).toBeLessThan(firstOwn);
      // A left-out payment to someone else makes the warning red; only the user's own, amber.
      if (leftOut) expect(s.warnings.find((w) => w.code === 'steps_not_listed')?.level).toBe(missingOthers > 0 ? 'danger' : 'warning');
    }
  });
});

describe('D810 with D814: the risk lines of requests that leave things out, at the right level', () => {
  const level = (s: ApprovalSummary, c: string) => s.warnings.find((w) => w.code === c)?.level;
  it('red: unknown contract calls, unexplained typed data, extra authorizations, raw', () => {
    expect(level(tokenCall('0xdeadbeef'), 'cannot_explain')).toBe('danger');
    expect(level(near([call('m', Uint8Array.of(0xff))]), 'cannot_explain')).toBe('danger');
    expect(level(stellar([invokeOp(ROUTER, 'swap', [i128(1n)])]), 'cannot_explain')).toBe('danger');
    expect(level(stellar([invokeOp(TOKEN, 'transfer', [addr(USER), addr(OTHER), i128(1n)], [sourceAuth(invocation(ROUTER, 'x', []))])]), 'cannot_explain')).toBe('danger');
    expect(level(typed({ types: { EIP712Domain: [{ name: 'name', type: 'string' }], Order: [{ name: 'x', type: 'uint256' }] }, primaryType: 'Order', domain: { name: 'X' }, message: { x: '1' } }), 'cannot_explain')).toBe('danger');
  });

  it('amber: bounded or not about value', () => {
    expect(level(evmSummary({ to: null, value: 0n, data: '0x6000' }), 'contract_creation')).toBe('warning');
    expect(level(stellar([Operation.createClaimableBalance({ asset: Asset.native(), amount: '1', claimants: [new Claimant(USER, Claimant.predicateBeforeRelativeTime('100'))] })]), 'cannot_explain')).toBe('warning');
    expect(warnings(msg('personal_sign', 'a‮b'))).toEqual([['warning', 'cannot_explain', `Journear can’t read this message, so it can’t tell what signing it does. Only approve if you fully trust ${APP}. Technical details are below.`]]);
  });

  it('every red warning has a short bullet form', () => {
    for (const s of [tokenCall(calldata('approve(address,uint256)', SPENDER, UINT256_MAX)), tokenCall('0xdeadbeef'), summarizeApproval(decodeApprovalRequest({ kind: 'raw', chain: 'evm', address: ME, context: {}, bytes: new Uint8Array(32) }), { address: ME })]) {
      for (const w of s.warnings.filter((x) => x.level === 'danger')) expect(w.short?.length, w.code).toBeGreaterThan(0);
    }
    expect(text(tokenCall(calldata('approve(address,uint256)', SPENDER, UINT256_MAX)).warnings[0]!.short!)).toBe(`Lets ${SPENDER} (unverified) spend all of your tokens of contract ${TOKEN_EVM}`);
  });
});

describe('D814: nothing that matters is left out unnamed', () => {
  it('property: every control change and approval is in a line or named in a red bullet; the largest amount to others is in a line', () => {
    let seed = 23;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const keys = Array.from({ length: 6 }, (_, i) => Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(40 + i) as never).publicKey());
    const spenders = [OTHER, ATTACKER, ...keys.slice(0, 3)];
    const recipients = [OTHER, ATTACKER, USER];
    for (let round = 0; round < 80; round++) {
      const named: string[] = [];
      const outs: { to: string; amount: bigint }[] = [];
      const ops = Array.from({ length: 3 + rnd(12) }, () => {
        const kind = rnd(5);
        if (kind === 0) {
          const k = keys[rnd(keys.length)]!;
          named.push(k);
          return Operation.setOptions({ signer: { ed25519PublicKey: k, weight: 1 + rnd(255) } });
        }
        if (kind === 1) {
          const sp = spenders[rnd(spenders.length)]!;
          named.push(sp);
          return invokeOp(TOKEN, 'approve', [addr(USER), addr(sp), i128(BigInt(1 + rnd(1000))), xdr.ScVal.scvU32(10)]);
        }
        if (kind === 2) {
          const to = recipients[rnd(recipients.length)]!;
          const amount = BigInt(1 + rnd(90_000_000));
          if (to !== USER) outs.push({ to, amount });
          return Operation.payment({ destination: to, asset: Asset.native(), amount: formatTokenUnits(amount, 7) });
        }
        if (kind === 3) return Operation.manageData({ name: `n${rnd(4)}`, value: 'v' });
        return Operation.bumpSequence({ bumpTo: String(100 + rnd(3)) });
      });
      const s = stellar(ops);
      const lines = s.lines.map(text).join('\n');
      const red = s.warnings.filter((w) => w.level === 'danger').map((w) => text(w.text)).join('\n');
      for (const id of named) expect(lines.includes(id) || red.includes(id), `${id} in round ${round}`).toBe(true);
      // The largest total to one other recipient is always in a line.
      const totals = new Map<string, bigint>();
      for (const o of outs) totals.set(o.to, (totals.get(o.to) ?? 0n) + o.amount);
      const top = [...totals.entries()].sort((a, b) => (a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1))[0];
      if (top) expect(lines.includes(top[0]), `largest to others in round ${round}`).toBe(true);
    }
  });

  it('four control changes and a payment: the payment is in a line; the control change that gives way is named in red', () => {
    const k = (i: number) => Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(60 + i) as never).publicKey();
    const s = stellar([1, 2, 3, 4].map((i) => Operation.setOptions({ signer: { ed25519PublicKey: k(i), weight: 1 } })).concat([Operation.payment({ destination: OTHER, asset: Asset.native(), amount: '7' })]));
    expect(s.lines.map(text)).toContain(`Send 7 XLM to ${OTHER}`);
    const leftOut = s.warnings.filter((w) => w.code === 'step_left_out');
    // The fourth was left out anyway; the third gives way to the payment: both named in red.
    expect(leftOut.map((w) => w.level)).toEqual(['danger', 'danger']);
    expect(leftOut.map((w) => text(w.text)).join(' ')).toContain(k(3));
    expect(leftOut.map((w) => text(w.text)).join(' ')).toContain(k(4));
  });
});

describe('review of 5ef13452: control keys in full, spenders marked, sums, directions', () => {
  const k = (i: number) => Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(80 + i) as never).publicKey();
  it('a NEAR key change names the whole key in its line and headline', () => {
    const pub = { type: 'ed25519' as const, bytes: new Uint8Array(32).fill(9) };
    const full = nearPublicKeyString(pub.bytes);
    expect(headline(near([{ type: 'addKey', publicKey: pub, accessKey: { nonce: 0n, permission: { type: 'fullAccess' } } }], NEAR_ME))).toBe(`${APP} wants to add the full-access key ${full} to your account`);
    expect(headline(near([{ type: 'deleteKey', publicKey: pub }], NEAR_ME))).toBe(`${APP} wants to remove the key ${full} from your account`);
  });

  it('a left-out control change is named in full, never cut', () => {
    const s = stellar([1, 2, 3, 4].map((i) => Operation.setOptions({ signer: { ed25519PublicKey: k(i), weight: 1 } })).concat([Operation.payment({ destination: OTHER, asset: Asset.native(), amount: '7' })]));
    for (const w of s.warnings.filter((x) => x.code === 'step_left_out')) expect(text(w.short!)).toMatch(/G[A-Z2-7]{55}/u);
  });

  it('a spender bullet keeps the whole address and says when it isn’t verified', () => {
    expect(text(tokenCall(calldata('approve(address,uint256)', SPENDER, UINT256_MAX)).warnings[0]!.short!)).toBe(`Lets ${SPENDER} (unverified) spend all of your tokens of contract ${TOKEN_EVM}`);
  });

  it('a path payment’s coin counts toward the largest amount to others', () => {
    const s = stellar([
      Operation.payment({ destination: OTHER, asset: Asset.native(), amount: '1' }),
      Operation.payment({ destination: ATTACKER, asset: Asset.native(), amount: '1' }),
      Operation.payment({ destination: k(5), asset: Asset.native(), amount: '1' }),
      Operation.pathPaymentStrictSend({ sendAsset: Asset.native(), sendAmount: '1000000', destination: k(6), destAsset: new Asset('USDC', ISSUER), destMin: '1', path: [] }),
      Operation.payment({ destination: k(7), asset: Asset.native(), amount: '1' }),
    ]);
    expect(s.lines.map(text).some((l) => l.startsWith('Pay exactly 1,000,000 XLM'))).toBe(true);
  });

  it('a buy offer’s received amount rounds down, its cost up', () => {
    const s = stellar([Operation.manageBuyOffer({ selling: Asset.native(), buying: new Asset('USDC', ISSUER), buyAmount: '0.3333333', price: { n: 1, d: 1 } })]);
    expect(headline(s)).toBe(`${APP} wants to offer to buy about 0.333333 of the asset USDC:${ISSUER}, paying at most about 0.333334 XLM`);
  });

  it('a left-out approval of 0 is said as taking a permission back', () => {
    const s = stellar([1, 2, 3, 4].map((i) => Operation.setOptions({ signer: { ed25519PublicKey: k(i), weight: 1 } })).concat([invokeOp(TOKEN, 'approve', [addr(USER), addr(ATTACKER), i128(0n), xdr.ScVal.scvU32(1)])]));
    const w = s.warnings.filter((x) => x.code === 'step_left_out').map((x) => text(x.text)).join(' ');
    expect(w).toContain(`Take back ${ATTACKER}’s permission`);
    expect(w).not.toContain(`Let ${ATTACKER} spend`);
  });
});

describe('shownSteps: the steps whose own line is in view', () => {
  const fullKey = (fill: number): NearAction => ({ type: 'addKey', publicKey: { type: 'ed25519', bytes: new Uint8Array(32).fill(fill) }, accessKey: { nonce: 0n, permission: { type: 'fullAccess' } } });
  it('a single step: its headline is its line', () => {
    expect(near([fullKey(9)], NEAR_ME).shownSteps).toEqual([0]);
    expect(stellar([addSignerOp(1)]).shownSteps).toEqual([0]);
  });
  it('grouped lines: every member of a visible group, none of a left-out one', () => {
    const many = near([...Array.from({ length: 99 }, (): NearAction => ({ type: 'transfer', deposit: 1n })), fullKey(9)], NEAR_ME);
    expect([...(many.shownSteps ?? [])].sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, i) => i));
    const six = near([1, 2, 3, 4, 5, 6].map(fullKey), NEAR_ME);
    expect(six.shownSteps).toHaveLength(3);
    expect(six.warnings.filter((w) => w.code === 'step_left_out')).toHaveLength(3);
    for (const i of six.shownSteps ?? []) expect(JSON.stringify(six.lines)).toContain(nearPublicKeyString(new Uint8Array(32).fill(i + 1)));
  });
  it('a summary that names no step (an EVM call, a message) lists none', () => {
    expect(near([], NEAR_ME).shownSteps ?? []).toEqual([]);
  });
});
