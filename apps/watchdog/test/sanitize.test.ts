// On-chain strings in alerts (sanitize.ts), from the helpers to every channel and a full run: hostile kids with line
// breaks, Slack control sequences, huge lengths and non-ASCII never reach a header, Slack or an email as is.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { alertText } from '../src/alerts.ts';
import { type AlertMessage, emailSender, ntfyPager, pagerDutyPager, pushoverPager, sendgridEmail, slackSender } from '../src/channels.ts';
import { headerValue, ident, MAX_IDENT_CHARS, printable, slackEscape } from '../src/sanitize.ts';
import { alertsOf, initialized, jwk, NO_GRACE, T0 } from './helpers.ts';

/** Kids a compromised owner or updater could post (the contract allows any 1..=128 bytes). */
const HOSTILE = {
  newline: 'k1\r\nX-Injected: yes\n\nfake body',
  slack: '<!channel> <https://evil.example|click> &amp;',
  long: 'a'.repeat(128),
  unicode: 'kíd-🔑-‮reversed\u0000',
};
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/u;

afterEach(() => vi.restoreAllMocks());

describe('ident', () => {
  it('shows allow-listed identifiers as they are', () => {
    for (const v of ['k1', 'a1b2c3d4e5f6', 'google', 'signer.test.near', 'ed25519:7mEBxCsWzXSq3Rpy2RwEGWb7ux5YX4tdTnRvAYfGHuFc', 'Add', 'kid_with-dash.and:colon']) expect(ident(v)).toBe(v);
  });

  it('quotes and escapes anything else, as printable ASCII, cut to the maximum', () => {
    expect(ident(HOSTILE.newline)).toBe('"k1\\r\\nX-Injected: yes\\n\\nfake body"');
    expect(ident('a b')).toBe('"a b"');
    expect(ident('')).toBe('""');
    expect(ident('quo"te\\')).toBe('"quo\\"te\\\\"');
    expect(ident(HOSTILE.unicode)).toBe('"k\\u00edd-\\ud83d\\udd11-\\u202ereversed\\u0000"');
    const long = ident(HOSTILE.long);
    expect(long.length).toBe(MAX_IDENT_CHARS);
    expect(long.endsWith('...')).toBe(true);
    for (const v of Object.values(HOSTILE)) expect(ident(v)).toMatch(PRINTABLE_ASCII);
    expect(ident(42)).toBe('42');
    expect(ident(null)).toBe('null');
  });
});

describe('channel helpers', () => {
  it('printable escapes control and non-ASCII characters and keeps the rest', () => {
    expect(printable('a\nb\t"c" <d>')).toBe('a\\nb\\t"c" <d>');
    expect(printable('é')).toBe('\\u00e9');
  });

  it('headerValue drops CR, LF and non-ASCII, and caps the length', () => {
    expect(headerValue('a\r\nb: c\u0000é')).toBe('a b: c');
    expect(headerValue('x'.repeat(300))).toHaveLength(250);
  });

  it('slackEscape turns &, < and > into entities', () => {
    expect(slackEscape(HOSTILE.slack)).toBe('&lt;!channel&gt; &lt;https://evil.example|click&gt; &amp;amp;');
  });
});

const hostileMsg = (kid: string): AlertMessage => ({
  alertId: 9,
  severity: 'critical',
  kind: 'forged_key_change',
  // As a title would be built before this fix: the raw kid interpolated.
  title: `Forged issuer key ${kid} (change 3)`,
  text: `kid: ${kid}`,
  resend: false,
});

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A fetch stub that, like the real one, refuses header values with CR, LF or non-Latin-1 characters. */
function capture(reply: () => Response = () => new Response('ok')): Captured[] {
  const calls: Captured[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
      if (/[\r\n]/u.test(v) || /[^\x00-\xff]/u.test(v)) throw new TypeError(`invalid header value for ${k}`);
      headers[k.toLowerCase()] = v;
    }
    const body = init?.body instanceof URLSearchParams ? init.body.toString() : typeof init?.body === 'string' ? init.body : '';
    calls.push({ url: String(input), headers, body });
    return reply();
  });
  return calls;
}

describe('channels with hostile titles', () => {
  it.each(Object.entries(HOSTILE))('ntfy pages even with a %s kid: the title header is one printable line', async (_name, kid) => {
    const calls = capture();
    expect(await ntfyPager('https://ntfy.example.com/topic', undefined, 'e').send(hostileMsg(kid))).toEqual({ ok: true });
    expect(calls[0]!.headers.title).toMatch(PRINTABLE_ASCII);
    expect(calls[0]!.headers.title!.length).toBeLessThanOrEqual(250);
    expect(Object.keys(calls[0]!.headers)).not.toContain('x-injected');
  });

  it('Slack: no <!channel>, link or entity can be injected, in the title or the text', async () => {
    const calls = capture();
    await slackSender('https://hooks.slack.com/services/T/B/x', 'e').send(hostileMsg(HOSTILE.slack));
    const text = JSON.parse(calls[0]!.body).text as string;
    expect(text).not.toMatch(/[<>]/u);
    expect(text).toContain('&lt;!channel&gt;');
    expect(text).toContain('&amp;amp;');
    // The title stays on its line: the first line is the bold title, the rest is the text.
    await slackSender('https://hooks.slack.com/services/T/B/x', 'e').send(hostileMsg(HOSTILE.newline));
    const lines = (JSON.parse(calls[1]!.body).text as string).split('\n');
    expect(lines[0]).toMatch(/^\*CRITICAL: Forged issuer key k1 X-Injected: yes fake body \(change 3\) \[Hana ID e\]\*$/u);
  });

  it('email: the subject is one printable line', async () => {
    const calls = capture(() => new Response(null, { status: 202 }));
    await emailSender(sendgridEmail('SG.k', 'a@b.co'), ['x@y.co'], 'e').send(hostileMsg(HOSTILE.newline + HOSTILE.unicode));
    const subject = JSON.parse(calls[0]!.body).subject as string;
    expect(subject).toMatch(PRINTABLE_ASCII);
    expect(subject).not.toMatch(/[\r\n]/u);
  });

  it('Pushover and PagerDuty titles are one printable line', async () => {
    const calls = capture(() => Response.json({ status: 1 }));
    await pushoverPager('a'.repeat(30), 'u'.repeat(30), 'e').send(hostileMsg(HOSTILE.newline));
    expect(new URLSearchParams(calls[0]!.body).get('title')).toMatch(PRINTABLE_ASCII);
    await pagerDutyPager('r'.repeat(32), 'e').send(hostileMsg(HOSTILE.unicode));
    expect((JSON.parse(calls[1]!.body) as { payload: { summary: string } }).payload.summary).toMatch(PRINTABLE_ASCII);
  });
});

describe('alert texts', () => {
  it('show identifiers through the allow-list and escape every other value; one line per field', () => {
    const text = alertText(
      { id: 1, kind: 'forged_key_change', severity: 'warning', created_at: T0, details: { kid: HOSTILE.newline, provider: HOSTILE.slack, by: 'signer.test.near', note: 'x\ny', nested: { kid: HOSTILE.unicode } } },
      'e',
    );
    const lines = text.split('\n');
    expect(lines).toHaveLength(7); // five details, the alert line, the playbook line
    for (const l of lines) expect(l).toMatch(PRINTABLE_ASCII);
    expect(lines[0]).toBe('kid: "k1\\r\\nX-Injected: yes\\n\\nfake body"');
    expect(lines[2]).toBe('by: signer.test.near');
    expect(lines[3]).toBe('note: x\\ny');
  });
});

describe('a run with hostile kids', () => {
  it('cancels them and raises alerts whose titles are printable, escaped and bounded', async () => {
    const w = await initialized();
    const kids = Object.values(HOSTILE);
    for (const [i, kid] of kids.entries()) w.chain.propose('Add', kid, { key: jwk(`x${i}`, 40 + i), ...NO_GRACE });
    await w.run();
    expect(w.writer.methods().filter((m) => m === 'cancel_issuer_key_change')).toHaveLength(kids.length);
    const alerts = await alertsOf(w.store, 'forged_key_change');
    expect(alerts).toHaveLength(kids.length);
    for (const a of alerts) {
      expect(a.title).toMatch(PRINTABLE_ASCII);
      expect(a.title.length).toBeLessThan(250);
      // Not allow-listed: shown quoted (Slack's own escaping then neutralises the `<`, see above).
      expect(a.title).toContain(`issuer key "`);
    }
    expect(alerts.map((a) => a.title)).toContain(`Forged issuer key "<!channel> <https://evil.example|click> &amp;" (change ${alerts.find((a) => a.details.kid === HOSTILE.slack)!.details.id}): Google doesn't publish it; cancelled`);
    // The stored details keep the exact on-chain value for the portal.
    expect(alerts.map((a) => a.details.kid).sort()).toEqual([...kids].sort());
    // Everything delivered is one printable title and printable text lines.
    for (const s of w.notifier.sent) {
      expect(s.msg.title).toMatch(PRINTABLE_ASCII);
      for (const line of s.msg.text.split('\n')) expect(line).toMatch(PRINTABLE_ASCII);
    }
  });
});
