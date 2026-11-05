// coop-canary.ts's body: the manual pre-release check of D347's assumption (D386). The vault notices a closed login
// popup by reading its window handle's `.closed` every 250 ms (D347). That handle stays valid across the popup's trip
// to Google only while no page on the way *enforces* Cross-Origin-Opener-Policy: an enforcing page switches the
// popup's browsing context group, and the opener's handle then reads `closed: true` while the window is still open
// (the spec makes the two indistinguishable). Google sends `cross-origin-opener-policy-report-only: same-origin` on
// its authorization endpoint and sign-in pages today (checked 2026-11-04 and 2026-11-05) and enforces `same-origin`
// only on its OAuth error page. If it ever enforces it on a sign-in page, D347's watch would cancel logins while the
// user is still at Google (beyond its 8 s guard), so this canary runs before each release (docs/operations.md
// "Before each release: the COOP canary").
//
// Two checks, both on exactly the requests the product sends (`packages/web/src/auth/google.ts`'s builders, the env's
// shared Google client and `authOrigin + /login/callback`), signed out:
//   1. Headers: fetch with manual redirects under several browser User-Agents; every hop of token_first's first
//      request, D273's interactive retry and the silent ID-token request (Hana's callback page included) must send no
//      enforcing COOP other than `unsafe-none` and no enforcing COEP. Report-only is fine. Only Google's OAuth error
//      page is exempt (it is the positive control below).
//   2. Browsers (Playwright from apps/e2e; Chromium, Firefox, WebKit; headless): a localhost opener `window.open`s the
//      first request and reads `.closed` every 250 ms for 10 s; a `true` while the popup is open fails. Control: the
//      same with a redirect URI Google refuses (its error page enforces COOP) must read `true`; if it doesn't, the
//      canary can't see an enforcing page and fails as broken.
//
// No secret is involved (a client id is public). It never prints a cookie, a query value or a fragment: hops are
// shown as status, host and path, and header values are escaped and cut (`safeLine`).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { type Manifest, loadEnv, repoRoot } from '@hana-id/env';
import { CALLBACK_PATH, googleAuthUrl, googleTokenFirstUrl } from '../../packages/web/src/auth/google.ts';
import { CliError, parseCli } from './cli.ts';
import { safeLine } from './identity-probe.ts';

export const COOP_CANARY_USAGE = `Usage: coop-canary.ts <env> [--headers-only]
  Checks that Google's sign-in pages (and Hana's callback) don't enforce Cross-Origin-Opener-Policy, which would make
  the vault's popup-close watch (D347) cancel logins. Uses envs/<env>.json's first sharedGoogleClientIds entry and
  authOrigin, signed out. --headers-only skips the browser check (Playwright from apps/e2e).
  Exit 0: pass. 1: a finding (an enforcing COOP or COEP; a request Google refuses). 2: the canary couldn't decide
  (network, browsers missing, or its positive control didn't flip).`;

export const EXIT_PASS = 0;
export const EXIT_FINDING = 1;
export const EXIT_BROKEN = 2;

/** Browser User-Agents the header check sends (Google may vary pages by browser and platform). */
export const USER_AGENTS: ReadonlyArray<{ name: string; ua: string }> = [
  { name: 'chrome-mac', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36' },
  { name: 'chrome-windows', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36' },
  { name: 'safari-mac', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15' },
  { name: 'firefox-mac', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0' },
  { name: 'safari-ios', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1' },
  { name: 'chrome-android', ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36' },
];

export const GOOGLE_ACCOUNTS_HOST = 'accounts.google.com';
/** Google's OAuth error page: it enforces `same-origin` today, and is both checks' positive control. */
export const ERROR_PAGE = { host: GOOGLE_ACCOUNTS_HOST, path: '/signin/oauth/error' } as const;
export const isErrorPage = (host: string, path: string): boolean => host === ERROR_PAGE.host && (path === ERROR_PAGE.path || path.startsWith(`${ERROR_PAGE.path}/`));

/** A redirect URI no Google client registers (`.invalid` is reserved): Google answers with its error page. */
export const CONTROL_AUTH_ORIGIN = 'https://coop-canary.invalid';
/** D273's retry and the silent request carry the account's `sub` as `login_hint`; signed out, any well-formed one does. */
export const CANARY_LOGIN_HINT = '100000000000000000000';

export const MAX_HOPS = 10;
export const HOP_TIMEOUT_MS = 15_000;
export const WATCH_MS = 10_000;
export const POLL_MS = 250;

export interface CanaryRequest {
  /** What the product sends it for (printed). */
  label: string;
  url: string;
  /** Where a healthy chain ends, signed out: Google's sign-in page, or Hana's callback (the silent request's error). */
  ends: 'google' | 'callback';
}

/** A fresh relay id (RELAY_ID_PATTERN: 43 base64url characters), as the login's `state` and `nonce`. */
const relayId = (): string => randomBytes(32).toString('base64url');

export interface CanaryEnv {
  env: string;
  clientId: string;
  authOrigin: string;
}

/** The env's shared Google client and auth origin; refuses a missing or placeholder value. */
export function canaryEnv(m: Manifest): CanaryEnv {
  const clientId = m.sharedGoogleClientIds[0];
  if (!clientId || clientId.startsWith('UNSET')) throw new CliError(`envs/${m.name}.json has no shared Google client (sharedGoogleClientIds)`);
  const authOrigin = m.authOrigin;
  if (!authOrigin || authOrigin.startsWith('UNSET') || !/^https?:\/\//u.test(authOrigin)) throw new CliError(`envs/${m.name}.json has no authOrigin`);
  return { env: m.name, clientId, authOrigin };
}

/** The product's requests, built by the product's own builders. */
export function canaryRequests(e: CanaryEnv): CanaryRequest[] {
  const base = { clientId: e.clientId, authOrigin: e.authOrigin };
  return [
    { label: "token_first's first request (googleTokenFirstUrl)", url: googleTokenFirstUrl({ ...base, state: relayId() }), ends: 'google' },
    { label: "D273's interactive retry (googleAuthUrl, the account as hint)", url: googleAuthUrl({ ...base, nonce: relayId(), state: relayId(), forceReauth: false, loginHint: CANARY_LOGIN_HINT, silent: false }), ends: 'google' },
    { label: 'the silent ID-token request (googleAuthUrl, prompt=none)', url: googleAuthUrl({ ...base, nonce: relayId(), state: relayId(), forceReauth: false, loginHint: CANARY_LOGIN_HINT, silent: true }), ends: 'callback' },
  ];
}

/** The first request with a redirect URI Google refuses: the positive control. */
export const controlUrl = (e: CanaryEnv): string => googleTokenFirstUrl({ clientId: e.clientId, authOrigin: CONTROL_AUTH_ORIGIN, state: relayId() });

// --- Header rules ---------------------------------------------------------------------------------------------------

export interface Hop {
  status: number;
  host: string;
  path: string;
  coop: string | null;
  coopRO: string | null;
  coep: string | null;
  coepRO: string | null;
  corp: string | null;
}

/** A policy header's value without its parameters (`same-origin; report-to="x"` → `same-origin`), lowercased. */
export function policyValue(v: string | null): string | null {
  if (v === null) return null;
  return (v.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * What one hop breaks (empty: fine). An enforcing COOP or COEP whose value isn't `unsafe-none` (anything else, an
 * unknown or doubled value included, is taken as enforcing); report-only headers and CORP never count. Google's error
 * page is exempt.
 */
export function judgeHop(h: Hop): string[] {
  if (isErrorPage(h.host, h.path)) return [];
  const findings: string[] = [];
  const coop = policyValue(h.coop);
  if (coop !== null && coop !== 'unsafe-none') findings.push(`${h.host}${h.path} enforces Cross-Origin-Opener-Policy: ${h.coop}`);
  const coep = policyValue(h.coep);
  if (coep !== null && coep !== 'unsafe-none') findings.push(`${h.host}${h.path} enforces Cross-Origin-Embedder-Policy: ${h.coep}`);
  return findings;
}

export interface Chain {
  hops: Hop[];
  /** Why the chain stopped early (network error, a loop, a redirect without Location). */
  error?: string;
}

/**
 * Every finding of a chain: each hop's (judgeHop), and whether it got where a healthy chain ends. Ending on Google's
 * error page means Google refuses the request itself (client id, redirect URI): a finding too, not a COOP one.
 */
export function judgeChain(c: Chain, r: Pick<CanaryRequest, 'ends'>, authHost: string): { findings: string[]; broken: string[] } {
  const findings = c.hops.flatMap(judgeHop);
  const broken: string[] = [];
  if (c.error) {
    broken.push(c.error);
    return { findings, broken };
  }
  const last = c.hops[c.hops.length - 1];
  if (!last) {
    broken.push('no response');
    return { findings, broken };
  }
  if (isErrorPage(last.host, last.path)) findings.push(`Google answered with its OAuth error page (${last.host}${last.path}): it refuses the request (check the client id and its redirect URI)`);
  else if (last.status !== 200) findings.push(`ended with HTTP ${last.status} at ${last.host}${last.path}`);
  else if (r.ends === 'google' && last.host !== GOOGLE_ACCOUNTS_HOST) findings.push(`ended at ${last.host}${last.path}, not on Google's sign-in page (signed out it should stop there)`);
  else if (r.ends === 'callback' && (last.host !== authHost || last.path !== CALLBACK_PATH)) findings.push(`ended at ${last.host}${last.path}, not Hana's callback`);
  return { findings, broken };
}

const header = (h: Headers, name: string): string | null => h.get(name);

/** A minimal cookie jar, so the chain sees what a browser would; its values are never printed or returned. */
class Jar {
  private readonly cookies = new Map<string, { domain: string; hostOnly: boolean; value: string }>();
  take(url: URL, res: Response): void {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of list) {
      const [pair, ...attrs] = line.split(';');
      const eq = (pair ?? '').indexOf('=');
      if (eq <= 0) continue;
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const domainAttr = attrs.map((a) => a.trim()).find((a) => /^domain=/iu.test(a));
      const domain = domainAttr ? domainAttr.slice(7).replace(/^\./u, '').toLowerCase() : url.hostname;
      if (domain !== url.hostname && !url.hostname.endsWith(`.${domain}`)) continue;
      this.cookies.set(`${domain}\0${name}`, { domain, hostOnly: !domainAttr, value: `${name}=${value}` });
    }
  }
  header(url: URL): string | null {
    const out = [...this.cookies.values()].filter((c) => (c.hostOnly ? url.hostname === c.domain : url.hostname === c.domain || url.hostname.endsWith(`.${c.domain}`))).map((c) => c.value);
    return out.length ? out.join('; ') : null;
  }
}

/** Follows `url` by hand (manual redirects, like a browser navigation), recording each hop's policy headers. */
export async function fetchChain(url: string, ua: string, fetchFn: typeof fetch = fetch): Promise<Chain> {
  const hops: Hop[] = [];
  const jar = new Jar();
  let next = new URL(url);
  let site: 'cross-site' | 'same-origin' = 'cross-site';
  for (let i = 0; i < MAX_HOPS; i++) {
    const headers: Record<string, string> = {
      'user-agent': ua,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': site,
      'upgrade-insecure-requests': '1',
    };
    const cookie = jar.header(next);
    if (cookie) headers.cookie = cookie;
    let res: Response;
    try {
      res = await fetchFn(next.toString(), { headers, redirect: 'manual', signal: AbortSignal.timeout(HOP_TIMEOUT_MS) });
    } catch (err) {
      return { hops, error: `fetch failed at ${next.host}${next.pathname} (${err instanceof Error ? err.name : 'error'})` };
    }
    jar.take(next, res);
    await res.body?.cancel().catch(() => undefined);
    const h = res.headers;
    hops.push({
      status: res.status,
      host: next.host,
      path: next.pathname,
      coop: header(h, 'cross-origin-opener-policy'),
      coopRO: header(h, 'cross-origin-opener-policy-report-only'),
      coep: header(h, 'cross-origin-embedder-policy'),
      coepRO: header(h, 'cross-origin-embedder-policy-report-only'),
      corp: header(h, 'cross-origin-resource-policy'),
    });
    if (res.status < 300 || res.status >= 400) return { hops };
    const location = h.get('location');
    if (!location) return { hops, error: `HTTP ${res.status} without a Location at ${next.host}${next.pathname}` };
    let to: URL;
    try {
      to = new URL(location, next);
    } catch {
      return { hops, error: `HTTP ${res.status} with an unreadable Location at ${next.host}${next.pathname}` };
    }
    if (to.protocol !== 'https:' && to.protocol !== 'http:') return { hops, error: `redirect to a ${to.protocol} URL from ${next.host}${next.pathname}` };
    site = to.origin === next.origin ? 'same-origin' : 'cross-site';
    to.hash = '';
    next = to;
  }
  return { hops, error: `more than ${MAX_HOPS} redirects` };
}

/** `report-to="group"` shown as `report-to=...`; the rest escaped and cut by safeLine. */
const shownPolicy = (v: string | null): string => (v === null ? '-' : v.replace(/report-to="[^"]*"/gu, 'report-to=...'));

/** One printed hop: status, host and path (never the query), then the policy headers. */
export function formatHop(h: Hop): string {
  const parts = [`COOP ${shownPolicy(h.coop)}`, `COOP-RO ${shownPolicy(h.coopRO)}`, `CORP ${shownPolicy(h.corp)}`];
  if (h.coep !== null) parts.push(`COEP ${shownPolicy(h.coep)}`);
  if (h.coepRO !== null) parts.push(`COEP-RO ${shownPolicy(h.coepRO)}`);
  const note = isErrorPage(h.host, h.path) ? '  (Google error page: exempt)' : '';
  return `    ${h.status} ${h.host}${h.path}  ${parts.join(' | ')}${note}`;
}

export interface HeaderResult {
  findings: string[];
  broken: string[];
}

/** The header check over every request and User-Agent. */
export async function headerCheck(e: CanaryEnv, log: (line: string) => void, fetchFn: typeof fetch = fetch): Promise<HeaderResult> {
  const findings: string[] = [];
  const broken: string[] = [];
  const authHost = new URL(e.authOrigin).host;
  for (const r of canaryRequests(e)) {
    log(safeLine(`  ${r.label}`));
    for (const { name, ua } of USER_AGENTS) {
      const chain = await fetchChain(r.url, ua, fetchFn);
      log(safeLine(`   [${name}]`));
      for (const h of chain.hops) log(safeLine(formatHop(h)));
      const j = judgeChain(chain, r, authHost);
      for (const f of j.findings) {
        findings.push(`${r.label} [${name}]: ${f}`);
        log(safeLine(`    FINDING: ${f}`));
      }
      for (const b of j.broken) {
        broken.push(`${r.label} [${name}]: ${b}`);
        log(safeLine(`    COULD NOT CHECK: ${b}`));
      }
    }
  }
  const control = judgeHeaderControl(await fetchChain(controlUrl(e), USER_AGENTS[0]!.ua, fetchFn));
  log(safeLine(`  control: a redirect URI Google refuses must reach its error page with an enforcing COOP`));
  for (const h of control.hops) log(safeLine(formatHop(h)));
  if (control.broken) {
    broken.push(`header control: ${control.broken}`);
    log(safeLine(`    CANARY BROKEN: ${control.broken}`));
  } else log('    ok: the error page enforces COOP, and this check reads it');
  return { findings, broken };
}

/**
 * The header check's positive control: the request with a refused redirect URI must reach Google's error page with an
 * enforcing COOP. If it doesn't, the check can't be shown to see an enforcing header (or the control has moved).
 */
export function judgeHeaderControl(c: Chain): { hops: Hop[]; broken?: string } {
  if (c.error) return { hops: c.hops, broken: c.error };
  const page = c.hops.find((h) => isErrorPage(h.host, h.path) && h.status === 200);
  if (!page) return { hops: c.hops, broken: "the control didn't reach Google's error page" };
  const v = policyValue(page.coop);
  if (v === null || v === 'unsafe-none') return { hops: c.hops, broken: "Google's error page no longer enforces COOP: the canary needs a new positive control" };
  return { hops: c.hops };
}

// --- Browser check --------------------------------------------------------------------------------------------------

export interface Reading {
  /** ms since `window.open`. */
  t: number;
  closed: boolean;
}

export interface PopupRun {
  /** Every change of `.closed` the opener saw, from `window.open` on (the first reading included). */
  readings: Reading[];
  /** ms since `window.open` when the popup page really closed (Playwright's `close` event), or null. */
  closedAt: number | null;
  /** Where the popup was at the end of the watch (host and path). */
  at: string | null;
}

/** The first reading of `closed: true` while the popup was really open, within the watch. */
const falseClose = (run: PopupRun): Reading | undefined => run.readings.find((r) => r.closed && r.t <= WATCH_MS && (run.closedAt === null || r.t < run.closedAt));

/** The real request: `.closed` must never read true while the popup is open. */
export function judgeRealRun(run: PopupRun, afterRealClose: boolean): { finding?: string; broken?: string } {
  if (run.readings.length === 0) return { broken: 'the opener recorded no reading of popup.closed' };
  // On the error page `.closed` flips because of the error page itself (the control): the request is what's wrong.
  if (run.at !== null && isErrorPage(...splitAt(run.at))) return { finding: `the popup is on Google's OAuth error page (${run.at}): Google refuses the request` };
  const f = falseClose(run);
  if (f) return { finding: `popup.closed read true at ${f.t} ms while the popup was open (at ${run.at ?? 'unknown'}): a page on the way enforces COOP` };
  if (run.closedAt !== null && run.closedAt <= WATCH_MS) return { broken: `the popup closed by itself after ${run.closedAt} ms` };
  if (!afterRealClose) return { broken: 'closing the popup for real never read popup.closed true: the poll is broken' };
  return {};
}

/** The control (Google's error page enforces COOP): `.closed` must read true while the popup is open. */
export function judgeControlRun(run: PopupRun): { broken?: string; flippedAt?: number } {
  const f = falseClose(run);
  if (f) return { flippedAt: f.t };
  if (run.closedAt !== null && run.closedAt <= WATCH_MS) return { broken: `the control popup closed by itself after ${run.closedAt} ms` };
  return { broken: `the control did not flip: popup.closed never read true within ${WATCH_MS / 1000} s on Google's error page (at ${run.at ?? 'unknown'}). The canary can't see an enforcing page; fix the canary (a new positive control) before trusting a pass` };
}

const splitAt = (at: string): [string, string] => {
  const i = at.indexOf('/');
  return i < 0 ? [at, '/'] : [at.slice(0, i), at.slice(i)];
};

// The part of Playwright the canary uses (apps/e2e's @playwright/test, loaded at run time).
interface PwResponse {
  url(): string;
  status(): number;
  allHeaders(): Promise<Record<string, string>>;
  request(): { resourceType(): string; frame(): { parentFrame(): unknown } };
}
interface PwPage {
  goto(url: string): Promise<unknown>;
  click(selector: string): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  isClosed(): boolean;
  url(): string;
  close(): Promise<void>;
  on(event: 'close', fn: () => void): void;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  waitForEvent(event: 'page', options?: { timeout: number }): Promise<PwPage>;
  on(event: 'response', fn: (r: PwResponse) => void): void;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(): Promise<PwContext>;
  close(): Promise<void>;
}
export interface PwBrowserType {
  launch(options: { headless: boolean }): Promise<PwBrowser>;
}
export type Playwright = Record<'chromium' | 'firefox' | 'webkit', PwBrowserType>;
export const BROWSERS = ['chromium', 'firefox', 'webkit'] as const;

/** apps/e2e's Playwright (the version the repo's browsers are installed for). */
export function loadPlaywright(): Playwright {
  const req = createRequire(join(repoRoot, 'apps/e2e/package.json'));
  return req('@playwright/test') as Playwright;
}

/** The opener page: a button (`window.open` needs a click) and a 250 ms poll of `.closed`, logging each change. */
export const OPENER_HTML = `<!doctype html><meta charset=utf-8><title>coop-canary opener</title><button id=go>open</button><script>
window.__log = [];
document.getElementById('go').onclick = () => {
  const t0 = performance.now();
  const w = window.open(window.__target, 'coop_canary', 'popup,width=500,height=600');
  let last = null;
  const tick = () => { const c = w ? w.closed : true; if (c !== last) { window.__log.push({ t: Math.round(performance.now() - t0), closed: c }); last = c; } setTimeout(tick, ${POLL_MS}); };
  tick();
};
</script>`;

/** Serves OPENER_HTML on 127.0.0.1 (opened as http://localhost:<port>/). */
export async function openerServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(OPENER_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://localhost:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const hostPath = (u: string): string | null => {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname}`;
  } catch {
    return null;
  }
};

/** One popup in a fresh context: open `target`, watch WATCH_MS, then (when `closeAfter`) close it for real. */
async function popupRun(browser: PwBrowser, opener: string, target: string, closeAfter: boolean, log: (line: string) => void): Promise<{ run: PopupRun; afterRealClose: boolean }> {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    // The popup's top-level document responses, printed after the watch (in order, with the policy headers only).
    const navs: Promise<string>[] = [];
    ctx.on('response', (resp) => {
      const req = resp.request();
      if (req.resourceType() !== 'document' || resp.url().startsWith(`${opener}/`)) return;
      try {
        if (req.frame().parentFrame()) return; // an iframe's document
      } catch {
        // A popup's first navigation can have no frame yet: it is top-level.
      }
      const [host, path] = splitAt(hostPath(resp.url()) ?? '?');
      const status = resp.status();
      navs.push(
        resp
          .allHeaders()
          .catch(() => ({}) as Record<string, string>)
          .then((h) => formatHop({ status, host, path, coop: h['cross-origin-opener-policy'] ?? null, coopRO: h['cross-origin-opener-policy-report-only'] ?? null, coep: h['cross-origin-embedder-policy'] ?? null, coepRO: h['cross-origin-embedder-policy-report-only'] ?? null, corp: h['cross-origin-resource-policy'] ?? null })),
      );
    });
    await page.goto(`${opener}/`);
    await page.evaluate(`window.__target = ${JSON.stringify(target)}`);
    const popupP = ctx.waitForEvent('page', { timeout: 10_000 });
    const t0 = Date.now();
    await page.click('#go');
    const popupPage = await popupP;
    let closedAt: number | null = null;
    popupPage.on('close', () => {
      closedAt ??= Date.now() - t0;
    });
    await page.waitForTimeout(WATCH_MS + 500);
    const readings = (await page.evaluate('window.__log')) as Reading[];
    const at = popupPage.isClosed() ? null : hostPath(popupPage.url());
    for (const line of await Promise.all(navs)) log(safeLine(line));
    // A real close must read closed (the poll works at all): the last change logged after it is `closed: true`.
    let afterRealClose = false;
    if (closeAfter && !popupPage.isClosed()) {
      await popupPage.close();
      await page.waitForTimeout(1_000);
      const after = (await page.evaluate('window.__log')) as Reading[];
      afterRealClose = after[after.length - 1]?.closed === true;
    }
    return { run: { readings, closedAt, at }, afterRealClose };
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

export interface BrowserResult {
  findings: string[];
  broken: string[];
}

/** The browser check in each of Chromium, Firefox and WebKit, headless and signed out. */
export async function browserCheck(e: CanaryEnv, log: (line: string) => void, load: () => Playwright = loadPlaywright): Promise<BrowserResult> {
  const findings: string[] = [];
  const broken: string[] = [];
  let pw: Playwright;
  try {
    pw = load();
  } catch (err) {
    const msg = `Playwright not found in apps/e2e (${err instanceof Error ? err.name : 'error'}): run corepack pnpm install`;
    log(safeLine(`  ${msg}`));
    return { findings, broken: [msg] };
  }
  const server = await openerServer();
  const real = canaryRequests(e)[0]!;
  try {
    for (const name of BROWSERS) {
      let browser: PwBrowser;
      try {
        browser = await pw[name].launch({ headless: true });
      } catch (err) {
        const msg = `${name}: could not launch (${err instanceof Error ? (err.message.split('\n')[0] ?? err.name) : 'error'}); install the browsers: corepack pnpm --filter @hana-id/e2e exec playwright install chromium firefox webkit`;
        broken.push(msg);
        log(safeLine(`  ${msg}`));
        continue;
      }
      try {
        log(safeLine(`  [${name}] ${real.label}`));
        const r = await popupRun(browser, server.origin, real.url, true, log);
        log(safeLine(`    readings ${JSON.stringify(r.run.readings)}; popup at ${r.run.at ?? 'closed'}; a real close read closed: ${r.afterRealClose ? 'yes' : 'no'}`));
        const jr = judgeRealRun(r.run, r.afterRealClose);
        if (jr.finding) {
          findings.push(`${name}: ${jr.finding}`);
          log(safeLine(`    FINDING: ${jr.finding}`));
        } else if (jr.broken) {
          broken.push(`${name}: ${jr.broken}`);
          log(safeLine(`    COULD NOT CHECK: ${jr.broken}`));
        } else log(`    ok: never read closed while open`);

        log(safeLine(`  [${name}] control: the same request with a redirect URI Google refuses (its error page enforces COOP)`));
        const c = await popupRun(browser, server.origin, controlUrl(e), false, log);
        log(safeLine(`    readings ${JSON.stringify(c.run.readings)}; popup at ${c.run.at ?? 'closed'}`));
        const jc = judgeControlRun(c.run);
        if (jc.broken) {
          broken.push(`${name}: ${jc.broken}`);
          log(safeLine(`    CANARY BROKEN: ${jc.broken}`));
        } else log(`    ok: flipped to closed at ${jc.flippedAt} ms while open`);
      } catch (err) {
        const msg = `${name}: ${err instanceof Error ? (err.message.split('\n')[0] ?? err.name) : 'error'}`;
        broken.push(msg);
        log(safeLine(`  COULD NOT CHECK: ${msg}`));
      } finally {
        await browser.close().catch(() => undefined);
      }
    }
  } finally {
    await server.close();
  }
  return { findings, broken };
}

// --- Main -----------------------------------------------------------------------------------------------------------

export interface CanaryDeps {
  log: (line: string) => void;
  loadManifest?: (name: string) => Manifest;
  fetchFn?: typeof fetch;
  /** The browser check (tests stub it). */
  browsers?: (e: CanaryEnv, log: (line: string) => void) => Promise<BrowserResult>;
}

/** Runs the canary; returns the exit code (EXIT_PASS, EXIT_FINDING, EXIT_BROKEN). */
export async function coopCanary(argv: readonly string[], deps: CanaryDeps): Promise<number> {
  const args = parseCli(argv, { booleans: ['headers-only'] });
  if (args.positionals.length !== 1) throw new CliError('give exactly one <env>');
  const m = (deps.loadManifest ?? loadEnv)(args.positionals[0]!);
  const e = canaryEnv(m);
  const { log } = deps;
  log(safeLine(`COOP canary for ${e.env}: client ${e.clientId}, redirect ${e.authOrigin}${CALLBACK_PATH} (D347, D386)`));
  log('Header check (fetch, manual redirects; per hop: status, host+path, COOP / COOP report-only / CORP):');
  const h = await headerCheck(e, log, deps.fetchFn);
  let b: BrowserResult | null = null;
  if (args.flag('headers-only')) log('Browser check: skipped (--headers-only).');
  else {
    log(`Browser check (Playwright, headless, signed out; popup.closed every ${POLL_MS} ms for ${WATCH_MS / 1000} s):`);
    b = await (deps.browsers ?? ((x, l) => browserCheck(x, l)))(e, log);
  }
  const findings = [...h.findings, ...(b?.findings ?? [])];
  const broken = [...h.broken, ...(b?.broken ?? [])];
  log('');
  if (findings.length) {
    log(`FAIL: ${findings.length} finding(s). D347's popup-close watch can't be trusted with what Google sends now:`);
    for (const f of findings) log(safeLine(`  - ${f}`));
    log('Don\'t release; see docs/operations.md "Before each release: the COOP canary" (what to do) and D347.');
  }
  if (broken.length) {
    log(`${findings.length ? 'Also' : 'INCONCLUSIVE'}: the canary couldn't check ${broken.length} thing(s):`);
    for (const x of broken) log(safeLine(`  - ${x}`));
  }
  if (findings.length) return EXIT_FINDING;
  if (broken.length) {
    log('Not a pass: fix what stopped the canary and run it again.');
    return EXIT_BROKEN;
  }
  log(`PASS: no enforcing COOP or COEP on the way${b ? `; popup.closed stayed false in ${BROWSERS.join(', ')}, and the control flipped in each` : ' (browser check skipped)'}.`);
  return EXIT_PASS;
}
