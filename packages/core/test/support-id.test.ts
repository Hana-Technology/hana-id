// The Support ID on the client side (batch C15, support-id.ts): its exact shape, the API answers' drop-if-malformed
// read, the SDK version gate, and the protocol shapes that carry it (hana_status, hana_login, `ready`, the approval
// request), additive and refused when malformed.
import { describe, expect, it } from 'vitest';
import { isLoginResponse } from '../src/api-types.ts';
import { newRequestId, parsePortEvent, parsePortReply, parseWindowMessage } from '../src/protocol.ts';
import { STELLAR_TESTNET_PASSPHRASE } from '../src/verified-contracts.ts';
import {
  CROCKFORD_ALPHABET,
  SUPPORT_ID_RE,
  SUPPORT_ID_SDK_MIN,
  crockford32,
  formatSupportId,
  decodeIdentitySub,
  isSupportId,
  sdkAtLeast,
  supportCodeFromSub,
  supportIdFrom,
  supportIdFromSub,
} from '../src/support-id.ts';
import { VERSION } from '../src/index.ts';

const CODE = 'HANA-2750-G5HM';
const G = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const EVM = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const ADDRESSES = { stellar: G, evm: EVM };
const BAD = ['hana-2750-g5hm', 'HANA-2750-G5HU', 'HANA-2750-G5HI', 'HANA-2750-G5HL', 'HANA-2750-G5HO', 'HANA2750G5HM', 'HANA-2750-G5H', 'HANA-2750-G5HMM', ' HANA-2750-G5HM', 'X-2750-G5HM', '', 42, null, {}];

describe('isSupportId', () => {
  it('takes exactly the API’s output: HANA-, 4, dash, 4, uppercase Crockford (no I, L, O, U)', () => {
    for (const ok of [CODE, 'HANA-0000-0000', 'HANA-ZZZZ-ZZZZ', 'HANA-ABCD-EFGH', 'HANA-JKMN-PQRS', 'HANA-TVWX-YZ19']) expect(isSupportId(ok), ok).toBe(true);
    for (const bad of BAD) expect(isSupportId(bad), String(bad)).toBe(false);
    expect(SUPPORT_ID_RE.test('HANA-2750-G5HM\n')).toBe(false);
  });

  it('supportIdFrom reads an answer’s supportId, or null when absent or malformed (never throws)', () => {
    expect(supportIdFrom({ supportId: CODE })).toBe(CODE);
    expect(supportIdFrom({})).toBeNull();
    expect(supportIdFrom(null)).toBeNull();
    expect(supportIdFrom('HANA-2750-G5HM')).toBeNull();
    for (const bad of BAD) expect(supportIdFrom({ supportId: bad })).toBeNull();
  });

  it('a /v1/login answer with any supportId is still a login answer (decoration: checked where used)', () => {
    const body = { result: { big_y: 'y', big_c: 'c' }, session: { scope_id: 's1', expires_at_ms: 1, max_uses: 1, used: 1 }, nearTx: 'tx', requestId: 'r' };
    expect(isLoginResponse({ ...body, supportId: CODE })).toBe(true);
    expect(isLoginResponse({ ...body, supportId: 'nonsense' })).toBe(true);
  });
});

describe('sdkAtLeast (the vault’s gate on the hello’s sdk)', () => {
  it('compares x.y.z numerically; a prerelease is below its release; anything else is false', () => {
    expect(sdkAtLeast('0.2.0', '0.2.0')).toBe(true);
    expect(sdkAtLeast('0.2.1', '0.2.0')).toBe(true);
    expect(sdkAtLeast('0.10.0', '0.2.0')).toBe(true);
    expect(sdkAtLeast('1.0.0', '0.2.0')).toBe(true);
    expect(sdkAtLeast('0.1.9', '0.2.0')).toBe(false);
    expect(sdkAtLeast('0.1.0', '0.2.0')).toBe(false);
    expect(sdkAtLeast('0.0.0', '0.2.0')).toBe(false);
    expect(sdkAtLeast('0.2.0-rc.1', '0.2.0')).toBe(false);
    expect(sdkAtLeast('0.3.0-rc.1', '0.2.0')).toBe(true);
    for (const v of ['', 'dev', 'v0.2.0', '0.2', '02.0.0', '0.2.0+build', null, undefined]) expect(sdkAtLeast(v, '0.2.0'), String(v)).toBe(false);
  });

  it('this build’s SDK takes the field (its own version is at least the minimum)', () => {
    expect(sdkAtLeast(VERSION, SUPPORT_ID_SDK_MIN)).toBe(true);
  });
});

describe('the protocol shapes', () => {
  const statusIn = { status: 'logged_in', addresses: ADDRESSES, expiresAtMs: 1, persistence: 'session' };

  it('hana_status: an optional supportId while logged in; refused malformed or while logged out', () => {
    expect(parsePortReply({ v: 1, id: 'a', result: { ...statusIn, supportId: CODE } }, 'hana_status')).not.toBeNull();
    expect(parsePortReply({ v: 1, id: 'a', result: statusIn }, 'hana_status')).not.toBeNull();
    for (const bad of BAD) expect(parsePortReply({ v: 1, id: 'a', result: { ...statusIn, supportId: bad } }, 'hana_status'), String(bad)).toBeNull();
    expect(parsePortReply({ v: 1, id: 'a', result: { status: 'logged_out', persistence: 'session', supportId: CODE } }, 'hana_status')).toBeNull();
  });

  it('hana_login and `ready` take it the same way', () => {
    const login = { addresses: ADDRESSES, expiresAtMs: 1, persistence: 'session' };
    expect(parsePortReply({ v: 1, id: 'a', result: { ...login, supportId: CODE } }, 'hana_login')).not.toBeNull();
    expect(parsePortReply({ v: 1, id: 'a', result: { ...login, supportId: 'HANA-0000' } }, 'hana_login')).toBeNull();
    expect(parsePortEvent({ v: 1, event: 'ready', data: { ...statusIn, supportId: CODE, warning: 'storage_unavailable' } })).not.toBeNull();
    expect(parsePortEvent({ v: 1, event: 'ready', data: { ...statusIn, supportId: 'x' } })).toBeNull();
  });

  it('hana:approve-request: an optional supportId, refused when malformed', () => {
    const m = {
      v: 1,
      t: 'hana:approve-request',
      id: newRequestId(),
      appName: 'Partner',
      parentOrigin: 'https://partner.test',
      kind: 'stellar_tx',
      chain: 'stellar',
      address: G,
      bytes: new Uint8Array([1, 2, 3]),
      context: { networkPassphrase: STELLAR_TESTNET_PASSPHRASE },
      position: 1,
      queued: 1,
    };
    const ok = parseWindowMessage(m, ['hana:approve-request']);
    // The fixture must be a valid request on its own for the next lines to mean anything.
    expect(ok).not.toBeNull();
    expect(parseWindowMessage({ ...m, supportId: CODE }, ['hana:approve-request'])).not.toBeNull();
    for (const bad of BAD) expect(parseWindowMessage({ ...m, supportId: bad }, ['hana:approve-request']), String(bad)).toBeNull();
  });
});

describe('supportIdFromSub (exported to partners; console-core re-exports it)', () => {
  const VECTOR_SUB = 'u1_ASNFZ4mrze8BI0VniavN7w'; // the 16 bytes 0123456789abcdef0123456789abcdef

  it("the guide's vector: HANA-04HM-ASW9", () => {
    // 01 23 45 67 89 -> 00000 00100 10001 10100 01010 11001 11100 01001 -> 0 4 H M A S W 9 (MSB first, uppercase).
    expect(supportIdFromSub(VECTOR_SUB)).toBe('HANA-04HM-ASW9');
    expect(supportCodeFromSub(VECTOR_SUB)).toBe('04HMASW9');
    expect(Array.from(decodeIdentitySub(VECTOR_SUB), (b) => b.toString(16).padStart(2, '0')).join('')).toBe('0123456789abcdef0123456789abcdef');
  });

  it('only the first 5 bytes count; the result is always a well-formed Support ID', () => {
    expect(supportIdFromSub('u1_AAAAAAAAAAAAAAAAAAAAAA')).toBe('HANA-0000-0000');
    expect(supportIdFromSub(`u1_${'_'.repeat(21)}w`)).toBe('HANA-ZZZZ-ZZZZ');
    expect(supportIdFromSub(`u1_ASNFZ4mr${'_'.repeat(13)}w`)).toBe('HANA-04HM-ASW9');
    for (const sub of ['u1_8pQm3yR0tZ1vW5xA7cB2dA', 'u1_Jf2kL9mN0pQ3rS6tU8vW1Q']) expect(isSupportId(supportIdFromSub(sub)), sub).toBe(true);
    expect(formatSupportId('04HMASW9')).toBe('HANA-04HM-ASW9');
    expect(crockford32(Uint8Array.of(0xff))).toBe('ZW');
    expect(CROCKFORD_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
  });

  it('refuses anything that is not a sub (prefix, length, a non-canonical last character, padding)', () => {
    for (const bad of ['', 'u1_', `U${VECTOR_SUB.slice(1)}`, `u2${VECTOR_SUB.slice(2)}`, `${VECTOR_SUB.slice(0, -1)}x`, VECTOR_SUB.slice(0, -1), `${VECTOR_SUB}=`, 'HANA-04HM-ASW9', 42 as unknown as string]) {
      expect(() => supportIdFromSub(bad), String(bad)).toThrow(new TypeError('Not a Journear Passport identity sub (u1_...)'));
    }
  });

  it('is exported from the package entry', async () => {
    const core = await import('../src/index.ts');
    expect(core.supportIdFromSub(VECTOR_SUB)).toBe('HANA-04HM-ASW9');
  });
});
