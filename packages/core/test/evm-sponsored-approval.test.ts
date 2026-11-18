// The sponsored EVM action's approval (D831, D839, D850): its kind and digest (approval.ts), its port method, status
// field and window message (protocol.ts), the popup's own decode of the subject bytes (decode/evm-sponsored.ts), and its
// summary (decode/summary.ts): every call summarised and warned about exactly as the same call in an ordinary EVM
// transaction, plus the fee line and, only when the authorization is signed, the one-time setup note. Hostile subject
// bytes included.
import { afterAll, describe, expect, it } from 'vitest';
import {
  APPROVAL_KINDS,
  NEVER_AUTO_APPROVED_KINDS,
  type ApprovalSubject,
  approvalDigest,
  approvalKindChain,
  approvalKindContext,
  validateApprovalSubject,
} from '../src/approval.ts';
import { toHex } from '../src/bytes.ts';
import {
  type ApprovalSummary,
  DecodeError,
  type DecodedApproval,
  SPONSORED_FEE,
  type SummaryText,
  UNEXPLAINED_SUMMARY,
  decodeApprovalRequest,
  evmTxSigningPayload,
  parseEvmTxRequest,
  summarizeApproval as summarizeApprovalRaw,
  summaryString,
} from './entries.ts';
import { EVM_SPONSOR_MAX_CALLS, EVM_SPONSOR_MAX_CALL_DATA_BYTES } from '../src/evm-sponsor/execute.ts';
import { decodeSponsorSubject, encodeSponsorSubject, sponsoredApprovalContent } from '../src/evm-sponsor/subject.ts';
import { rlpEncode } from '../src/signers/evm.ts';
import { mainnetOfRequest } from '../src/networks.ts';
import {
  APPROVAL_KIND,
  APPROVAL_POPUP_METHODS,
  EVM_SPONSOR_SDK_MIN,
  NEAR_SDK_MIN,
  PORT_METHODS,
  type PortRequest,
  SIGN_METHODS,
  SPONSORED_CHAINS_MAX,
  SPONSORED_MAX_CALLS,
  SPONSORED_MAX_CALL_DATA_BYTES,
  approvalChain,
  newRequestId,
  parsePortEvent,
  parsePortReply,
  parsePortRequest,
  parseWindowMessage,
} from '../src/protocol.ts';
import { matchAutoApprovePolicy, validateAutoApprovePolicy } from '../src/policy/index.ts';
import { CHAIN as POLICY_CHAIN, EVM_PERMIT2, EVM_USDC, EVM_USER, EVM_VAULT, policyJson } from './policy-fixtures.ts';
import { EXECUTE_TYPES } from '../src/evm-sponsor/execute.ts';
import {
  CHECK_IN,
  CHECK_IN_DATA,
  RECIPIENT,
  SPENDER,
  SPONSOR_CHAIN,
  SPONSOR_CHAINS,
  SPONSOR_DELEGATE,
  SPONSOR_ME,
  SPONSOR_NOW_MS,
  SPONSOR_RELAYER,
  TOKEN,
  UINT256_MAX,
  calldata,
  sponsorSubject,
  sponsoredApproval,
  sponsoredCall,
} from './evm-sponsored-fixture.ts';

const APP = 'Partner App';
const fallbackHits: string[] = [];
const summarizeApproval: typeof summarizeApprovalRaw = (d, ctx) => {
  const s = summarizeApprovalRaw(d, ctx);
  if (s === UNEXPLAINED_SUMMARY) fallbackHits.push(d.kind);
  return s;
};
afterAll(() => {
  // A valid request never gets the catch-all summary (review 3).
  expect(fallbackHits).toEqual([]);
});
const text = (t: SummaryText): string => summaryString(t, APP);
const warnings = (s: ApprovalSummary) => s.warnings.map((w) => [w.level, w.code, text(w.text)] as const);

const decode = (s: ApprovalSubject = sponsoredApproval(), chains: typeof SPONSOR_CHAINS | 'none' = SPONSOR_CHAINS) => decodeApprovalRequest(s, chains === 'none' ? { nowMs: SPONSOR_NOW_MS } : { sponsorChains: chains, nowMs: SPONSOR_NOW_MS });
const sponsored = (calls: ReturnType<typeof sponsoredCall>[], over: Parameters<typeof sponsorSubject>[0] = {}) => summarizeApproval(decode(sponsoredApproval(sponsorSubject({ calls, ...over }))), { address: SPONSOR_ME });

/** The same call as an ordinary EIP-1559 transaction on the same chain (value 0). */
function plain(to: string, data: string): ApprovalSummary {
  const tx = parseEvmTxRequest({ chainId: `0x${SPONSOR_CHAIN.toString(16)}`, nonce: '0x1', gas: '0x5208', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', to, value: '0x0', data });
  return summarizeApproval(decodeApprovalRequest({ kind: 'evm_tx', chain: 'evm', address: SPONSOR_ME, context: { chainId: SPONSOR_CHAIN }, bytes: evmTxSigningPayload(tx) }), { address: SPONSOR_ME });
}

const SETUP = 'One-time setup: this also turns on free network fees for your account on the local test chain 31337. Your address stays the same and you still approve every action.';
/** A contract Journear doesn't know, called with the check-in's selector (the pinned check-in reads plainly, D854). */
const UNKNOWN = '0x4444444444444444444444444444444444444444' as const;
const TRANSFER = calldata('transfer(address,uint256)', RECIPIENT, 5_000_000n);
const APPROVE_MAX = calldata('approve(address,uint256)', SPENDER, UINT256_MAX);

// ---- the kind and its digest ----

describe('the evm_sponsored approval kind (approval.ts)', () => {
  it('is an EVM kind with a chain ID context, never auto-approved (D839)', () => {
    expect(APPROVAL_KINDS).toContain('evm_sponsored');
    expect(approvalKindChain('evm_sponsored')).toBe('evm');
    expect(approvalKindContext('evm_sponsored')).toBe('chainId');
    expect(NEVER_AUTO_APPROVED_KINDS.has('evm_sponsored')).toBe(true);
    expect(() => validateApprovalSubject(sponsoredApproval())).not.toThrow();
  });

  it('refuses a subject without bytes, without its chain ID, or on another chain', () => {
    const s = sponsoredApproval();
    expect(() => validateApprovalSubject({ ...s, bytes: new Uint8Array(0) })).toThrow(/subject bytes/u);
    expect(() => validateApprovalSubject({ ...s, context: {} })).toThrow(/chainId/u);
    expect(() => validateApprovalSubject({ ...s, chain: 'stellar' })).toThrow(/not on stellar/u);
  });

  it('the approval digest binds every field of the subject, the authorization nonce included ([] and [0] differ)', () => {
    const digest = (over: Parameters<typeof sponsorSubject>[0]) => toHex(approvalDigest({ ...sponsoredApproval(sponsorSubject(over)), id: 'a'.repeat(32), parentOrigin: 'https://partner.example' }));
    const base = digest({});
    const variants: Parameters<typeof sponsorSubject>[0][] = [
      { authNonce: 0n },
      { authNonce: 1n },
      { executeNonce: 1n },
      { deadline: 1_900_000_001n },
      { minGas: 100_001n },
      { relayer: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' },
      { calls: [sponsoredCall(CHECK_IN, '0x183ff08500')] },
      { calls: [sponsoredCall(TOKEN, CHECK_IN_DATA)] },
      { calls: [sponsoredCall(CHECK_IN, CHECK_IN_DATA), sponsoredCall(CHECK_IN, CHECK_IN_DATA)] },
    ];
    const all = variants.map(digest);
    expect(new Set([base, ...all]).size).toBe(variants.length + 1);
    expect(digest({ authNonce: 0n })).not.toBe(digest({ authNonce: null }));
  });

  it('the auto-approve matcher never covers it', () => {
    const policy = validateAutoApprovePolicy(policyJson());
    if (!policy.ok) throw new Error('policy');
    expect(matchAutoApprovePolicy(policy.policy, sponsoredApproval(), { usage: null, nowMs: Date.UTC(2026, 10, 17) })).toMatchObject({ ok: false, reason: 'never_covered' });
  });

  it('sponsoredApprovalContent is the subject’s bytes and its chain', () => {
    const s = sponsorSubject({ authNonce: 3n });
    const c = sponsoredApprovalContent(s);
    expect(toHex(c.bytes)).toBe(toHex(encodeSponsorSubject(s)));
    expect(c.context).toEqual({ chainId: SPONSOR_CHAIN });
  });
});

// ---- the protocol ----

const CALL = { to: CHECK_IN, value: '0x0', data: CHECK_IN_DATA };
const req = (params: unknown, extra: Record<string, unknown> = {}) => parsePortRequest({ v: 1, id: 'r1', method: 'evm_sendSponsored', params, ...extra });

describe('evm_sendSponsored (protocol.ts)', () => {
  it('is a port and sign method whose approval kind is evm_sponsored, and may carry popupOpened', () => {
    expect(PORT_METHODS).toContain('evm_sendSponsored');
    expect(SIGN_METHODS).toContain('evm_sendSponsored');
    expect(APPROVAL_POPUP_METHODS).toContain('evm_sendSponsored');
    expect(APPROVAL_KIND.evm_sendSponsored).toBe('evm_sponsored');
    const r = req({ chainId: 84532, calls: [CALL] }, { popupOpened: true });
    expect(r).toEqual({ v: 1, id: 'r1', method: 'evm_sendSponsored', params: { chainId: 84532, calls: [CALL] }, popupOpened: true });
    expect(approvalChain(r as Extract<PortRequest, { method: 'evm_sendSponsored' }>)).toBe('evm');
  });

  it('takes 1 to 8 calls of value 0x0 with a function, and nothing else', () => {
    const many = Array.from({ length: SPONSORED_MAX_CALLS }, () => ({ ...CALL }));
    expect(req({ chainId: 84532, calls: many })).not.toBeNull();
    expect(req({ chainId: 84532, calls: `0x${'ab'.repeat(SPONSORED_MAX_CALL_DATA_BYTES)}` })).toBeNull();
    expect(req({ chainId: 84532, calls: [{ ...CALL, data: `0x${'ab'.repeat(SPONSORED_MAX_CALL_DATA_BYTES)}` }] })).not.toBeNull();
    const bad: unknown[] = [
      undefined,
      [],
      { chainId: 84532 },
      { chainId: 84532, calls: [] },
      { chainId: 84532, calls: [...many, { ...CALL }] },
      { chainId: 0, calls: [CALL] },
      { chainId: '84532', calls: [CALL] },
      { chainId: 2 ** 53, calls: [CALL] },
      { chainId: 84532, calls: [CALL], from: SPONSOR_ME },
      { chainId: 84532, calls: [{ ...CALL, value: '0x1' }] },
      { chainId: 84532, calls: [{ ...CALL, value: '0x00' }] },
      { chainId: 84532, calls: [{ ...CALL, value: 0 }] },
      { chainId: 84532, calls: [{ ...CALL, data: '0x' }] },
      { chainId: 84532, calls: [{ ...CALL, data: '0x183ff0' }] },
      { chainId: 84532, calls: [{ ...CALL, data: '0x183ff085a' }] },
      { chainId: 84532, calls: [{ ...CALL, data: `0x${'ab'.repeat(SPONSORED_MAX_CALL_DATA_BYTES + 1)}` }] },
      { chainId: 84532, calls: [{ ...CALL, to: '0x1234' }] },
      { chainId: 84532, calls: [{ ...CALL, gas: '0x1' }] },
      { chainId: 84532, calls: [{ to: CHECK_IN, data: CHECK_IN_DATA }] },
    ];
    for (const p of bad) expect(req(p), JSON.stringify(p ?? null)).toBeNull();
  });

  it('keeps its limits equal to the signing core’s (the root entry doesn’t import that module)', () => {
    expect(SPONSORED_MAX_CALLS).toBe(EVM_SPONSOR_MAX_CALLS);
    expect(SPONSORED_MAX_CALL_DATA_BYTES).toBe(EVM_SPONSOR_MAX_CALL_DATA_BYTES);
  });

  it('answers { transactionHash, status: executed } and nothing else', () => {
    const hash = `0x${'ab'.repeat(32)}`;
    const reply = (result: unknown) => parsePortReply({ v: 1, id: 'r1', result }, 'evm_sendSponsored');
    expect(reply({ transactionHash: hash, status: 'executed' })).not.toBeNull();
    for (const r of [{ transactionHash: hash }, { transactionHash: hash, status: 'pending' }, { transactionHash: `0x${'ab'.repeat(31)}`, status: 'executed' }, { transactionHash: hash, status: 'executed', signature: '0x' }, hash]) {
      expect(reply(r)).toBeNull();
    }
  });

  it('a mainnet chain is named for a test app’s refusal; a test chain isn’t', () => {
    const r = (chainId: number) => req({ chainId, calls: [CALL] }) as Extract<PortRequest, { method: 'evm_sendSponsored' }>;
    expect(mainnetOfRequest(r(84532))).toBeNull();
    expect(mainnetOfRequest(r(8453))).toEqual({ chain: 'evm', chainId: 8453 });
  });

  it('status and ready may carry sponsoredChains: 1 to 4 ascending distinct chain IDs, from SDK 0.5.0', () => {
    expect(EVM_SPONSOR_SDK_MIN > NEAR_SDK_MIN).toBe(true);
    const status = (sponsoredChains: unknown) => parsePortReply({ v: 1, id: 'r1', result: { status: 'logged_out', persistence: 'session', sponsoredChains } }, 'hana_status');
    expect(status([84532])).not.toBeNull();
    expect(status([31337, 84532])).not.toBeNull();
    for (const bad of [[], [84532, 31337], [84532, 84532], [0], ['84532'], [1, 2, 3, 4, 5].slice(0, SPONSORED_CHAINS_MAX + 1), null]) expect(status(bad), JSON.stringify(bad)).toBeNull();
    expect(parsePortEvent({ v: 1, event: 'ready', data: { status: 'logged_out', persistence: 'session', sponsoredChains: [84532] } })).not.toBeNull();
    expect(parsePortReply({ v: 1, id: 'r1', result: { status: 'logged_out', persistence: 'session' } }, 'hana_status')).not.toBeNull();
  });

  it('the approve-request window message carries the subject bytes as `bytes`, with no new field', () => {
    const s = sponsoredApproval(sponsorSubject({ authNonce: 0n }));
    const msg = { v: 1, t: 'hana:approve-request', id: newRequestId(), appName: 'Partner', parentOrigin: 'https://partner.example', ...s, position: 1, queued: 1 };
    expect(parseWindowMessage(msg, ['hana:approve-request'])).not.toBeNull();
    expect(parseWindowMessage({ ...msg, subject: s.bytes }, ['hana:approve-request'])).toBeNull();
    expect(parseWindowMessage({ ...msg, context: {} }, ['hana:approve-request'])).toBeNull();
    expect(parseWindowMessage({ ...msg, bytes: new Uint8Array(0) }, ['hana:approve-request'])).toBeNull();
  });
});

// ---- the popup's decode ----

const decodeError = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof DecodeError) return e.code;
    throw e;
  }
  return 'decoded';
};

describe('decoding a sponsored action (decode/evm-sponsored.ts)', () => {
  it('reads the subject and decodes each call as an EVM transaction’s call', () => {
    const d = decode(sponsoredApproval(sponsorSubject({ authNonce: 0n, calls: [sponsoredCall(TOKEN, TRANSFER), sponsoredCall(CHECK_IN, CHECK_IN_DATA)] })));
    expect(d).toMatchObject({ kind: 'evm_sponsored', chainId: SPONSOR_CHAIN, setup: true, helperVersion: 1 });
    const a = d as Extract<DecodedApproval, { kind: 'evm_sponsored' }>;
    expect(a.subject).toMatchObject({ account: SPONSOR_ME, delegate: SPONSOR_DELEGATE, relayer: SPONSOR_RELAYER, authNonce: 0n });
    expect(a.calls[0]).toMatchObject({ to: TOKEN, value: 0n, selector: '0xa9059cbb', call: { signature: 'transfer(address,uint256)' } });
    expect(a.calls[1]).toMatchObject({ to: CHECK_IN, selector: CHECK_IN_DATA, call: null });
    expect((decode() as Extract<DecodedApproval, { kind: 'evm_sponsored' }>).setup).toBe(false);
  });

  it('refuses (no Approve) when this build doesn’t sponsor the chain, or names another delegate or relayer', () => {
    expect(decodeError(() => decode(sponsoredApproval(), 'none'))).toBe('unsupported');
    expect(decodeError(() => decode(sponsoredApproval(), {}))).toBe('unsupported');
    // A build entry for a chain with no pinned delegate (Base Sepolia, until the delegate is deployed and pinned).
    const s84532 = sponsoredApproval(sponsorSubject({ chainId: 84532 }));
    expect(decodeError(() => decode(s84532, { 84532: { delegate: SPONSOR_DELEGATE, relayer: SPONSOR_RELAYER } } as never))).toBe('unsupported');
    // The vault names a delegate that isn't the pinned one: refused even when the build says the same.
    const other = '0x7702000000000000000000000000000000007702';
    expect(decodeError(() => decode(sponsoredApproval(sponsorSubject({ delegate: other })), { [SPONSOR_CHAIN]: { delegate: other, relayer: SPONSOR_RELAYER } } as never))).toBe('invalid_value');
    expect(decodeError(() => decode(sponsoredApproval(sponsorSubject({ delegate: other }))))).toBe('invalid_value');
    // The build's delegate differs from the pinned one (a build the generators would refuse).
    expect(decodeError(() => decode(sponsoredApproval(), { [SPONSOR_CHAIN]: { delegate: other, relayer: SPONSOR_RELAYER } } as never))).toBe('invalid_value');
    expect(decodeError(() => decode(sponsoredApproval(sponsorSubject({ relayer: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' }))))).toBe('invalid_value');
    expect(decodeError(() => decode(sponsoredApproval(), { [SPONSOR_CHAIN]: { delegate: SPONSOR_DELEGATE } } as never))).toBe('unsupported');
  });

  it('refuses another account, another chain than the context, and a call that names no function', () => {
    expect(decodeError(() => decode(sponsoredApproval(sponsorSubject(), '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23')))).toBe('invalid_value');
    expect(decodeError(() => decode({ ...sponsoredApproval(), context: { chainId: 84532 } }))).toBe('network_mismatch');
    expect(decodeError(() => decode(sponsoredApproval(sponsorSubject({ calls: [sponsoredCall(CHECK_IN, '0x183ff0')] }))))).toBe('unsupported');
    expect(decodeError(() => decode(sponsoredApproval(sponsorSubject({ calls: [sponsoredCall(CHECK_IN, '0x')] }))))).toBe('unsupported');
    // The address in any case is the user's (EVM addresses compare case-insensitively).
    expect(decodeError(() => decode(sponsoredApproval(sponsorSubject(), SPONSOR_ME.toLowerCase())))).toBe('decoded');
  });

  it('refuses hostile subject bytes: value, forbidden targets, too many calls, another prefix, trailing bytes', () => {
    const prefix = new TextEncoder().encode('hana-id/evm-sponsored/v1');
    const addr = (h: string) => Uint8Array.from(Buffer.from(h.slice(2), 'hex'));
    const big = (n: bigint) => (n === 0n ? new Uint8Array(0) : Uint8Array.from(Buffer.from(n.toString(16).padStart(n.toString(16).length + (n.toString(16).length % 2), '0'), 'hex')));
    const raw = (calls: Uint8Array[][], over: { auth?: Uint8Array[]; account?: string } = {}) => {
      const body = rlpEncode([big(BigInt(SPONSOR_CHAIN)), addr(over.account ?? SPONSOR_ME), addr(SPONSOR_DELEGATE), over.auth ?? [], calls, big(0n), big(1_900_000_000n), addr(SPONSOR_RELAYER), big(100_000n)]);
      const out = new Uint8Array(prefix.length + body.length);
      out.set(prefix);
      out.set(body, prefix.length);
      return out;
    };
    const subject = (bytes: Uint8Array): ApprovalSubject => ({ kind: 'evm_sponsored', chain: 'evm', address: SPONSOR_ME, context: { chainId: SPONSOR_CHAIN }, bytes });
    const ok = raw([[addr(CHECK_IN), big(0n), addr(CHECK_IN_DATA)]]);
    expect(decodeError(() => decode(subject(ok)))).toBe('decoded');
    expect(decodeError(() => decode(subject(raw([[addr(CHECK_IN), big(1n), addr(CHECK_IN_DATA)]]))))).toBe('invalid_value');
    expect(decodeError(() => decode(subject(raw([[addr(SPONSOR_ME), big(0n), addr(CHECK_IN_DATA)]]))))).toBe('invalid_value');
    expect(decodeError(() => decode(subject(raw([[addr(SPONSOR_DELEGATE), big(0n), addr(CHECK_IN_DATA)]]))))).toBe('invalid_value');
    expect(decodeError(() => decode(subject(raw([[new Uint8Array(20), big(0n), addr(CHECK_IN_DATA)]]))))).toBe('invalid_value');
    expect(decodeError(() => decode(subject(raw(Array.from({ length: 9 }, () => [addr(CHECK_IN), big(0n), addr(CHECK_IN_DATA)])))))).toBe('invalid_value');
    expect(decodeError(() => decode(subject(raw([[addr(CHECK_IN), big(0n), addr(CHECK_IN_DATA)]], { auth: [big(0n), big(1n)] }))))).toBe('malformed');
    expect(decodeError(() => decode(subject(Uint8Array.from([...ok, 0]))))).toBe('malformed');
    expect(decodeError(() => decode(subject(ok.subarray(0, ok.length - 1))))).not.toBe('decoded');
    const otherPrefix = Uint8Array.from(ok);
    otherPrefix[prefix.length - 1] = '2'.charCodeAt(0);
    expect(decodeError(() => decode(subject(otherPrefix)))).toBe('malformed');
  });

  it('every single-byte change is refused or decodes to a subject whose bytes are exactly the changed ones', () => {
    const bytes = encodeSponsorSubject(sponsorSubject({ authNonce: 0n, calls: [sponsoredCall(TOKEN, TRANSFER), sponsoredCall(CHECK_IN, CHECK_IN_DATA)] }));
    let decoded = 0;
    for (let i = 0; i < bytes.length; i++) {
      for (const delta of [1, 0x80]) {
        const b = Uint8Array.from(bytes);
        b[i] = ((b[i] as number) ^ delta) & 0xff;
        const s: ApprovalSubject = { kind: 'evm_sponsored', chain: 'evm', address: SPONSOR_ME, context: { chainId: SPONSOR_CHAIN }, bytes: b };
        let d: DecodedApproval;
        try {
          d = decode(s);
        } catch (e) {
          expect(e).toBeInstanceOf(DecodeError);
          continue;
        }
        decoded++;
        const a = d as Extract<DecodedApproval, { kind: 'evm_sponsored' }>;
        // What the popup shows is exactly what the bytes say: re-encoding gives the same bytes.
        expect(toHex(encodeSponsorSubject(a.subject))).toBe(toHex(b));
        expect(a.subject.delegate).toBe(SPONSOR_DELEGATE);
        expect(a.subject.relayer).toBe(SPONSOR_RELAYER);
        // The summary is never the catch-all for bytes the decoder accepts.
        expect(summarizeApproval(d, { address: SPONSOR_ME })).not.toBe(UNEXPLAINED_SUMMARY);
      }
    }
    // Some changes (a nonce, the deadline, calldata) are still valid subjects: the test reached them.
    expect(decoded).toBeGreaterThan(0);
    expect(decodeSponsorSubject(bytes).calls).toHaveLength(2);
  });
});

// ---- the summary ----

describe('the sponsored action’s summary (D831, D850)', () => {
  it('one known call: its own headline, the fee line, the network; no setup note when nothing is authorized', () => {
    const s = sponsored([sponsoredCall(TOKEN, TRANSFER)]);
    expect(text(s.headline)).toBe(`${APP} wants to send tokens of contract ${TOKEN} to ${RECIPIENT}`);
    expect(s.lines.map(text)).toEqual(['Amount: 5,000,000 in the token’s smallest units (Journear doesn’t know this token’s decimals).']);
    expect(text(s.fee!)).toBe('none. Journear pays it for you.');
    expect(s.fee).toBe(SPONSORED_FEE);
    expect(text(s.network!)).toBe('Local (Hardhat, Anvil), chain 31337');
    expect(s.warnings).toEqual([]);
    expect(s.explainable).toBe(true);
    expect(s.shownSteps).toEqual([0]);
  });

  it('first time (an authorization signed): the amber one-time setup note, never "upgrade" or "smart account"', () => {
    const s = sponsored([sponsoredCall(TOKEN, TRANSFER)], { authNonce: 0n });
    expect(warnings(s)).toEqual([['warning', 'account_setup', SETUP]]);
    expect(text(s.warnings[0]!.short!)).toBe('One-time setup: it also turns on free network fees for your account on the local test chain 31337 (your address stays the same)');
    expect(s.explainable).toBe(true);
    const all = JSON.stringify(s);
    expect(all).not.toMatch(/upgrade|smart account|7702|delegat/iu);
    // Later (no authorization): no note at all.
    expect(sponsored([sponsoredCall(TOKEN, TRANSFER)], { authNonce: null }).warnings).toEqual([]);
  });

  it('the setup note names the chain as people know it', () => {
    // Base Sepolia isn't pinned yet, so its summary is built from a decoded shape (the summary is pure).
    const d = decode(sponsoredApproval(sponsorSubject({ authNonce: 0n }))) as Extract<DecodedApproval, { kind: 'evm_sponsored' }>;
    const s = summarizeApproval({ ...d, chainId: 84532 }, { address: SPONSOR_ME });
    expect(text(s.warnings.find((w) => w.code === 'account_setup')!.text)).toBe('One-time setup: this also turns on free network fees for your account on Base Sepolia. Your address stays the same and you still approve every action.');
    expect(text(s.network!)).toBe('Base Sepolia (testnet), chain 84532');
  });

  it('an unknown call: the same red "can’t tell" line as the same call in an ordinary transaction; nothing about ETH leaving', () => {
    const s = sponsored([sponsoredCall(UNKNOWN, CHECK_IN_DATA)]);
    const p = plain(UNKNOWN, CHECK_IN_DATA);
    expect(text(s.headline)).toBe(text(p.headline));
    expect(text(s.headline)).toBe(`${APP} wants to use contract ${UNKNOWN}`);
    expect(warnings(s)).toEqual(warnings(p));
    expect(warnings(s)).toEqual([['danger', 'cannot_explain', `Journear can’t tell what this request does: it calls a function Journear doesn’t recognise. It could move your money or tokens. Only approve if you fully trust ${APP}. Technical details are below.`]]);
    expect(s.explainable).toBe(false);
    expect(JSON.stringify(s)).not.toMatch(/ETH|sends/u);
  });

  it('approve(spender, unlimited) inside a sponsored batch is exactly as alarming as unsponsored, plus the fee line', () => {
    const s = sponsored([sponsoredCall(TOKEN, APPROVE_MAX)], { authNonce: 0n });
    const p = plain(TOKEN, APPROVE_MAX);
    expect(text(s.headline)).toBe(text(p.headline));
    expect(s.lines.map(text)).toEqual(p.lines.map(text));
    expect(warnings(s).filter((w) => w[1] !== 'account_setup')).toEqual(warnings(p));
    expect(warnings(s)[0]).toEqual(['danger', 'unlimited_spend', `This lets ${SPENDER}, an address Journear hasn’t verified, spend all of your tokens of contract ${TOKEN}, with no limit, until you take the permission back. Approve only if you trust it completely.`]);
    expect(warnings(s)[1]).toEqual(['warning', 'account_setup', SETUP]);
    expect(text(s.fee!)).toBe('none. Journear pays it for you.');
  });

  it('every known call reads as it does unsponsored (headline, lines, warnings, explainable)', () => {
    const cases: [string, string][] = [
      [TOKEN, TRANSFER],
      [TOKEN, APPROVE_MAX],
      [TOKEN, calldata('approve(address,uint256)', SPENDER, 1000n)],
      [TOKEN, calldata('approve(address,uint256)', SPENDER, 0n)],
      [TOKEN, calldata('increaseAllowance(address,uint256)', SPENDER, 5n)],
      [TOKEN, calldata('decreaseAllowance(address,uint256)', SPENDER, 5n)],
      [TOKEN, calldata('setApprovalForAll(address,bool)', SPENDER, true)],
      [TOKEN, calldata('setApprovalForAll(address,bool)', SPENDER, false)],
      [TOKEN, calldata('transferFrom(address,address,uint256)', SPONSOR_ME, RECIPIENT, 7n)],
      [TOKEN, calldata('safeTransferFrom(address,address,uint256)', SPONSOR_ME, RECIPIENT, 7n)],
      [TOKEN, calldata('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)', SPONSOR_ME, SPENDER, UINT256_MAX, 1n, 27n, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`)],
      [TOKEN, calldata('withdraw(uint256)', 10n)],
      [TOKEN, calldata('deposit()')],
      [TOKEN, '0xdeadbeef'],
      [TOKEN, `${calldata('transfer(address,uint256)', RECIPIENT, 1n)}`.slice(0, 20)],
    ];
    for (const [to, data] of cases) {
      const s = sponsored([sponsoredCall(to as `0x${string}`, data as `0x${string}`)]);
      const p = plain(to, data);
      expect([text(s.headline), s.lines.map(text), warnings(s), s.explainable], data).toEqual([text(p.headline), p.lines.map(text), warnings(p), p.explainable]);
    }
  });

  it('several calls: one line each (at most four), grouped only when identical; every warning kept', () => {
    const s = sponsored([sponsoredCall(TOKEN, APPROVE_MAX), sponsoredCall(TOKEN, TRANSFER), sponsoredCall(TOKEN, TRANSFER)], { authNonce: 0n });
    expect(text(s.headline)).toBe(`${APP} wants to do 3 things in one transaction`);
    expect(s.lines.map(text)).toEqual([
      `2 times: send tokens of contract ${TOKEN} to ${RECIPIENT}. Amount: 5,000,000 in the token’s smallest units (Journear doesn’t know this token’s decimals).`,
      `Lets ${SPENDER} (unverified) spend all of your tokens of contract ${TOKEN}`,
    ]);
    expect(warnings(s).map((w) => w[1])).toEqual(['unlimited_spend', 'account_setup']);
    expect(s.explainable).toBe(true);
    expect(s.shownSteps).toEqual([1, 2, 0]);
  });

  it('several calls, one unknown: the batch gets that call’s red "can’t tell" line; two kinds of unknown: one for the batch', () => {
    const one = sponsored([sponsoredCall(TOKEN, TRANSFER), sponsoredCall(UNKNOWN, CHECK_IN_DATA)]);
    expect(warnings(one)).toEqual(warnings(plain(UNKNOWN, CHECK_IN_DATA)));
    expect(one.explainable).toBe(false);
    expect(one.lines.map(text)).toEqual([`Send tokens of contract ${TOKEN} to ${RECIPIENT}. Amount: 5,000,000 in the token’s smallest units (Journear doesn’t know this token’s decimals).`, `Use contract ${UNKNOWN}`]);
    const two = sponsored([sponsoredCall(UNKNOWN, CHECK_IN_DATA), sponsoredCall(TOKEN, calldata('multicall(bytes[])', 32n, 0n))]);
    expect(warnings(two)).toEqual([['danger', 'cannot_explain', `Journear can’t tell what this request does: part of it is something Journear can’t summarise. It could move your money or tokens. Only approve if you fully trust ${APP}. Technical details are below.`]]);
  });

  it('more than four kinds of call: three lines, "…and N other steps", and a red line (calls can move tokens)', () => {
    const calls = [1n, 2n, 3n, 4n, 5n].map((n) => sponsoredCall(TOKEN, calldata('transfer(address,uint256)', RECIPIENT, n)));
    const s = sponsored(calls);
    expect(s.lines).toHaveLength(4);
    expect(text(s.lines[3]!)).toBe('…and 2 other steps: see the details.');
    expect(s.explainable).toBe(false);
    expect(s.warnings.map((w) => [w.level, w.code])).toEqual([
      ['danger', 'step_left_out'],
      ['danger', 'step_left_out'],
      ['danger', 'steps_not_listed'],
    ]);
    expect(text(s.warnings[2]!.text)).toBe(`This request does 5 things at once and not all are listed here; some of those left out move money or tokens or change who controls your account. Only approve if you fully trust ${APP}. Technical details are below.`);
  });

  it('the largest amount to others is never left out; revokes rank last and move nothing', () => {
    const revoke = calldata('decreaseAllowance(address,uint256)', SPENDER, 1n);
    const calls = [sponsoredCall(TOKEN, revoke), sponsoredCall('0x2222222222222222222222222222222222222222', revoke), sponsoredCall('0x4444444444444444444444444444444444444444', revoke), sponsoredCall('0x5555555555555555555555555555555555555555', revoke), sponsoredCall(TOKEN, TRANSFER)];
    const s = sponsored(calls);
    expect(text(s.lines[0]!)).toMatch(/^Send tokens of contract/u);
    // Left out: only revokes, which move nothing: amber.
    expect(s.warnings.map((w) => [w.level, w.code])).toEqual([['warning', 'steps_not_listed']]);
  });

  it('is total: an odd decoded shape gives the unexplained summary, never a throw', () => {
    const d = decode() as Extract<DecodedApproval, { kind: 'evm_sponsored' }>;
    expect(summarizeApprovalRaw({ ...d, calls: [null] } as never, { address: SPONSOR_ME })).toBe(UNEXPLAINED_SUMMARY);
  });
});

// ---- D833 in the popup and the matcher: the delegate's typed-data domain is never an eip712 request ----

describe('typed data in the delegate’s domain (D833): the popup refuses it, the matcher never matches it', () => {
  const eip712 = (json: unknown, address = SPONSOR_ME): ApprovalSubject => ({ kind: 'eip712', chain: 'evm', address, context: {}, bytes: new TextEncoder().encode(JSON.stringify(json)) });
  const execute = (domain: Record<string, unknown>) => ({
    types: { EIP712Domain: EXECUTE_TYPES.EIP712Domain, Execute: EXECUTE_TYPES.Execute, Call: EXECUTE_TYPES.Call },
    primaryType: 'Execute',
    domain,
    message: { calls: [{ to: SPENDER, value: '1', data: '0x' }], nonce: '0', deadline: '1900000000', relayer: SPENDER, minGas: '0' },
  });
  const salt = `0x${'00'.repeat(12)}${SPONSOR_DELEGATE.slice(2).toLowerCase()}`;

  it.each([
    ['the exact domain', { name: 'HanaDelegateExecutor', version: '1', chainId: 31337, verifyingContract: SPONSOR_ME, salt }],
    ['another key order and a hex chain ID', { salt, verifyingContract: SPONSOR_ME, chainId: '0x7a69', version: '1', name: 'HanaDelegateExecutor' }],
    ['another version', { name: 'HanaDelegateExecutor', version: '9', chainId: 84532, verifyingContract: SPONSOR_ME, salt }],
  ])('%s: no Approve (unsupported)', (_name, domain) => {
    expect(decodeError(() => decodeApprovalRequest(eip712(execute(domain))))).toBe('unsupported');
  });

  it('a look-alike or padded name is ordinary typed data (the delegate never accepts its digest), shown with the red line', () => {
    for (const name of ['HanaDelegateExecutor ', 'HanaDeIegateExecutor']) {
      const d = decodeApprovalRequest(eip712(execute({ name, version: '1', chainId: 31337, verifyingContract: SPONSOR_ME, salt })));
      expect(d.kind).toBe('eip712');
      expect(summarizeApproval(d, { address: SPONSOR_ME }).warnings.map((w) => [w.level, w.code])).toEqual([['danger', 'cannot_explain']]);
    }
  });

  it('a policy-listed (verifyingContract, primaryType) pair in the delegate’s domain never auto-approves', () => {
    const policy = validateAutoApprovePolicy(policyJson());
    if (!policy.ok) throw new Error('policy');
    const permit = (name: string) => ({
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        PermitDetails: [
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'expiration', type: 'uint48' },
          { name: 'nonce', type: 'uint48' },
        ],
        PermitSingle: [
          { name: 'details', type: 'PermitDetails' },
          { name: 'spender', type: 'address' },
          { name: 'sigDeadline', type: 'uint256' },
        ],
      },
      primaryType: 'PermitSingle',
      domain: { name, chainId: POLICY_CHAIN, verifyingContract: EVM_PERMIT2 },
      message: { details: { token: EVM_USDC, amount: '1000', expiration: 1, nonce: 0 }, spender: EVM_VAULT, sigDeadline: '1' },
    });
    const ctx = { usage: null, nowMs: Date.UTC(2026, 10, 17) };
    // The same shape under Permit2's name matches (the control), under the delegate's name never.
    expect(matchAutoApprovePolicy(policy.policy, eip712(permit('Permit2'), EVM_USER), ctx)).toMatchObject({ ok: true });
    expect(matchAutoApprovePolicy(policy.policy, eip712(permit('HanaDelegateExecutor'), EVM_USER), ctx)).toMatchObject({ ok: false, reason: 'decode_failed' });
  });
});

describe('the deadline against the popup’s clock (review, Low): at most 2 hours ahead, at most 5 minutes past', () => {
  const at = (nowS: number, deadline = 1_900_000_000n) => decodeError(() => decodeApprovalRequest(sponsoredApproval(sponsorSubject({ deadline })), { sponsorChains: SPONSOR_CHAINS, nowMs: nowS * 1000 }));
  it('accepts a deadline from 5 minutes past to 2 hours ahead, inclusive', () => {
    expect(at(1_900_000_000 - 7200)).toBe('decoded');
    expect(at(1_900_000_000)).toBe('decoded');
    expect(at(1_900_000_000 + 300)).toBe('decoded');
  });
  it('refuses one further ahead or further past (a drifting clock of minutes still passes)', () => {
    expect(at(1_900_000_000 - 7201)).toBe('invalid_value');
    expect(at(1_900_000_000 + 301)).toBe('invalid_value');
    expect(at(1_700_000_000, 2n ** 64n - 1n)).toBe('invalid_value');
  });
  it('refuses when the popup gives no clock (fail closed)', () => {
    expect(decodeError(() => decodeApprovalRequest(sponsoredApproval(), { sponsorChains: SPONSOR_CHAINS }))).toBe('unsupported');
  });
});
