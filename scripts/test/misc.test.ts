import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { manifestPath } from '@hana-id/env';
import { ckdKeyFromState } from '../lib/ckd.ts';
import { normaliseIssuer } from '../lib/contract.ts';
import { d1Argv, parseD1Json } from '../lib/d1.ts';
import { diffJwks } from '../lib/jwks.ts';
import { setManifestString } from '../lib/manifest-edit.ts';
import { describePermission, type FinalOutcome, failureText, formatNear, hasFullAccess, nearToYocto, successValue } from '../lib/near.ts';

const jwk = (kid: string) => ({ kid, kty: 'RSA', alg: 'RS256', use: 'sig', n: 'sXch', e: 'AQAB' });

describe('diffJwks', () => {
  it('sets new kids and removes retired ones', () => {
    const d = diffJwks(['old', 'keep'], { keys: [jwk('keep'), jwk('new')] });
    expect(d.set).toEqual([{ kid: 'new', n: 'sXch', e: 'AQAB' }]);
    expect(d.remove).toEqual(['old']);
  });

  it('ignores unusable keys and refuses an empty JWKS', () => {
    expect(() => diffJwks(['a'], { keys: [] })).toThrow('refusing');
    expect(() => diffJwks(['a'], { keys: [{ ...jwk('x'), kty: 'EC' }, { ...jwk('y'), alg: 'RS512' }, { ...jwk('z#'), n: 'a' }] })).toThrow('refusing');
    const d = diffJwks([], { keys: [jwk('a'), { ...jwk('b'), n: 'not base64url!' }] });
    expect(d.set.map((k) => k.kid)).toEqual(['a']);
  });
});

describe('normaliseIssuer', () => {
  it('accepts the plausible get_issuer shapes', () => {
    expect(normaliseIssuer(null)).toBeNull();
    expect(normaliseIssuer({ provider: 'google', iss_values: ['a'], kids: ['k1'] })).toEqual({ iss_values: ['a'], kids: ['k1'] });
    expect(normaliseIssuer(['k1', 'k2'])).toEqual({ iss_values: [], kids: ['k1', 'k2'] });
    expect(normaliseIssuer({ iss_values: [], keys: { k1: {} } })).toEqual({ iss_values: [], kids: ['k1'] });
  });
});

describe('ckdKeyFromState', () => {
  const state = { Running: { keyset: { domains: [{ domain_id: 0, key: {} }, { domain_id: 2, key: { Bls12381: { public_key: 'bls12381g2:3xYz' } } }] } } };
  it('finds the domain key', () => {
    expect(ckdKeyFromState(state, 2)).toBe('bls12381g2:3xYz');
    expect(() => ckdKeyFromState(state, 1)).toThrow('domain 1');
    expect(() => ckdKeyFromState({}, 2)).toThrow('Running');
  });
});

describe('setManifestString', () => {
  it('replaces ckdNetworkKey and keeps the rest of the file byte-identical', () => {
    const text = readFileSync(manifestPath('sandbox-dev'), 'utf8');
    const out = setManifestString(text, 'ckdNetworkKey', 'bls12381g2:abc');
    expect(JSON.parse(out).ckdNetworkKey).toBe('bls12381g2:abc');
    expect(out.replace('"bls12381g2:abc"', '')).toBe(text.replace(JSON.stringify(JSON.parse(text).ckdNetworkKey), ''));
  });

  it('handles $ in values and rejects unknown fields', () => {
    const text = readFileSync(manifestPath('sandbox-dev'), 'utf8');
    expect(JSON.parse(setManifestString(text, 'ckdNetworkKey', "bls12381g2:a$&b$'")).ckdNetworkKey).toBe("bls12381g2:a$&b$'");
    expect(() => setManifestString(text, 'nope', 'x')).toThrow();
  });
});

describe('near helpers', () => {
  it('amounts', () => {
    expect(nearToYocto('1')).toBe(10n ** 24n);
    expect(nearToYocto('0.25')).toBe(25n * 10n ** 22n);
    expect(() => nearToYocto('-1')).toThrow();
    expect(() => nearToYocto('1e3')).toThrow();
    expect(formatNear(15n * 10n ** 23n)).toBe('1.5000 NEAR');
  });

  it('access key descriptions', () => {
    const keys = [
      { public_key: 'ed25519:A', access_key: { nonce: 1, permission: 'FullAccess' as const } },
      { public_key: 'ed25519:B', access_key: { nonce: 1, permission: { FunctionCall: { allowance: null, receiver_id: 'signer.testnet', method_names: [] } } } },
      { public_key: 'ed25519:C', access_key: { nonce: 1, permission: { FunctionCall: { allowance: null, receiver_id: 'other.testnet', method_names: ['a', 'b'] } } } },
    ];
    expect(hasFullAccess(keys, 'ed25519:A')).toBe(true);
    expect(hasFullAccess(keys, 'ed25519:B')).toBe(false);
    expect(keys.map((k) => describePermission(k.access_key.permission))).toEqual([
      'a full-access key',
      'a function-call key for signer.testnet (ANY method)',
      'a function-call key for other.testnet (methods a, b)',
    ]);
  });

  it('outcome decoding', () => {
    const ok: FinalOutcome = { status: { SuccessValue: Buffer.from('"s1"').toString('base64') }, receipts_outcome: [], transaction: { hash: 'h' } };
    expect(successValue(ok)).toBe('s1');
    expect(failureText(ok)).toBeNull();
    const bad: FinalOutcome = {
      status: { SuccessValue: '' },
      receipts_outcome: [{ outcome: { logs: [], status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: nope' } } } } } } }],
      transaction: { hash: 'h' },
    };
    expect(failureText(bad)).toBe('Smart contract panicked: nope');
  });
});

describe('d1', () => {
  it('argv passes SQL as a single argument', () => {
    const m = { cloudflare: { d1Name: 'db', workerName: 'w' } } as Parameters<typeof d1Argv>[0];
    expect(d1Argv(m, "SELECT 'a b'", { remote: false })).toEqual(['exec', 'wrangler', 'd1', 'execute', 'db', '--local', '--json', '--command', "SELECT 'a b'"]);
    expect(d1Argv(m, 'x', { remote: true })).toContain('--remote');
  });

  it('parses wrangler JSON output', () => {
    expect(parseD1Json('some log\n[{"results":[{"id":1}],"success":true},{"results":[{"id":2}],"success":true}]')).toEqual([{ id: 1 }, { id: 2 }]);
    expect(() => parseD1Json('[{"success":false,"error":"boom"}]')).toThrow('boom');
  });
});
