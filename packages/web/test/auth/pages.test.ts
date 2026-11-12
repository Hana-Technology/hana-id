// The auth pages' CSP and headers (docs/batch-b-spec.md "Origins and pages"), and the per-env build: static HTML with
// a <meta> CSP and no inline script or style, nothing from another origin, and the env's constants inlined.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '@hana-id/env';
import { parseBuildMeta } from '@hana-id/env/build-id';
import { localBuild } from '@hana-id/env/local-build';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BRAND, FONT_FILES } from '@hana-id/brand';
import { ASSET_DIR, type BuiltEnv, FILES_DIR, HOME_HEADER, ORIGIN_DIR, PASSPORT_BADGE, buildAuthPages, pageHtml, selectEnvs } from '../../scripts/build-auth-pages.ts';
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
    // sandbox-dev is a dev env on testnet: the approval popup may read a mainnet demo wallet's balance (D429) from
    // Hana's two pinned endpoints, and nothing else.
    expect(authPageCsp(sandbox, 'approve')).toBe(`${BASE}; connect-src https://mainnet.base.org https://horizon.stellar.org; frame-ancestors 'none'`);
    const { rpcFallback: _fallback, ...oneRpc } = sandbox;
    expect(authPageCsp(oneRpc, 'export')).toBe(
      `${BASE}; connect-src https://hana-id-api-sandbox-dev.tingtc.workers.dev https://test.rpc.fastnear.com https://www.googleapis.com; frame-ancestors 'none'`,
    );
  });

  it('a production build’s approval popup fetches nothing: the mainnet demo’s balance reads are dev-env only (D429)', () => {
    expect(authPageCsp({ ...sandbox, devEnv: false }, 'approve')).toBe(`${BASE}; frame-ancestors 'none'`);
    for (const p of AUTH_PAGES.filter((x) => x.name !== 'approve')) {
      expect(authPageCsp(sandbox, p.name)).not.toContain('mainnet.base.org');
      expect(authPageCsp(sandbox, p.name)).not.toContain('horizon.stellar.org');
    }
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
    expect(LOGO_PAGES).toEqual(['login', 'email', 'approve', 'export', 'share', 'home']);
    for (const p of AUTH_PAGES) {
      const policy = authPageMetaCsp(files, p.name);
      // One img-src only: a browser ignores a repeated directive.
      expect(policy.match(/img-src/gu), p.name).toHaveLength(1);
      expect(imgSources(files, p.name), p.name).toEqual((p.name === 'callback' || p.name === 'home-callback') ? ["'self'", 'data:'] : ["'self'", 'data:', 'https://files.example']);
      // Everything else is the policy without a files origin.
      expect(policy, p.name).toBe((p.name === 'callback' || p.name === 'home-callback') ? authPageMetaCsp(sandbox, p.name) : authPageMetaCsp({ ...sandbox, filesOrigin: undefined }, p.name).replace("img-src 'self' data:", IMG));
    }
    expect(authPageCsp(files, 'login')).toBe(`${BASE.replace("img-src 'self' data:", IMG)}; frame-ancestors 'none'`);
    expect(authPageMetaCsp(files, 'callback')).not.toContain('files.example');
    // The origin alone, whatever the manifest value carries after it; an env without the dashboard blocks: no change.
    expect(authPageMetaCsp({ ...sandbox, filesOrigin: 'https://files.example/' }, 'approve')).toContain(`${IMG};`);
    const { filesOrigin: _f, ...noFiles } = files;
    for (const p of AUTH_PAGES) expect(authPageMetaCsp(noFiles, p.name), p.name).toContain("img-src 'self' data:;");
  });

  it('serves the eight pages at the spec’s paths (D411 adds /share-email, Hana Home adds /home and /home/callback)', () => {
    expect(AUTH_PAGES.map((p) => [p.path, p.file])).toEqual([
      ['/login', 'login.html'],
      ['/login/email', 'login/email.html'],
      ['/login/callback', 'login/callback.html'],
      ['/approve', 'approve.html'],
      ['/export', 'export.html'],
      ['/share-email', 'share-email.html'],
      ['/home', 'home.html'],
      ['/home/callback', 'home/callback.html'],
    ]);
    // Hana Home: the API, Google's JWKS and the two NEAR providers (opening a wallet reads the chain, a linked identity's
    // path on both, D263): the export window's origins, plus the email issuer in an env with one (its email sign-in, H10).
    const withBoth = { ...sandbox, rpc: 'https://rpc1.example', rpcFallback: 'https://rpc2.example', emailIssuerUrl: 'https://issuer.example' };
    expect(connectSources(withBoth, 'home')).toEqual([new URL(sandbox.apiUrl).origin, 'https://rpc1.example', 'https://rpc2.example', 'https://www.googleapis.com', 'https://issuer.example']);
    expect(connectSources(withBoth, 'home')).toEqual([...connectSources(withBoth, 'export'), 'https://issuer.example']);
    const { rpcFallback: _none, emailIssuerUrl: _noIssuer, ...single } = withBoth;
    expect(connectSources(single, 'home')).toEqual([new URL(sandbox.apiUrl).origin, 'https://rpc1.example', 'https://www.googleapis.com']);
    expect(connectSources(single, 'home')).toEqual(connectSources(single, 'export'));
    // The exit client's callback (D491): the relay write to the API, nothing else, even in an env with an email issuer.
    expect(connectSources(withBoth, 'home-callback')).toEqual([new URL(sandbox.apiUrl).origin]);
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
      expect(scripts[0]?.[1]).toMatch(/^ type="module" src="\/assets\/[a-z]+(?:-[a-z]+)?-[A-Z0-9]+\.js"$/u);
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

  /** The faces src/auth/fonts.css declares (D765): Plex Sans for text, Plex Mono for codes, Archivo for Home's lockup. */
  const FACES = ['archivo-700', 'ibm-plex-mono-400', 'ibm-plex-mono-500', 'ibm-plex-sans-400', 'ibm-plex-sans-500', 'ibm-plex-sans-600'];

  it('D426, D765: the brand’s fonts are files on this origin, under /assets/files/, with their OFL licences beside them', () => {
    const filesDir = join(built.dir, ASSET_DIR, FILES_DIR);
    const shipped = readdirSync(filesDir).sort();
    // The faces the pages use (fonts.css), content-hashed, and one licence per family.
    const fonts = shipped.filter((f) => f.endsWith('.woff2'));
    expect(fonts.map((f) => f.replace(/-[A-Z0-9]+\.woff2$/u, '')).sort()).toEqual(FACES);
    const licences = shipped.filter((f) => !f.endsWith('.woff2'));
    expect(licences).toEqual(['OFL-Archivo.txt', 'OFL-IBMPlexMono.txt', 'OFL-IBMPlexSans.txt']);
    for (const l of licences) {
      const brandOfl = readFileSync(fileURLToPath(import.meta.resolve(`@hana-id/brand/fonts/${l}`)));
      expect(readFileSync(join(filesDir, l)).equals(brandOfl), l).toBe(true);
    }
    // Each is the brand's own file, byte for byte (its sha256 in @hana-id/brand's manifest), and no Montserrat is left.
    const hashes = new Set(FONT_FILES.map((f) => f.sha256));
    for (const f of fonts) expect(hashes.has(createHash('sha256').update(readFileSync(join(filesDir, f))).digest('hex')), f).toBe(true);
    expect(shipped.join(' ')).not.toMatch(/montserrat/iu);
  });

  it('D426, D765: the stylesheet loads only those files, relatively from this origin, with font-display optional', () => {
    const css = readFileSync(join(built.dir, built.pages.login.stylesheet.slice(1)), 'utf8');
    const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gu)].map((m) => m[1]!);
    // The fonts, and the design system's one data: URI (select.jp-input's chevron, an image under img-src 'self' data:).
    const fontUrls = urls.filter((u) => !u.startsWith('data:'));
    expect(fontUrls).toHaveLength(FACES.length);
    for (const u of fontUrls) {
      expect(u).toMatch(/^\.\/files\/[\w-]+\.woff2$/u);
      expect(existsSync(join(built.dir, ASSET_DIR, u))).toBe(true);
    }
    const dataUris = css.match(/url\("data:[^"]*"\)/gu) ?? [];
    expect(dataUris).toHaveLength(1);
    expect(dataUris[0]).toMatch(/^url\("data:image\/svg\+xml,/u);
    expect(css).toMatch(/select\.jp-input\{[^}]*background-image:url\("data:image\/svg\+xml,/u);
    const rest = css.replace(/url\("data:image\/svg\+xml,[^"]*"\)/u, '');
    expect(rest).not.toMatch(/@import|https?:|data:|\/\//u);
    const faces = [...css.matchAll(/@font-face\{([^}]*)\}/gu)].map((m) => m[1]!);
    expect(faces).toHaveLength(FACES.length);
    for (const f of faces) expect(f).toContain('font-display:optional');
    // The design system's tokens and components are in, the old brand's are gone, and every page shares this stylesheet.
    expect(css).toContain('--jp-primary:');
    expect(css).toContain('.jp-modal{');
    expect(css).not.toMatch(/--hana-|Montserrat/u);
    for (const page of AUTH_PAGES) expect(built.pages[page.name].stylesheet).toBe(built.pages.login.stylesheet);
  });

  it('D765: no --hana- variable and no colour of its own in the pages’ stylesheets: only the brand’s tokens', () => {
    const dir = new URL('../../src/auth/', import.meta.url);
    const sheets = ['auth.css', ...readdirSync(new URL('css/', dir)).map((f) => `css/${f}`)];
    for (const f of sheets) {
      const css = readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
      expect(css, f).not.toMatch(/--hana-|Montserrat/u);
      expect(css, f).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/iu);
    }
  });

  it('D426, D765: the faces in src/auth/fonts.css are the brand’s files with the brand’s unicode-range', () => {
    const own = readFileSync(new URL('../../src/auth/fonts.css', import.meta.url), 'utf8');
    const brand = readFileSync(fileURLToPath(import.meta.resolve('@hana-id/brand/fonts.css')), 'utf8');
    const faces = (css: string) =>
      new Map([...css.matchAll(/@font-face\s*\{([^}]*)\}/gu)].map((m) => [/url\('[^']*\/(\w[\w-]*\.woff2)'\)/u.exec(m[1]!)![1]!, /unicode-range:([^;]*);/u.exec(m[1]!)![1]!.trim()]));
    const mine = faces(own);
    const theirs = faces(brand);
    expect([...mine.keys()].sort()).toEqual(FACES.map((f) => `${f}.woff2`));
    for (const [file, range] of mine) expect(range, file).toBe(theirs.get(file));
  });

  it('D765: every popup has the one badge after its content, outside #app: the mark inline and the brand’s words only', () => {
    for (const page of AUTH_PAGES.filter((p) => p.name !== 'home')) {
      const html = readFileSync(join(built.dir, page.file), 'utf8');
      expect(html.split(PASSPORT_BADGE), page.name).toHaveLength(2);
      expect(html, page.name).toContain(`<body class="popup"><div class="jp-modal popup-modal"><main id="app"><noscript>${BRAND.product} needs JavaScript to continue.</noscript></main>${PASSPORT_BADGE}</div></body>`);
      expect(html, page.name).not.toContain('home-top');
    }
    expect(PASSPORT_BADGE).not.toMatch(/https?:|href|<image|<use|<img|style=|\son[a-z]+=|<script/iu);
    // Its only text is the badge's: nothing a reader could take for the app's name, nothing a partner controls.
    expect(PASSPORT_BADGE.replace(/<[^>]+>/gu, '')).toBe(BRAND.badge);
    expect(BRAND.badge).toBe('Secured by Journear Passport');
    // The mark is decorative (the words beside it name the brand).
    expect(PASSPORT_BADGE).toContain('aria-hidden="true"');
  });

  it('D765: Passport Home has the Journear lockup above its content, and no popup badge', () => {
    const html = readFileSync(join(built.dir, 'home.html'), 'utf8');
    expect(html).toContain(`<body class="home-page">${HOME_HEADER}<main id="app">`);
    expect(html).not.toContain('passport-badge');
    expect(HOME_HEADER).toContain(`role="img" aria-label="${BRAND.product}"`);
    expect(HOME_HEADER).not.toMatch(/https?:\/\/(?!www\.w3\.org)|href|<image|<use|<img|style=|\son[a-z]+=|<script/iu);
    // Only the lockup's own "PASSPORT", never as big as the wordmark (the logo rules).
    expect(HOME_HEADER.replace(/<[^>]+>/gu, '')).toBe('PASSPORT');
  });

  it('batch C11: an env with a files origin builds it into the logo pages’ meta img-src, and not the callback’s', () => {
    for (const page of AUTH_PAGES) {
      const html = readFileSync(join(builtProd.dir, page.file), 'utf8');
      expect(html, page.name).toContain(`<meta http-equiv="Content-Security-Policy" content="${authPageMetaCsp(prod, page.name)}">`);
      expect(html.includes("img-src 'self' data: https://files.hana-prod.example;"), page.name).toBe(page.name !== 'callback' && page.name !== 'home-callback');
    }
    // sandbox-dev's manifest has its dashboard blocks (M4): its logo pages carry its files origin the same way.
    expect(sandboxEnv.filesOrigin).toBe(loadEnv('sandbox-dev').files!.origin);
    for (const page of AUTH_PAGES) {
      const html = readFileSync(join(built.dir, page.file), 'utf8');
      expect(html.includes(`img-src 'self' data: ${sandboxEnv.filesOrigin};`), page.name).toBe(page.name !== 'callback' && page.name !== 'home-callback');
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
    expect(readdirSync(built.dir).sort()).toEqual([ASSET_DIR, 'approve.html', 'export.html', 'home', 'home.html', 'login', 'login.html', 'share-email.html'].sort());
    expect(readdirSync(join(built.dir, 'login')).sort()).toEqual(['callback.html', 'email.html']);
    expect(readdirSync(join(built.dir, 'home'))).toEqual(['callback.html']);
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
