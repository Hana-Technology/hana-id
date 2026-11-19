// Journear's demo check-in on the verified list (D854): the pin is the contract's checked-in artifact; its one
// function, `checkIn()`, is a known call that reads plainly, sponsored or not, but only for exactly the pinned contract
// on a chain where it is pinned, exactly `0x183ff085` and no value. Anything else keeps the red "can't tell" line.
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { DEMO_CHECK_IN, DEMO_CHECK_IN_CALLDATA, isDemoCheckInCall } from '../src/demo-check-in.ts';
import { VERIFIED_CONTRACTS, verifiedContract } from '../src/verified-contracts.ts';
import { checksumAddress, parseHex0x } from '../src/decode/hex.ts';
import {
  type ApprovalSummary,
  type SummaryText,
  UNEXPLAINED_SUMMARY,
  decodeApprovalRequest,
  evmTxSigningPayload,
  parseEvmTxRequest,
  summarizeApproval as summarizeApprovalRaw,
  summaryString,
} from './entries.ts';
import { SPONSOR_CHAINS, SPONSOR_ME, SPONSOR_NOW_MS, sponsorSubject, sponsoredApproval, sponsoredCall } from './evm-sponsored-fixture.ts';

import { jargonIn, zeroCostIn } from './plain-words.ts';

const APP = 'Partner App';
const fallbackHits: string[] = [];
const summarizeApproval: typeof summarizeApprovalRaw = (d, ctx) => {
  const s = summarizeApprovalRaw(d, ctx);
  if (s === UNEXPLAINED_SUMMARY) fallbackHits.push(d.kind);
  jargonHits.push(...jargonIn(s), ...zeroCostIn(s));
  return s;
};
// No chain jargon in what the user reads (D853).
const jargonHits: string[] = [];
afterAll(() => expect(jargonHits).toEqual([]));
afterAll(() => expect(fallbackHits).toEqual([]));
const text = (t: SummaryText) => summaryString(t, APP);

const CHECK_IN = (DEMO_CHECK_IN[31337] as { address: `0x${string}` }).address;
/** The pinned address with its last character changed (checksummed again). */
const LOOK_ALIKE = checksumAddress(parseHex0x(`${CHECK_IN.slice(0, -1).toLowerCase()}f`, 20)) as `0x${string}`;
const OTHER = '0x1111111111111111111111111111111111111111';

const HEADLINE = `${APP} wants to check you in`;
const LINES = ['This is Journear’s demo check-in. It doesn’t move any money or tokens.', `It uses Journear demo check-in (${CHECK_IN}, checked by Journear).`];
const CANT_TELL = `Journear can’t check what this does (it asks for an action Journear doesn’t know). It could take your money or tokens. If you’re not sure, reject it.`;

function plain(to: string, data: string, value = 0n, chainId = 31337): ApprovalSummary {
  const tx = parseEvmTxRequest({ chainId: `0x${chainId.toString(16)}`, nonce: '0x1', gas: '0x5208', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', to, value: `0x${value.toString(16)}`, data });
  return summarizeApproval(decodeApprovalRequest({ kind: 'evm_tx', chain: 'evm', address: SPONSOR_ME, context: { chainId }, bytes: evmTxSigningPayload(tx) }), { address: SPONSOR_ME });
}
const sponsored = (calls: ReturnType<typeof sponsoredCall>[], authNonce: bigint | null = null) =>
  summarizeApproval(decodeApprovalRequest(sponsoredApproval(sponsorSubject({ calls, authNonce })), { sponsorChains: SPONSOR_CHAINS, nowMs: SPONSOR_NOW_MS }), { address: SPONSOR_ME });

describe('the pin', () => {
  it('every pinned entry is the contract’s checked-in artifact: its CREATE2 address and runtime code hash', () => {
    const artifact = JSON.parse(readFileSync(new URL('../../../contracts/evm-delegate/artifacts/CheckIn.json', import.meta.url), 'utf8')) as {
      contractName: string;
      create2: { address: string };
      runtimeCodeHash: string;
      abi: { type: string; name?: string; inputs?: unknown[] }[];
    };
    expect(artifact.contractName).toBe('CheckIn');
    expect(Object.keys(DEMO_CHECK_IN).length).toBeGreaterThan(0);
    for (const c of Object.values(DEMO_CHECK_IN)) {
      expect(c.address).toBe(artifact.create2.address);
      expect(c.runtimeCodeHash).toBe(artifact.runtimeCodeHash);
    }
    // Its one function is checkIn() with no arguments.
    expect(artifact.abi.filter((f) => f.type === 'function' && f.name === 'checkIn').map((f) => f.inputs)).toEqual([[]]);
    expect(DEMO_CHECK_IN_CALLDATA).toBe('0x183ff085');
  });

  it('pinned on the local chain only until the deploy adds Base Sepolia; on the verified list for each pinned chain', () => {
    expect(Object.keys(DEMO_CHECK_IN)).toEqual(['31337']);
    for (const [chainId, c] of Object.entries(DEMO_CHECK_IN)) {
      expect(verifiedContract({ kind: 'evm', chainId: Number(chainId) }, c.address)).toMatchObject({ name: 'Journear demo check-in', protocol: 'Journear' });
    }
    expect(VERIFIED_CONTRACTS.filter((e) => e.protocol === 'Journear')).toHaveLength(Object.keys(DEMO_CHECK_IN).length);
    expect(verifiedContract({ kind: 'evm', chainId: 84532 }, CHECK_IN)).toBeNull();
    expect(verifiedContract({ kind: 'evm', chainId: 31337 }, LOOK_ALIKE)).toBeNull();
  });

  it('isDemoCheckInCall: exactly the pinned contract on its chain, exactly the selector, no value', () => {
    expect(isDemoCheckInCall(31337, CHECK_IN, '0x183ff085', 0n)).toBe(true);
    expect(isDemoCheckInCall(31337, CHECK_IN.toLowerCase(), '0x183FF085', 0n)).toBe(true);
    expect(isDemoCheckInCall(31337, CHECK_IN, '0x183ff08500', 0n)).toBe(false);
    expect(isDemoCheckInCall(31337, CHECK_IN, '0x183ff0', 0n)).toBe(false);
    expect(isDemoCheckInCall(31337, CHECK_IN, '0x183ff085', 1n)).toBe(false);
    expect(isDemoCheckInCall(31337, LOOK_ALIKE, '0x183ff085', 0n)).toBe(false);
    expect(isDemoCheckInCall(31337, OTHER, '0x183ff085', 0n)).toBe(false);
    expect(isDemoCheckInCall(84532, CHECK_IN, '0x183ff085', 0n)).toBe(false);
    expect(isDemoCheckInCall(31337, null, '0x183ff085', 0n)).toBe(false);
  });
});

describe('the summary of a check-in', () => {
  it('unsponsored: plain words, the contract named and in view, no box', () => {
    const s = plain(CHECK_IN, '0x183ff085');
    expect(text(s.headline)).toBe(HEADLINE);
    expect(s.lines.map(text)).toEqual(LINES);
    expect(s.warnings).toEqual([]);
    expect(s.explainable).toBe(true);
    expect(text(s.fee!)).toBe('Less than 0.000001 ETH');
  });

  it('sponsored: the same, the fee line Journear’s; the one-time setup note still the first time', () => {
    const later = sponsored([sponsoredCall(CHECK_IN, '0x183ff085')]);
    expect([text(later.headline), later.lines.map(text), later.warnings, later.explainable]).toEqual([HEADLINE, LINES, [], true]);
    expect(text(later.fee!)).toBe('Free. Journear pays it for you.');
    const first = sponsored([sponsoredCall(CHECK_IN, '0x183ff085')], 0n);
    expect(first.warnings.map((w) => [w.level, w.code])).toEqual([['warning', 'account_setup']]);
    expect(text(first.headline)).toBe(HEADLINE);
  });

  it.each([
    ['trailing calldata', CHECK_IN, '0x183ff08500'],
    ['another contract with the same selector', OTHER, '0x183ff085'],
    ['a look-alike address', LOOK_ALIKE, '0x183ff085'],
  ] as const)('%s: the red "can’t tell" line, no name', (_name, to, data) => {
    for (const s of [plain(to, data), sponsored([sponsoredCall(to as `0x${string}`, data as `0x${string}`)])]) {
      expect(text(s.headline)).toBe(`${APP} wants to use the program ${to}`);
      expect(s.warnings.map((w) => text(w.text))).toEqual([CANT_TELL]);
      expect(s.explainable).toBe(false);
      expect(JSON.stringify(s)).not.toContain('check-in');
    }
  });

  it('with value (unsponsored only: a sponsored call carries none): the red line', () => {
    const s = plain(CHECK_IN, '0x183ff085', 10n ** 15n);
    expect(s.explainable).toBe(false);
    expect(s.warnings.map((w) => w.code)).toEqual(['cannot_explain']);
    expect(text(s.headline)).toContain('sending it');
  });

  it('on a chain where it isn’t pinned: the red line', () => {
    const s = plain(CHECK_IN, '0x183ff085', 0n, 84532);
    expect(s.explainable).toBe(false);
  });

  it('several check-ins in a batch: one grouped line, nothing left out, no box', () => {
    const s = sponsored([sponsoredCall(CHECK_IN, '0x183ff085'), sponsoredCall(CHECK_IN, '0x183ff085')]);
    expect(text(s.headline)).toBe(`${APP} wants to do 2 things at once`);
    // In a batch the reassurance is about the check-in alone, never the whole request.
    expect(s.lines.map(text)).toEqual([`2 times: check you in. This is Journear’s demo check-in. The check-in itself doesn’t move any money or tokens. ${LINES[1]}`]);
    const mixed = sponsored([sponsoredCall(CHECK_IN, '0x183ff085'), sponsoredCall(OTHER, '0xdeadbeef')]);
    expect(mixed.lines.map(text)).toContain(`Use the program ${OTHER}`);
    expect(mixed.lines.map(text).join('\n')).toContain('The check-in itself doesn’t move any money or tokens.');
    expect(JSON.stringify(mixed)).not.toContain('It doesn’t move any money');
    expect(s.warnings).toEqual([]);
    expect(s.explainable).toBe(true);
  });
});

describe('punctuation and rounded amounts in composed texts (review of PR 73)', () => {
  it('a fee below the shown precision reads "less than …", never "up to less than"; a rounded one "up to" its rounded-up figure', () => {
    expect(text(plain(OTHER, '0x', 0n).fee!)).toBe('Less than 0.000001 ETH');
    // 21 000 gas × 1 234 567 000 wei = 0.000025925907 ETH: rounded up, so "up to" stays true without "about".
    const tx = parseEvmTxRequest({ chainId: '0x7a69', nonce: '0x1', gas: '0x5208', maxFeePerGas: '0x4995ff58', maxPriorityFeePerGas: '0x1', to: OTHER, value: '0x0', data: '0x' });
    const s = summarizeApproval(decodeApprovalRequest({ kind: 'evm_tx', chain: 'evm', address: SPONSOR_ME, context: { chainId: 31337 }, bytes: evmTxSigningPayload(tx) }), { address: SPONSOR_ME });
    expect(text(s.fee!)).toBe('Up to 0.000026 ETH');
  });

  it('a left-out step whose line ends with a full stop gets one, not two', () => {
    const calls = [1n, 2n, 3n, 4n, 5n].map((n) => sponsoredCall(OTHER, `0xa9059cbb${'0'.repeat(24)}${'de'.repeat(20)}${n.toString(16).padStart(64, '0')}` as `0x${string}`));
    const s = sponsored(calls);
    const left = s.warnings.filter((w) => w.code === 'step_left_out').map((w) => text(w.text));
    expect(left.length).toBeGreaterThan(0);
    for (const t of left) {
      expect(t).toMatch(/[^.]\.$/u);
      expect(t).not.toMatch(/\.\.|\s{2}|\s[.,]/u);
    }
  });
});
