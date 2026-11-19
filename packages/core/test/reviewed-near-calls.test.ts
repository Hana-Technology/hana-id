// Journear's reviewed NEAR calls (src/reviewed-near-calls.ts, D885): each entry's exact match and its plain reading;
// every near-miss gets exactly the summary it would get with no entry at all (today's screen); the entries are tied
// to the contract source a person reviewed, so a change to it fails here until it is reviewed again.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type ApprovalSummary,
  type NearAction,
  type ReviewedNearAccounts,
  type ReviewedNearContract,
  type ReviewedStampId,
  type SummaryText,
  GUESTBOOK_TEXT_MAX_CHARS,
  REVIEWED_NEAR_CONTRACTS,
  REVIEWED_NEAR_DEPLOYS,
  REVIEWED_NEAR_MAX_GAS,
  REVIEWED_STAMP_TITLES,
  STAMP_NOTE_MAX_CHARS,
  STAMP_SIGN_MESSAGE_PREFIX,
  UNEXPLAINED_SUMMARY,
  base64Encode,
  decodeApprovalRequest,
  encodeNearDelegateAction,
  encodeNearTransaction,
  encodeNep413Message,
  nearImplicitAccountId,
  reviewedNearCall,
  reviewedNearMessage,
  sha256,
  summarizeApproval,
  summaryString,
  utf8,
} from './entries.ts';
import { jargonIn, zeroCostIn } from './plain-words.ts';

const APP = 'Stamp Trail';
const text = (t: SummaryText): string => summaryString(t, APP);
const PUB = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
const ME = nearImplicitAccountId(PUB);
const KEY = { type: 'ed25519' as const, bytes: PUB };
const STAMPS = 'stamps-reviewed.testnet';
const BOOK = 'guestbook-reviewed.testnet';
const ACCOUNTS: ReviewedNearAccounts = Object.freeze({ stamps: STAMPS, guestbook: BOOK });
const TGAS = 1_000_000_000_000n;

const fn = (methodName: string, args: string | Uint8Array, over: { gas?: bigint; deposit?: bigint } = {}): NearAction => ({
  type: 'functionCall',
  methodName,
  args: typeof args === 'string' ? utf8(args) : Uint8Array.from(args),
  gas: over.gas ?? 10n * TGAS,
  deposit: over.deposit ?? 0n,
});
const collect = (args: Record<string, unknown> | string, over?: { gas?: bigint; deposit?: bigint }) => fn('collect', typeof args === 'string' ? args : JSON.stringify(args), over);
const addMessage = (args: Record<string, unknown> | string, over?: { gas?: bigint; deposit?: bigint }) => fn('add_message', typeof args === 'string' ? args : JSON.stringify(args), over);

type Req = { actions: NearAction[]; receiver?: string; relayed?: boolean; network?: 'testnet' | 'mainnet'; sender?: string };
const decoded = (r: Req) => {
  const receiverId = r.receiver ?? STAMPS;
  const senderId = r.sender ?? ME;
  const context = { nearNetwork: r.network ?? 'testnet' };
  return r.relayed === false
    ? decodeApprovalRequest({ kind: 'near_tx', chain: 'near', address: senderId, context, bytes: encodeNearTransaction({ signerId: senderId, publicKey: KEY, nonce: 3n, receiverId, blockHash: sha256(utf8('b')), actions: r.actions }) })
    : decodeApprovalRequest({ kind: 'near_delegate', chain: 'near', address: senderId, context, bytes: encodeNearDelegateAction({ senderId, receiverId, actions: r.actions, nonce: 7n, maxBlockHeight: 9n, publicKey: KEY }) });
};

/** Every summary built here is checked for jargon, an unallowed zero-cost claim and the catch-all. */
const hits: string[] = [];
afterAll(() => expect(hits).toEqual([]));
const summarize = (d: ReturnType<typeof decoded>, accounts: ReviewedNearAccounts | undefined, address = ME): ApprovalSummary => {
  const s = summarizeApproval(d, { address, ...(accounts ? { reviewedNear: accounts } : {}) });
  if (s === UNEXPLAINED_SUMMARY) hits.push(`fallback ${d.kind}`);
  hits.push(...jargonIn(s), ...zeroCostIn(s));
  return s;
};
const reviewed = (r: Req) => summarize(decoded(r), ACCOUNTS);
/** The summary the same request gets with no entries at all: today's screen. */
const today = (r: Req) => summarize(decoded(r), undefined);

const nonce = base64Encode(new Uint8Array(32).fill(1));
const signature = base64Encode(new Uint8Array(64).fill(2));
const proof = (over: Record<string, unknown> = {}) => ({ message: `${STAMP_SIGN_MESSAGE_PREFIX}${ME}`, nonce, recipient: STAMPS, signature, ...over });
const message = (over: { message?: string; recipient?: string; callbackUrl?: string | null } = {}) =>
  decodeApprovalRequest({ kind: 'near_message', chain: 'near', address: ME, context: {}, bytes: encodeNep413Message({ message: over.message ?? `${STAMP_SIGN_MESSAGE_PREFIX}${ME}`, nonce: new Uint8Array(32).fill(3), recipient: over.recipient ?? STAMPS, callbackUrl: over.callbackUrl ?? null }) });

describe('the reviewed source: an entry cannot outlive its review', () => {
  const source = (c: ReviewedNearContract) => readFileSync(new URL(`../../../${REVIEWED_NEAR_CONTRACTS[c].source}`, import.meta.url), 'utf8').replace(/\r\n/gu, '\n');

  it('each contract’s whole src/lib.rs is the file a person reviewed (re-review, then update the hash and D885)', () => {
    for (const c of Object.keys(REVIEWED_NEAR_CONTRACTS) as ReviewedNearContract[]) {
      expect(createHash('sha256').update(source(c)).digest('hex'), `${REVIEWED_NEAR_CONTRACTS[c].source} changed since its review`).toBe(REVIEWED_NEAR_CONTRACTS[c].sourceSha256);
    }
  });

  it('the lines the readings rest on, verbatim', () => {
    const stamps = source('stamps');
    for (const l of [
      'pub const CATALOG: [&str; 6] = ["arrival", "sponsored", "own_fare", "signature", "postcard", "layover"];',
      `pub const MAX_NOTE_CHARS: usize = ${STAMP_NOTE_MAX_CHARS};`,
      `pub const SIGN_MESSAGE_PREFIX: &str = "${STAMP_SIGN_MESSAGE_PREFIX}";`,
      // Not payable (no #[payable] anywhere: near-sdk refuses a deposit), and the one method the window reads.
      'pub fn collect(&mut self, stamp: String, note: Option<String>, proof: Option<SignatureProof>) -> StampView {',
      'require!(note.is_none() || id == Stamp::Postcard, ERR_BAD_NOTE);',
      'require!(proof.is_none() || id == Stamp::Signature, ERR_BAD_PROOF);',
      'require!(id != Stamp::Sponsored || sponsored, ERR_NOT_SPONSORED);',
      'require!(id != Stamp::OwnFare || !sponsored, ERR_NOT_OWN_FARE);',
      // A stamp is only ever added to the caller's own passport, never removed or changed.
      'require!(stamps.iter().all(|s| s.stamp != id), ERR_ALREADY);',
      'self.passports.insert(caller.clone(), stamps);',
      'let text = note.as_deref().unwrap_or("").trim();',
    ])
      expect(stamps, l).toContain(l);
    const book = source('guestbook');
    for (const l of [
      `pub const MAX_TEXT_CHARS: usize = ${GUESTBOOK_TEXT_MAX_CHARS};`,
      'pub fn add_message(&mut self, text: String) -> Message {',
      'let text = text.trim();',
      'let stored = StoredMessage { account_id: env::predecessor_account_id(), text: text.to_string(), block_timestamp_ms: env::block_timestamp_ms() };',
    ])
      expect(book, l).toContain(l);
    // Neither moves anything or can change its own code: no payable method, no promise, no transfer, no deploy.
    for (const [name, src] of [['stamps', stamps], ['guestbook', book]] as const) {
      for (const bad of ['#[payable]', 'Promise', '.transfer(', 'deploy_contract', 'delete_account', 'ext_contract', 'promise_', 'storage_remove', '.remove(']) expect(src.includes(bad), `${name}: ${bad}`).toBe(false);
    }
  });

  it('the stamps carry the titles the stamps site gives their slots', () => {
    const labels = readFileSync(new URL('../../../apps/stamps/src/ui/labels.ts', import.meta.url), 'utf8');
    for (const [id, title] of Object.entries(REVIEWED_STAMP_TITLES)) expect(labels, id).toContain(`${id}: { title: '${title}',`);
  });

  it('deployment records: only named envs, never a mainnet one, each a locked deploy of a listed contract', () => {
    for (const [env, record] of Object.entries(REVIEWED_NEAR_DEPLOYS)) {
      expect(env).not.toMatch(/main|prod|live/iu);
      for (const [c, d] of Object.entries(record)) {
        expect(Object.keys(REVIEWED_NEAR_CONTRACTS)).toContain(c);
        expect(d.codeHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/u);
        expect(d.lockTx).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/u);
        expect(d.locked).toMatch(/^2026-\d\d-\d\d$/u);
      }
    }
    expect(Object.keys(REVIEWED_NEAR_DEPLOYS)).toEqual(['sandbox-dev']);
  });
});

describe('each entry: the exact match and its plain reading', () => {
  const lines = (s: ApprovalSummary) => s.lines.map(text);
  const uses = (c: ReviewedNearContract, account: string, verb = 'It uses') => `${verb} ${REVIEWED_NEAR_CONTRACTS[c].name} (${account}, checked by Journear).`;

  it('the stamps relayed with no other argument: Arrival, Fare paid, Layover', () => {
    for (const stamp of ['arrival', 'sponsored', 'layover'] as const) {
      const r: Req = { actions: [collect({ stamp })] };
      expect(reviewedNearCall({ network: 'testnet', sender: ME, receiver: STAMPS, actions: r.actions, relayed: true }, ACCOUNTS)).toEqual({ contract: 'stamps', account: STAMPS, kind: 'collect', stamp });
      const s = reviewed(r);
      expect(text(s.headline)).toBe(`${APP} wants to collect the ${REVIEWED_STAMP_TITLES[stamp]} stamp for you`);
      expect(lines(s)).toEqual(['Collecting a stamp doesn’t move any money or tokens.', uses('stamps', STAMPS)]);
      // The amber acts-as-you line goes; the fee row, the network and the total rows are the generic summary's.
      const old = today(r);
      expect(old.warnings.map((w) => w.code)).toEqual(['acts_as_you']);
      expect(s.warnings).toEqual([]);
      expect({ fee: s.fee, freeFee: s.freeFee, network: s.network, noNearLeaves: s.noNearLeaves, explainable: s.explainable }).toEqual({ fee: old.fee, freeFee: old.freeFee, network: old.network, noNearLeaves: old.noNearLeaves, explainable: true });
      expect(s.reviewed).toBe(true);
      expect(s.shownSteps).toEqual([0]);
    }
  });

  it('Postcard: the note as the user’s quoted words, said to be public', () => {
    const note = 'Hello from Kuala Lumpur 👋';
    const s = reviewed({ actions: [collect({ stamp: 'postcard', note })] });
    expect(text(s.headline)).toBe(`${APP} wants to collect the Postcard stamp for you`);
    expect(s.lines[0]).toEqual(['Your note: ', { kind: 'quote', text: note }]);
    expect(lines(s)).toEqual([`Your note: ${note}`, 'Anyone can see your note, and you can’t delete it.', 'Collecting a stamp doesn’t move any money or tokens.', uses('stamps', STAMPS)]);
    // Right-to-left and long text is kept whole, as stored (the page isolates its direction).
    const rtl = 'مرحبا من هنا';
    expect(reviewed({ actions: [collect({ stamp: 'postcard', note: rtl })] }).lines[0]).toEqual(['Your note: ', { kind: 'quote', text: rtl }]);
    expect(reviewed({ actions: [collect({ stamp: 'postcard', note: '😀'.repeat(STAMP_NOTE_MAX_CHARS) })] }).reviewed).toBe(true);
  });

  it('Signature, step 2: the relayed collect with the proof the user signed for this contract and account', () => {
    const s = reviewed({ actions: [collect({ stamp: 'signature', proof: proof() })] });
    expect(text(s.headline)).toBe(`${APP} wants to collect the Signature stamp for you`);
    expect(lines(s)).toEqual(['It includes the message you signed for this stamp.', 'Collecting a stamp doesn’t move any money or tokens.', uses('stamps', STAMPS)]);
  });

  it('Signature, step 1: the NEP-413 message, exactly the stamp’s for the user’s own account', () => {
    const s = summarizeApproval(message(), { address: ME, reviewedNear: ACCOUNTS });
    hits.push(...jargonIn(s), ...zeroCostIn(s));
    expect(text(s.headline)).toBe(`${APP} wants you to sign a message for your Signature stamp`);
    expect(lines(s)).toEqual(['Signing it doesn’t move any money or tokens. The stamp uses it to check that this account is yours.', uses('stamps', STAMPS, 'It’s for')]);
    expect(s.reviewed).toBe(true);
    expect(s.warnings).toEqual([]);
    expect(s.fee).toBeNull();
  });

  it('Own fare: the user’s own transaction (its fee is theirs: the stamp itself moves nothing)', () => {
    const r: Req = { actions: [collect({ stamp: 'own_fare' })], relayed: false };
    const s = reviewed(r);
    expect(text(s.headline)).toBe(`${APP} wants to collect the Own fare stamp for you`);
    expect(lines(s)).toEqual(['The stamp itself doesn’t move any money or tokens.', uses('stamps', STAMPS)]);
    const old = today(r);
    // The fee row stays the user's own ("A small amount of NEAR, from your account"): the reading never hides it.
    expect(s.fee).toEqual(old.fee);
    expect(s.freeFee).toBeUndefined();
    expect(s.noNearLeaves).toBeUndefined();
    expect(old.warnings).toEqual([]);
  });

  it('the guestbook, relayed and the user’s own transaction', () => {
    const msg = 'gm from the demo';
    const relayed = reviewed({ actions: [addMessage({ text: msg })], receiver: BOOK });
    expect(text(relayed.headline)).toBe(`${APP} wants to add your message to the demo guestbook`);
    expect(lines(relayed)).toEqual([`Your message: ${msg}`, 'Anyone can see it, and you can’t delete it.', 'Adding it doesn’t move any money or tokens.', uses('guestbook', BOOK)]);
    expect(relayed.lines[0]).toEqual(['Your message: ', { kind: 'quote', text: msg }]);
    expect(relayed.warnings).toEqual([]);
    const direct = reviewed({ actions: [addMessage({ text: msg })], receiver: BOOK, relayed: false });
    expect(lines(direct)).toEqual([`Your message: ${msg}`, 'Anyone can see it, and you can’t delete it.', 'The message itself doesn’t move any money or tokens.', uses('guestbook', BOOK)]);
    expect(direct.fee).toEqual(today({ actions: [addMessage({ text: msg })], receiver: BOOK, relayed: false }).fee);
    expect(reviewed({ actions: [addMessage({ text: 'x'.repeat(GUESTBOOK_TEXT_MAX_CHARS) })], receiver: BOOK }).reviewed).toBe(true);
  });

  it('per contract, not per app: any app making the exact call gets the same reading under its own name', () => {
    const d = decoded({ actions: [collect({ stamp: 'arrival' })] });
    const s = summarizeApproval(d, { address: ME, reviewedNear: ACCOUNTS });
    expect(s.headline[0]).toEqual({ kind: 'app' });
    expect(summaryString(s.headline, 'Some Other App')).toBe('Some Other App wants to collect the Arrival stamp for you');
  });
});

describe('near-misses: exactly today’s summary', () => {
  const same = (r: Req, why: string) => {
    const s = reviewed(r);
    expect(s.reviewed, why).toBeUndefined();
    expect(s, why).toEqual(today(r));
  };
  const ok = { stamp: 'arrival' };

  it('no entries in the build, or the other contract’s account', () => {
    expect(summarize(decoded({ actions: [collect(ok)] }), {})).toEqual(today({ actions: [collect(ok)] }));
    expect(summarize(decoded({ actions: [collect(ok)] }), { guestbook: BOOK })).toEqual(today({ actions: [collect(ok)] }));
    same({ actions: [collect(ok)], receiver: BOOK }, 'collect on the guestbook');
    same({ actions: [addMessage({ text: 'hi' })], receiver: STAMPS }, 'add_message on the stamps');
    // Two contracts named the same account (the schema refuses it): neither.
    expect(reviewedNearCall({ network: 'testnet', sender: ME, receiver: STAMPS, actions: [collect(ok)], relayed: true }, { stamps: STAMPS, guestbook: STAMPS })).toBeNull();
  });

  it('the wrong network, a different or look-alike account, the user’s own account', () => {
    same({ actions: [collect(ok)], network: 'mainnet' }, 'mainnet');
    for (const receiver of ['stamps-reviewed.testnet.evil.testnet', 'xstamps-reviewed.testnet', 'stamps-reviewed1.testnet', 'stamps-reveiwed.testnet', 'evil.stamps-reviewed.testnet', 'stamps.testnet']) same({ actions: [collect(ok)], receiver }, receiver);
    expect(reviewedNearCall({ network: 'testnet', sender: STAMPS, receiver: STAMPS, actions: [collect(ok)], relayed: true }, ACCOUNTS)).toBeNull();
  });

  it('a different method, a deposit, too much gas, an extra action or a batch with the reviewed call', () => {
    same({ actions: [fn('collect_all', '{"stamp":"arrival"}')] }, 'another method');
    same({ actions: [fn('Collect', '{"stamp":"arrival"}')] }, 'case');
    same({ actions: [collect(ok, { deposit: 1n })] }, 'one yocto');
    same({ actions: [collect(ok, { deposit: 10n ** 24n })] }, 'one NEAR');
    same({ actions: [collect(ok, { gas: REVIEWED_NEAR_MAX_GAS + 1n })] }, 'gas over the bound');
    expect(reviewed({ actions: [collect(ok, { gas: REVIEWED_NEAR_MAX_GAS })] }).reviewed).toBe(true);
    same({ actions: [collect(ok), collect(ok)] }, 'twice');
    same({ actions: [collect(ok), { type: 'transfer', deposit: 1n }] }, 'with a transfer');
    same({ actions: [collect(ok), fn('ft_transfer', '{"receiver_id":"bob.testnet","amount":"5"}', { deposit: 1n })] }, 'with a token transfer');
    same({ actions: [addMessage({ text: 'hi' }), addMessage({ text: 'again' })], receiver: BOOK }, 'two messages');
  });

  it('arguments outside the reviewed shape', () => {
    for (const args of [
      '{"stamp":"arrival","note":"x"}',
      '{"stamp":"arrival","extra":1}',
      '{"stamp":"arrival","stamp":"arrival"}',
      '{"stamp":"Arrival"}',
      '{"stamp":"passport"}',
      '{"stamp":["arrival"]}',
      '{}',
      '[]',
      '"arrival"',
      '﻿{"stamp":"arrival"}',
      '{"stamp":"postcard"}',
      '{"stamp":"postcard","note":""}',
      '{"stamp":"postcard","note":" padded "}',
      '{"stamp":"postcard","note":"line\\nbreak"}',
      '{"stamp":"postcard","note":"rtl\\u202eoverride"}',
      '{"stamp":"postcard","note":"zero\\u200bwidth"}',
      '{"stamp":"postcard","note":null}',
      '{"stamp":"postcard","note":"x","proof":null}',
      `{"stamp":"postcard","note":"${'a'.repeat(STAMP_NOTE_MAX_CHARS + 1)}"}`,
      '{"stamp":"signature"}',
    ])
      same({ actions: [collect(args)] }, args);
    same({ actions: [fn('collect', Uint8Array.of(0xff, 0x7b))] }, 'not UTF-8');
    for (const p of [proof({ message: `${STAMP_SIGN_MESSAGE_PREFIX}someone.testnet` }), proof({ recipient: BOOK }), proof({ nonce: 'AAAA' }), proof({ signature: base64Encode(new Uint8Array(63)) }), proof({ extra: 'x' }), { message: proof().message, nonce, recipient: STAMPS }])
      same({ actions: [collect({ stamp: 'signature', proof: p })] }, JSON.stringify(p));
    for (const args of ['{"text":""}', '{"text":" hi"}', '{"text":"hi","extra":true}', '{"message":"hi"}', '{"text":7}', `{"text":"${'a'.repeat(GUESTBOOK_TEXT_MAX_CHARS + 1)}"}`, '{"text":"bell\\u0007"}'])
      same({ actions: [addMessage(args)], receiver: BOOK }, args);
  });

  it('relayed or direct as the site sends it: Own fare only direct, every other stamp only relayed', () => {
    same({ actions: [collect({ stamp: 'own_fare' })] }, 'own fare relayed');
    for (const stamp of ['arrival', 'sponsored', 'layover'] as ReviewedStampId[]) same({ actions: [collect({ stamp })], relayed: false }, `${stamp} direct`);
    same({ actions: [collect({ stamp: 'postcard', note: 'hi' })], relayed: false }, 'postcard direct');
    same({ actions: [collect({ stamp: 'signature', proof: proof() })], relayed: false }, 'signature direct');
  });

  it('the signature message: any other text, recipient, account or a callback URL', () => {
    const plain = (d: ReturnType<typeof message>, address = ME) => {
      const s = summarizeApproval(d, { address, reviewedNear: ACCOUNTS });
      expect(s.reviewed).toBeUndefined();
      expect(s).toEqual(summarizeApproval(d, { address }));
    };
    plain(message({ message: `${STAMP_SIGN_MESSAGE_PREFIX}someone-else.testnet` }));
    plain(message({ message: `Stamp my passport:  ${ME}` }));
    plain(message({ message: `${STAMP_SIGN_MESSAGE_PREFIX}${ME} ` }));
    plain(message({ recipient: BOOK }));
    plain(message({ recipient: 'stamps-reviewed.testnet.example' }));
    plain(message({ callbackUrl: 'https://stamps.example/back' }));
    plain(message(), nearImplicitAccountId(new Uint8Array(32).fill(5)));
    expect(reviewedNearMessage({ message: STAMP_SIGN_MESSAGE_PREFIX, recipient: STAMPS, callbackUrl: null }, '', ACCOUNTS)).toBeNull();
  });
});
