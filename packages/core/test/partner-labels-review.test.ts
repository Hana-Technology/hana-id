// Partner labels after PR 114's review (D892): the reviewer's example documents refused; every true value returned;
// the network and the code hash checked as inputs; the no-match `at` never a request's text; the plain form naming the
// partner as the source of a token amount; the verb rules; and that nothing outside the tests uses the module yet.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { base58 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { utf8 } from '../src/bytes.ts';
import type { NearAction } from '../src/near/codec.ts';
import { type LabelMatch, type LabelNoMatchCode, type LabelRequest, labelRequestOf, matchLabel, noMatchKind } from '../src/partner-labels/match.ts';
import { type LabelErrorCode, SENTENCE_PARTNER_CHARS, parseLabelDocument } from '../src/partner-labels/schema.ts';
import { PARTNER_CONNECTORS, PARTNER_VERBS, SOFT_VERBS } from '../src/partner-labels/words.ts';
import { decodeApprovalRequest } from '../src/decode/request.ts';
import { ME, OTHER, PASSPHRASE, PAYMENT_DOC_JSON, POOL, SOROBAN_DOC_JSON, STAMPS, STAMPS_DOC_JSON, STAMPS_HASH, fn, nearDecoded, parsed, paymentTx } from './partner-labels-fixtures.ts';
import { Asset, Memo } from '@stellar/stellar-base';
import { ISSUER as STELLAR_ISSUER, USER as STELLAR_USER } from './stellar-fixtures.ts';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const codes = (doc: unknown): LabelErrorCode[] => {
  const r = parseLabelDocument(JSON.stringify(doc));
  return r.ok ? [] : r.errors.map((e) => e.code);
};

const nearDoc = (account: string, formats: Json, metadata: Json = {}) => ({ schema: 'journear-labels/1', context: { near: { network: 'testnet', account, codeHash: STAMPS_HASH } }, metadata, display: { formats } });
const collectFmt = (): Json => clone(STAMPS_DOC_JSON.display.formats.collect);

describe('item 1: no label on what Journear reads itself', () => {
  it('refuses a known token, a reviewed NEAR contract, a verified Soroban contract or token as the context', () => {
    expect(codes(nearDoc('wrap.testnet', { collect: collectFmt() }, STAMPS_DOC_JSON.metadata))).toContain('journear_reads_this');
    // The reviewed stamps contract recorded for sandbox-dev (by the sha256 of its account, as the record holds it).
    expect(codes(nearDoc('hana-id-stamps-dev1.testnet', { collect: collectFmt() }, STAMPS_DOC_JSON.metadata))).toContain('journear_reads_this');
    const soroban = clone(SOROBAN_DOC_JSON) as Json;
    soroban.context.soroban.contract = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
    expect(codes(soroban)).toContain('journear_reads_this');
  });
  it('refuses the reviewer’s ft_transfer label with no fields, and nft_approve on the partner’s own contract', () => {
    const ft = nearDoc('wrap.testnet', {
      ft_transfer: { call: { deposit: { exactly: '1' }, args: { receiver_id: { type: 'accountId' }, amount: { type: 'u128' } } }, intent: { verb: 'collect', object: 'the stamp' }, sentence: ['verb', 'object'], fields: [] },
    });
    expect(codes(ft)).toEqual(expect.arrayContaining(['journear_reads_this', 'reserved_method']));
    const approve = nearDoc(STAMPS, { nft_approve: { call: { args: { account_id: { type: 'accountId' } } }, intent: { verb: 'join', object: 'the club' }, sentence: ['verb', 'object'], fields: [{ path: 'args.account_id', label: 'Member', format: 'account' }] } });
    expect(codes(approve)).toContain('reserved_method');
  });
  it.each(['ft_transfer', 'ft_transfer_call', 'nft_transfer', 'nft_transfer_call', 'nft_approve', 'nft_revoke', 'nft_revoke_all', 'mt_transfer', 'mt_batch_transfer', 'storage_deposit', 'storage_withdraw', 'storage_unregister', 'near_deposit', 'near_withdraw', 'deposit_and_stake', 'unstake_all', 'withdraw_all'])('refuses the NEAR method %s', (m) => {
    expect(codes(nearDoc(STAMPS, { [m]: collectFmt() }, STAMPS_DOC_JSON.metadata))).toContain('reserved_method');
  });
  it.each(['transfer', 'transfer_from', 'approve', 'burn', 'burn_from', 'mint', 'set_admin', 'clawback', 'set_authorized', 'upgrade'])('refuses the Soroban function %s', (m) => {
    const d = clone(SOROBAN_DOC_JSON) as Json;
    d.display.formats = { [m]: d.display.formats.deposit };
    expect(codes(d)).toContain('reserved_method');
  });
  it('the matcher refuses the build’s reviewed NEAR accounts too', () => {
    const r = matchLabel(parsed(STAMPS_DOC_JSON), labelRequestOf(nearDecoded([fn('collect', '{"stamp":"arrival"}')]), ME)!, { codeHash: STAMPS_HASH, networkChecked: true, reviewedNear: [STAMPS] });
    expect(r).toEqual({ ok: false, reason: 'journear_reads_this', at: 'receiver' });
  });
});

describe('item 2: every value that matters is shown, and every true value is returned', () => {
  const withdraw = (fields: Json[]) =>
    nearDoc(STAMPS, {
      withdraw: { call: { args: { owner: { type: 'accountId', isSelf: true }, beneficiary: { type: 'accountId' }, amount: { type: 'u128' } } }, intent: { verb: 'withdraw', object: 'the locker deposit' }, sentence: ['verb', 'object'], fields },
    });
  it('refuses a format that leaves an account, an amount or a non-zero deposit out of its fields', () => {
    expect(codes(withdraw([{ path: 'args.owner', label: 'From', format: 'account' }]))).toContain('field_required');
    const ok = codes(withdraw([{ path: 'args.owner', label: 'From', format: 'account' }, { path: 'args.beneficiary', label: 'To', format: 'account' }, { path: 'args.amount', label: 'Amount', format: 'tokenAmount', params: { token: 'shop.testnet' } }]));
    expect(ok).not.toContain('field_required');
    const dep = collectFmt();
    dep.call.deposit = { atMost: '5' };
    expect(codes(nearDoc(STAMPS, { collect: dep }, STAMPS_DOC_JSON.metadata))).toContain('field_required');
  });

  // The typed-slots document, with a gas bound; requests vary one value at a time.
  const DOC = parsed(
    nearDoc('shop.testnet', {
      buy: {
        call: { deposit: { atMost: '9' }, gasAtMost: '300000000000000', args: { token: { type: 'accountId' }, amount: { type: 'u128' }, to: { type: 'accountId' }, note: { type: 'string', optional: true }, n: { type: 'integer' } } },
        intent: { verb: 'buy', object: 'tickets' },
        sentence: ['verb', 'object'],
        fields: [
          { path: 'args.token', label: 'Token', format: 'account' },
          { path: 'args.amount', label: 'Price', format: 'tokenAmount', params: { tokenPath: 'args.token' } },
          { path: 'args.to', label: 'Paid to', format: 'account' },
          { path: 'deposit', label: 'Attached', format: 'nativeAmount' },
        ],
      },
    }),
  );
  const req = (args: Json, deposit = 0n, gas = 10n ** 13n) => labelRequestOf(nearDecoded([fn('buy', JSON.stringify(args), { deposit, gas })], { receiver: 'shop.testnet' }), ME)!;
  it('returns each declared argument (null when absent), the deposit and the gas, marking which are shown', () => {
    const r = matchLabel(DOC, req({ token: 't.testnet', amount: '5', to: 'x.testnet', n: 3 }, 2n), { codeHash: STAMPS_HASH, networkChecked: true }) as LabelMatch;
    expect(r.values).toEqual([
      { path: 'args.token', type: 'accountId', value: 't.testnet', shown: true },
      { path: 'args.amount', type: 'u128', value: '5', shown: true },
      { path: 'args.to', type: 'accountId', value: 'x.testnet', shown: true },
      { path: 'args.note', type: 'string', value: null, shown: false },
      { path: 'args.n', type: 'integer', value: '3', shown: false },
      { path: 'deposit', type: 'deposit', value: '2', shown: true },
      { path: 'gas', type: 'gas', value: '10000000000000', shown: false },
    ]);
  });
  it('property: two matching requests whose values differ never give the same values', () => {
    const seen = new Map<string, string>();
    for (const note of [undefined, '', 'a', 'b']) {
      for (const n of [0, 1, 2]) {
        for (const deposit of [0n, 1n, 9n]) {
          for (const gas of [1n, 10n ** 13n]) {
            for (const to of ['x.testnet', 'y.testnet']) {
              const args: Json = { token: 't.testnet', amount: '5', to, n, ...(note === undefined ? {} : { note }) };
              const r = matchLabel(DOC, req(args, deposit, gas), { codeHash: STAMPS_HASH, networkChecked: true });
              expect(r.ok).toBe(true);
              const key = JSON.stringify((r as LabelMatch).values);
              const id = JSON.stringify({ args, deposit: deposit.toString(), gas: gas.toString() });
              expect(seen.get(key) ?? id, id).toBe(id);
              seen.set(key, id);
            }
          }
        }
      }
    }
    expect(seen.size).toBe(4 * 3 * 3 * 2 * 2);
  });
  it('a payment returns its amount, asset, destination, memo and fee; a hidden memo or amount changes them', () => {
    const DOCP = parsed(PAYMENT_DOC_JSON);
    const pay = (o: Parameters<typeof paymentTx>[0]) => matchLabel(DOCP, labelRequestOf(decodeApprovalRequest({ kind: 'stellar_tx', chain: 'stellar', address: STELLAR_USER, context: { networkPassphrase: PASSPHRASE }, bytes: paymentTx(o) }), STELLAR_USER)!) as LabelMatch;
    const a = pay({});
    expect(a.values.map((v) => v.path)).toEqual(['amount', 'asset', 'destination', 'memo', 'fee']);
    expect(a.values.find((v) => v.path === 'destination')!.value).toBe(OTHER);
    for (const o of [{ amount: '26' }, { asset: new Asset('USDC', STELLAR_ISSUER) }, { memo: Memo.text('1043') }]) expect(JSON.stringify(pay(o).values), JSON.stringify(o)).not.toBe(JSON.stringify(a.values));
  });
});

describe('item 3a: one partner-worded value in the sentence, and a short one', () => {
  it('refuses two enumeration or account fields in the sentence', () => {
    const f = collectFmt();
    f.call.args.badge = { type: 'string' };
    f.fields.push({ path: 'args.badge', label: 'Badge', format: 'enum', params: { enum: 'stamp' } });
    f.sentence = ['verb', 'object', { field: 'args.stamp' }, { word: 'with' }, { field: 'args.badge' }];
    expect(codes(nearDoc(STAMPS, { collect: f }, STAMPS_DOC_JSON.metadata))).toContain('sentence_text');
  });
  it(`refuses an object and a label longer than ${SENTENCE_PARTNER_CHARS} characters together`, () => {
    const f = collectFmt();
    f.intent.object = 'the stamp of the arrival hall';
    const meta = { enums: { stamp: { arrival: 'Arrival at the grand gate' } } };
    expect(codes(nearDoc(STAMPS, { collect: f }, meta))).toContain('sentence_text');
  });
  it('refuses the reviewer’s three-phrase sentence at the text rules already', () => {
    const meta = { enums: { stamp: { a: 'nothing leaves the account', b: 'no tokens are moved at all', c: 'nothing to pay ever' } } };
    expect(codes(nearDoc(STAMPS, { collect: collectFmt() }, meta))).toContain('text_negation');
  });
});

describe('items 6, 7, 11, 14: amounts, joining words, duplicates, verbs', () => {
  it('nativeAmount only on the deposit', () => {
    const f = collectFmt();
    f.call.args.amount = { type: 'u128' };
    f.fields.push({ path: 'args.amount', label: 'Price', format: 'nativeAmount' });
    expect(codes(nearDoc(STAMPS, { collect: f }, STAMPS_DOC_JSON.metadata))).toContain('bad_field');
  });
  it('no "at least" or "at most"', () => {
    expect(PARTNER_CONNECTORS).not.toContain('at least');
    const f = collectFmt();
    f.sentence = ['verb', { word: 'at least' }, 'object', { field: 'args.stamp' }];
    expect(codes(nearDoc(STAMPS, { collect: f }, STAMPS_DOC_JSON.metadata))).toContain('bad_sentence');
  });
  it('near-duplicate enumeration labels and address names, and two fields with one label', () => {
    expect(codes(nearDoc(STAMPS, { collect: collectFmt() }, { enums: { stamp: { a: 'Gold', b: 'Göld' } } }))).toContain('duplicate');
    expect(codes(nearDoc(STAMPS, { collect: collectFmt() }, { ...STAMPS_DOC_JSON.metadata, addressBook: [{ account: 'a.testnet', name: 'Till' }, { account: 'b.testnet', name: 'Tíll' }] }))).toContain('duplicate');
    const f = collectFmt();
    f.call.args.a = { type: 'accountId' };
    f.call.args.b = { type: 'accountId' };
    f.fields.push({ path: 'args.a', label: 'To', format: 'account' }, { path: 'args.b', label: 'To', format: 'account' });
    expect(codes(nearDoc(STAMPS, { collect: f }, STAMPS_DOC_JSON.metadata))).toContain('duplicate');
  });
  it('the verb list, and soft verbs only where no value can move', () => {
    for (const v of ['claim', 'update', 'transfer']) expect(PARTNER_VERBS).not.toContain(v);
    expect([...SOFT_VERBS].every((v) => (PARTNER_VERBS as readonly string[]).includes(v))).toBe(true);
    const f = collectFmt();
    f.call.deposit = { atMost: '5' };
    f.fields.push({ path: 'deposit', label: 'Attached', format: 'nativeAmount' });
    expect(codes(nearDoc(STAMPS, { collect: f }, STAMPS_DOC_JSON.metadata))).toContain('bad_verb');
    f.intent.verb = 'pay';
    expect(codes(nearDoc(STAMPS, { collect: f }, STAMPS_DOC_JSON.metadata))).toEqual([]);
    const p = clone(PAYMENT_DOC_JSON) as Json;
    p.display.formats.payment.intent.verb = 'join';
    expect(codes(p)).toContain('bad_verb');
  });
});

describe('items 8, 9, 10, 13: the matcher’s inputs and outputs', () => {
  const DOC = parsed(STAMPS_DOC_JSON);
  const near = (a: NearAction[]) => labelRequestOf(nearDecoded(a), ME)!;
  const ok = [fn('collect', '{"stamp":"arrival"}')];
  it('a key of the request is named only when it is plain; otherwise args.*', () => {
    const evil = `${String.fromCharCode(0x202e)}evil${String.fromCharCode(0x200b)} <b>`;
    expect(matchLabel(DOC, near([fn('collect', JSON.stringify({ stamp: 'arrival', [evil]: 1 }))]), { codeHash: STAMPS_HASH, networkChecked: true })).toEqual({ ok: false, reason: 'undeclared_arg', at: 'args.*' });
    expect(matchLabel(DOC, near([fn('collect', JSON.stringify({ stamp: 'arrival', to: 1 }))]), { codeHash: STAMPS_HASH, networkChecked: true })).toEqual({ ok: false, reason: 'undeclared_arg', at: 'args.to' });
  });
  it('the network must have been checked by the vault', () => {
    expect(matchLabel(DOC, near(ok), { codeHash: STAMPS_HASH })).toEqual({ ok: false, reason: 'network_not_checked' });
    expect(matchLabel(DOC, near(ok), { codeHash: STAMPS_HASH, networkChecked: false })).toEqual({ ok: false, reason: 'network_not_checked' });
  });
  it('the code hash: unread, malformed, no code, different', () => {
    const f = (codeHash: string | null) => (matchLabel(DOC, near(ok), { codeHash, networkChecked: true }) as { reason?: string }).reason;
    expect(f(null)).toBe('no_code_hash');
    expect(f(`${STAMPS_HASH}0`)).toBe('bad_code_hash_input');
    expect(f(STAMPS_HASH.toUpperCase())).toBe('bad_code_hash_input');
    expect(f(Buffer.from(base58.decode(STAMPS_HASH)).toString('hex'))).toBe('bad_code_hash_input');
    expect(f('11111111111111111111111111111111')).toBe('no_contract_code');
    expect(f(base58.encode(new Uint8Array(32).fill(9)))).toBe('code_hash_mismatch');
    const S = parsed(SOROBAN_DOC_JSON);
    const sreq: LabelRequest = { kind: 'stellar_auth', networkPassphrase: PASSPHRASE, user: STELLAR_USER, invocation: { function: { type: 'contractFn', contract: POOL, function: 'deposit', args: [] }, subInvocations: [] } };
    expect((matchLabel(S, sreq, { codeHash: 'AB'.repeat(32) }) as { reason?: string }).reason).toBe('bad_code_hash_input');
    expect((matchLabel(S, sreq, { codeHash: '0'.repeat(64) }) as { reason?: string }).reason).toBe('no_contract_code');
  });
  it('"-0" is not an integer value', () => {
    const d = clone(STAMPS_DOC_JSON) as Json;
    d.display.formats.collect.call.args.n = { type: 'integer', optional: true };
    expect((matchLabel(parsed(d), near([fn('collect', '{"stamp":"arrival","n":-0}')]), { codeHash: STAMPS_HASH, networkChecked: true }) as { reason?: string }).reason).toBe('type_mismatch');
  });
  it('empty arguments only when nothing is declared (near-sdk fails to parse empty input for a method with arguments)', () => {
    const d = clone(STAMPS_DOC_JSON) as Json;
    d.display.formats.collect.call.args = { note: { type: 'string', optional: true } };
    d.display.formats.collect.fields = [];
    d.display.formats.collect.sentence = ['verb', 'object'];
    expect((matchLabel(parsed(d), near([fn('collect', '')]), { codeHash: STAMPS_HASH, networkChecked: true }) as { reason?: string }).reason).toBe('args_not_json');
    expect(matchLabel(parsed(d), near([fn('collect', '{}')]), { codeHash: STAMPS_HASH, networkChecked: true }).ok).toBe(true);
  });
  it('classifies every no-match', () => {
    const all: LabelNoMatchCode[] = ['wrong_chain', 'wrong_network', 'wrong_account', 'wrong_method', 'wrong_operation', 'calls_own_account', 'journear_reads_this', 'not_a_function_call', 'no_code_hash', 'bad_code_hash_input', 'network_not_checked', 'code_hash_mismatch', 'no_contract_code', 'deposit_not_allowed', 'undeclared_arg', 'enum_value_not_listed', 'spec_mismatch'];
    expect(all.map(noMatchKind)).toEqual(['not_described', 'not_described', 'not_described', 'not_described', 'not_described', 'not_described', 'not_described', 'not_described', 'couldnt_check', 'couldnt_check', 'couldnt_check', 'described_mismatch', 'described_mismatch', 'described_mismatch', 'described_mismatch', 'described_mismatch', 'described_mismatch']);
  });
});

describe('item 13, as amended by D894: exactly two places outside core import the module, through its subpath', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  /** An import of the module: the subpath, or a relative path into core's folder. */
  const IMPORT = /(?:from\s*|import\s*\(\s*)['"]([^'"]*(?:@hana-id\/core\/partner-labels|core\/src\/partner-labels|vault\/partner-labels)[^'"]*)['"]/gu;
  const isTest = (p: string) => /(^|\/)(test|tests|test-[a-z-]+)\//u.test(p) || /\.test\.ts$/u.test(p);
  const importers = (): { file: string; spec: string }[] => {
    const hits: { file: string; spec: string }[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|mjs|js)$/u.test(name)) for (const m of readFileSync(p, 'utf8').matchAll(IMPORT)) hits.push({ file: p.slice(root.length), spec: m[1]! });
      }
    };
    walk(join(root, 'apps'));
    walk(join(root, 'packages'));
    return hits.filter((h) => !h.file.startsWith('packages/core/src/partner-labels/') && !h.file.startsWith('packages/core/test/'));
  };
  it('core publishes it as the ./partner-labels subpath only, never from its root entry', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'packages/core/package.json'), 'utf8')) as { exports: Record<string, string> };
    expect(Object.entries(pkg.exports).filter(([, v]) => v.includes('partner-labels'))).toEqual([['./partner-labels', './src/partner-labels/index.ts']]);
    expect(readFileSync(join(root, 'packages/core/src/index.ts'), 'utf8')).not.toMatch(/partner-labels/u);
  });
  it('the API’s labels module and the vault’s check are the only sources that import it, by the subpath', () => {
    const sources = importers().filter((h) => !isTest(h.file));
    expect(sources.map((h) => h.file).sort()).toEqual(['apps/api/src/labels/document.ts', 'packages/web/src/vault/partner-labels.ts']);
    // (Other files named partner-labels, such as the admin portal's own screen module, are not core's module.)
    expect(new Set(sources.map((h) => h.spec))).toEqual(new Set(['@hana-id/core/partner-labels']));
  });
  it('outside core, only those two places’ tests import it (or the helper that wraps it)', () => {
    const tests = importers().filter((h) => isTest(h.file));
    for (const t of tests) expect(t.file, t.spec).toMatch(/^(apps\/api\/test\/|packages\/web\/test\/)/u);
  });
});
