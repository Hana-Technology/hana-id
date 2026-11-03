// The auth pages' CSP and headers (docs/batch-b-spec.md "Origins and pages"), and the per-env build: static HTML with
// a <meta> CSP and no inline script or style, nothing from another origin, and the env's constants inlined.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '@hana-id/env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASSET_DIR, type BuiltEnv, ORIGIN_DIR, buildAuthPages, pageHtml, selectEnvs } from '../../scripts/build-auth-pages.ts';
import { hanaEnv } from '../../scripts/gen-envs.ts';
import { AUTH_PAGES, authPageCsp, authPageMetaCsp } from '../../src/auth/pages.ts';
import type { HanaEnv } from '../../src/hana-env.ts';

const sandbox = hanaEnv(loadEnv('sandbox-dev')) as HanaEnv;
const BASE = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'";

describe('auth page policies', () => {
  it('sets the spec’s CSP per page: base policy, connect-src and frame-ancestors none', () => {
    // The login popup fetches nothing (D77): no connect-src, so default-src 'none' applies.
    expect(authPageCsp(sandbox, 'login')).toBe(`${BASE}; frame-ancestors 'none'`);
    expect(authPageCsp(sandbox, 'callback')).toBe(`${BASE}; connect-src https://hana-id-api-sandbox-dev.tingtc.workers.dev; frame-ancestors 'none'`);
    expect(authPageCsp(sandbox, 'approve')).toBe(`${BASE}; frame-ancestors 'none'`);
    expect(authPageCsp(sandbox, 'export')).toBe(
      `${BASE}; connect-src https://hana-id-api-sandbox-dev.tingtc.workers.dev https://test.rpc.fastnear.com https://www.googleapis.com; frame-ancestors 'none'`,
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

  it('serves the five pages at the spec’s paths', () => {
    expect(AUTH_PAGES.map((p) => [p.path, p.file])).toEqual([
      ['/login', 'login.html'],
      ['/login/email', 'login/email.html'],
      ['/login/callback', 'login/callback.html'],
      ['/approve', 'approve.html'],
      ['/export', 'export.html'],
    ]);
  });

  it('page HTML escapes what it writes into attributes', () => {
    const html = pageHtml(sandbox, AUTH_PAGES[0]!, '/assets/a"b.js', '/assets/c.css');
    expect(html).toContain('src="/assets/a&quot;b.js"');
  });

  it('every page opts out of browser auto-translation (AUTH-4)', () => {
    for (const page of AUTH_PAGES) {
      const html = pageHtml(sandbox, page, '/assets/a.js', '/assets/c.css');
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
    ...sandbox,
    name: 'prod-test',
    signer: 'hana-signer-prod.example',
    relayer: 'hana-relayer-prod.example',
    apiUrl: 'https://api.hana-prod.example',
    vaultOrigin: 'https://vault.hana-prod.example',
    authOrigin: 'https://auth.hana-login.example',
    devEnv: false,
  };
  let builtProd: BuiltEnv;

  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), 'hana-auth-pages-'));
    built = await buildAuthPages(sandbox, out);
    builtProd = await buildAuthPages(prod, out);
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
      expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${authPageMetaCsp(sandbox, page.name)}">`);
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
    for (const v of [sandbox.signer, sandbox.relayer, sandbox.vaultOrigin, sandbox.authOrigin, sandbox.ckdNetworkKey]) expect(sandboxJs).toContain(v);
    for (const v of [prod.signer, prod.relayer, prod.vaultOrigin, prod.authOrigin]) expect(prodJs).toContain(v);
    expect(prodJs).not.toContain(sandbox.signer);
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
    expect(readdirSync(built.dir).sort()).toEqual([ASSET_DIR, 'approve.html', 'export.html', 'login', 'login.html'].sort());
    expect(readdirSync(join(built.dir, 'login')).sort()).toEqual(['callback.html', 'email.html']);
  });

  it('replaces only its own root on a rebuild: stale auth files go, the vault’s root stays', async () => {
    const vaultDir = join(out, 'sandbox-dev', 'vault');
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(join(vaultDir, 'vault.js'), '// vault');
    writeFileSync(join(built.dir, ASSET_DIR, 'stale-OLD.js'), '// stale');
    const before = readdirSync(join(built.dir, ASSET_DIR)).filter((f) => f.endsWith('.js') && !f.startsWith('stale')).sort();
    const again = await buildAuthPages(sandbox, out);
    expect(readFileSync(join(vaultDir, 'vault.js'), 'utf8')).toBe('// vault');
    expect(existsSync(join(again.dir, ASSET_DIR, 'stale-OLD.js'))).toBe(false);
    expect(readdirSync(join(again.dir, ASSET_DIR)).filter((f) => f.endsWith('.js')).sort()).toEqual(before);
    rmSync(vaultDir, { recursive: true, force: true });
  }, 60_000);

  it('refuses an env name that is not a plain manifest name (it becomes a deleted path)', async () => {
    await expect(buildAuthPages({ ...sandbox, name: '../x' }, out)).rejects.toThrow(/Invalid environment name/u);
  });

  it('fails for an env whose pinned CKD key is unusable, and for an env without the Hana origins', async () => {
    await expect(buildAuthPages({ ...sandbox, name: 'sandbox-bad', ckdNetworkKey: 'UNSET' }, out)).rejects.toThrow(/sandbox-bad\.json ckdNetworkKey/u);
    expect(() => selectEnvs(['no-such-env'])).toThrow(/does not exist or does not set vaultOrigin and authOrigin/u);
    expect(selectEnvs([]).map((e) => e.name)).toContain('sandbox-dev');
  });
});
