import { describe, expect, it } from 'vitest';
import { readJson } from '../src/http.ts';
import { ipSubject } from '../src/ip.ts';

/** A body stream with no Content-Length that would go on far past any limit; counts the chunks pulled. */
function endless(chunk = 1024): { stream: ReadableStream<Uint8Array>; pulled: () => number } {
  let n = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      n++;
      if (n > 100_000) controller.close();
      else controller.enqueue(new Uint8Array(chunk).fill(0x20));
    },
  });
  return { stream, pulled: () => n };
}

describe('readJson', () => {
  it('stops reading a chunked body as soon as it passes the limit', async () => {
    const { stream, pulled } = endless();
    const request = new Request('https://api.test/x', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    expect(request.headers.get('content-length')).toBeNull();
    const res = await readJson(request, 16 * 1024);
    expect(res).toMatchObject({ ok: false, status: 413 });
    expect(pulled()).toBeLessThan(40);
  });

  it('rejects a declared Content-Length over the limit without reading', async () => {
    const request = new Request('https://api.test/x', { method: 'POST', body: '{}', headers: { 'content-length': '999999' } });
    expect(await readJson(request, 1024)).toMatchObject({ ok: false, status: 413 });
  });

  it('reads bodies up to the limit, split across chunks', async () => {
    const text = JSON.stringify({ a: 'é'.repeat(100) });
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        // Split inside a multi-byte character.
        c.enqueue(bytes.slice(0, 7));
        c.enqueue(bytes.slice(7));
        c.close();
      },
    });
    const request = new Request('https://api.test/x', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    expect(await readJson(request, bytes.length)).toEqual({ ok: true, body: { a: 'é'.repeat(100) } });
    expect(await readJson(new Request('https://api.test/x', { method: 'POST', body: text }), bytes.length - 1)).toMatchObject({ ok: false, status: 413 });
    expect(await readJson(new Request('https://api.test/x', { method: 'POST', body: 'nope' }), 100)).toMatchObject({ ok: false, status: 400 });
  });
});

describe('ipSubject', () => {
  it('keys IPv4 on the address and IPv6 on its /64', () => {
    expect(ipSubject('203.0.113.7')).toBe('v4:203.0.113.7');
    expect(ipSubject('2001:db8:aa:bb::1')).toBe('v6:2001:db8:aa:bb::/64');
    expect(ipSubject('2001:0DB8:00aa:00bb:1:2:3:4')).toBe('v6:2001:db8:aa:bb::/64');
    expect(ipSubject('2001:db8:aa:bb:ffff:ffff:ffff:ffff')).toBe(ipSubject('2001:db8:aa:bb::'));
    expect(ipSubject('2001:db8:aa:bc::1')).not.toBe(ipSubject('2001:db8:aa:bb::1'));
    expect(ipSubject('2001:db8::1')).toBe('v6:2001:db8:0:0::/64');
    expect(ipSubject('::1')).toBe('v6:0:0:0:0::/64');
    expect(ipSubject('fe80::1%eth0')).toBe('v6:fe80:0:0:0::/64');
  });

  it('treats IPv4-mapped IPv6 as IPv4', () => {
    expect(ipSubject('::ffff:203.0.113.7')).toBe('v4:203.0.113.7');
    expect(ipSubject('::ffff:cb00:7107')).toBe('v4:203.0.113.7');
  });

  it('never throws on junk', () => {
    for (const junk of [null, '', 'unknown', '1.2.3.999', '1:2:3', ':::', '1::2::3', 'g::1', '1:2:3:4:5:6:7:8:9']) {
      expect(ipSubject(junk).startsWith('other:'), String(junk)).toBe(true);
    }
  });
});
