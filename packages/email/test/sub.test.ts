import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EMAIL_V1, emailSub, importSubKey, isEmailSub, subMessage } from '../src/index.ts';
import { testKey } from './helpers.ts';

describe('emailSub', () => {
  it('is "e1." + b64url(HMAC-SHA256(K_sub, label ‖ 0x00 ‖ utf8(normalized))): 46 characters, no #', async () => {
    const key = testKey();
    const email = 'alice@example.com';
    const expected = `e1.${createHmac('sha256', key).update(Buffer.from(`hana-id/email-sub/v1\0${email}`, 'utf8')).digest('base64url')}`;
    const sub = await emailSub(key, email);
    expect(sub).toBe(expected);
    expect(sub).toHaveLength(46);
    expect(sub).not.toContain('#');
    expect(isEmailSub(sub)).toBe(true);
  });

  it('authenticates exactly label ‖ 0x00 ‖ utf8(normalized)', () => {
    const m = subMessage('a@b.co');
    expect(Buffer.from(m).toString('hex')).toBe(Buffer.from('hana-id/email-sub/v1\u0000a@b.co', 'utf8').toString('hex'));
    expect(m[EMAIL_V1.subLabel.length]).toBe(0);
  });

  it('depends on the key', async () => {
    const other = testKey();
    other[0]! ^= 1;
    expect(await emailSub(other, 'alice@example.com')).not.toBe(await emailSub(testKey(), 'alice@example.com'));
  });

  it('refuses an address that is not normalizeEmail output (raw input never reaches the HMAC)', async () => {
    for (const raw of ['Alice@example.com', ' alice@example.com', 'a.b@gmail.com', 'ab@googlemail.com', 'x@faß.de', 'alice@example.com.', 'not an email', '']) {
      await expect(emailSub(testKey(), raw)).rejects.toThrow(TypeError);
    }
  });

  it('refuses a key that is not 32 bytes or not an HMAC-SHA256 signing key', async () => {
    await expect(emailSub(new Uint8Array(31), 'alice@example.com')).rejects.toThrow(TypeError);
    await expect(emailSub(new Uint8Array(33), 'alice@example.com')).rejects.toThrow(TypeError);
    await expect(importSubKey(new Uint8Array(16))).rejects.toThrow(TypeError);
    await expect(importSubKey('x'.repeat(32) as unknown as Uint8Array)).rejects.toThrow(TypeError);
    const raw = testKey();
    const sha384 = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-384' }, false, ['sign']);
    await expect(emailSub(sha384, 'alice@example.com')).rejects.toThrow(TypeError);
    const short = await crypto.subtle.importKey('raw', new Uint8Array(16), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    await expect(emailSub(short, 'alice@example.com')).rejects.toThrow(TypeError);
    const verifyOnly = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    await expect(emailSub(verifyOnly, 'alice@example.com')).rejects.toThrow(TypeError);
  });

  it('imports K_sub non-extractable and leaves the caller\'s bytes intact', async () => {
    const raw = testKey();
    const key = await importSubKey(raw);
    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(['sign']);
    expect(raw).toEqual(testKey());
  });
});

describe('isEmailSub', () => {
  it('accepts only the e1. shape of a 32-byte MAC', async () => {
    expect(isEmailSub(await emailSub(testKey(), 'x@example.com'))).toBe(true);
    for (const bad of ['', 'e1.', `e2.${'A'.repeat(43)}`, `e1.${'A'.repeat(42)}`, `e1.${'A'.repeat(44)}`, `e1.${'A'.repeat(42)}B`, `e1.${'A'.repeat(42)}=`, `e1.${'+'.repeat(43)}`, 42, null]) {
      expect(isEmailSub(bad)).toBe(false);
    }
    expect(isEmailSub(`e1.${'A'.repeat(42)}w`)).toBe(true);
  });
});
