// admin <env> watchdog:test-page (lib/admin-test-page.ts, D449): the dry run never POSTs, --yes reports each channel,
// failures say what to do and exit non-zero, and the token never reaches the terminal.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Manifest } from '@hana-id/env';
import { afterEach, describe, expect, it } from 'vitest';
import { assertCommandPositionals } from '../lib/admin-args.ts';
import { type TestPageDeps, statusTokenFromSecrets, watchdogTestPage } from '../lib/admin-test-page.ts';
import { CliError } from '../lib/cli.ts';

const TOKEN = 'status-token-for-tests-only-0123456789abcdef';
const ORIGIN = 'https://hana-id-watchdog-sandbox-test.example.workers.dev';
const m = { name: 'sandbox-test', watchdog: { url: ORIGIN } } as unknown as Manifest;

const PLAN = {
  dry_run: true,
  env: 'sandbox-test',
  network: 'testnet',
  severity: 'critical',
  title: '[SANDBOX] CRITICAL: TEST (no action needed): paging check [Journear Passport sandbox-test]',
  text: 'TEST PAGE. NO ACTION NEEDED.\nsecond line',
  channels: [
    { channel: 'pager', configured: true, provider: 'ntfy' },
    { channel: 'slack', configured: false },
    { channel: 'email', configured: true, recipients: 2 },
  ],
  cooldown_ms: 300_000,
  next_allowed_at: null,
};

const ALL_OK = { sent: true, ok: true, at: 1, results: [{ channel: 'pager', provider: 'ntfy', ok: true }, { channel: 'slack', ok: true }, { channel: 'email', ok: true }] };

interface Call {
  url: string;
  method: string;
  headers: Headers;
  redirect: RequestRedirect | undefined;
}

function deps(answers: { get?: () => Response; post?: () => Response } = {}, token: string | undefined = TOKEN) {
  const calls: Call[] = [];
  const lines: string[] = [];
  const d: TestPageDeps = {
    token: () => token,
    log: (l) => lines.push(l),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), redirect: init?.redirect });
      return init?.method === 'POST' ? (answers.post ?? (() => Response.json(ALL_OK)))() : (answers.get ?? (() => Response.json(PLAN)))();
    }) as typeof fetch,
  };
  return { d, calls, lines };
}

describe('watchdog:test-page', () => {
  it('by default is a dry run: only GET, the channels listed, nothing sent', async () => {
    const { d, calls, lines } = deps();
    await watchdogTestPage(m, false, d);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(calls[0]!.url).toBe(`${ORIGIN}/test-page`);
    const out = lines.join('\n');
    expect(out).toContain('TEST (no action needed)');
    expect(out).toMatch(/pager \(ntfy\) +configured/u);
    expect(out).toMatch(/slack +NOT CONFIGURED/u);
    expect(out).toMatch(/email +configured, 2 recipients/u);
    expect(out).toContain('Dry run: nothing was sent');
  });

  it('with --yes sends once, after the plan, and reports every channel', async () => {
    const { d, calls, lines } = deps();
    await watchdogTestPage(m, true, d);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    const out = lines.join('\n');
    expect(out).toMatch(/pager \(ntfy\) +ok/u);
    expect(out).toMatch(/slack +ok/u);
    expect(out).toContain('confirm with both founders');
    expect(out).toContain('no alert to acknowledge');
  });

  it('sends the token only as the bearer, follows no redirect, and never prints it', async () => {
    const { d, calls, lines } = deps();
    await watchdogTestPage(m, true, d);
    for (const c of calls) {
      expect(c.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(c.redirect).toBe('manual');
    }
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  it('a failed channel prints FAILED with its reason and exits non-zero', async () => {
    const report = { sent: true, ok: false, at: 1, results: [{ channel: 'pager', provider: 'ntfy', ok: false, error: 'HTTP 429' }, { channel: 'slack', ok: true }, { channel: 'email', ok: true }] };
    const { d, lines } = deps({ post: () => Response.json(report) });
    await expect(watchdogTestPage(m, true, d)).rejects.toThrow(/1 of 3 channels failed/u);
    expect(lines.join('\n')).toMatch(/pager \(ntfy\) +FAILED: HTTP 429/u);
    expect(lines.join('\n')).not.toContain('confirm with both founders');
  });

  it('refuses a watchdog that is another env, and sends nothing', async () => {
    const { d, calls } = deps({ get: () => Response.json({ ...PLAN, env: 'production-x' }) });
    await expect(watchdogTestPage(m, true, d)).rejects.toThrow(/is production-x, not sandbox-test/u);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('a Worker without the route says it needs a redeploy', async () => {
    const { d } = deps({ get: () => Response.json({ code: 'not_found' }, { status: 404 }) });
    await expect(watchdogTestPage(m, false, d)).rejects.toThrow(/redeploy/u);
  });

  it('a wrong token names the file, never the value', async () => {
    const { d } = deps({ get: () => new Response('{}', { status: 401 }) });
    const err = await watchdogTestPage(m, false, d).catch((e: Error) => e);
    expect((err as Error).message).toContain('watchdog-secrets.json');
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('the cooldown says how long to wait and sent nothing', async () => {
    const { d } = deps({ post: () => Response.json({ code: 'test_page_cooldown', retry_after_ms: 90_000 }, { status: 429 }) });
    await expect(watchdogTestPage(m, true, d)).rejects.toThrow(/2 min ago; nothing was sent/u);
  });

  it('a lost answer to the send does not claim either way', async () => {
    const { d } = deps();
    d.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error(`socket closed with ${TOKEN}`);
      return Response.json(PLAN);
    }) as typeof fetch;
    const err = (await watchdogTestPage(m, true, d).catch((e: Error) => e)) as Error;
    expect(err.message).toContain('may or may not have gone out');
    expect(err.message).not.toContain(TOKEN);
  });

  it('strips control characters from what the Worker answers', async () => {
    const { d, lines } = deps({ get: () => Response.json({ ...PLAN, title: 'x\u001b[2Jy' }) });
    await watchdogTestPage(m, false, d);
    expect(lines.join('\n')).not.toContain('\u001b');
  });

  it('refuses an env with no watchdog.url or no token, as usage errors', async () => {
    await expect(watchdogTestPage({ name: 'x' } as unknown as Manifest, false, deps().d)).rejects.toBeInstanceOf(CliError);
    const { d } = deps();
    d.token = () => undefined;
    await expect(watchdogTestPage(m, false, d)).rejects.toBeInstanceOf(CliError);
  });

  it('takes no positional argument', () => {
    expect(() => assertCommandPositionals('watchdog:test-page', [])).not.toThrow();
    expect(() => assertCommandPositionals('watchdog:test-page', ['x'])).toThrow('Unexpected argument x');
  });
});

describe('statusTokenFromSecrets', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function root(mode: number | null): string {
    const dir = mkdtempSync(join(tmpdir(), 'test-page-'));
    dirs.push(dir);
    if (mode !== null) {
      mkdirSync(join(dir, '.secrets', 'sandbox-test'), { recursive: true });
      writeFileSync(join(dir, '.secrets', 'sandbox-test', 'watchdog-secrets.json'), JSON.stringify({ WATCHDOG_STATUS_TOKEN: TOKEN }), { mode });
    }
    return dir;
  }

  it('reads the token from the 0600 file', () => {
    expect(statusTokenFromSecrets('sandbox-test', root(0o600))).toBe(TOKEN);
  });

  it('is undefined without the file', () => {
    expect(statusTokenFromSecrets('sandbox-test', root(null))).toBe(undefined);
  });

  it('refuses a file others can read, without printing it', () => {
    const r = root(0o644);
    let message = '';
    try {
      statusTokenFromSecrets('sandbox-test', r);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(TOKEN);
  });
});
