// The sealed email (src/sealed.ts, D419): the AAD against @hana-id/core's pinned vector, an independent node:crypto
// open of what sealEmail writes, and every refusal openSealedEmail must make.
import { createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SEALED_EMAIL_PREFIX, openSealedEmail, parseSealKey, sealEmail, sealedEmailAad, sealedEmailHeader } from '../src/index.ts';
import { PKG } from './helpers.ts';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const keyValue = (id: number, raw: Uint8Array = randomBytes(32)): string => `${id}:${Buffer.from(raw).toString('base64')}`;
const PK = new Uint8Array(32).fill(7);
const NOW = 1_800_000_000_000;
const base = { appId: 'app_0123456789abcdef', sessionPublicKey: PK, notAfterMs: NOW + 3_600_000, email: 'ada@example.com', src: 'google' as const };

describe('sealedEmailAad', () => {
  it("is core's pinned layout (packages/core/test/vectors/identity-v1.json)", () => {
    const vectors = JSON.parse(readFileSync(join(PKG, '../core/test/vectors/identity-v1.json'), 'utf8')) as { layouts?: Record<string, { preimage_hex: string; not_after_ms: number }> } & Record<string, unknown>;
    const find = (o: unknown): { preimage_hex: string; not_after_ms: number } | null => {
      if (!o || typeof o !== 'object') return null;
      const r = o as Record<string, unknown>;
      if (r.sealed_email_aad) return r.sealed_email_aad as { preimage_hex: string; not_after_ms: number };
      for (const v of Object.values(r)) {
        const f = find(v);
        if (f) return f;
      }
      return null;
    };
    const v = find(vectors);
    expect(v).not.toBeNull();
    // core's vectors use the session key of seed [7; 32]; its public key is in the preimage after the app id.
    const pre = Buffer.from(v!.preimage_hex, 'hex');
    const pk = pre.subarray(pre.length - 40, pre.length - 8);
    expect(hex(sealedEmailAad('app_0123456789abcdef', pk, v!.not_after_ms))).toBe(v!.preimage_hex);
  });
});

describe('parseSealKey', () => {
  it('takes <id>:<base64 of 32 bytes> with id 1..2^32-1, nothing else', async () => {
    expect((await parseSealKey(keyValue(1)))?.id).toBe(1);
    expect((await parseSealKey(` ${keyValue(4294967295)}\n`))?.id).toBe(4294967295);
    for (const bad of [undefined, '', keyValue(0), keyValue(4294967296), `1:${Buffer.from(randomBytes(31)).toString('base64')}`, '1:not-base64', `x:${Buffer.from(randomBytes(32)).toString('base64')}`]) {
      expect(await parseSealKey(bad)).toBeNull();
    }
  });
});

describe('sealEmail / openSealedEmail', () => {
  it('seals se1. ‖ b64url(u32le id ‖ u64le not_after ‖ iv ‖ AES-256-GCM): node:crypto opens it with the AAD', async () => {
    const raw = randomBytes(32);
    const key = (await parseSealKey(keyValue(9, raw)))!;
    const blob = await sealEmail(key, base);
    expect(blob.startsWith(SEALED_EMAIL_PREFIX)).toBe(true);
    const bytes = Buffer.from(blob.slice(4), 'base64url');
    expect(bytes.readUInt32LE(0)).toBe(9);
    expect(Number(bytes.readBigUInt64LE(4))).toBe(base.notAfterMs);
    const iv = bytes.subarray(12, 24);
    const ct = bytes.subarray(24, bytes.length - 16);
    const tag = bytes.subarray(bytes.length - 16);
    const d = createDecipheriv('aes-256-gcm', raw, iv);
    d.setAAD(sealedEmailAad(base.appId, PK, base.notAfterMs));
    d.setAuthTag(tag);
    const pt = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    expect(JSON.parse(pt)).toEqual({ email: 'ada@example.com', src: 'google' });
    expect(sealedEmailHeader(blob)).toEqual({ keyId: 9, notAfterMs: base.notAfterMs });
    // The address is never readable from the blob.
    expect(blob).not.toContain('ada');
  });

  it('opens for its app and session until not_after, with the key of its id (a rotation keeps the previous one)', async () => {
    const prev = (await parseSealKey(keyValue(1)))!;
    const cur = (await parseSealKey(keyValue(2)))!;
    const blob = await sealEmail(prev, { ...base, src: 'email' });
    expect(await openSealedEmail([cur, prev], blob, { appId: base.appId, sessionPublicKey: PK, nowMs: NOW })).toEqual({ ok: true, email: 'ada@example.com', src: 'email', notAfterMs: base.notAfterMs });
    expect(await openSealedEmail([cur], blob, { appId: base.appId, sessionPublicKey: PK, nowMs: NOW })).toEqual({ ok: false, reason: 'unknown_key' });
  });

  it('refuses another app, another session, an expired, tampered or malformed blob', async () => {
    const key = (await parseSealKey(keyValue(3)))!;
    const blob = await sealEmail(key, base);
    const open = (b: unknown, o: Partial<{ appId: string; sessionPublicKey: Uint8Array; nowMs: number }> = {}) =>
      openSealedEmail([key], b, { appId: base.appId, sessionPublicKey: PK, nowMs: NOW, ...o });
    expect(await open(blob, { appId: 'app_other' })).toEqual({ ok: false, reason: 'bad_seal' });
    expect(await open(blob, { sessionPublicKey: new Uint8Array(32).fill(8) })).toEqual({ ok: false, reason: 'bad_seal' });
    expect(await open(blob, { nowMs: base.notAfterMs })).toEqual({ ok: false, reason: 'expired' });
    const bytes = Buffer.from(blob.slice(4), 'base64url');
    bytes[bytes.length - 1]! ^= 1;
    expect(await open(`se1.${bytes.toString('base64url')}`)).toEqual({ ok: false, reason: 'bad_seal' });
    // A moved expiry is caught by the AAD.
    const moved = Buffer.from(blob.slice(4), 'base64url');
    moved.writeBigUInt64LE(BigInt(base.notAfterMs + 1), 4);
    expect(await open(`se1.${moved.toString('base64url')}`)).toEqual({ ok: false, reason: 'bad_seal' });
    for (const bad of [null, 42, '', 'se1.', 'se2.AAAA', `se1.${'A'.repeat(2000)}`, 'se1.!!!!']) expect(await open(bad)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses to seal what is not an address', async () => {
    const key = (await parseSealKey(keyValue(3)))!;
    await expect(sealEmail(key, { ...base, email: 'nope' })).rejects.toThrow('Not an address');
    await expect(sealEmail(key, { ...base, email: `${'a'.repeat(250)}@b.co` })).rejects.toThrow('Not an address');
    await expect(sealEmail(key, { ...base, src: 'apple' as 'google' })).rejects.toThrow('Unknown address source');
  });
});
