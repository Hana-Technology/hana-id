// lib/d1.ts issuerD1Execute: the email issuer's statements (which can hold a user's address) never go in a process
// argument. Local: a 0600 file in .secrets/tmp (0700) passed as --file and deleted after, a killed run's leftovers
// swept. Remote: D1's REST query endpoint with the operator's wrangler credentials, the statement in the body. Errors
// never quote the statement or a credential.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Manifest } from '@hana-id/env';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CloudflareFetch, type IssuerD1Deps, STALE_SQL_FILE_MS, apiPrivateD1Execute, cloudflareApiBase, issuerD1Execute, parseD1Json, redactQuoted, withPrivateSqlFile } from '../lib/d1.ts';

const ADDRESS = 'alice.private@example.com';
const STATEMENT = `SELECT * FROM user_emails u WHERE u.email IN ('${ADDRESS}')`;
const M = { name: 'sandbox-dev', cloudflare: { d1Name: 'hana-id-sandbox-dev' }, emailIssuer: { cloudflare: { d1Name: 'hana-id-email-issuer-sandbox-dev', workerName: 'w' } } } as unknown as Manifest;
const ACCOUNT = 'a'.repeat(32);
const UUID = '12345678-90ab-cdef-1234-567890abcdef';
const TOKEN = 'cf-oauth-token-value';
const ROWS = [{ provider: 'email', sub: 'e1.a' }];

let root: string;
let sqlDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hana-d1-'));
  sqlDir = join(root, '.secrets', 'tmp');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const mode = (p: string): number => statSync(p).mode & 0o777;

describe('withPrivateSqlFile', () => {
  it('writes the statement to a 0600 file in a 0700 .secrets/tmp, and deletes it after', () => {
    let seen = '';
    const out = withPrivateSqlFile(
      STATEMENT,
      (file) => {
        seen = file;
        expect(file.startsWith(`${sqlDir}/`)).toBe(true);
        expect(file).toMatch(/\/d1-[0-9a-f]{24}\.sql$/u);
        expect(readFileSync(file, 'utf8')).toBe(STATEMENT);
        expect(mode(file)).toBe(0o600);
        return 42;
      },
      sqlDir,
    );
    expect(out).toBe(42);
    expect(mode(sqlDir)).toBe(0o700);
    expect(mode(join(root, '.secrets'))).toBe(0o700);
    expect(existsSync(seen)).toBe(false);
    expect(readdirSync(sqlDir)).toEqual([]);
  });

  it('deletes the file when the callback throws', () => {
    expect(() =>
      withPrivateSqlFile(
        STATEMENT,
        () => {
          throw new Error('wrangler failed');
        },
        sqlDir,
      ),
    ).toThrow('wrangler failed');
    expect(readdirSync(sqlDir)).toEqual([]);
  });

  it('tightens an existing, looser directory to 0700', () => {
    mkdirSync(sqlDir, { recursive: true, mode: 0o755 });
    withPrivateSqlFile('SELECT 1', () => undefined, sqlDir);
    expect(mode(sqlDir)).toBe(0o700);
  });

  it('removes its own files older than 15 minutes (a killed run), keeps fresh ones and anything else', () => {
    mkdirSync(sqlDir, { recursive: true, mode: 0o700 });
    const now = Date.now();
    const stale = join(sqlDir, `d1-${'1'.repeat(24)}.sql`);
    const fresh = join(sqlDir, `d1-${'2'.repeat(24)}.sql`);
    const other = join(sqlDir, 'notes.sql');
    for (const f of [stale, fresh, other]) writeFileSync(f, 'x', { mode: 0o600 });
    const old = (now - STALE_SQL_FILE_MS - 60_000) / 1000;
    utimesSync(stale, old, old);
    utimesSync(other, old, old);
    withPrivateSqlFile('SELECT 1', () => undefined, sqlDir, now);
    expect(readdirSync(sqlDir).sort()).toEqual([`d1-${'2'.repeat(24)}.sql`, 'notes.sql']);
  });

  it('refuses a directory outside .secrets', () => {
    expect(() => withPrivateSqlFile('SELECT 1', () => undefined, join(root, 'tmp'))).toThrow('inside a .secrets directory');
    expect(existsSync(join(root, 'tmp'))).toBe(false);
  });
});

interface Calls {
  wrangler: string[][];
  fetch: { url: string; method: string; headers: Record<string, string>; body?: string }[];
}

function deps(over: { env?: Record<string, string>; token?: string; routes?: Record<string, { status: number; json: unknown }>; tokenFails?: boolean } = {}): { d: IssuerD1Deps; calls: Calls } {
  const calls: Calls = { wrangler: [], fetch: [] };
  const routes: Record<string, { status: number; json: unknown }> = {
    [`GET /accounts?per_page=50`]: { status: 200, json: { success: true, result: [{ id: ACCOUNT, name: 'Hana' }] } },
    [`GET /accounts/${ACCOUNT}/d1/database/hana-id-email-issuer-sandbox-dev`]: { status: 200, json: { success: true, result: { uuid: UUID, name: 'hana-id-email-issuer-sandbox-dev' } } },
    [`POST /accounts/${ACCOUNT}/d1/database/${UUID}/query`]: { status: 200, json: { success: true, errors: [], result: [{ results: ROWS, success: true, meta: {} }] } },
    ...over.routes,
  };
  const fetch: CloudflareFetch = async (url, init) => {
    calls.fetch.push({ url, method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
    const path = url.replace('https://api.cloudflare.com/client/v4', '');
    const r = routes[`${init.method} ${path}`];
    if (!r) throw new Error(`unexpected ${init.method} ${url}`);
    return r;
  };
  const d: IssuerD1Deps = {
    wrangler: (argv) => {
      calls.wrangler.push(argv);
      if (argv.includes('auth')) {
        if (over.tokenFails) throw new Error(`wrangler auth token failed: ${TOKEN}`);
        return over.token ?? `\n${JSON.stringify({ type: 'oauth', token: TOKEN }, null, 2)}\n`;
      }
      const file = argv[argv.indexOf('--file') + 1]!;
      expect(readFileSync(file, 'utf8')).toBe(STATEMENT);
      return `🌀 Executing on local database\n${JSON.stringify([{ results: ROWS, success: true, meta: {} }])}`;
    },
    requireLocalConfig: () => undefined,
    fetch,
    env: over.env ?? {},
    sqlDir,
  };
  return { d, calls };
}

const noArgvHoldsTheAddress = (calls: Calls): void => {
  for (const argv of calls.wrangler) for (const a of argv) expect(a).not.toContain(ADDRESS);
};

describe('issuerD1Execute, local', () => {
  it('runs wrangler with --file, never the statement in the argv, and returns the rows; the file is gone after', async () => {
    const { d, calls } = deps();
    expect(await issuerD1Execute(M, STATEMENT, { remote: false }, d)).toEqual(ROWS);
    expect(calls.wrangler).toHaveLength(1);
    const argv = calls.wrangler[0]!;
    expect(argv.slice(0, 8)).toEqual(['exec', 'wrangler', 'd1', 'execute', 'hana-id-email-issuer-sandbox-dev', '--local', '--json', '--file']);
    expect(argv).not.toContain('--command');
    noArgvHoldsTheAddress(calls);
    expect(calls.fetch).toEqual([]);
    expect(readdirSync(sqlDir)).toEqual([]);
  });

  it('a D1 error is reported without the statement’s quoted values; the file is still deleted', async () => {
    const { d } = deps();
    d.wrangler = () => JSON.stringify([{ success: false, error: { message: `near "${ADDRESS}": syntax error` } }]);
    const err = await issuerD1Execute(M, STATEMENT, { remote: false }, d).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("D1 error: near '…': syntax error");
    expect(readdirSync(sqlDir)).toEqual([]);
  });

  it('needs the issuer’s wrangler config', async () => {
    const { d } = deps();
    d.requireLocalConfig = (env) => {
      throw new Error(`No wrangler config (${env})`);
    };
    await expect(issuerD1Execute(M, STATEMENT, { remote: false }, d)).rejects.toThrow('No wrangler config (sandbox-dev)');
  });
});

describe('apiPrivateD1Execute: the wallet directory’s reads of the API’s D1 (D316)', () => {
  it('locally: wrangler with --file on the API’s database, never the statement in the argv; the file is gone after', async () => {
    const { d, calls } = deps();
    expect(await apiPrivateD1Execute(M, STATEMENT, { remote: false }, d)).toEqual(ROWS);
    const argv = calls.wrangler[0]!;
    expect(argv.slice(0, 8)).toEqual(['exec', 'wrangler', 'd1', 'execute', M.cloudflare.d1Name, '--local', '--json', '--file']);
    expect(argv).not.toContain('--command');
    noArgvHoldsTheAddress(calls);
    expect(readdirSync(sqlDir)).toEqual([]);
  });

  it('remotely: D1’s REST query on the API’s database, the statement in the body only', async () => {
    const { d, calls } = deps({
      routes: {
        [`GET /accounts/${ACCOUNT}/d1/database/${M.cloudflare.d1Name}`]: { status: 200, json: { success: true, result: { uuid: UUID, name: M.cloudflare.d1Name } } },
      },
    });
    expect(await apiPrivateD1Execute(M, STATEMENT, { remote: true }, d)).toEqual(ROWS);
    noArgvHoldsTheAddress(calls);
    expect(calls.fetch.map((c) => c.url.replace('https://api.cloudflare.com/client/v4', ''))).toContain(`/accounts/${ACCOUNT}/d1/database/${M.cloudflare.d1Name}`);
    expect(JSON.parse(calls.fetch.at(-1)!.body!)).toEqual({ sql: STATEMENT });
  });
});

describe('issuerD1Execute, remote: D1’s REST API, not wrangler --remote', () => {
  it('reads the credentials from wrangler over a pipe, finds the account and the database, posts the statement in the body', async () => {
    const { d, calls } = deps();
    expect(await issuerD1Execute(M, STATEMENT, { remote: true }, d)).toEqual(ROWS);
    expect(calls.wrangler).toEqual([['exec', 'wrangler', 'auth', 'token', '--json']]);
    noArgvHoldsTheAddress(calls);
    expect(calls.fetch.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://api.cloudflare.com/client/v4/accounts?per_page=50',
      `GET https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/hana-id-email-issuer-sandbox-dev`,
      `POST https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${UUID}/query`,
    ]);
    for (const c of calls.fetch) expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const q = calls.fetch[2]!;
    expect(q.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(q.body!)).toEqual({ sql: STATEMENT });
    // Only the query carries the statement.
    expect(calls.fetch.slice(0, 2).every((c) => c.body === undefined && !c.url.includes(ADDRESS))).toBe(true);
    expect(existsSync(sqlDir)).toBe(false);
  });

  it('CLOUDFLARE_ACCOUNT_ID skips the account list; a malformed one is refused', async () => {
    const { d, calls } = deps({ env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT } });
    await issuerD1Execute(M, STATEMENT, { remote: true }, d);
    expect(calls.fetch.map((c) => c.url).some((u) => u.endsWith('/accounts?per_page=50'))).toBe(false);
    await expect(issuerD1Execute(M, STATEMENT, { remote: true }, deps({ env: { CLOUDFLARE_ACCOUNT_ID: 'nope' } }).d)).rejects.toThrow('CLOUDFLARE_ACCOUNT_ID must be 32 lowercase hex');
  });

  it('several accounts, or none: asks for CLOUDFLARE_ACCOUNT_ID, sends nothing else', async () => {
    const two = deps({ routes: { [`GET /accounts?per_page=50`]: { status: 200, json: { success: true, result: [{ id: ACCOUNT }, { id: 'b'.repeat(32) }] } } } });
    await expect(issuerD1Execute(M, STATEMENT, { remote: true }, two.d)).rejects.toThrow('reach 2 accounts: set CLOUDFLARE_ACCOUNT_ID');
    expect(two.calls.fetch).toHaveLength(1);
    const none = deps({ routes: { [`GET /accounts?per_page=50`]: { status: 200, json: { success: true, result: [] } } } });
    await expect(issuerD1Execute(M, STATEMENT, { remote: true }, none.d)).rejects.toThrow('reach no account');
  });

  it('an API token and a global API key become their headers', async () => {
    const t = deps({ token: JSON.stringify({ type: 'api_token', token: 'tok' }) });
    await issuerD1Execute(M, STATEMENT, { remote: true }, t.d);
    expect(t.calls.fetch[0]!.headers.Authorization).toBe('Bearer tok');
    const k = deps({ token: JSON.stringify({ type: 'api_key', key: 'k', email: 'ops@hana.example' }) });
    await issuerD1Execute(M, STATEMENT, { remote: true }, k.d);
    expect(k.calls.fetch[0]!.headers).toEqual({ 'X-Auth-Key': 'k', 'X-Auth-Email': 'ops@hana.example' });
  });

  it('no credentials: a login hint that never quotes wrangler’s output; unusable output is refused', async () => {
    const err = await issuerD1Execute(M, STATEMENT, { remote: true }, deps({ tokenFails: true }).d).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^No Cloudflare credentials: run `corepack pnpm --dir apps\/email-issuer exec wrangler login`/u);
    expect((err as Error).message).not.toContain(TOKEN);
    await expect(issuerD1Execute(M, STATEMENT, { remote: true }, deps({ token: 'not json' }).d)).rejects.toThrow('returned no usable credentials');
    await expect(issuerD1Execute(M, STATEMENT, { remote: true }, deps({ token: JSON.stringify({ type: 'oauth' }) }).d)).rejects.toThrow('returned no usable credentials');
  });

  it('a database that isn’t the issuer’s is refused before any query', async () => {
    const { d, calls } = deps({ routes: { [`GET /accounts/${ACCOUNT}/d1/database/hana-id-email-issuer-sandbox-dev`]: { status: 200, json: { success: true, result: { uuid: UUID, name: 'other' } } } } });
    await expect(issuerD1Execute(M, STATEMENT, { remote: true }, d)).rejects.toThrow('No D1 database named hana-id-email-issuer-sandbox-dev');
    expect(calls.fetch.some((c) => c.method === 'POST')).toBe(false);
  });

  it('HTTP and D1 failures name codes and messages with quoted values redacted, never the statement', async () => {
    const query = `POST /accounts/${ACCOUNT}/d1/database/${UUID}/query`;
    const denied = deps({ routes: { [query]: { status: 403, json: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] } } } });
    await expect(issuerD1Execute(M, STATEMENT, { remote: true }, denied.d)).rejects.toThrow('Cloudflare D1 query on hana-id-email-issuer-sandbox-dev failed (HTTP 403): 10000 Authentication error (check `wrangler whoami`');
    const bad = deps({ routes: { [query]: { status: 400, json: { success: false, errors: [{ code: 7500, message: `near "${ADDRESS}": syntax error at offset 40: SQLITE_ERROR` }] } } } });
    const e1 = (await issuerD1Execute(M, STATEMENT, { remote: true }, bad.d).catch((e: Error) => e)) as Error;
    expect(e1.message).toBe("Cloudflare D1 query on hana-id-email-issuer-sandbox-dev failed (HTTP 400): 7500 near '…': syntax error at offset 40: SQLITE_ERROR");
    const stmt = deps({ routes: { [query]: { status: 200, json: { success: true, result: [{ success: false, error: { message: `no such table: user_emails near '${ADDRESS}'` } }] } } } });
    const e2 = (await issuerD1Execute(M, STATEMENT, { remote: true }, stmt.d).catch((e: Error) => e)) as Error;
    expect(e2.message).toBe("D1 error: no such table: user_emails near '…'");
    const odd = deps({ routes: { [query]: { status: 200, json: { success: true, result: [{ success: false, error: { sql: STATEMENT } }] } } } });
    const e3 = (await issuerD1Execute(M, STATEMENT, { remote: true }, odd.d).catch((e: Error) => e)) as Error;
    expect(e3.message).toBe('D1 error: (details withheld: they could quote the statement)');
    for (const e of [e1, e2, e3]) expect(e.message).not.toContain(ADDRESS);
    const html = deps({ routes: { [query]: { status: 502, json: null } } });
    await expect(issuerD1Execute(M, STATEMENT, { remote: true }, html.d)).rejects.toThrow('failed (HTTP 502)');
  });

  it('the API base: CLOUDFLARE_API_BASE_URL as wrangler reads it; FedRAMP and staging need it', async () => {
    expect(cloudflareApiBase({})).toBe('https://api.cloudflare.com/client/v4');
    expect(cloudflareApiBase({ CLOUDFLARE_API_BASE_URL: 'https://api.fed.cloudflare.com/client/v4/' })).toBe('https://api.fed.cloudflare.com/client/v4');
    expect(() => cloudflareApiBase({ CLOUDFLARE_API_BASE_URL: 'http://x' })).toThrow('must be an https URL');
    expect(() => cloudflareApiBase({ CLOUDFLARE_COMPLIANCE_REGION: 'fedramp_high' })).toThrow('Set CLOUDFLARE_API_BASE_URL');
    expect(() => cloudflareApiBase({ WRANGLER_API_ENVIRONMENT: 'staging' })).toThrow('Set CLOUDFLARE_API_BASE_URL');
  });
});

describe('redaction', () => {
  it('replaces every quoted span; unquoted names survive', () => {
    expect(redactQuoted(`near "a@b.c": x 'd@e.f' \`g\` no such table: user_emails`)).toBe("near '…': x '…' '…' no such table: user_emails");
    expect(() => parseD1Json(JSON.stringify([{ success: false, error: `bad '${ADDRESS}'` }]), true)).toThrow("D1 error: bad '…'");
    // The API's D1 (no personal data) keeps the full error.
    expect(() => parseD1Json(JSON.stringify([{ success: false, error: "bad 'x'" }]))).toThrow(`D1 error: "bad 'x'"`);
  });
});
