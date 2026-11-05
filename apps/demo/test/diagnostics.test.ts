import { describe, expect, it } from 'vitest';
import { type DiagnosticsInput, MAX_ENTRIES, diagnostics, diagnosticsJson, keyPrefix, scrub } from '../src/diagnostics.ts';
import { ADDRESSES } from './fixtures.ts';

// Secret-shaped values, as they could appear in an error message. None of them is a real secret.
const b64url = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
/** A JWT-shaped string (header.payload.signature), made here: no real token. */
const JWT = `${b64url({ alg: 'RS256', kid: 'test' })}.${b64url({ sub: '1234567890', nonce: 'x' })}.${b64url('signature-test')}`;
const STELLAR_SECRET = `S${'A'.repeat(55)}`;
const HEX_KEY = `0x${'ab'.repeat(32)}`;
const SIGNATURE = `0x${'cd'.repeat(65)}`;
const RELAY_ID = 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5';
const PK = 'pk_test_85gdPtFF4kYzqgPisccZbsT9fQP1tq7ie';

const input = (patch: Partial<DiagnosticsInput> = {}): DiagnosticsInput => ({
  environment: 'sandbox-dev',
  publishableKey: PK,
  pageOrigin: 'https://hana-id-demo-sandbox-dev.tingtc.workers.dev',
  vaultOrigin: 'https://hana-id-vault-sandbox-dev.tingtc.workers.dev',
  sdkVersion: '0.0.0',
  evmChainId: 84532,
  status: 'logged_in',
  persistence: 'session',
  warning: null,
  expiresAtMs: Date.UTC(2026, 9, 29, 23),
  addresses: ADDRESSES,
  supportId: 'HANA-2750-G5HM',
  unlockMs: 212.6,
  logins: [{ at: '2026-10-29T11:00:00.000Z', method: 'google', totalMs: 7012.4, stages: { app: 120, popup: 900, google: 4000, verify: 15, chain: 6200, decrypt: 40 } }],
  errors: [],
  userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
  ...patch,
});

describe('diagnostics', () => {
  it('reports exactly the public fields', () => {
    const d = diagnostics(input(), Date.UTC(2026, 9, 29, 12));
    expect(d).toEqual({
      v: 1,
      at: '2026-10-29T12:00:00.000Z',
      environment: 'sandbox-dev',
      appKey: 'pk_test_85gd…',
      pageOrigin: 'https://hana-id-demo-sandbox-dev.tingtc.workers.dev',
      vaultOrigin: 'https://hana-id-vault-sandbox-dev.tingtc.workers.dev',
      sdkVersion: '0.0.0',
      evmChainId: 84532,
      status: 'logged_in',
      persistence: 'session',
      warning: null,
      sessionExpiresAt: '2026-10-29T23:00:00.000Z',
      addresses: ADDRESSES,
      supportId: 'HANA-2750-G5HM',
      unlockMs: 213,
      logins: [{ at: '2026-10-29T11:00:00.000Z', method: 'google', totalMs: 7012, stages: { app: 120, popup: 900, google: 4000, verify: 15, chain: 6200, decrypt: 40 } }],
      errors: [],
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
    });
  });

  it('never carries the full app key, a token, a key, a signature or a relay id, even inside error messages', () => {
    const errors = [
      { at: 'a', action: 'login', code: 'token_invalid', reason: null, message: `bad token ${JWT} for ${PK}` },
      { at: 'b', action: 'export', code: 4001, reason: null, message: `key ${STELLAR_SECRET} / ${HEX_KEY}` },
      { at: 'c', action: 'sign', code: null, reason: null, message: `sig ${SIGNATURE} relay ${RELAY_ID} sk_abcdefghijkl` },
    ];
    const json = diagnosticsJson(input({ errors }), 0);
    for (const secret of [JWT, STELLAR_SECRET, HEX_KEY, 'ab'.repeat(32), SIGNATURE, RELAY_ID, PK, 'sk_abcdefghijkl', 'eyJ']) expect(json).not.toContain(secret);
    const parsed = JSON.parse(json) as { errors: { message: string; code: unknown }[] };
    expect(parsed.errors.map((e) => e.message)).toEqual([
      'bad token [redacted token] for pk_test_85gd…',
      'key [redacted] / [redacted hex]',
      'sig [redacted hex] relay [redacted] [redacted]',
    ]);
    expect(parsed.errors.map((e) => e.code)).toEqual(['token_invalid', 4001, null]);
  });

  it('batch C15: the Support ID only when it is one (null without one, or for anything else)', () => {
    expect(diagnostics(input({ supportId: null }), 0).supportId).toBeNull();
    for (const bad of ['hana-2750-g5hm', `HANA-2750-G5HM ${JWT}`, 'u1_EcoIFjT5lAWZsk0862e8Tg', '']) expect(diagnostics(input({ supportId: bad }), 0).supportId).toBeNull();
  });

  it('keeps addresses in their own field and only the latest entries, with stage names and numbers re-typed', () => {
    const logins = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => ({ at: String(i), method: 'email' as const, totalMs: i, stages: { chain: i, 'bad key!': 1, nan: Number.NaN } as Record<string, number> }));
    const d = diagnostics(input({ logins, addresses: null, expiresAtMs: null, unlockMs: null }), 0) as { logins: { at: string; stages: unknown }[]; addresses: unknown; sessionExpiresAt: unknown };
    expect(d.logins).toHaveLength(MAX_ENTRIES);
    expect(d.logins[0]!.at).toBe('5');
    expect(d.logins[0]!.stages).toEqual({ chain: 5 });
    expect(d.addresses).toBeNull();
    expect(d.sessionExpiresAt).toBeNull();
  });
});

describe('scrub', () => {
  it('keeps EVM and Stellar addresses short enough to read, and cuts long text', () => {
    expect(scrub(`to ${ADDRESSES.evm}`)).toBe(`to ${ADDRESSES.evm}`);
    expect(scrub(`from ${ADDRESSES.stellar}.`)).toBe(`from ${ADDRESSES.stellar}.`);
    expect(scrub('x'.repeat(10) + ' '.repeat(300))).toHaveLength(201);
  });

  it('keyPrefix keeps 12 characters', () => {
    expect(keyPrefix(PK)).toBe('pk_test_85gd…');
    expect(keyPrefix('short')).toBe('short');
  });
});
