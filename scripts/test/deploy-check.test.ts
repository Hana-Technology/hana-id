// deploy-check (D384): which pieces of an env it reads, how it reads each build id (JSON `build`, the vault bundle's
// banner, the auth page's meta), what fails and what warns, the read-only D1 migrations check, and the exit code.
// Stubbed fetch and wrangler: no network.
import { type Manifest, loadEnv } from '@hana-id/env';
import { buildMeta, vaultBanner } from '@hana-id/env/build-id';
import type { LocalBuild } from '@hana-id/env/local-build';
import { describe, expect, it } from 'vitest';
import { CliError } from '../lib/cli.ts';
import {
  BANNER_LIMIT,
  GROUPS,
  checkTargets,
  d1Targets,
  deployCheck,
  deployedVersions,
  deploymentStatusArgv,
  isProductionNetwork,
  judge,
  judgeUsageCapture,
  orgKindArgv,
  orgKindOf,
  readUsageCapture,
  migrationsListArgv,
  observe,
  observeWrangler,
  parseGroups,
  pendingMigrations,
  selectGroups,
  versionBuild,
  versionViewArgv,
  type Observed,
  type WranglerResult,
  type WranglerRun,
} from '../lib/deploy-check.ts';

const HEAD = '0485faa1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7';
const ID = '0485faa1c2d3';
const OLD = '6426908aaaaa';
const head = (dirty = false): LocalBuild => ({ id: dirty ? `${ID}-dirty` : ID, commit: ID, dirty, head: HEAD });

// sandbox-dev without its dashboard blocks (it has them since M4, D414): these tests are about an env without a dashboard.
const { console: _console, files: _files, admin: _admin, usage: _usage, email: _email, ownerGrantDelayMs: _ownerGrant, ...sandboxBare } = loadEnv('sandbox-dev');
const m: Manifest = {
  ...(sandboxBare as Manifest),
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
      ['auth pages', URLS.authLogin, 'html-meta'],
      ['email issuer', URLS.issuer, 'json'],
      // sandbox-dev has a watchdog block: a piece, read only with --only watchdog (selectGroups).
      ['watchdog worker', `wrangler: ${m.watchdog!.cloudflare.workerName}`, 'wrangler'],
    ]);
  });

  it('leaves out what the manifest doesn’t have; the issuer defaults to the API’s URL', () => {
    expect(checkTargets(noIssuer).map((t) => t.name)).not.toContain('email issuer');
    const { vaultOrigin: _v, authOrigin: _a, watchdog: _w, ...apiOnly } = noIssuer;
    expect(checkTargets(apiOnly as Manifest).map((t) => t.name)).toEqual(['api']);
    const shared = { ...m, apiUrl: 'https://api.example.test/', emailIssuer: { ...m.emailIssuer!, url: undefined } } as Manifest;
    expect(checkTargets(shared).find((t) => t.name === 'email issuer')?.url).toBe('https://api.example.test/v1/email/health');
    expect(checkTargets(shared)[0]!.url).toBe(URLS.api);
  });

  it('sandbox-dev’s own manifest (its dashboard blocks since D414): the console, console-auth, files and admin pieces too', () => {
    const real = loadEnv('sandbox-dev');
    expect(checkTargets(real).map((t) => t.name)).toEqual([
      'api', 'vault worker', 'vault bundle', 'auth worker', 'auth pages', 'email issuer',
      'console worker', 'console spa', 'console-auth worker', 'files worker', 'admin worker', 'watchdog worker',
    ]);
    expect(checkTargets(real).find((t) => t.name === 'console spa')?.url).toBe(`${real.console!.origin}/`);
    expect(checkTargets(real).find((t) => t.name === 'files worker')?.url).toBe(`${real.files!.origin}/.well-known/hana-build`);
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
    // The API's health answer is read twice: for its build id, and for whether usage capture is on.
    expect([...new Set(seen.map((s) => s.url))].sort()).toEqual(Object.values(URLS).sort());
    expect(seen.filter((s) => s.url === URLS.api)).toHaveLength(2);
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

// ---- D406: the console, console-auth, files, admin and watchdog Workers ----

/** sandbox-dev with every dashboard block (as a production env has them), on test origins. */
const full = {
  ...withIssuer,
  console: { workerName: 'hana-id-console-x', d1Name: 'hana-id-console-x', origin: 'https://console.example.test', authWorkerName: 'hana-id-console-auth-x', authOrigin: 'https://console-auth.example.test' },
  files: { workerName: 'hana-id-files-x', origin: 'https://files.example.test', logosBucket: 'hana-id-logos-x', statementsBucket: 'hana-id-statements-x', exportsBucket: 'hana-id-exports-x' },
  admin: { workerName: 'hana-id-admin-x', origin: 'https://admin.example.test', accessTeamDomain: 'team.cloudflareaccess.com', accessAud: 'UNSET', staffEmails: ['staff@example.com'] },
} as Manifest;
const WATCHDOG = full.watchdog!.cloudflare;

const DASH_URLS = {
  consoleWorker: 'https://console.example.test/.well-known/hana-build',
  consoleSpa: 'https://console.example.test/',
  consoleAuth: 'https://console-auth.example.test/.well-known/hana-build',
  files: 'https://files.example.test/.well-known/hana-build',
};

/** Every HTTP piece of `full` runs `id` unless `over` says otherwise. */
function fullServer(id: string, over: Partial<Record<keyof typeof DASH_URLS, Answer>> = {}) {
  const base = server(id);
  const seen: string[] = [];
  const defaults: Record<keyof typeof DASH_URLS, () => Response> = {
    consoleWorker: () => Response.json({ build: id }),
    consoleSpa: () => new Response(`<!doctype html><html><head><title>Hana ID console</title>${buildMeta(id)}\n  </head><body><div id="root"></div></body></html>`),
    consoleAuth: () => Response.json({ build: id }),
    files: () => Response.json({ build: id }),
  };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    const key = (Object.keys(DASH_URLS) as (keyof typeof DASH_URLS)[]).find((k) => DASH_URLS[k] === url);
    if (!key) return base.fetchFn(input, init);
    const a = over[key];
    if (a instanceof Error) throw a;
    if (a instanceof Response) return a;
    return (a ?? defaults[key])();
  }) as typeof fetch;
  return { fetchFn, seen };
}

const VID = '11111111-2222-4333-8444-555555555555';
const VID2 = '66666666-7777-4888-9999-aaaaaaaaaaaa';
/** What wrangler prints besides HANA_BUILD: never shown. */
const PRIVATE = ['owner@example.com', 'staff-only-value'];

/** A wrangler whose every Worker's deployed version carries `id` (null: no HANA_BUILD var), unless `over` says otherwise. */
function fakeWrangler(id: string | null, over: { status?: WranglerResult; view?: WranglerResult } = {}) {
  const calls: { app: string; argv: string[]; env: Record<string, string> }[] = [];
  const run: WranglerRun = (app, argv, env) => {
    calls.push({ app, argv, env });
    if (argv[0] === 'deployments') return over.status ?? { status: 0, stdout: JSON.stringify({ id: 'dep', author_email: PRIVATE[0], versions: [{ version_id: VID, percentage: 100 }] }), stderr: '' };
    const bindings = [
      { type: 'plain_text', name: 'STAFF_EMAILS', text: PRIVATE[1] },
      { type: 'secret_text', name: 'EMAIL_API_KEY' },
      ...(id === null ? [] : [{ type: 'plain_text', name: 'HANA_BUILD', text: id }]),
    ];
    return over.view ?? { status: 0, stdout: JSON.stringify({ id: VID, metadata: { author_email: PRIVATE[0] }, resources: { bindings } }), stderr: '' };
  };
  return { run, calls };
}

const runFull = async (argv: string[], fetchFn: typeof fetch, extra: Parameters<typeof deployCheck>[1] = {}) => {
  const lines: string[] = [];
  const code = await deployCheck(argv, { fetch: fetchFn, localBuild: () => head(), loadManifest: () => full, log: (l) => lines.push(l), wrangler: fakeWrangler(ID).run, ...extra });
  return { code, out: lines.join('\n') };
};

describe('checkTargets: the dashboard Workers and the watchdog (D406)', () => {
  it('reads each one the manifest has, where it serves its id; the admin and the watchdog through wrangler', () => {
    const t = checkTargets(full);
    expect(t.map((x) => [x.group, x.name, x.url, x.kind])).toEqual([
      ['api', 'api', URLS.api, 'json'],
      ['pages', 'vault worker', URLS.vaultWorker, 'json'],
      ['pages', 'vault bundle', URLS.vaultJs, 'vault-js'],
      ['pages', 'auth worker', URLS.authWorker, 'json'],
      ['pages', 'auth pages', URLS.authLogin, 'html-meta'],
      ['issuer', 'email issuer', URLS.issuer, 'json'],
      ['console', 'console worker', DASH_URLS.consoleWorker, 'json'],
      ['console', 'console spa', DASH_URLS.consoleSpa, 'html-meta'],
      ['console-auth', 'console-auth worker', DASH_URLS.consoleAuth, 'json'],
      ['files', 'files worker', DASH_URLS.files, 'json'],
      ['admin', 'admin worker', 'wrangler: hana-id-admin-x', 'wrangler'],
      ['watchdog', 'watchdog worker', `wrangler: ${WATCHDOG.workerName}`, 'wrangler'],
    ]);
    // The admin on the login's own account (the API's); the watchdog on its own.
    expect(t.find((x) => x.group === 'admin')!.wrangler).toMatchObject({ worker: 'hana-id-admin-x', app: 'admin', accountId: null });
    expect(t.find((x) => x.group === 'watchdog')!.wrangler).toMatchObject({ worker: WATCHDOG.workerName, app: 'watchdog', accountId: WATCHDOG.accountId });
    // Nothing on the admin's origin is fetched: it is behind Cloudflare Access.
    expect(t.some((x) => x.url.startsWith('https://admin.example.test'))).toBe(false);
  });
});

describe('selectGroups, --only and --skip', () => {
  const all = checkTargets(full);

  it('by default reads every group the manifest has but the watchdog, and says how to check that', () => {
    const s = selectGroups(full, all, [], []);
    expect(s.groups).toEqual(['api', 'pages', 'issuer', 'console', 'console-auth', 'files', 'admin']);
    expect(s.notRead).toEqual(['watchdog']);
    expect(s.notes.join('\n')).toMatch(new RegExp(`watchdog \\(${WATCHDOG.workerName}\\) is on its own Cloudflare account .*deploy-check sandbox-dev --only watchdog`, 'u'));
  });

  it('--only reads just those (the watchdog too); --skip all but those', () => {
    expect(selectGroups(full, all, ['watchdog'], []).groups).toEqual(['watchdog']);
    const some = selectGroups(full, all, ['files', 'admin'], []);
    expect(some.groups).toEqual(['files', 'admin']);
    expect(some.notes).toEqual(['not read (--only): api, pages, issuer, console, console-auth, watchdog']);
    const skipped = selectGroups(full, all, [], ['admin', 'watchdog']);
    expect(skipped.groups).toEqual(['api', 'pages', 'issuer', 'console', 'console-auth', 'files']);
    expect(skipped.notes).toEqual(['not read (--skip): admin, watchdog']);
  });

  it('refuses both flags, an --only group the manifest lacks, skipping everything, and an unknown name', () => {
    expect(() => selectGroups(full, all, ['api'], ['files'])).toThrow(CliError);
    expect(() => selectGroups(withIssuer, checkTargets(withIssuer), ['admin'], [])).toThrow(/envs\/sandbox-dev\.json has no admin/u);
    expect(() => selectGroups(full, all, [], [...GROUPS])).toThrow(/Nothing to check/u);
    expect(parseGroups(['console,files', 'files', ' admin'], 'only')).toEqual(['console', 'files', 'admin']);
    expect(() => parseGroups(['consoles'], 'only')).toThrow(/unknown group "consoles"/u);
  });
});

describe('observe: the console, console-auth and files Workers, the console SPA', () => {
  const t = (url: string) => checkTargets(full).find((x) => x.url === url)!;

  it('reads `build` from each Worker’s build path and the SPA’s meta', async () => {
    const { fetchFn } = fullServer(`${ID}-dirty`);
    for (const url of Object.values(DASH_URLS)) {
      const o = await observe(t(url), fetchFn);
      expect(o.problem, url).toBeNull();
      expect(o.build?.id, url).toBe(`${ID}-dirty`);
    }
  });

  it('names a stale or unstamped SPA, and an unstamped or pre-D406 Worker', async () => {
    const cases: [keyof typeof DASH_URLS, Answer, RegExp][] = [
      ['consoleSpa', new Response('<!doctype html><head><title>Hana ID console</title></head>'), /no build id in the page/u],
      ['consoleWorker', Response.json({ build: null }), /not stamped/u],
      ['consoleAuth', new Response('Not found', { status: 404 }), /^HTTP 404$/u],
      ['files', Response.json({}), /deployed before D384 \(D406 for the console, console-auth and files Workers\)/u],
    ];
    for (const [k, answer, want] of cases) {
      const o = await observe(t(DASH_URLS[k]), fullServer(ID, { [k]: answer }).fetchFn);
      expect(o.build, k).toBeNull();
      expect(o.problem, k).toMatch(want);
    }
  });
});

describe('observeWrangler: the admin’s and the watchdog’s deployed version', () => {
  const admin = checkTargets(full).find((x) => x.group === 'admin')!;
  const watchdog = checkTargets(full).find((x) => x.group === 'watchdog')!;

  it('reads HANA_BUILD from the one version deployed, with read-only commands, outside any wrangler config', () => {
    expect(deploymentStatusArgv('w')).toEqual(['deployments', 'status', '--name', 'w', '--json']);
    expect(versionViewArgv(VID, 'w')).toEqual(['versions', 'view', VID, '--name', 'w', '--json']);
    const { run, calls } = fakeWrangler(`${ID}-dirty`);
    const o = observeWrangler(admin, run);
    expect(o).toEqual({ name: 'admin worker', url: 'wrangler: hana-id-admin-x', build: { id: `${ID}-dirty`, commit: ID, dirty: true }, problem: null });
    expect(calls).toEqual([
      { app: 'admin', argv: deploymentStatusArgv('hana-id-admin-x'), env: {} },
      { app: 'admin', argv: versionViewArgv(VID, 'hana-id-admin-x'), env: {} },
    ]);
    for (const c of calls) expect(c.argv.join(' ')).not.toMatch(/deploy\b(?!ments)|rollback|secret|delete|put/u);
  });

  it('asks the watchdog’s own account for the watchdog', () => {
    const { run, calls } = fakeWrangler(ID);
    expect(observeWrangler(watchdog, run).build?.id).toBe(ID);
    expect(calls).toEqual([
      { app: 'watchdog', argv: deploymentStatusArgv(WATCHDOG.workerName), env: { CLOUDFLARE_ACCOUNT_ID: WATCHDOG.accountId } },
      { app: 'watchdog', argv: versionViewArgv(VID, WATCHDOG.workerName), env: { CLOUDFLARE_ACCOUNT_ID: WATCHDOG.accountId } },
    ]);
    const unset = { ...watchdog, wrangler: { ...watchdog.wrangler!, accountId: 'UNSET' } };
    const none = fakeWrangler(ID);
    expect(observeWrangler(unset, none.run).problem).toMatch(/accountId is UNSET/u);
    expect(none.calls).toEqual([]);
  });

  it('names an unstamped, secret or malformed var, a gradual deployment, a failed or unrecognised run, never printing what else wrangler said', () => {
    const json = (v: unknown): WranglerResult => ({ status: 0, stdout: JSON.stringify(v), stderr: '' });
    const cases: [ReturnType<typeof fakeWrangler>, RegExp][] = [
      [fakeWrangler(null), /^not stamped: .*or before D406$/u],
      [fakeWrangler(ID, { view: json({ resources: { bindings: [{ type: 'secret_text', name: 'HANA_BUILD' }] } }) }), /not a plain-text var/u],
      [fakeWrangler('latest\u001b[31m'), /^malformed build id$/u],
      [fakeWrangler(ID, { status: json({ versions: [{ version_id: VID, percentage: 90 }, { version_id: VID2, percentage: 10 }] }) }), /gradual deployment is in progress \(90% \/ 10%\)/u],
      [fakeWrangler(ID, { status: json({ versions: [{ version_id: VID, percentage: 50 }] }) }), /gradual deployment/u],
      [fakeWrangler(ID, { status: json({ versions: [{ version_id: '--config=evil', percentage: 100 }] }) }), /deployments status printed something unexpected/u],
      [fakeWrangler(ID, { status: { status: 0, stdout: 'Not JSON', stderr: '' } }), /deployments status printed something unexpected/u],
      [fakeWrangler(ID, { view: { status: 0, stdout: '{"oops":', stderr: '' } }), /versions view printed something unexpected/u],
      [fakeWrangler(ID, { status: { status: 1, stdout: `{"author_email":"${PRIVATE[0]}"}`, stderr: '\u001b[31m✘ [ERROR]\u001b[0m Not logged in.\n\n' } }), /deployments status failed \(exit 1\): logged in to the API's Cloudflare account\?:\n {4}✘ \[ERROR\] Not logged in\.$/u],
      [fakeWrangler(ID, { view: { status: 2, stdout: '', stderr: 'Authentication error [code: 10000]' } }), /versions view failed \(exit 2\)/u],
    ];
    for (const [w, want] of cases) {
      const o = observeWrangler(admin, w.run);
      expect(o.build, String(want)).toBeNull();
      expect(o.problem, String(want)).toMatch(want);
      for (const p of PRIVATE) expect(o.problem).not.toContain(p);
      expect(o.problem).not.toContain('\u001b');
    }
    // A version id that isn't one is never passed to wrangler.
    const odd = fakeWrangler(ID, { status: json({ versions: [{ version_id: '--config=evil', percentage: 100 }] }) });
    observeWrangler(admin, odd.run);
    expect(odd.calls).toHaveLength(1);
  });

  it('parses only what it uses', () => {
    expect(deployedVersions({ versions: [{ version_id: VID, percentage: 100 }] })).toEqual([{ id: VID, percentage: 100 }]);
    for (const v of [null, {}, { versions: [] }, { versions: [{ version_id: VID }] }]) expect(deployedVersions(v)).toBeNull();
    expect(versionBuild({ resources: { bindings: [{ type: 'plain_text', name: 'HANA_BUILD', text: ID }] } }).build?.id).toBe(ID);
    expect(versionBuild({ resources: {} }).problem).toMatch(/unexpected/u);
  });
});

describe('deployCheck with the dashboard Workers', () => {
  it('exit 0 when every piece runs HEAD; the watchdog is not read, and the run says so', async () => {
    const { fetchFn, seen } = fullServer(ID);
    const w = fakeWrangler(ID);
    const { code, out } = await runFull(['sandbox-dev'], fetchFn, { wrangler: w.run });
    expect(code).toBe(0);
    for (const url of Object.values(DASH_URLS)) expect(seen).toContain(url);
    expect(seen.some((u) => u.includes('admin.example.test'))).toBe(false);
    expect(w.calls.map((c) => c.app)).toEqual(['admin', 'admin']);
    for (const name of ['console worker', 'console spa', 'console-auth worker', 'files worker', 'admin worker']) expect(out).toMatch(new RegExp(`${name}\\s+${ID}`, 'u'));
    expect(out).not.toMatch(/watchdog worker\s/u);
    expect(out).toMatch(/note: the watchdog .* --only watchdog/u);
    expect(out).toContain(`OK: every piece of sandbox-dev runs ${ID} (this checkout); not read: watchdog`);
    for (const p of PRIVATE) expect(out).not.toContain(p);
  });

  it('exit 1 on a stale console SPA, an unstamped files Worker or an admin on another commit', async () => {
    for (const [over, wranglerId, want] of [
      [{ consoleSpa: new Response(`<head>${buildMeta(OLD)}</head>`) }, ID, `console spa runs ${OLD}`],
      [{ files: Response.json({ build: null }) }, ID, 'files worker: not stamped'],
      [{}, OLD, `admin worker runs ${OLD}`],
    ] as const) {
      const { code, out } = await runFull(['sandbox-dev'], fullServer(ID, over).fetchFn, { wrangler: fakeWrangler(wranglerId).run });
      expect(code, want).toBe(1);
      expect(out).toContain(`FAIL: ${want}`);
    }
  });

  it('--only watchdog reads only the watchdog, on its account, and fetches nothing', async () => {
    const { fetchFn, seen } = fullServer(ID);
    const w = fakeWrangler(ID);
    const { code, out } = await runFull(['sandbox-dev', '--only', 'watchdog'], fetchFn, { wrangler: w.run });
    expect(code).toBe(0);
    expect(seen).toEqual([]);
    expect(w.calls.every((c) => c.app === 'watchdog' && c.env.CLOUDFLARE_ACCOUNT_ID === WATCHDOG.accountId)).toBe(true);
    expect(out).toMatch(new RegExp(`watchdog worker\\s+${ID}\\s+wrangler: ${WATCHDOG.workerName}`, 'u'));
    expect(out).toContain('note: not read (--only): api, pages, issuer, console, console-auth, files, admin');
  });

  it('--skip leaves groups out; --only/--skip of an unknown group is refused', async () => {
    const { fetchFn, seen } = fullServer(ID);
    const w = fakeWrangler(ID);
    expect((await runFull(['sandbox-dev', '--skip', 'admin,console'], fetchFn, { wrangler: w.run })).code).toBe(0);
    expect(w.calls).toEqual([]);
    expect(seen).not.toContain(DASH_URLS.consoleWorker);
    expect(seen).toContain(DASH_URLS.files);
    await expect(runFull(['sandbox-dev', '--only', 'dashboard'], fetchFn)).rejects.toThrow(/unknown group/u);
    await expect(runFull(['sandbox-dev', '--only', 'api', '--skip', 'files'], fetchFn)).rejects.toThrow(/not both/u);
  });

  it('--d1 adds the console’s D1 by default and the watchdog’s with --only watchdog', async () => {
    expect(d1Targets(full).map((x) => [x.name, x.db, x.dir.split('/').slice(-2).join('/')])).toEqual([
      ['api D1', full.cloudflare.d1Name, 'apps/api'],
      ['issuer D1', full.emailIssuer!.cloudflare.d1Name, 'apps/email-issuer'],
      ['console D1', 'hana-id-console-x', 'apps/console'],
    ]);
    expect(d1Targets(full, ['watchdog']).map((x) => [x.name, x.db, x.dir.split('/').slice(-2).join('/')])).toEqual([['watchdog D1', WATCHDOG.d1Name, 'apps/watchdog']]);
    const dirs: string[] = [];
    const pnpm = (dir: string) => {
      dirs.push(dir.split('/').slice(-2).join('/'));
      return { status: 0, output: '✅ No migrations to apply!' };
    };
    expect((await runFull(['sandbox-dev', '--d1'], fullServer(ID).fetchFn, { pnpm, hasWranglerConfig: () => true })).code).toBe(0);
    expect(dirs).toEqual(['apps/api', 'apps/email-issuer', 'apps/console']);
    dirs.length = 0;
    expect((await runFull(['sandbox-dev', '--only', 'watchdog', '--d1'], fullServer(ID).fetchFn, { pnpm, hasWranglerConfig: () => true })).code).toBe(0);
    expect(dirs).toEqual(['apps/watchdog']);
    const missing = await runFull(['sandbox-dev', '--only', 'console', '--d1'], fullServer(ID).fetchFn, { pnpm, hasWranglerConfig: () => false });
    expect(missing.out).toMatch(/console D1: no wrangler config in apps\/console; generate it for sandbox-dev first: corepack pnpm --filter @hana-id\/console gen sandbox-dev --d1-id <its id>/u);
  });
});

describe('usage capture and Hana’s own org (Hana Home’s billing, D596, D597)', () => {
  const HANA_ORG = 'org_2Yh8sJq4LmHana';
  const production = { ...full, network: 'mainnet' } as unknown as Manifest;
  const api = (usageCapture?: boolean) => fullServer(ID).fetchFn && ((async (input: string | URL | Request, init?: RequestInit) => (String(input) === URLS.api ? Response.json({ ok: true, build: ID, ...(usageCapture === undefined ? {} : { usageCapture }) }) : fullServer(ID).fetchFn(input, init))) as typeof fetch);

  it('reads usageCapture from the API’s health answer; anything else is "doesn’t say"', async () => {
    expect(await readUsageCapture(full, api(true))).toBe(true);
    expect(await readUsageCapture(full, api(false))).toBe(false);
    expect(await readUsageCapture(full, api())).toBeNull();
    expect(await readUsageCapture(full, (async () => new Response('down', { status: 503 })) as typeof fetch)).toBeNull();
    expect(await readUsageCapture(full, (async () => { throw new Error('network'); }) as typeof fetch)).toBeNull();
  });

  it('on a production network capture off, or an API that doesn’t say, fails; on testnet it is a note', async () => {
    expect(isProductionNetwork(full)).toBe(false);
    expect(isProductionNetwork(production)).toBe(true);
    expect(judgeUsageCapture(production, true)).toEqual({});
    expect(judgeUsageCapture(production, false).failure).toMatch(/usage capture is off .* production network/u);
    expect(judgeUsageCapture(production, null).failure).toMatch(/does not say whether usage capture is on/u);
    expect(judgeUsageCapture(full, false)).toEqual({ note: expect.stringMatching(/usage capture is off in the API/u) });
    expect(judgeUsageCapture(full, null)).toEqual({});

    const off = await runFull(['sandbox-dev'], api(false));
    expect(off.code).toBe(0);
    expect(off.out).toMatch(/note: usage capture is off in the API/u);
    const prodOff = await runFull(['prod'], api(false), { loadManifest: () => ({ ...production, hanaOrgId: HANA_ORG }) as Manifest });
    expect(prodOff.code).toBe(1);
    expect(prodOff.out).toMatch(/FAIL: api: usage capture is off/u);
    const prodOn = await runFull(['prod'], api(true), { loadManifest: () => ({ ...production, hanaOrgId: HANA_ORG }) as Manifest });
    expect(prodOn.code).toBe(0);
    // A production env must name Hana's own org.
    const noOrg = await runFull(['prod'], api(true), { loadManifest: () => production });
    expect(noOrg.code).toBe(1);
    expect(noOrg.out).toMatch(/FAIL: manifest: no hanaOrgId on a production network/u);
  });

  it('--d1 checks that hanaOrgId is an org that exists and is internal, reading only its kind from the console’s D1', async () => {
    const named = { ...full, hanaOrgId: HANA_ORG } as Manifest;
    expect(orgKindArgv('hana-id-console-x', HANA_ORG)).toEqual(['exec', 'wrangler', 'd1', 'execute', 'hana-id-console-x', '--remote', '--json', '--command', `SELECT kind FROM orgs WHERE id = '${HANA_ORG}'`]);
    expect(orgKindOf(JSON.stringify([{ results: [{ kind: 'internal' }], success: true }]))).toBe('internal');
    expect(orgKindOf(`some banner\n${JSON.stringify([{ results: [{ kind: 'partner' }] }])}`)).toBe('partner');
    expect(orgKindOf(JSON.stringify([{ results: [] }]))).toBeNull();
    expect(orgKindOf('✘ [ERROR] not logged in')).toBeUndefined();
    expect(orgKindOf(JSON.stringify([{ results: [{ kind: 5 }] }]))).toBeUndefined();

    const withKind = (answer: { status: number; output: string }) => {
      const asked: string[][] = [];
      const pnpm = (_dir: string, argv: string[]) => {
        if (argv.includes('execute')) {
          asked.push(argv);
          return answer;
        }
        return { status: 0, output: '✅ No migrations to apply!' };
      };
      return { asked, run: () => runFull(['sandbox-dev', '--d1'], api(true), { loadManifest: () => named, pnpm, hasWranglerConfig: () => true }) };
    };
    const ok = withKind({ status: 0, output: JSON.stringify([{ results: [{ kind: 'internal' }] }]) });
    const good = await ok.run();
    expect(good.code).toBe(0);
    expect(good.out).toContain(`${HANA_ORG} exists and is internal`);
    expect(ok.asked).toEqual([orgKindArgv('hana-id-console-x', HANA_ORG)]);
    for (const [answer, want] of [
      [{ status: 0, output: JSON.stringify([{ results: [{ kind: 'partner' }] }]) }, /FAIL: hanaOrgId: org .* is of kind partner, not internal/u],
      [{ status: 0, output: JSON.stringify([{ results: [] }]) }, /FAIL: hanaOrgId: no org /u],
      [{ status: 1, output: 'not logged in' }, /FAIL: hanaOrgId: could not read org /u],
      [{ status: 0, output: 'garbage' }, /FAIL: hanaOrgId: could not read org /u],
    ] as const) {
      const r = await withKind(answer).run();
      expect(r.code).toBe(1);
      expect(r.out).toMatch(want);
    }
    // Without --d1 nothing is read from D1; an env that names no org asks nothing.
    const none = withKind({ status: 0, output: '[]' });
    expect((await runFull(['sandbox-dev', '--d1'], api(true), { pnpm: (_d, argv) => (argv.includes('execute') ? (none.asked.push(argv), { status: 1, output: '' }) : { status: 0, output: '✅ No migrations to apply!' }), hasWranglerConfig: () => true })).code).toBe(0);
    expect(none.asked).toEqual([]);
  });
});
