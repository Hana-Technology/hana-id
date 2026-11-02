// Runs in workerd (vitest.workerd.config.ts): the frozen vectors must give the same answers in the Workers runtime as
// in Node, with workerd's own V8 and ICU.
import { describe, expect, it } from 'vitest';
import { emailSub, importSubKey, isDisposableDomain, isGoogleHosted, normalizeEmail } from '../src/index.ts';
import V from '../vectors/email-v1.json';

async function testKey(): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(V.testKey.preimage)));
}

describe('email v1 vectors in workerd', () => {
  it('runs in workerd, not Node', () => {
    expect(typeof navigator !== 'undefined' && navigator.userAgent).toBe('Cloudflare-Workers');
  });

  it.each(V.normalize)('normalize: $label', (v) => {
    const r = normalizeEmail(v.in);
    expect(r.ok && r.email).toBe(v.out);
  });

  it.each(V.reject)('reject: $label', (v) => {
    expect(normalizeEmail(v.in).ok).toBe(false);
  });

  it('every sub vector', async () => {
    const raw = await testKey();
    const key = await importSubKey(raw);
    for (const v of V.sub) {
      expect(await emailSub(key, v.email)).toBe(v.sub);
      expect(await emailSub(raw, v.email)).toBe(v.sub);
    }
  });

  it('the Google-hosted rule and the disposable list', () => {
    expect(isGoogleHosted({ email: 'ab@gmail.com', emailVerified: true })).toBe(true);
    expect(isGoogleHosted({ email: 'ab@gmail.com', emailVerified: true, hd: 'example.com' })).toBe(false);
    expect(isDisposableDomain('x.mailinator.com')).toBe(true);
    expect(isDisposableDomain('gmail.com')).toBe(false);
  });
});
