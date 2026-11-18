// Journear's reviewed list of well-known tokens (src/known-tokens.ts, D860): every entry's shape and source, the Stellar
// asset contracts derived again from the listed assets, the mainnet demo's tokens all on it, exact matching per
// network (look-alike addresses, the wrong network), collectibles never given an amount, and the amounts the window
// shows for listed tokens, rounded against the user as decided (D814).
import { Asset, StrKey } from '@stellar/stellar-base';
import { describe, expect, it } from 'vitest';
import { MAINNET_DEMO } from '../src/mainnet-demo.ts';
import { codeShape, imitatedSymbolOn } from '../src/known-tokens.ts';

const OTHER_EVM = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
import { CIRCLE_STELLAR_ISSUERS, KNOWN_TOKENS, type KnownTokenList, STELLAR_MAINNET_PASSPHRASE, STELLAR_TESTNET_PASSPHRASE, checksumAddress, isNearAccountId, knownToken, parseHex0x } from '../src/index.ts';
import { decodeApprovalRequest, evmTxSigningPayload, knownEvmToken, knownNearToken, knownStellarToken, parseEvmTxRequest, parseFunctionSignature, summarizeApproval, summaryString, type ApprovalSummary, encodeNearTransaction, utf8, sha256 } from './entries.ts';
import { Operation } from '@stellar/stellar-base';
import { OTHER, PASSPHRASE, USER, txBytes } from './stellar-fixtures.ts';

const APP = 'Partner App';
const text = (t: Parameters<typeof summaryString>[0]) => summaryString(t, APP);

describe('the list itself', () => {
  const all = [
    ...Object.entries(KNOWN_TOKENS.evm).flatMap(([c, t]) => Object.entries(t).map(([id, e]) => ({ net: `evm:${c}`, id, e }))),
    ...Object.entries(KNOWN_TOKENS.stellar).flatMap(([p, t]) => Object.entries(t).map(([id, e]) => ({ net: `stellar:${p}`, id, e }))),
    ...Object.entries(KNOWN_TOKENS.near).flatMap(([n, t]) => Object.entries(t).map(([id, e]) => ({ net: `near:${n}`, id, e }))),
  ];

  it('every entry has a symbol, a name, whole decimals, a kind, a source and the date it was read', () => {
    expect(all.length).toBeGreaterThan(20);
    for (const { id, e } of all) {
      expect(e.symbol, id).toMatch(/^[A-Za-z]{2,12}$/u);
      expect(e.name.length, id).toBeGreaterThan(2);
      expect(Number.isInteger(e.decimals) && e.decimals >= 0 && e.decimals <= 30, id).toBe(true);
      expect(['token', 'collectible']).toContain(e.kind);
      expect(e.sources.length, id).toBeGreaterThan(0);
      // An issuer's page (https), or a stated derivation.
      for (const s of e.sources) expect(s, id).toMatch(/^(https:\/\/|derived: |the native asset)/u);
      expect(e.read).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    }
  });

  it('ids are well-formed for their network: EIP-55 EVM addresses, Stellar assets and contracts, NEAR account ids', () => {
    for (const [, t] of Object.entries(KNOWN_TOKENS.evm)) for (const id of Object.keys(t)) expect(checksumAddress(parseHex0x(id, 20))).toBe(id);
    for (const [, t] of Object.entries(KNOWN_TOKENS.stellar))
      for (const id of Object.keys(t)) {
        if (id.includes(':')) expect(StrKey.isValidEd25519PublicKey(id.split(':')[1] as string), id).toBe(true);
        else expect(StrKey.isValidContract(id), id).toBe(true);
      }
    for (const [, t] of Object.entries(KNOWN_TOKENS.near)) for (const id of Object.keys(t)) expect(isNearAccountId(id), id).toBe(true);
  });

  it('every Stellar asset contract is the one its listed asset derives to on that network (or the native asset’s)', () => {
    for (const [passphrase, t] of Object.entries(KNOWN_TOKENS.stellar)) {
      const derived = new Map<string, string>([[Asset.native().contractId(passphrase), 'XLM']]);
      for (const id of Object.keys(t)) if (id.includes(':')) derived.set(new Asset(id.split(':')[0] as string, id.split(':')[1] as string).contractId(passphrase), id.split(':')[0] as string);
      for (const [id, e] of Object.entries(t)) if (!id.includes(':')) expect(derived.get(id), id).toBe(e.symbol);
    }
    // Circle's issuers, as listed: USDC and EURC on both networks.
    expect(knownStellarToken(STELLAR_MAINNET_PASSPHRASE, `USDC:${CIRCLE_STELLAR_ISSUERS.public.USDC}`)?.decimals).toBe(7);
    expect(knownStellarToken(STELLAR_TESTNET_PASSPHRASE, `EURC:${CIRCLE_STELLAR_ISSUERS.testnet.EURC}`)?.symbol).toBe('EURC');
  });

  it('every token of the mainnet demo is on the list with the same symbol and decimals (MAINNET_DEMO stays the demo’s source)', () => {
    for (const [chainId, chain] of Object.entries(MAINNET_DEMO.evm)) for (const [addr, t] of Object.entries(chain.tokens)) expect(knownEvmToken(Number(chainId), addr)).toMatchObject({ symbol: t.symbol, decimals: t.decimals });
    const s = MAINNET_DEMO.stellar;
    for (const t of [s.native, ...Object.values(s.assets)]) expect(knownStellarToken(s.networkPassphrase, t.assetContract)).toMatchObject({ symbol: t.symbol, decimals: t.decimals });
  });
});

describe('matching: exact, per network', () => {
  const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  it('an EVM address matches on its own chain in any letter case, never on another chain or with one character changed', () => {
    expect(knownEvmToken(84532, BASE_SEPOLIA_USDC)?.symbol).toBe('USDC');
    expect(knownEvmToken(84532, BASE_SEPOLIA_USDC.toLowerCase())?.symbol).toBe('USDC');
    expect(knownEvmToken(8453, BASE_SEPOLIA_USDC)).toBeNull();
    expect(knownEvmToken(11155111, BASE_SEPOLIA_USDC)).toBeNull();
    const lookalike = `${BASE_SEPOLIA_USDC.slice(0, -1)}${BASE_SEPOLIA_USDC.endsWith('e') ? 'f' : 'e'}`;
    expect(knownEvmToken(84532, lookalike)).toBeNull();
    expect(knownEvmToken(999_999, BASE_SEPOLIA_USDC)).toBeNull();
  });

  it('a Stellar asset matches only with its issuer on its network; a NEAR token only by its exact account on its network', () => {
    const pubUsdc = `USDC:${CIRCLE_STELLAR_ISSUERS.public.USDC}`;
    expect(knownStellarToken(STELLAR_MAINNET_PASSPHRASE, pubUsdc)?.symbol).toBe('USDC');
    expect(knownStellarToken(STELLAR_TESTNET_PASSPHRASE, pubUsdc)).toBeNull();
    expect(knownStellarToken(STELLAR_MAINNET_PASSPHRASE, `USDC:${OTHER}`)).toBeNull();
    expect(knownStellarToken(STELLAR_MAINNET_PASSPHRASE, `usdc:${CIRCLE_STELLAR_ISSUERS.public.USDC}`)).toBeNull();
    expect(knownNearToken('mainnet', 'wrap.near')?.decimals).toBe(24);
    expect(knownNearToken('testnet', 'wrap.near')).toBeNull();
    expect(knownNearToken('mainnet', 'wrap.near.evil.near')).toBeNull();
    expect(knownNearToken('testnet', 'wrap.testnet')?.symbol).toBe('wNEAR');
  });

  it('a collectible on a list is found, but never gives an amount a symbol or decimals', () => {
    const list: KnownTokenList = { evm: { 84532: { '0x1111111111111111111111111111111111111111': { symbol: 'PASS', name: 'Pass', decimals: 0, kind: 'collectible', sources: ['https://example.invalid'], read: '2026-11-18' } } }, stellar: {}, near: { testnet: {}, mainnet: {} } };
    expect(knownToken({ kind: 'evm', chainId: 84532 }, '0x1111111111111111111111111111111111111111', list)?.kind).toBe('collectible');
    expect(knownEvmToken(84532, '0x1111111111111111111111111111111111111111', list)).toBeNull();
    // Today's list has none: a collectible's numbers are item ids, so none is seeded until one is reviewed.
    for (const t of Object.values(KNOWN_TOKENS.evm)) for (const e of Object.values(t)) expect(e.kind).toBe('token');
  });
});

describe('what the window says for a listed token (D860)', () => {
  const ME = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
  const TO = '0x000000000000000000000000000000000000dEaD';
  const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  const word = (v: bigint | string) => (typeof v === 'string' ? v.slice(2).toLowerCase().padStart(64, '0') : v.toString(16).padStart(64, '0'));
  const evm = (data: string, chainId = 84532, to = USDC): ApprovalSummary => {
    const tx = { chainId: `0x${chainId.toString(16)}`, nonce: '0x1', gas: '0x5208', maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1', to, value: '0x0', data };
    return summarizeApproval(decodeApprovalRequest({ kind: 'evm_tx', chain: 'evm', address: ME, context: { chainId }, bytes: evmTxSigningPayload(parseEvmTxRequest(tx)) }), { address: ME });
  };
  const transfer = (amount: bigint) => `${parseFunctionSignature('transfer(address,uint256)').selector}${word(TO)}${word(amount)}`;

  it('EVM: "5 USDC" and the real-token line naming the contract; the same address on another chain is unlisted', () => {
    const s = evm(transfer(5_000_000n));
    expect(text(s.headline)).toBe(`${APP} wants to send 5 USDC to ${TO}`);
    expect(s.lines.map(text)).toEqual([`This is the real USDC token (${USDC}).`]);
    expect(text(evm(transfer(5_000_000n), 11155111).headline)).toBe(`${APP} wants to send 5,000,000 units of an unlisted token to ${TO}`);
  });

  it('decimals and rounding: exact up to six places, "less than" below, rounded up when it leaves the user', () => {
    expect(text(evm(transfer(1_234_567n)).headline)).toBe(`${APP} wants to send 1.234567 USDC to ${TO}`);
    expect(text(evm(transfer(1n)).headline)).toBe(`${APP} wants to send 0.000001 USDC to ${TO}`);
    expect(text(evm(transfer(10n ** 12n)).headline)).toBe(`${APP} wants to send 1,000,000 USDC to ${TO}`);
  });

  it('a permission for a listed token says its amount in the token, from the user’s account', () => {
    const s = evm(`${parseFunctionSignature('approve(address,uint256)').selector}${word(TO)}${word(2_500_000n)}`);
    expect(text(s.warnings[0]!.text)).toBe(`This lets ${TO} (not checked by Journear) take up to 2.5 USDC from your account. The permission lasts until they’ve used it all or you cancel it elsewhere.`);
  });

  it('NEAR: wNEAR in its 24 decimals, rounded against the user both ways', () => {
    const me = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
    const ft = (to: string, amount: string) =>
      summarizeApproval(
        decodeApprovalRequest({
          kind: 'near_tx',
          chain: 'near',
          address: me,
          context: { nearNetwork: 'testnet' },
          bytes: encodeNearTransaction({ signerId: me, publicKey: { type: 'ed25519', bytes: Uint8Array.from({ length: 32 }, (_, i) => i + 1) }, nonce: 1n, receiverId: 'wrap.testnet', blockHash: sha256(utf8('b')), actions: [{ type: 'functionCall', methodName: 'ft_transfer', args: utf8(JSON.stringify({ receiver_id: to, amount })), gas: 1n, deposit: 1n }] }),
        }),
        { address: me },
      );
    const out = ft('bob.testnet', '1000000500000000000000000');
    expect(text(out.headline)).toBe(`${APP} wants to send about 1.000001 wNEAR to bob.testnet`);
    expect(out.lines.map(text)).toEqual(['This is the real wNEAR token (wrap.testnet).']);
    expect(text(ft('bob.testnet', '1').headline)).toBe(`${APP} wants to send less than 0.000001 wNEAR to bob.testnet`);
    // On mainnet, wrap.testnet is unlisted (the wrong network).
    expect(text(ft(me, '1000000500000000000000000').headline)).toBe(`${APP} wants to send about 1 wNEAR to your account`);
  });

  it('Stellar (the fixtures’ test network): a listed asset by its symbol; another issuer’s "USDC" is shown as the asset and warned as a possible copy', () => {
    const usdcTest = `USDC:${CIRCLE_STELLAR_ISSUERS.testnet.USDC}`;
    const pay = (asset: string) =>
      summarizeApproval(decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: txBytes([Operation.payment({ destination: OTHER, asset: new Asset(asset.split(':')[0] as string, asset.split(':')[1] as string), amount: '5' })]) }), { address: USER });
    const real = pay(usdcTest);
    expect(text(real.headline)).toBe(`${APP} wants to send 5 USDC to ${OTHER}`);
    expect(real.lines.map(text)).toEqual([`This is the real USDC token (${usdcTest}).`]);
    expect(real.warnings).toEqual([]);
    const copy = pay(`USDC:${OTHER}`);
    expect(text(copy.headline)).toBe(`${APP} wants to send 5 of the asset USDC:${OTHER} to ${OTHER}`);
    expect(copy.warnings.map((w) => [w.level, w.code, text(w.text)])).toEqual([['warning', 'token_lookalike', `This is not the USDC Journear knows (USDC:${OTHER}). It may be a copy.`]]);
    // A code no listed token has: neither line.
    const other = pay(`ABC:${OTHER}`);
    expect(other.warnings).toEqual([]);
    expect(other.lines).toEqual([]);
  });

  it('the possible-copy line: the listed code from another issuer, and codes that only look like it (case, trailing digits, 0/O-style characters)', () => {
    const net = { kind: 'stellar', networkPassphrase: PASSPHRASE } as const;
    for (const c of ['USDC', 'usdc', 'USDC2', 'U5DC', 'usdc10', 'EURC1', 'XLM']) expect(imitatedSymbolOn(net, c), c).not.toBeNull();
    for (const c of ['USDCX', 'XUSDC', 'USD', 'ABC', '123', 'EUR']) expect(imitatedSymbolOn(net, c), c).toBeNull();
    expect(codeShape('u5dc1')).toBe('USDC');
    const pay = (code: string) =>
      summarizeApproval(decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: USER, context: { networkPassphrase: PASSPHRASE }, bytes: txBytes([Operation.payment({ destination: OTHER, asset: new Asset(code, OTHER), amount: '5' })]) }), { address: USER });
    expect(pay('U5DC').warnings.map((w) => text(w.text))).toEqual([`This is not the USDC Journear knows (U5DC:${OTHER}). It may be a copy.`]);
    expect(pay('usdc').warnings.map((w) => w.code)).toEqual(['token_lookalike']);
    expect(pay('USDCX').warnings).toEqual([]);
  });

  it('the real-token line speaks about the token only, never the request', () => {
    const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
    const approve = `${parseFunctionSignature('approve(address,uint256)').selector}${'0'.repeat(24)}${'3'.repeat(40)}${'f'.repeat(64)}`;
    const tx = { chainId: '0x14a34', nonce: '0x1', gas: '0x5208', maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1', to: USDC, value: '0x0', data: approve };
    const s = summarizeApproval(decodeApprovalRequest({ kind: 'evm_tx', chain: 'evm', address: OTHER_EVM, context: { chainId: 84532 }, bytes: evmTxSigningPayload(parseEvmTxRequest(tx)) }), { address: OTHER_EVM });
    // Under a red unlimited-permission warning, the line must not read as if the request was checked.
    expect(s.warnings.map((w) => w.code)).toEqual(['unlimited_spend']);
    expect(s.lines.map(text)).toEqual([`This is the real USDC token (${USDC}).`]);
    for (const l of s.lines) expect(text(l)).not.toMatch(/checked/u);
  });
});
