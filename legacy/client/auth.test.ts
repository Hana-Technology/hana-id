import { Buffer } from 'buffer';
import { describe, expect, it } from 'vitest';
import fixture from '../../../contracts/hana-signer/src/test_fixture.json';
import { sessionMessage, sessionNonce } from './auth';

describe('embed session encoding matches hana-signer', () => {
  it('computes the nonce the contract recomputes (same fixture as the Rust tests)', async () => {
    const claims = JSON.parse(Buffer.from(fixture.jwt.split('.')[1]!, 'base64url').toString()) as { nonce: string };
    const nonce = await sessionNonce(Uint8Array.from(Buffer.from(fixture.session_pk_hex, 'hex')), 1_800_000_000_000 + 3_600_000, new Uint8Array(16).fill(9));
    expect(nonce).toBe(claims.nonce);
  });

  it('builds domain ++ counter (u64 LE) ++ sha256(envelope)', async () => {
    const msg = await sessionMessage(258, new TextEncoder().encode('revoke'));
    const domain = new TextEncoder().encode('hana-embed-session-v1:');
    expect([...msg.slice(0, domain.length)]).toEqual([...domain]);
    expect([...msg.slice(domain.length, domain.length + 8)]).toEqual([2, 1, 0, 0, 0, 0, 0, 0]);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('revoke')));
    expect([...msg.slice(domain.length + 8)]).toEqual([...digest]);
  });
});
