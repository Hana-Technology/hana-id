// deploy-check (D384): which pieces of an env it reads, how it reads each build id (JSON `build`, the vault bundle's
// banner, the auth page's meta), what fails and what warns, the read-only D1 migrations check, and the exit code.
// Stubbed fetch and wrangler: no network.
import { type Manifest, loadEnv } from '@hana-id/env';
import { buildMeta, vaultBanner } from '@hana-id/env/build-id';
import type { LocalBuild } from '@hana-id/env/local-build';
import { describe, expect, it } from 'vitest';
import { CliError } from '../lib/cli.ts';
import { BANNER_LIMIT, checkTargets, d1Targets, deployCheck, judge, migrationsListArgv, observe, pendingMigrations, type Observed } from '../lib/deploy-check.ts';

const HEAD = '0485faa1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7';
const ID = '0485faa1c2d3';
const OLD = '6426908aaaaa';
const head = (dirty = false): LocalBuild => ({ id: dirty ? `${ID}-dirty` : ID, commit: ID, dirty, head: HEAD });

const m: Manifest = {
  ...loadEnv('sandbox-dev'),
  apiUrl: 'https://api.example.test',
  vaultOrigin: 'https://vault.example.test',
  authOrigin: 'https://auth.example.test',
};
const withIssuer: Manifest = { ...m, emailIssuer: { ...m.emailIssuer!, url: 'https://issuer.example.test' } };
const noIssuer: Manifest = { ...m, emailIssuer: undefined };

const URLS = {
  api: 'https://api.example.test/v1/health',
  vaultWorker: 'https://vault.example.test/.well-known/hana-build',
  vaultJs: 'https://vault.example.test/vault.js',
  authWorker: 'https://auth.example.test/.well-known/hana-build',
  authLogin: 'https://auth.example.test/login',
  issuer: 'https://issuer.example.test/v1/email/health',
};

type Answer = Response | (() => Response) | Error;
/** An env whose every piece runs `id` unless `over` says otherwise. */
function server(id: string, over: Partial<Record<keyof typeof URLS, Answer>> = {}) {
  const seen: { url: string; init: RequestInit }[] = [];
  const defaults: Record<keyof typeof URLS, () => Response> = {
    api: () => Response.json({ ok: true, env: 'sandbox-dev', hotDb: 9, build: id }),
    vaultWorker: () => Response.json({ build: id }),
    vaultJs: () => new Response(`${vaultBanner(id)}\nvar a=1;${'x'.repeat(100_000)}`),
    authWorker: () => Response.json({ build: id }),
    authLogin: () => new Response(`<!doctype html><head>${buildMeta(id)}<title>Hana</title></head>`),
    issuer: () => Response.json({ ok: true, env: 'sandbox-dev', build: id }),
  };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, init: init ?? {} });
    const key = (Object.keys(URLS) as (keyof typeof URLS)[]).find((k) => URLS[k] === url);
    if (!key) return new Response('not found', { status: 404 });
    const a = over[key];
    if (a instanceof Error) throw a;
    if (a instanceof Response) return a;
    return (a ?? defaults[key])();
  }) as typeof fetch;
  return { fetchFn, seen };
}

const run = async (argv: string[], fetchFn: typeof fetch, extra: Parameters<typeof deployCheck>[1] = {}) => {
  const lines: string[] = [];
  const code = await deployCheck(argv, { fetch: fetchFn, localBuild: () => head(), loadManifest: () => withIssuer, log: (l) => lines.push(l), ...extra });
  return { code, out: lines.join('\n') };
};

describe('checkTargets', () => {
  it('reads the API, both page Workers, both bundles and the issuer, at the paths each serves its build id', () => {
    expect(checkTargets(withIssuer).map((t) => [t.name, t.url, t.kind])).toEqual([
      ['api', URLS.api, 'json'],
      ['vault worker', URLS.vaultWorker, 'json'],
      ['vault bundle', URLS.vaultJs, 'vault-js'],
      ['auth worker', URLS.authWorker, 'json'],
      ['auth pages', URLS.authLogin, 'auth-html'],
      ['email issuer', URLS.issuer, 'json'],
    ]);
  });

  it('leaves out what the manifest doesn’t have; the issuer defaults to the API’s URL', () => {
    expect(checkTargets(noIssuer).map((t) => t.name)).not.toContain('email issuer');
    const { vaultOrigin: _v, authOrigin: _a, ...apiOnly } = noIssuer;
    expect(checkTargets(apiOnly as Manifest).map((t) => t.name)).toEqual(['api']);
    const shared = { ...m, apiUrl: 'https://api.example.test/', emailIssuer: { ...m.emailIssuer!, url: undefined } } as Manifest;
    expect(checkTargets(shared).find((t) => t.name === 'email issuer')?.url).toBe('https://api.example.test/v1/email/health');
    expect(checkTargets(shared)[0]!.url).toBe(URLS.api);
  });
});

describe('observe', () => {
  const t = (name: keyof typeof URLS) => checkTargets(withIssuer).find((x) => x.url === URLS[name])!;

  it('reads `build` from a JSON answer, the vault bundle’s first line and the auth page’s meta', async () => {
    const { fetchFn } = server(`${ID}-dirty`);
    for (const k of ['api', 'vaultWorker', 'vaultJs', 'authWorker', 'authLogin', 'issuer'] as const) {
      const o = await observe(t(k), fetchFn);
      expect(o.problem, k).toBeNull();
      expect(o.build, k).toEqual({ id: `${ID}-dirty`, commit: ID, dirty: true });
    }
  });

  it('never follows a redirect, asks past caches, and gives up after a timeout', async () => {
    const { fetchFn, seen } = server(ID);
    await observe(t('api'), fetchFn);
    expect(seen[0]!.init.redirect).toBe('manual');
    expect((seen[0]!.init.headers as Record<string, string>)['cache-control']).toBe('no-cache');
    expect(seen[0]!.init.signal).toBeInstanceOf(AbortSignal);
    const moved = server(ID, { api: new Response(null, { status: 302, headers: { location: 'https://elsewhere.example' } }) });
    expect((await observe(t('api'), moved.fetchFn)).problem).toBe('redirected (HTTP 302)');
  });

  it('reads only the start of the vault bundle', async () => {
    let pulled = 0;
    const big = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        c.enqueue(new TextEncoder().encode(pulled === 1 ? `${vaultBanner(ID)}\n` : 'x'.repeat(65_536)));
        if (pulled > 1000) c.close();
      },
    });
    const o = await observe(t('vaultJs'), server(ID, { vaultJs: new Response(big) }).fetchFn);
    expect(o.build?.id).toBe(ID);
    expect(pulled).toBeLessThan(5);
    expect(BANNER_LIMIT).toBeLessThanOrEqual(1024);
  });

  it('names what is wrong, never echoing the answer', async () => {
    const cases: [keyof typeof URLS, Answer, RegExp][] = [
      ['api', Response.json({ ok: true, hotDb: 9 }), /deployed before D384/u],
      ['api', Response.json({ ok: true, build: null }), /not stamped/u],
      ['api', Response.json({ build: 'evil\u001b[31m' }), /^malformed build id$/u],
      ['api', new Response('<html>'), /not JSON/u],
      ['api', Response.json({ build: ID, pad: 'x'.repeat(20_000) }), /too large/u],
      ['api', new Response('down', { status: 503 }), /^HTTP 503$/u],
      ['api', new Error('ECONNREFUSED'), /^unreachable$/u],
      ['vaultWorker', new Response('Not found', { status: 404 }), /^HTTP 404$/u],
      ['vaultJs', new Response('var a=1;/* hana-build 0485faa1c2d3 */'), /no build id in the bundle/u],
      ['authLogin', new Response('<!doctype html><title>old</title>'), /no build id in the page/u],
    ];
    for (const [k, answer, want] of cases) {
      const o = await observe(t(k), server(ID, { [k]: answer }).fetchFn);
      expect(o.build, `${k} ${want}`).toBeNull();
      expect(o.problem, `${k}`).toMatch(want);
      expect(o.problem).not.toContain('evil');
    }
  });
});

describe('judge', () => {
  const obs = (name: string, id: string | null, problem: string | null = null): Observed => ({
    name,
    url: `https://${name}.example`,
    build: id ? { id, commit: id.slice(0, 12), dirty: id.endsWith('-dirty') } : null,
    problem,
  });

  it('passes when every piece runs HEAD', () => {
    expect(judge([obs('api', ID), obs('vault bundle', ID)], head())).toEqual({ failures: [], warnings: [] });
  });

  it('fails a piece on another commit than HEAD: the 2026-11-05 stale vault bundle', () => {
    const { failures } = judge([obs('api', ID), obs('vault worker', ID), obs('vault bundle', OLD)], head());
    expect(failures).toEqual([`vault bundle runs ${OLD}, not this checkout's ${ID} (HEAD)`]);
  });

  it('fails an unreadable or unstamped piece', () => {
    expect(judge([obs('api', ID), obs('auth worker', null, 'not stamped')], head()).failures).toEqual(['auth worker: not stamped (https://auth worker.example)']);
  });

  it('--skip-head compares the pieces with each other only', () => {
    expect(judge([obs('api', OLD), obs('vault bundle', OLD)], null).failures).toEqual([]);
    expect(judge([obs('api', OLD), obs('vault bundle', ID)], null).failures).toEqual([`the pieces run different commits: api ${OLD}, vault bundle ${ID}`]);
  });

  it('warns on a piece deployed from a dirty tree (--strict: fails), and on a dirty checkout', () => {
    const dirty = [obs('api', `${ID}-dirty`), obs('vault bundle', ID)];
    const loose = judge(dirty, head());
    expect(loose.failures).toEqual([]);
    expect(loose.warnings).toEqual([`api was deployed from a tree with uncommitted changes (${ID}-dirty): its code is not exactly any commit`]);
    expect(judge(dirty, head(), { strict: true }).failures).toHaveLength(1);
    expect(judge([obs('api', ID)], head(true)).warnings[0]).toMatch(/this checkout has uncommitted changes/u);
  });
});

describe('D1 migrations (--d1)', () => {
  it('lists each database with wrangler’s read-only `migrations list --remote`, from the app that binds it', () => {
    expect(migrationsListArgv('hana-id-sandbox-dev')).toEqual(['exec', 'wrangler', 'd1', 'migrations', 'list', 'hana-id-sandbox-dev', '--remote']);
    expect(migrationsListArgv('x')).not.toContain('apply');
    const t = d1Targets(withIssuer);
    expect(t.map((x) => [x.name, x.db, x.dir.split('/').slice(-2).join('/')])).toEqual([
      ['api D1', withIssuer.cloudflare.d1Name, 'apps/api'],
      ['issuer D1', withIssuer.emailIssuer!.cloudflare.d1Name, 'apps/email-issuer'],
    ]);
    expect(d1Targets(noIssuer).map((x) => x.name)).toEqual(['api D1']);
  });

  it('reads wrangler’s answer: none pending, the pending names, or something else', () => {
    expect(pendingMigrations('✅ No migrations to apply!\n')).toEqual([]);
    const table = 'Migrations to be applied:\n┌──────────────────────────┐\n│ Name                     │\n├──────────────────────────┤\n│ 0011_wallet_directory.sql │\n│ 0012_next.sql │\n└──────────────────────────┘\n';
    expect(pendingMigrations(table)).toEqual(['0011_wallet_directory.sql', '0012_next.sql']);
    expect(pendingMigrations('✘ [ERROR] Not logged in')).toBeNull();
  });
});

describe('deployCheck', () => {
  it('exit 0 when every piece runs HEAD, printing each piece', async () => {
    const { fetchFn, seen } = server(ID);
    const { code, out } = await run(['sandbox-dev'], fetchFn);
    expect(code).toBe(0);
    expect(seen.map((s) => s.url).sort()).toEqual(Object.values(URLS).sort());
    for (const name of ['api', 'vault worker', 'vault bundle', 'auth worker', 'auth pages', 'email issuer']) expect(out).toMatch(new RegExp(`${name}\\s+${ID}`, 'u'));
    expect(out).toContain(`OK: every piece of sandbox-dev runs ${ID}`);
  });

  it('exit 1 on a stale bundle, an unstamped Worker or an unreachable issuer', async () => {
    for (const over of [
      { vaultJs: new Response(`${vaultBanner(OLD)}\n`) },
      { authWorker: Response.json({ build: null }) },
      { issuer: new Error('down') },
    ]) {
      const { code, out } = await run(['sandbox-dev'], server(ID, over).fetchFn);
      expect(code, JSON.stringify(Object.keys(over))).toBe(1);
      expect(out).toMatch(/FAIL: /u);
    }
  });

  it('--skip-head passes an env that agrees on another commit; --strict fails a dirty deploy', async () => {
    expect((await run(['sandbox-dev'], server(OLD).fetchFn)).code).toBe(1);
    expect((await run(['sandbox-dev', '--skip-head'], server(OLD).fetchFn)).code).toBe(0);
    expect((await run(['sandbox-dev'], server(`${ID}-dirty`).fetchFn)).code).toBe(0);
    expect((await run(['sandbox-dev', '--strict'], server(`${ID}-dirty`).fetchFn)).code).toBe(1);
  });

  it('--d1 fails on a pending migration, a failed or unrecognised wrangler run, or a missing config', async () => {
    const calls: { dir: string; argv: string[] }[] = [];
    const answer = (output: string, status = 0) => (dir: string, argv: string[]) => {
      calls.push({ dir, argv });
      return { status, output };
    };
    const ok = await run(['sandbox-dev', '--d1'], server(ID).fetchFn, { pnpm: answer('✅ No migrations to apply!'), hasWranglerConfig: () => true });
    expect(ok.code).toBe(0);
    expect(calls.map((c) => c.argv[5])).toEqual([withIssuer.cloudflare.d1Name, withIssuer.emailIssuer!.cloudflare.d1Name]);
    expect(ok.out).toMatch(/every migration of this checkout is applied/u);

    const pending = await run(['sandbox-dev', '--d1'], server(ID).fetchFn, { pnpm: answer('Migrations to be applied:\n│ 0011_wallet_directory.sql │'), hasWranglerConfig: () => true });
    expect(pending.code).toBe(1);
    expect(pending.out).toMatch(/lacks 1 migration\(s\) of this checkout: 0011_wallet_directory\.sql/u);

    for (const pnpm of [answer('✘ [ERROR] Couldn’t find a D1 DB', 1), answer('something new')]) {
      const r = await run(['sandbox-dev', '--d1'], server(ID).fetchFn, { pnpm, hasWranglerConfig: () => true });
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/wrangler d1 migrations list .* --remote (failed|printed something unexpected)/u);
    }
    const unconfigured = await run(['sandbox-dev', '--d1'], server(ID).fetchFn, { pnpm: answer('✅ No migrations to apply!'), hasWranglerConfig: () => false });
    expect(unconfigured.code).toBe(1);
    expect(unconfigured.out).toMatch(/no wrangler config in apps\/api; generate it for sandbox-dev first: corepack pnpm --filter @hana-id\/api gen sandbox-dev/u);
  });

  it('without --d1 runs no wrangler', async () => {
    let ran = false;
    await run(['sandbox-dev'], server(ID).fetchFn, {
      pnpm: () => {
        ran = true;
        return { status: 0, output: '' };
      },
    });
    expect(ran).toBe(false);
  });

  it('takes exactly one env, never a local* one, and no unknown flag', async () => {
    const { fetchFn } = server(ID);
    await expect(run([], fetchFn)).rejects.toBeInstanceOf(CliError);
    await expect(run(['a', 'b'], fetchFn)).rejects.toBeInstanceOf(CliError);
    await expect(run(['local-dev'], fetchFn)).rejects.toThrow(/local\* envs/u);
    await expect(run(['sandbox-dev', '--fix'], fetchFn)).rejects.toBeInstanceOf(CliError);
  });
});
