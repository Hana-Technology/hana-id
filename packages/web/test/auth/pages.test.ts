// The auth pages' CSP and headers (docs/batch-b-spec.md "Origins and pages"), and the per-env build: static HTML with
// a <meta> CSP and no inline script or style, nothing from another origin, and the env's constants inlined.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '@hana-id/env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASSET_DIR, type BuiltEnv, MANIFEST_FILE, buildAuthPages, pageHtml, selectEnvs } from '../../scripts/build-auth-pages.ts';
import { hanaEnv } from '../../scripts/gen-envs.ts';
import { AUTH_PAGES, authPageCsp, authPageHeaders, authPageMetaCsp } from '../../src/auth/pages.ts';
import type { HanaEnv } from '../../src/hana-env.ts';

const sandbox = hanaEnv(loadEnv('sandbox-dev')) as HanaEnv;
const BASE = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'";

describe('auth page policies', () => {
  it('sets the spec’s CSP per page: base policy, connect-src and frame-ancestors none', () => {
    expect(authPageCsp(sandbox, 'login')).toBe(`${BASE}; connect-src https://hana-id-api-sandbox-dev.tingtc.workers.dev; frame-ancestors 'none'`);
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

  it('sends no-store, no-referrer, nosniff, and no COOP header', () => {
    for (const p of AUTH_PAGES) {
      const h = authPageHeaders(sandbox, p.name);
      expect(h).toMatchObject({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-type': 'text/html; charset=utf-8' });
      expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain('cross-origin-opener-policy');
    }
  });

  it('serves the four pages at the spec’s paths', () => {
    expect(AUTH_PAGES.map((p) => [p.path, p.file])).toEqual([
      ['/login', 'login.html'],
      ['/login/callback', 'login/callback.html'],
      ['/approve', 'approve.html'],
      ['/export', 'export.html'],
    ]);
  });

  it('page HTML escapes what it writes into attributes', () => {
    const html = pageHtml(sandbox, AUTH_PAGES[0]!, '/auth/a"b.js', '/auth/c.css');
    expect(html).toContain('src="/auth/a&quot;b.js"');
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
      expect(scripts[0]?.[1]).toMatch(/^ type="module" src="\/auth\/[a-z]+-[A-Z0-9]+\.js"$/u);
      expect(scripts[0]?.[2]).toBe('');
      expect(html).not.toMatch(/<style|\sstyle=|\son[a-z]+=/u);
      // No URL to another origin, except inside the CSP itself.
      expect(html.replace(/content="[^"]*"/gu, '')).not.toMatch(/https?:\/\//u);
      const links = [...html.matchAll(/<link\b[^>]*href="([^"]+)"/gu)].map((m) => m[1]);
      expect(links).toEqual([built.pages[page.name].stylesheet]);
      expect(existsSync(join(built.dir, built.pages[page.name].script.slice(1)))).toBe(true);
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

  it('writes the page manifest the Worker serves headers from', () => {
    const manifest = JSON.parse(readFileSync(join(builtProd.dir, MANIFEST_FILE), 'utf8')) as { env: string; origin: string; pages: { path: string; file: string; headers: Record<string, string> }[] };
    expect(manifest.env).toBe('prod-test');
    expect(manifest.origin).toBe(prod.authOrigin);
    expect(manifest.pages.map((p) => p.path)).toEqual(['/login', '/login/callback', '/approve', '/export']);
    expect(manifest.pages[0]?.headers['content-security-policy']).toBe(authPageCsp(prod, 'login'));
  });

  it('replaces only its own files on a rebuild (the vault’s assets share the directory)', async () => {
    writeFileSync(join(built.dir, 'vault.js'), '// vault');
    const again = await buildAuthPages(sandbox, out);
    expect(readFileSync(join(again.dir, 'vault.js'), 'utf8')).toBe('// vault');
    expect(readdirSync(join(again.dir, ASSET_DIR)).filter((f) => f.endsWith('.js')).length).toBe(readdirSync(join(built.dir, ASSET_DIR)).filter((f) => f.endsWith('.js')).length);
  }, 60_000);

  it('fails for an env whose pinned CKD key is unusable, and for an env without the Hana origins', async () => {
    await expect(buildAuthPages({ ...sandbox, name: 'sandbox-bad', ckdNetworkKey: 'UNSET' }, out)).rejects.toThrow(/sandbox-bad\.json ckdNetworkKey/u);
    expect(() => selectEnvs(['no-such-env'])).toThrow(/does not exist or does not set vaultOrigin and authOrigin/u);
    expect(selectEnvs([]).map((e) => e.name)).toContain('sandbox-dev');
  });
});
