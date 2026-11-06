// The auth pages' CSP and headers (docs/batch-b-spec.md "Origins and pages"), and the per-env build: static HTML with
// a <meta> CSP and no inline script or style, nothing from another origin, and the env's constants inlined.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '@hana-id/env';
import { parseBuildMeta } from '@hana-id/env/build-id';
import { localBuild } from '@hana-id/env/local-build';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASSET_DIR, type BuiltEnv, ORIGIN_DIR, buildAuthPages, pageHtml, selectEnvs } from '../../scripts/build-auth-pages.ts';
import { hanaEnv } from '../../scripts/gen-envs.ts';
import { GOOGLE_TOKENINFO_ORIGIN, GOOGLE_TOKENINFO_URL } from '../../src/auth/google.ts';
import { AUTH_PAGES, LOGO_PAGES, authPageCsp, authPageMetaCsp, connectSources, imgSources } from '../../src/auth/pages.ts';
import type { HanaEnv } from '../../src/hana-env.ts';

const sandboxEnv = hanaEnv(loadEnv('sandbox-dev')) as HanaEnv;
// Without the files origin: the policies below are the base ones; the batch C11 tests add a files origin themselves
// (sandbox-dev's manifest has one since M4, checked against its build at the end).
const { filesOrigin: _sandboxFiles, ...sandbox } = sandboxEnv;
const BASE = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'";

describe('auth page policies', () => {
  it('sets the spec’s CSP per page: base policy, connect-src and frame-ancestors none', () => {
    // The login popup fetches nothing (D77): no connect-src, so default-src 'none' applies.
    expect(authPageCsp(sandbox, 'login')).toBe(`${BASE}; frame-ancestors 'none'`);
    // The callback reaches Google's tokeninfo too when the env has an email issuer (token_first, D270; below).
    const tokeninfo = sandbox.emailIssuerUrl ? ' https://oauth2.googleapis.com' : '';
    expect(authPageCsp(sandbox, 'callback')).toBe(`${BASE}; connect-src https://hana-id-api-sandbox-dev.tingtc.workers.dev${tokeninfo}; frame-ancestors 'none'`);
    expect(authPageCsp(sandbox, 'approve')).toBe(`${BASE}; frame-ancestors 'none'`);
    const { rpcFallback: _fallback, ...oneRpc } = sandbox;
    expect(authPageCsp(oneRpc, 'export')).toBe(
      `${BASE}; connect-src https://hana-id-api-sandbox-dev.tingtc.workers.dev https://test.rpc.fastnear.com https://www.googleapis.com; frame-ancestors 'none'`,
    );
  });

  it('the export window may reach both NEAR providers (D263): its meta policy lists rpcFallback, as the header does', () => {
    // A browser enforces the meta and the header policy together: a fallback missing from the meta one blocks every
    // read of it, and a linked identity's export is refused path_unconfirmed (sandbox-dev, 2026-11-04).
    const two = { ...sandbox, rpc: 'https://test.rpc.fastnear.com', rpcFallback: 'https://rpc.testnet.near.org/' };
    expect(authPageMetaCsp(two, 'export')).toContain(
      'connect-src https://hana-id-api-sandbox-dev.tingtc.workers.dev https://test.rpc.fastnear.com https://rpc.testnet.near.org https://www.googleapis.com',
    );
    // The same origin twice is listed once.
    expect(authPageMetaCsp({ ...two, rpcFallback: 'https://test.rpc.fastnear.com/other' }, 'export')).toContain(
      'connect-src https://hana-id-api-sandbox-dev.tingtc.workers.dev https://test.rpc.fastnear.com https://www.googleapis.com',
    );
  });

  it('the meta policy is the header policy without frame-ancestors (which a <meta> CSP ignores)', () => {
    for (const p of AUTH_PAGES) {
      expect(authPageMetaCsp(sandbox, p.name)).not.toContain('frame-ancestors');
      expect(authPageCsp(sandbox, p.name)).toBe(`${authPageMetaCsp(sandbox, p.name)}; frame-ancestors 'none'`);
    }
  });

  it('the email step’s connect-src is the issuer and the API only (batch 8a), the API only without an issuer', () => {
    // The live manifest may or may not carry an emailIssuer block: strip it for the "without" half.
    const { emailIssuerUrl: _url, emailIss: _iss, ...noIssuer } = sandbox;
    expect(authPageCsp(noIssuer, 'email')).toBe(`${BASE}; connect-src https://hana-id-api-sandbox-dev.tingtc.workers.dev; frame-ancestors 'none'`);
    const withIssuer = { ...noIssuer, emailIssuerUrl: 'https://hana-id-email-sandbox-dev.tingtc.workers.dev', emailIss: 'https://hana-id-email-sandbox-dev.tingtc.workers.dev/v1/email' };
    expect(authPageCsp(withIssuer, 'email')).toBe(
      `${BASE}; connect-src https://hana-id-email-sandbox-dev.tingtc.workers.dev https://hana-id-api-sandbox-dev.tingtc.workers.dev; frame-ancestors 'none'`,
    );
    // The chooser stays fetch-free with email on (D77).
    expect(authPageCsp(withIssuer, 'login')).toBe(`${BASE}; frame-ancestors 'none'`);
  });

  it('token_first (D270): with an email issuer the callback’s meta policy also lists Google’s tokeninfo, as the header does', () => {
    const { emailIssuerUrl: _url, emailIss: _iss, ...noIssuer } = sandbox;
    const withIssuer = { ...noIssuer, emailIssuerUrl: 'https://hana-id-email-sandbox-dev.tingtc.workers.dev', emailIss: 'https://hana-id-email-sandbox-dev.tingtc.workers.dev/v1/email' };
    // The same string apps/api's pages/host.ts sends (its test pins it): a browser enforces both policies.
    expect(authPageMetaCsp(withIssuer, 'callback')).toBe(`${BASE}; connect-src https://hana-id-api-sandbox-dev.tingtc.workers.dev https://oauth2.googleapis.com`);
    expect(GOOGLE_TOKENINFO_URL.startsWith(`${GOOGLE_TOKENINFO_ORIGIN}/`)).toBe(true);
    // Only the callback: no other page may reach it.
    for (const p of AUTH_PAGES.filter((x) => x.name !== 'callback')) expect(authPageMetaCsp(withIssuer, p.name), p.name).not.toContain('oauth2.googleapis.com');
    // Without an issuer no login can be token_first.
    expect(authPageMetaCsp(noIssuer, 'callback')).toBe(`${BASE}; connect-src https://hana-id-api-sandbox-dev.tingtc.workers.dev`);
  });

  it('batch C11: the pages that show the app’s name add the files origin to img-src in place; the callback doesn’t', () => {
    const files = { ...sandbox, filesOrigin: 'https://files.example' };
    const IMG = "img-src 'self' data: https://files.example";
    expect(LOGO_PAGES).toEqual(['login', 'email', 'approve', 'export', 'share']);
    for (const p of AUTH_PAGES) {
      const policy = authPageMetaCsp(files, p.name);
      // One img-src only: a browser ignores a repeated directive.
      expect(policy.match(/img-src/gu), p.name).toHaveLength(1);
      expect(imgSources(files, p.name), p.name).toEqual(p.name === 'callback' ? ["'self'", 'data:'] : ["'self'", 'data:', 'https://files.example']);
      // Everything else is the policy without a files origin.
      expect(policy, p.name).toBe(p.name === 'callback' ? authPageMetaCsp(sandbox, p.name) : authPageMetaCsp({ ...sandbox, filesOrigin: undefined }, p.name).replace("img-src 'self' data:", IMG));
    }
    expect(authPageCsp(files, 'login')).toBe(`${BASE.replace("img-src 'self' data:", IMG)}; frame-ancestors 'none'`);
    expect(authPageMetaCsp(files, 'callback')).not.toContain('files.example');
    // The origin alone, whatever the manifest value carries after it; an env without the dashboard blocks: no change.
    expect(authPageMetaCsp({ ...sandbox, filesOrigin: 'https://files.example/' }, 'approve')).toContain(`${IMG};`);
    const { filesOrigin: _f, ...noFiles } = files;
    for (const p of AUTH_PAGES) expect(authPageMetaCsp(noFiles, p.name), p.name).toContain("img-src 'self' data:;");
  });

  it('serves the six pages at the spec’s paths (D411 adds /share-email)', () => {
    expect(AUTH_PAGES.map((p) => [p.path, p.file])).toEqual([
      ['/login', 'login.html'],
      ['/login/email', 'login/email.html'],
      ['/login/callback', 'login/callback.html'],
      ['/approve', 'approve.html'],
      ['/export', 'export.html'],
      ['/share-email', 'share-email.html'],
    ]);
    // D411: the sheet reads the address from the API, nothing else.
    expect(connectSources(sandbox, 'share')).toEqual([new URL(sandbox.apiUrl).origin]);
  });

  it('page HTML escapes what it writes into attributes', () => {
    const html = pageHtml(sandbox, AUTH_PAGES[0]!, '/assets/a"b.js', '/assets/c.css', '0485faa1c2d3');
    expect(html).toContain('src="/assets/a&quot;b.js"');
  });

  it('D384: every page carries its build id in one <meta name="hana-build">; nothing else is accepted as one', () => {
    for (const page of AUTH_PAGES) {
      const html = pageHtml(sandbox, page, '/assets/a.js', '/assets/c.css', '0485faa1c2d3-dirty');
      expect(html).toContain('<meta name="hana-build" content="0485faa1c2d3-dirty">');
      expect(parseBuildMeta(html)?.id).toBe('0485faa1c2d3-dirty');
      expect(() => pageHtml(sandbox, page, '/assets/a.js', '/assets/c.css', '"><script>')).toThrow(/build id/u);
    }
  });

  it('every page opts out of browser auto-translation (AUTH-4)', () => {
    for (const page of AUTH_PAGES) {
      const html = pageHtml(sandbox, page, '/assets/a.js', '/assets/c.css', '0485faa1c2d3');
      expect(html).toContain('<html lang="en" translate="no">');
      expect(html).toContain('<meta name="google" content="notranslate">');
    }
  });
});

describe('per-env build', () => {
  let out: string;
  let built: BuiltEnv;
  // A second env with its own signer, relayer and origins, to show each bundle carries only its env's constants.
  const prod: HanaEnv = {
    ...sandboxEnv,
    name: 'prod-test',
    signer: 'hana-signer-prod.example',
    relayer: 'hana-relayer-prod.example',
    apiUrl: 'https://api.hana-prod.example',
    vaultOrigin: 'https://vault.hana-prod.example',
    authOrigin: 'https://auth.hana-login.example',
    devEnv: false,
    filesOrigin: 'https://files.hana-prod.example',
  };
  let builtProd: BuiltEnv;

  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), 'hana-auth-pages-'));
    built = await buildAuthPages(sandboxEnv, out, '0485faa1c2d3');
    builtProd = await buildAuthPages(prod, out, '0485faa1c2d3');
  }, 60_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : [p];
    });
  const assetText = (b: BuiltEnv) => files(join(b.dir, ASSET_DIR)).filter((f) => f.endsWith('.js')).map((f) => readFileSync(f, 'utf8')).join('\n');

  it('writes every page with a meta CSP, one same-origin stylesheet and one same-origin module script, nothing inline', () => {
    for (const page of AUTH_PAGES) {
      const html = readFileSync(join(built.dir, page.file), 'utf8');
      expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${authPageMetaCsp(sandboxEnv, page.name)}">`);
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu)];
      expect(scripts).toHaveLength(1);
      expect(scripts[0]?.[1]).toMatch(/^ type="module" src="\/assets\/[a-z]+-[A-Z0-9]+\.js"$/u);
      expect(scripts[0]?.[2]).toBe('');
      expect(html).not.toMatch(/<style|\sstyle=|\son[a-z]+=/u);
      // No URL to another origin, except inside the CSP itself.
      expect(html.replace(/content="[^"]*"/gu, '')).not.toMatch(/https?:\/\//u);
      const links = [...html.matchAll(/<link\b[^>]*href="([^"]+)"/gu)].map((m) => m[1]);
      expect(links).toEqual([built.pages[page.name].stylesheet]);
      expect(built.pages[page.name].stylesheet).toMatch(/^\/assets\/auth-[A-Z0-9]+\.css$/u);
      expect(existsSync(join(built.dir, built.pages[page.name].script.slice(1)))).toBe(true);
      expect(existsSync(join(built.dir, built.pages[page.name].stylesheet.slice(1)))).toBe(true);
    }
  });

  it('batch C11: an env with a files origin builds it into the logo pages’ meta img-src, and not the callback’s', () => {
    for (const page of AUTH_PAGES) {
      const html = readFileSync(join(builtProd.dir, page.file), 'utf8');
      expect(html, page.name).toContain(`<meta http-equiv="Content-Security-Policy" content="${authPageMetaCsp(prod, page.name)}">`);
      expect(html.includes("img-src 'self' data: https://files.hana-prod.example;"), page.name).toBe(page.name !== 'callback');
    }
    // sandbox-dev's manifest has its dashboard blocks (M4): its logo pages carry its files origin the same way.
    expect(sandboxEnv.filesOrigin).toBe(loadEnv('sandbox-dev').files!.origin);
    for (const page of AUTH_PAGES) {
      const html = readFileSync(join(built.dir, page.file), 'utf8');
      expect(html.includes(`img-src 'self' data: ${sandboxEnv.filesOrigin};`), page.name).toBe(page.name !== 'callback');
    }
  });

  it('loads no third-party script: bundles import only their own chunks', () => {
    for (const f of files(join(built.dir, ASSET_DIR)).filter((x) => x.endsWith('.js'))) {
      const src = readFileSync(f, 'utf8');
      // esbuild's static imports (`import{a as b}from"./chunks/…"`) and any dynamic import.
      for (const m of src.matchAll(/\}\s*from\s*"([^"]+)"|\bimport\s*\(\s*["'`]([^"'`]+)/gu)) expect(m[1] ?? m[2]).toMatch(/^\.\.?\//u);
      expect(src).not.toMatch(/https?:\/\/[^"'`\s]*\.m?js\b/u);
      expect(src).not.toMatch(/accounts\.google\.com\/gsi/u);
    }
  });

  it('inlines each env’s own pinned constants', () => {
    const sandboxJs = assetText(built);
    const prodJs = assetText(builtProd);
    for (const v of [sandboxEnv.signer, sandboxEnv.relayer, sandboxEnv.vaultOrigin, sandboxEnv.authOrigin, sandboxEnv.ckdNetworkKey]) expect(sandboxJs).toContain(v);
    for (const v of [prod.signer, prod.relayer, prod.vaultOrigin, prod.authOrigin]) expect(prodJs).toContain(v);
    expect(prodJs).not.toContain(sandboxEnv.signer);
    expect(sandboxJs).not.toContain(prod.signer);
    expect(prodJs).not.toContain('__HANA_ENV__');
  });

  it('lays out the auth origin’s own assets root, as the auth Worker serves it: <env>/auth/<path>.html and /assets/…', () => {
    expect(built.dir).toBe(join(out, 'sandbox-dev', ORIGIN_DIR));
    expect(builtProd.dir).toBe(join(out, 'prod-test', 'auth'));
    // The Worker (apps/api src/pages/host.ts) serves `/login` from `<root>/login.html`, and so on for each route.
    for (const page of AUTH_PAGES) expect(existsSync(join(built.dir, `${page.path.slice(1)}.html`))).toBe(true);
    // Nothing is written next to the origin roots, so the vault root (<env>/vault) holds only the vault's files.
    expect(readdirSync(join(out, 'sandbox-dev'))).toEqual(['auth']);
    expect(readdirSync(built.dir).sort()).toEqual([ASSET_DIR, 'approve.html', 'export.html', 'login', 'login.html', 'share-email.html'].sort());
    expect(readdirSync(join(built.dir, 'login')).sort()).toEqual(['callback.html', 'email.html']);
  });

  it('replaces only its own root on a rebuild: stale auth files go, the vault’s root stays', async () => {
    const vaultDir = join(out, 'sandbox-dev', 'vault');
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(join(vaultDir, 'vault.js'), '// vault');
    writeFileSync(join(built.dir, ASSET_DIR, 'stale-OLD.js'), '// stale');
    const before = readdirSync(join(built.dir, ASSET_DIR)).filter((f) => f.endsWith('.js') && !f.startsWith('stale')).sort();
    // Another build id (D384) changes the pages' meta, never the bundles' content hashes (browsers keep their cache).
    const again = await buildAuthPages(sandboxEnv, out, '111111111111-dirty');
    expect(readFileSync(join(vaultDir, 'vault.js'), 'utf8')).toBe('// vault');
    expect(existsSync(join(again.dir, ASSET_DIR, 'stale-OLD.js'))).toBe(false);
    expect(readdirSync(join(again.dir, ASSET_DIR)).filter((f) => f.endsWith('.js')).sort()).toEqual(before);
    for (const page of AUTH_PAGES) expect(parseBuildMeta(readFileSync(join(again.dir, page.file), 'utf8'))?.id).toBe('111111111111-dirty');
    rmSync(vaultDir, { recursive: true, force: true });
    built = await buildAuthPages(sandboxEnv, out, '0485faa1c2d3');
  }, 60_000);

  it('D384: stamps every page with the build id it was given, by default this checkout’s', async () => {
    expect(built.buildId).toBe('0485faa1c2d3');
    for (const page of AUTH_PAGES) expect(parseBuildMeta(readFileSync(join(built.dir, page.file), 'utf8'))?.id).toBe('0485faa1c2d3');
    const local = await buildAuthPages(prod, out);
    expect(local.buildId).toBe(localBuild().id);
    expect(parseBuildMeta(readFileSync(join(local.dir, 'login.html'), 'utf8'))?.id).toBe(localBuild().id);
    await expect(buildAuthPages(prod, out, 'nope')).rejects.toThrow(/build id/u);
    // A refused id deletes nothing: the last build stays.
    expect(existsSync(join(local.dir, 'login.html'))).toBe(true);
  }, 60_000);

  it('refuses an env name that is not a plain manifest name (it becomes a deleted path)', async () => {
    await expect(buildAuthPages({ ...sandboxEnv, name: '../x' }, out)).rejects.toThrow(/Invalid environment name/u);
  });

  it('fails for an env whose pinned CKD key is unusable, and for an env without the Hana origins', async () => {
    await expect(buildAuthPages({ ...sandboxEnv, name: 'sandbox-bad', ckdNetworkKey: 'UNSET' }, out)).rejects.toThrow(/sandbox-bad\.json ckdNetworkKey/u);
    expect(() => selectEnvs(['no-such-env'])).toThrow(/does not exist or does not set vaultOrigin and authOrigin/u);
    expect(selectEnvs([]).map((e) => e.name)).toContain('sandbox-dev');
  });
});
