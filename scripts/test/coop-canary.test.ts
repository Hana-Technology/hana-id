// The COOP canary (D385, D347's guard): which requests it checks (the product's own builders), the header rules
// (enforcing COOP or COEP fails; report-only, `unsafe-none` and CORP don't; Google's error page is exempt), how it
// follows a chain (manual redirects, a cookie jar it never prints), the browser verdicts and their positive control,
// and the exit codes. Stubbed fetch and browsers: no network.
import { RELAY_ID_PATTERN } from '@hana-id/core';
import { type Manifest, loadEnv } from '@hana-id/env';
import { describe, expect, it } from 'vitest';
import { CliError } from '../lib/cli.ts';
import {
  type BrowserResult,
  CANARY_LOGIN_HINT,
  CONTROL_AUTH_ORIGIN,
  EXIT_BROKEN,
  EXIT_FINDING,
  EXIT_PASS,
  type Hop,
  MAX_HOPS,
  type PopupRun,
  USER_AGENTS,
  WATCH_MS,
  browserCheck,
  canaryEnv,
  canaryRequests,
  controlUrl,
  coopCanary,
  fetchChain,
  formatHop,
  judgeChain,
  judgeControlRun,
  judgeHeaderControl,
  judgeHop,
  judgeRealRun,
  policyValue,
} from '../lib/coop-canary.ts';

const AUTH = 'https://auth.hana.example';
const CLIENT = '123-abc.apps.googleusercontent.com';
const ENV = { env: 'staging', clientId: CLIENT, authOrigin: AUTH };
const GOOGLE = 'https://accounts.google.com';
const COOKIE_VALUE = 'cookie-value-never-printed';

const hop = (over: Partial<Hop> = {}): Hop => ({ status: 200, host: 'accounts.google.com', path: '/v3/signin/identifier', coop: null, coopRO: null, coep: null, coepRO: null, corp: null, ...over });
const params = (url: string) => Object.fromEntries(new URL(url).searchParams);

describe('the requests: exactly what the product sends', () => {
  it("token_first's first request, D273's retry and the silent request, with the env's shared client and callback", () => {
    const [first, retry, silent] = canaryRequests(ENV);
    const redirect = `${AUTH}/login/callback`;
    expect(first!.url.startsWith(`${GOOGLE}/o/oauth2/v2/auth?`)).toBe(true);
    const f = params(first!.url);
    expect(f).toMatchObject({ client_id: CLIENT, redirect_uri: redirect, response_type: 'token', response_mode: 'fragment', scope: 'openid email', prompt: 'select_account' });
    expect(f.nonce).toBeUndefined();
    const r = params(retry!.url);
    expect(r).toMatchObject({ client_id: CLIENT, redirect_uri: redirect, response_type: 'id_token', scope: 'openid', login_hint: CANARY_LOGIN_HINT });
    expect(r.prompt).toBeUndefined();
    expect(params(silent!.url)).toMatchObject({ response_type: 'id_token', scope: 'openid', login_hint: CANARY_LOGIN_HINT, prompt: 'none' });
    expect([first!.ends, retry!.ends, silent!.ends]).toEqual(['google', 'google', 'callback']);
    for (const p of [f, r]) expect(p.state).toMatch(RELAY_ID_PATTERN);
    expect(r.nonce).toMatch(RELAY_ID_PATTERN);
  });

  it('a fresh state each run', () => {
    expect(params(canaryRequests(ENV)[0]!.url).state).not.toBe(params(canaryRequests(ENV)[0]!.url).state);
  });

  it('the control is the first request with a redirect URI no client registers', () => {
    const c = params(controlUrl(ENV));
    expect(c).toMatchObject({ client_id: CLIENT, redirect_uri: `${CONTROL_AUTH_ORIGIN}/login/callback`, response_type: 'token', scope: 'openid email' });
    expect(new URL(CONTROL_AUTH_ORIGIN).hostname.endsWith('.invalid')).toBe(true);
  });

  it("reads the env's first shared client and authOrigin; refuses a missing one", () => {
    const m = loadEnv('sandbox-dev');
    expect(canaryEnv(m)).toEqual({ env: 'sandbox-dev', clientId: m.sharedGoogleClientIds[0], authOrigin: m.authOrigin });
    expect(() => canaryEnv({ ...m, sharedGoogleClientIds: [] } as Manifest)).toThrow(CliError);
    expect(() => canaryEnv({ ...m, authOrigin: undefined } as Manifest)).toThrow(/authOrigin/u);
    expect(() => canaryEnv({ ...m, authOrigin: 'UNSET' } as Manifest)).toThrow(/authOrigin/u);
  });
});

describe('the header rules', () => {
  it('policyValue drops parameters and case', () => {
    expect(policyValue('Same-Origin; report-to="coop"')).toBe('same-origin');
    expect(policyValue(null)).toBeNull();
  });

  it("report-only, unsafe-none, no header and CORP are fine (what Google sends today)", () => {
    expect(judgeHop(hop({ coopRO: 'same-origin; report-to="coop_gse_qebhlk"', corp: 'same-site' }))).toEqual([]);
    expect(judgeHop(hop({ coop: 'unsafe-none' }))).toEqual([]);
    expect(judgeHop(hop({ coop: 'UNSAFE-NONE; report-to="x"' }))).toEqual([]);
    expect(judgeHop(hop({ coepRO: 'require-corp' }))).toEqual([]);
    expect(judgeHop(hop({ coep: 'unsafe-none' }))).toEqual([]);
    expect(judgeHop(hop({ corp: 'same-origin' }))).toEqual([]);
  });

  it('any enforcing COOP other than unsafe-none is a finding, unknown and doubled values too', () => {
    for (const coop of ['same-origin', 'same-origin; report-to="x"', 'same-origin-allow-popups', 'noopener-allow-popups', 'restrict-properties', 'unsafe-none, same-origin', '']) {
      const f = judgeHop(hop({ coop }));
      expect(f, coop).toHaveLength(1);
      expect(f[0]).toContain('accounts.google.com/v3/signin/identifier enforces Cross-Origin-Opener-Policy');
    }
  });

  it('an enforcing COEP is a finding', () => {
    for (const coep of ['require-corp', 'credentialless']) expect(judgeHop(hop({ coep })), coep).toEqual([`accounts.google.com/v3/signin/identifier enforces Cross-Origin-Embedder-Policy: ${coep}`]);
  });

  it("only Google's OAuth error page is exempt", () => {
    expect(judgeHop(hop({ path: '/signin/oauth/error', coop: 'same-origin' }))).toEqual([]);
    expect(judgeHop(hop({ path: '/signin/oauth/error/v2', coop: 'same-origin' }))).toEqual([]);
    expect(judgeHop(hop({ path: '/signin/oauth/errorx', coop: 'same-origin' }))).toHaveLength(1);
    expect(judgeHop(hop({ host: 'evil.example', path: '/signin/oauth/error', coop: 'same-origin' }))).toHaveLength(1);
    expect(judgeHop(hop({ path: '/signin/oauth/consent', coop: 'same-origin' }))).toHaveLength(1);
    expect(judgeHop(hop({ host: 'auth.hana.example', path: '/login/callback', coop: 'same-origin' }))).toHaveLength(1);
  });

  it('a chain must end where a healthy one does', () => {
    const auth = hop({ status: 302, path: '/o/oauth2/v2/auth' });
    const ok = (h: Hop[], ends: 'google' | 'callback' = 'google') => judgeChain({ hops: h }, { ends }, 'auth.hana.example');
    expect(ok([auth, hop()])).toEqual({ findings: [], broken: [] });
    expect(ok([auth, hop({ host: 'auth.hana.example', path: '/login/callback' })], 'callback')).toEqual({ findings: [], broken: [] });
    expect(ok([auth, hop({ path: '/signin/oauth/error', coop: 'same-origin' })]).findings[0]).toMatch(/OAuth error page.*refuses the request/u);
    expect(ok([auth, hop({ status: 500 })]).findings[0]).toContain('HTTP 500');
    expect(ok([auth, hop({ host: 'auth.hana.example', path: '/login/callback' })]).findings[0]).toContain("not on Google's sign-in page");
    expect(ok([auth, hop()], 'callback').findings[0]).toContain("not Hana's callback");
    expect(judgeChain({ hops: [auth], error: 'more than 10 redirects' }, { ends: 'google' }, 'x')).toEqual({ findings: [], broken: ['more than 10 redirects'] });
    expect(judgeChain({ hops: [] }, { ends: 'google' }, 'x').broken).toEqual(['no response']);
  });

  it("an enforcing hop is a finding even when the chain ends well", () => {
    expect(judgeChain({ hops: [hop({ status: 302, path: '/o/oauth2/v2/auth', coop: 'same-origin' }), hop()] }, { ends: 'google' }, 'x').findings).toEqual(['accounts.google.com/o/oauth2/v2/auth enforces Cross-Origin-Opener-Policy: same-origin']);
  });

  it("the header control needs the error page's enforcing COOP", () => {
    const auth = hop({ status: 302, path: '/o/oauth2/v2/auth' });
    expect(judgeHeaderControl({ hops: [auth, hop({ path: '/signin/oauth/error', coop: 'same-origin' })] }).broken).toBeUndefined();
    expect(judgeHeaderControl({ hops: [auth, hop({ path: '/signin/oauth/error' })] }).broken).toContain('no longer enforces COOP');
    expect(judgeHeaderControl({ hops: [auth, hop({ path: '/signin/oauth/error', coop: 'unsafe-none' })] }).broken).toContain('no longer enforces COOP');
    expect(judgeHeaderControl({ hops: [auth, hop()] }).broken).toContain("didn't reach");
    expect(judgeHeaderControl({ hops: [], error: 'fetch failed' }).broken).toBe('fetch failed');
  });

  it('prints status, host and path, never the query; report-to groups elided', () => {
    const line = formatHop(hop({ coopRO: 'same-origin; report-to="coop_gse"', corp: 'same-site' }));
    expect(line).toBe('    200 accounts.google.com/v3/signin/identifier  COOP - | COOP-RO same-origin; report-to=... | CORP same-site');
    expect(formatHop(hop({ path: '/signin/oauth/error', coop: 'same-origin' }))).toContain('(Google error page: exempt)');
    expect(formatHop(hop({ coep: 'require-corp' }))).toContain('COEP require-corp');
  });
});

/** A signed-out Google: auth → identifier (or the error page for a refused redirect, or the callback for prompt=none). */
function google(over: { identifier?: Record<string, string>; errorPage?: Record<string, string>; callback?: Record<string, string>; fail?: boolean } = {}) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url: url.toString(), init: init ?? {} });
    if (over.fail) throw new TypeError('fetch failed');
    if (url.origin === GOOGLE && url.pathname === '/o/oauth2/v2/auth') {
      const ro = { 'cross-origin-opener-policy-report-only': 'same-origin; report-to="coop_gse"' };
      const cookie: [string, string] = ['set-cookie', `__Host-GAPS=${COOKIE_VALUE}; Path=/; Secure`];
      const redirect = url.searchParams.get('redirect_uri') ?? '';
      if (!redirect.startsWith(AUTH)) return new Response(null, { status: 302, headers: [['location', `/signin/oauth/error?authError=x&client_id=${CLIENT}`], cookie, ...Object.entries(ro)] });
      if (url.searchParams.get('prompt') === 'none') return new Response(null, { status: 302, headers: [['location', `${redirect}#error=login_required&state=${url.searchParams.get('state')}`], ...Object.entries(ro)] });
      return new Response(null, { status: 302, headers: [['location', `${GOOGLE}/v3/signin/identifier?continue=secret-continue&dsh=S1`], cookie, ...Object.entries(ro)] });
    }
    if (url.origin === GOOGLE && url.pathname === '/v3/signin/identifier') return new Response('<html>', { headers: { 'cross-origin-opener-policy-report-only': 'same-origin', 'cross-origin-resource-policy': 'same-site', ...over.identifier } });
    if (url.origin === GOOGLE && url.pathname === '/signin/oauth/error') return new Response('<html>', { headers: over.errorPage ?? { 'cross-origin-opener-policy': 'same-origin' } });
    if (url.origin === AUTH && url.pathname === '/login/callback') return new Response('<html>', { headers: over.callback ?? {} });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchFn, seen };
}

describe('fetchChain', () => {
  it('follows redirects by hand like a browser navigation, relative ones included', async () => {
    const g = google();
    const c = await fetchChain(controlUrl(ENV), 'UA', g.fetchFn);
    expect(c.error).toBeUndefined();
    expect(c.hops.map((h) => `${h.status} ${h.host}${h.path}`)).toEqual(['302 accounts.google.com/o/oauth2/v2/auth', '200 accounts.google.com/signin/oauth/error']);
    expect(c.hops[1]!.coop).toBe('same-origin');
    for (const s of g.seen) {
      expect(s.init.redirect).toBe('manual');
      expect((s.init.headers as Record<string, string>)['user-agent']).toBe('UA');
      expect((s.init.headers as Record<string, string>)['sec-fetch-mode']).toBe('navigate');
    }
    expect((g.seen[0]!.init.headers as Record<string, string>)['sec-fetch-site']).toBe('cross-site');
    expect((g.seen[1]!.init.headers as Record<string, string>)['sec-fetch-site']).toBe('same-origin');
  });

  it("carries Google's cookies to the same host only, and drops the fragment", async () => {
    const g = google();
    await fetchChain(canaryRequests(ENV)[0]!.url, 'UA', g.fetchFn);
    expect((g.seen[1]!.init.headers as Record<string, string>).cookie).toBe(`__Host-GAPS=${COOKIE_VALUE}`);
    const s = google();
    await fetchChain(canaryRequests(ENV)[2]!.url, 'UA', s.fetchFn);
    expect(s.seen[1]!.url).toBe(`${AUTH}/login/callback`);
    expect((s.seen[1]!.init.headers as Record<string, string>).cookie).toBeUndefined();
  });

  it('stops on a network error, a redirect without Location, or a loop', async () => {
    expect((await fetchChain(`${GOOGLE}/o/oauth2/v2/auth`, 'UA', google({ fail: true }).fetchFn)).error).toBe('fetch failed at accounts.google.com/o/oauth2/v2/auth (TypeError)');
    const noLoc = (async () => new Response(null, { status: 302 })) as typeof fetch;
    expect((await fetchChain(`${GOOGLE}/x`, 'UA', noLoc)).error).toContain('without a Location');
    const loop = (async () => new Response(null, { status: 302, headers: { location: '/loop' } })) as typeof fetch;
    const c = await fetchChain(`${GOOGLE}/loop`, 'UA', loop);
    expect(c.hops).toHaveLength(MAX_HOPS);
    expect(c.error).toBe(`more than ${MAX_HOPS} redirects`);
    const js = (async () => new Response(null, { status: 302, headers: { location: 'javascript:alert(1)' } })) as typeof fetch;
    expect((await fetchChain(`${GOOGLE}/x`, 'UA', js)).error).toContain('javascript:');
  });
});

const sandbox = loadEnv('sandbox-dev');
const manifest = { ...sandbox, name: 'staging', sharedGoogleClientIds: [CLIENT], authOrigin: AUTH } as Manifest;
const browsersOk = async (): Promise<BrowserResult> => ({ findings: [], broken: [] });

async function runCanary(argv: string[], fetchFn: typeof fetch, browsers = browsersOk) {
  const lines: string[] = [];
  const code = await coopCanary(argv, { log: (l) => lines.push(l), loadManifest: () => manifest, fetchFn, browsers });
  return { code, out: lines.join('\n') };
}

describe('coopCanary', () => {
  it('passes on what Google sends today, checking every request under every User-Agent', async () => {
    const g = google();
    const { code, out } = await runCanary(['staging'], g.fetchFn);
    expect(code).toBe(EXIT_PASS);
    expect(out).toContain('PASS: no enforcing COOP or COEP on the way; popup.closed stayed false in chromium, firefox, webkit');
    expect(g.seen.filter((s) => s.url.startsWith(`${GOOGLE}/o/oauth2/v2/auth?`))).toHaveLength(3 * USER_AGENTS.length + 1);
    for (const { name } of USER_AGENTS) expect(out).toContain(`[${name}]`);
  });

  it('never prints a cookie, a query value or a fragment', async () => {
    const { out } = await runCanary(['staging'], google().fetchFn);
    for (const bad of [COOKIE_VALUE, 'secret-continue', 'state', 'nonce', 'login_hint', 'error=login_required', '?', '#']) expect(out, bad).not.toContain(bad);
  });

  it('fails with the page named when Google enforces COOP on its sign-in page', async () => {
    const { code, out } = await runCanary(['staging', '--headers-only'], google({ identifier: { 'cross-origin-opener-policy': 'same-origin' } }).fetchFn);
    expect(code).toBe(EXIT_FINDING);
    expect(out).toContain('FINDING: accounts.google.com/v3/signin/identifier enforces Cross-Origin-Opener-Policy: same-origin');
    expect(out).toContain('FAIL: 12 finding(s)');
    expect(out).toContain('Before each release: the COOP canary');
    expect(out).toContain('Browser check: skipped (--headers-only).');
  });

  it("fails when Hana's callback sends an enforcing COOP or COEP", async () => {
    expect((await runCanary(['staging', '--headers-only'], google({ callback: { 'cross-origin-opener-policy': 'same-origin-allow-popups' } }).fetchFn)).code).toBe(EXIT_FINDING);
    expect((await runCanary(['staging', '--headers-only'], google({ callback: { 'cross-origin-embedder-policy': 'require-corp' } }).fetchFn)).code).toBe(EXIT_FINDING);
  });

  it("can't pass when its header control doesn't see the error page's COOP", async () => {
    const { code, out } = await runCanary(['staging', '--headers-only'], google({ errorPage: {} }).fetchFn);
    expect(code).toBe(EXIT_BROKEN);
    expect(out).toContain('CANARY BROKEN');
    expect(out).toContain('INCONCLUSIVE');
  });

  it("can't pass without the network", async () => {
    expect((await runCanary(['staging'], google({ fail: true }).fetchFn)).code).toBe(EXIT_BROKEN);
  });

  it("takes the browser check's verdicts: a finding fails, a broken control is inconclusive", async () => {
    expect((await runCanary(['staging'], google().fetchFn, async () => ({ findings: ['webkit: popup.closed read true'], broken: [] }))).code).toBe(EXIT_FINDING);
    const b = await runCanary(['staging'], google().fetchFn, async () => ({ findings: [], broken: ['chromium: the control did not flip'] }));
    expect(b.code).toBe(EXIT_BROKEN);
    expect(b.out).toContain('the control did not flip');
    expect(b.out).toContain('Not a pass');
  });

  it('--headers-only skips the browsers', async () => {
    let called = false;
    const { code } = await runCanary(['staging', '--headers-only'], google().fetchFn, async () => ((called = true), { findings: [], broken: [] }));
    expect(code).toBe(EXIT_PASS);
    expect(called).toBe(false);
  });

  it('needs exactly one env and no unknown flag', async () => {
    await expect(runCanary([], google().fetchFn)).rejects.toThrow(CliError);
    await expect(runCanary(['a', 'b'], google().fetchFn)).rejects.toThrow(CliError);
    await expect(runCanary(['staging', '--browser=chromium'], google().fetchFn)).rejects.toThrow(CliError);
  });
});

describe('the browser verdicts', () => {
  const run = (over: Partial<PopupRun> = {}): PopupRun => ({ readings: [{ t: 7, closed: false }], closedAt: null, at: 'accounts.google.com/v3/signin/identifier', ...over });

  it('the real request passes when popup.closed stays false while open and a real close reads true', () => {
    expect(judgeRealRun(run(), true)).toEqual({});
  });

  it('a true reading while the popup is open is a finding', () => {
    expect(judgeRealRun(run({ readings: [{ t: 7, closed: false }, { t: 510, closed: true }] }), true).finding).toContain('read true at 510 ms while the popup was open');
  });

  it("a true reading after the popup really closed, or after the watch, isn't", () => {
    expect(judgeRealRun(run({ readings: [{ t: 7, closed: false }, { t: WATCH_MS + 300, closed: true }] }), true)).toEqual({});
  });

  it('the popup on the error page is a refused request, not a COOP finding', () => {
    expect(judgeRealRun(run({ at: 'accounts.google.com/signin/oauth/error', readings: [{ t: 7, closed: false }, { t: 500, closed: true }] }), true).finding).toContain('Google refuses the request');
  });

  it("can't decide when the popup closed by itself, nothing was read, or a real close isn't seen", () => {
    expect(judgeRealRun(run({ closedAt: 3000, readings: [{ t: 7, closed: false }, { t: 3100, closed: true }] }), true).broken).toContain('closed by itself');
    expect(judgeRealRun(run({ readings: [] }), true).broken).toContain('no reading');
    expect(judgeRealRun(run(), false).broken).toContain('poll is broken');
  });

  it('the control must flip while the popup is open, or the canary is broken', () => {
    expect(judgeControlRun(run({ at: 'accounts.google.com/signin/oauth/error', readings: [{ t: 2, closed: false }, { t: 505, closed: true }] }))).toEqual({ flippedAt: 505 });
    expect(judgeControlRun(run({ at: 'accounts.google.com/signin/oauth/error' })).broken).toMatch(/^the control did not flip.*fix the canary/u);
    expect(judgeControlRun(run({ closedAt: 400, readings: [{ t: 2, closed: false }, { t: 500, closed: true }] })).broken).toContain('closed by itself');
  });

  it("can't decide when Playwright or a browser is missing", async () => {
    const lines: string[] = [];
    const none = await browserCheck(ENV, (l) => lines.push(l), () => {
      throw new Error('Cannot find module');
    });
    expect(none).toEqual({ findings: [], broken: [expect.stringContaining('Playwright not found')] });
    const launchFails = { launch: async () => Promise.reject(new Error("Executable doesn't exist at /x\nmore")) };
    const r = await browserCheck(ENV, (l) => lines.push(l), () => ({ chromium: launchFails, firefox: launchFails, webkit: launchFails }));
    expect(r.findings).toEqual([]);
    expect(r.broken).toHaveLength(3);
    expect(r.broken[0]).toContain('playwright install chromium firefox webkit');
    expect(r.broken[0]).not.toContain('more');
  });
});
