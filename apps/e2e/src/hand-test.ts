// The hand-test browser (D880; docs/operations.md "Trying sign-ins and NEAR actions by hand"): a browser context on
// an already-running local stack with the routes the suite installs, so a person can click through what only the tests
// could reach before: Google sign-in (the OIDC stub, src/google-stub.ts, with named test accounts in its chooser) and
// the NEAR relayer (src/near-relay.ts, the demo's guestbook and the stamps site). Both come from the very functions
// the specs use (src/browser-routes.ts routeStubs, routeNearRelayer), so the hand browser can't drift from what is
// tested (test/hand-browser.test.ts checks the route set).
//
// Test tooling only: nothing in any bundle changes, Google is never contacted (its three URLs are answered inside this
// browser context), and no product security is turned off (no bypassCSP, web security on): the stack's pages run with
// their own CSPs, exactly as under the suite. CSP violations and page errors are printed in the terminal instead of
// failing anything.
//
// The start page (HAND_START_ORIGIN, answered by a route of this context, never served by the stack) lists the local
// sites and the test accounts, and its buttons call the stack's test-only controls from this process: a waiting link
// takes effect (`POST /__e2e/links/expire`), a link is made 8 days old (`POST /__e2e/links/age`), the latest code mailed
// to an address (`GET {ISSUER}/__e2e/outbox`). Those endpoints refuse any request with an Origin, so no page can call
// them; the start page asks this process, which checks the request came from the start page itself.
import { createHash } from 'node:crypto';
import type { Browser, BrowserContext, Page, Route } from '@playwright/test';
import { routeStubs } from './browser-routes.ts';
import { GoogleStub, type StubAccount, stackGoogleKey } from './google-stub.ts';
import { type NearRelay, type NearRelayEvent, routeNearRelayer } from './near-relay.ts';
import { DEMO_APP, STAMPS_APP } from './site-apps.ts';
import { ADMIN_LANES, API_URL, AUTH_ORIGIN, DEMO_ORIGIN, ISSUER_URL, PARTNER_ORIGIN, STAMPS_ORIGIN, portBase } from './stack.ts';

/** The start page's origin: a reserved `*.localhost` name answered only by this context's route. */
export const HAND_START_ORIGIN = 'http://hand-test.localhost';
export const HAND_START_URL = `${HAND_START_ORIGIN}/`;
const DAY_MS = 24 * 3_600_000;
/** How old "Make its link 8 days old" makes a link: past the sign-in window's first 7 days (D875). */
export const AGED_LINK_DAYS = 8;

export type HandAccountId = 'ada' | 'ben' | 'cleo' | 'dev' | 'eve' | 'finn';

export interface HandAccount {
  id: HandAccountId;
  name: string;
  /** The address this Google account has (what Google tells Journear); also the address to sign in with by code. */
  email: string;
  /** Its Google `sub` (21 digits, as Google's), fixed by the tag and the name. */
  sub: string;
  /** What it's for, in plain words. */
  forWhat: string;
  /** Its start-page row offers the link buttons (a Google wallet another sign-in can join). */
  linkButtons: boolean;
}

const ACCOUNTS: readonly Omit<HandAccount, 'email' | 'sub'>[] = [
  { id: 'ada', name: 'Ada', forWhat: 'The automatic link (case A): sign in by email with Ada’s address first, then with Google as Ada. It opens the same wallet with nothing to decide.', linkButtons: false },
  { id: 'ben', name: 'Ben', forWhat: 'An email linked to a Google wallet, waiting 24 hours (case B), then cancelled from a Google sign-in (D864).', linkButtons: true },
  { id: 'cleo', name: 'Cleo', forWhat: 'The same waiting link, cancelled from the email’s own sign-in (D864).', linkButtons: true },
  { id: 'dev', name: 'Dev', forWhat: 'A waiting link that takes effect, then the “shared wallet” question and Remove (D865).', linkButtons: true },
  { id: 'eve', name: 'Eve', forWhat: 'An added sign-in more than 7 days old: the one quiet line, Done, and Remove (D875).', linkButtons: true },
  { id: 'finn', name: 'Finn', forWhat: 'Nothing linked: the demo’s guestbook and the stamps site.', linkButtons: false },
];

/** A new tag: 4 lowercase letters or digits (a new set of accounts). */
export function newHandTag(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => alphabet[b % alphabet.length]).join('');
}

export function isHandTag(tag: string): boolean {
  return /^[a-z0-9]{1,12}$/u.test(tag);
}

/**
 * The test accounts of a tag. Ada's address is a Gmail address (Google-hosted: case A links it with nothing to
 * decide, D865), written without dots as the issuer mails it; the others are on a made-up domain (not hosted: a link
 * to a Google wallet waits 24 hours, case B).
 */
export function handAccounts(tag: string): HandAccount[] {
  if (!isHandTag(tag)) throw new Error(`a tag is 1 to 12 lowercase letters or digits, not ${JSON.stringify(tag)}`);
  return ACCOUNTS.map((a) => {
    const digits = Array.from(createHash('sha256').update(`journear-hand-test/v1/${tag}/${a.id}`).digest().subarray(0, 20), (b) => String(b % 10)).join('');
    const email = a.id === 'ada' ? `ada${tag}@gmail.com` : `${a.id}-${tag}@mail-e2e.example.com`;
    return { ...a, email, sub: `1${digits}` };
  });
}

/** How an account shows in the Google stub's chooser. */
export const chooserLabel = (a: HandAccount): string => `${a.name} (${a.email})`;

export function stubAccounts(accounts: readonly HandAccount[]): StubAccount[] {
  return accounts.map((a) => ({ sub: a.sub, label: chooserLabel(a), email: a.email, emailVerified: true }));
}

// ---- the stack's test-only controls ----

async function control(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** The waiting period of the waiting links to `rootSub`'s wallets ends now (D864's "too late"); how many moved. */
export async function expireLinks(rootSub: string): Promise<number> {
  return ((await control('/__e2e/links/expire', { rootSub })) as { moved: number }).moved;
}

/** Every sign-in added to `rootSub`'s wallets started opening them `days` ago (D875); how many moved. */
export async function ageLinks(rootSub: string, days = AGED_LINK_DAYS): Promise<number> {
  return ((await control('/__e2e/links/age', { rootSub, ageMs: Math.round(days * DAY_MS) })) as { moved: number }).moved;
}

/** The newest code mailed to `address` (the outbox stub), with its subject, or null. */
export async function latestCode(address: string): Promise<{ code: string; subject: string; atMs: number } | null> {
  const res = await fetch(`${ISSUER_URL}/__e2e/outbox?to=${encodeURIComponent(address.trim().toLowerCase())}`);
  if (!res.ok) throw new Error(`the outbox: ${res.status}`);
  const mails = (await res.json()) as { subject: string; text: string; kind: string; atMs: number }[];
  const last = mails.filter((m) => m.kind === 'code').at(-1);
  const code = last && /\b(\d{6})\b/u.exec(last.text)?.[1];
  return last && code ? { code, subject: last.subject, atMs: last.atMs } : null;
}

/**
 * Forgets, in this browser, that Done was pressed on an older sign-in's line (D875: the sign-in window keeps it in the
 * sign-in origin's localStorage, `hana.ol.*`), as a private window starts without it. Returns how many it removed.
 */
export async function forgetDone(context: BrowserContext): Promise<number> {
  const page = await context.newPage();
  try {
    await page.goto(`${AUTH_ORIGIN}/home`);
    return await page.evaluate(() => {
      const keys = Object.keys(localStorage).filter((k) => k.startsWith('hana.ol.'));
      for (const k of keys) localStorage.removeItem(k);
      return keys.length;
    });
  } finally {
    await page.close();
  }
}

/** The stack answers on this port base (and, when `fingerprint` is given, whether it is that code's stack). */
export async function stackHealth(): Promise<{ ok: boolean; fingerprint: string | null }> {
  try {
    const res = await fetch(`${API_URL}/__e2e/health`);
    const b = (await res.json()) as { ok?: boolean; fingerprint?: string };
    return { ok: res.ok && b.ok === true, fingerprint: b.fingerprint ?? null };
  } catch {
    return { ok: false, fingerprint: null };
  }
}

/**
 * Creates the demo's and the stamps site's apps, as the specs create them (src/site-apps.ts; each once: a create with
 * the same key returns the first app). Both have email sign-in on.
 */
export async function ensureSiteApps(): Promise<void> {
  for (const spec of [DEMO_APP, STAMPS_APP]) {
    const res = await fetch(`${API_URL}/__e2e/apps`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec) });
    if (res.status !== 201) throw new Error(`creating the ${String(spec.name)} app: ${res.status} ${await res.text()}`);
  }
}

// ---- the start page ----

const esc = (s: string): string => s.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');

/** How to start the hand browser again with the same accounts (the port base named when it isn't the default). */
export function restartCommand(tag: string): string {
  const base = process.env.HANA_E2E_PORT_BASE ? `HANA_E2E_PORT_BASE=${portBase()} ` : '';
  return `${base}corepack pnpm --filter @hana-id/e2e hand-browser --tag ${tag}`;
}

export function startPageHtml(tag: string, accounts: readonly HandAccount[]): string {
  const site = (name: string, url: string, what: string, link = true) =>
    `<tr><th scope="row">${esc(name)}</th><td>${link ? `<a href="${esc(url)}" target="_blank">${esc(url)}</a>` : `<code>${esc(url)}</code>`}</td><td>${esc(what)}</td></tr>`;
  const rows = accounts
    .map((a) => {
      const linkButtons = a.linkButtons
        ? `<button type="button" data-action="expire" data-account="${a.id}">Make its waiting link take effect</button>
           <button type="button" data-action="age" data-account="${a.id}">Make its link ${AGED_LINK_DAYS} days old</button>`
        : '';
      return `<tr data-account="${a.id}"><th scope="row">${esc(a.name)}</th><td><code class="address">${esc(a.email)}</code></td><td>${esc(a.forWhat)}</td>
        <td class="actions"><button type="button" data-action="code" data-address="${esc(a.email)}">Show the latest code</button>${linkButtons}
        <p class="result" role="status" aria-live="polite"></p></td></tr>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Journear hand test</title>
<style>
  :root { color-scheme: light dark; --bg: #fbfaf7; --fg: #1d1b16; --muted: #5d5a52; --line: #dedad0; --accent: #1f5f8b; }
  @media (prefers-color-scheme: dark) { :root { --bg: #17171a; --fg: #ecebe6; --muted: #a9a69c; --line: #3a3a40; --accent: #8cc3ea; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 32px 0 8px; }
  p { margin: 6px 0; } .muted { color: var(--muted); }
  table { width: 100%; border-collapse: collapse; } th, td { text-align: left; vertical-align: top; padding: 8px; border-top: 1px solid var(--line); }
  th[scope="row"] { white-space: nowrap; } code { font-size: 13px; overflow-wrap: anywhere; } a { color: var(--accent); overflow-wrap: anywhere; }
  button { font: inherit; font-size: 14px; margin: 0 6px 6px 0; padding: 4px 10px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--fg); cursor: pointer; }
  button:hover { border-color: var(--accent); } .actions { min-width: 260px; } .result { font-size: 14px; }
  input { font: inherit; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--fg); width: min(100%, 360px); }
  @media (max-width: 760px) { table, tbody, tr, th, td { display: block; } th[scope="row"] { padding-bottom: 0; } td { border-top: 0; } tr { border-top: 1px solid var(--line); } }
</style></head>
<body><main>
<h1>Journear hand test</h1>
<p class="muted">The local test stack, in a browser that has the tests’ pretend Google and pretend NEAR relayer. Everything is made up and stays on this computer: Google is never contacted, no test network is used. Close this browser (or press Ctrl+C in its terminal) to end it.</p>

<h2>Sites</h2>
<table><tbody>
${site('Hosted demo', `${DEMO_ORIGIN}/`, 'Sign in with Google or email; write to the NEAR guestbook.')}
${site('Stamps site', `${STAMPS_ORIGIN}/`, 'Collect stamps on the pretend NEAR network.')}
${site('Passport Home', `${AUTH_ORIGIN}/home`, 'Your wallets and their ways to sign in.')}
${site('Staff admin portal', `${ADMIN_LANES.demo}/__e2e/access/sign-in?as=staff`, 'Signs you in as staff@e2e.invalid (docs/operations.md, “Trying the staff admin portal by hand”).')}
${site('Partner test app', `${PARTNER_ORIGIN}/?pk=<app key>`, 'Only for the automated tests: one Act button, nothing to try by hand.', false)}
${site('Email outbox', `${ISSUER_URL}/__e2e/outbox?to=<address>`, 'Every email the stack “sent” to that address (lower case), codes included. The buttons below read it for you.', false)}
</tbody></table>

<h2>Test Google accounts</h2>
<p class="muted">They show in the pretend Google’s “Choose an account” window. Each has its own address: type it when a step says to sign in by email with it.</p>
<table><thead><tr><th>Name</th><th>Address</th><th>What it’s for</th><th>Helpers</th></tr></thead><tbody>
${rows}
</tbody></table>

<h2>A code for any address</h2>
<p><label for="any-address">Address</label> <input id="any-address" type="email" autocomplete="off" spellcheck="false">
<button type="button" data-action="code" data-from="any-address">Show the latest code</button></p>
<p class="result" role="status" aria-live="polite" id="any-result"></p>

<h2>This browser</h2>
<p>A sign-in window that shows an older added sign-in (more than 7 days) stops showing it once you press Done, in this browser only. A private window starts without that memory.</p>
<p><button type="button" data-action="forget-done">Forget “Done” in this browser</button></p>
<p class="result" role="status" aria-live="polite" id="forget-result"></p>

<h2>Starting again</h2>
<p>These accounts belong to tag <code id="tag">${esc(tag)}</code>. The stack keeps their wallets until it stops. To use them again after closing this browser, start it with:</p>
<p><code id="restart">${esc(restartCommand(tag))}</code></p>
<p class="muted">Without <code>--tag</code> you get new accounts with new addresses: every flow starts from the beginning.</p>
</main>
<script>
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-action]');
  if (!b) return;
  const out = b.closest('td.actions')?.querySelector('.result') ?? (b.dataset.action === 'forget-done' ? document.getElementById('forget-result') : document.getElementById('any-result'));
  const body = { account: b.dataset.account ?? null, address: b.dataset.address ?? (b.dataset.from ? document.getElementById(b.dataset.from).value : null) };
  out.textContent = 'Working…';
  try {
    const res = await fetch('/control/' + b.dataset.action, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hand-test': '1' }, body: JSON.stringify(body) });
    out.textContent = (await res.json()).message;
  } catch (err) {
    out.textContent = 'The hand browser didn’t answer: is it still running?';
  }
});
</script>
</body></html>`;
}

// ---- the session ----

export interface HandSessionOptions {
  /** The accounts' tag (default a new one). */
  tag?: string;
  /** The context's viewport: null (the window's size) for a person, a size for a headless check. */
  viewport?: { width: number; height: number } | null;
  /** Where the session's notes go (default the terminal). */
  log?: (line: string) => void;
}

export interface HandSession {
  tag: string;
  accounts: HandAccount[];
  context: BrowserContext;
  google: GoogleStub;
  relay: NearRelay;
  start: Page;
  /** Resolves when the person has closed every window of the context, or the browser went away. */
  closed: Promise<'windows-closed' | 'browser-gone'>;
}

/** The start page's own route: the page, and its buttons' requests (only from the start page itself). */
async function startRoute(route: Route, o: { tag: string; accounts: readonly HandAccount[]; context: BrowserContext }): Promise<void> {
  const req = route.request();
  const url = new URL(req.url());
  const answer = (status: number, message: string) => route.fulfill({ status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify({ message }) });
  if (req.method() === 'GET' && url.pathname === '/') {
    return route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: startPageHtml(o.tag, o.accounts) });
  }
  if (req.method() === 'GET' && url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
  const m = /^\/control\/([a-z-]+)$/u.exec(url.pathname);
  const headers = req.headers();
  // Only the start page's own buttons: same origin, with the header a form or a cross-site page can't send.
  if (!m || req.method() !== 'POST' || headers['origin'] !== HAND_START_ORIGIN || headers['x-hand-test'] !== '1') return answer(404, 'Not found.');
  let body: { account?: string | null; address?: string | null };
  try {
    body = (req.postDataJSON() ?? {}) as typeof body;
  } catch {
    return answer(400, 'That request wasn’t understood.');
  }
  const account = o.accounts.find((a) => a.id === body.account);
  try {
    switch (m[1]) {
      case 'code': {
        const address = (body.address ?? '').trim().toLowerCase();
        if (!address.includes('@')) return answer(400, 'Type an address first.');
        const c = await latestCode(address);
        if (!c) return answer(200, `No code has been sent to ${address} yet.`);
        return answer(200, `Latest code for ${address}: ${c.code} (sent ${new Date(c.atMs).toLocaleTimeString('en-GB')}, “${c.subject}”).`);
      }
      case 'expire': {
        if (!account) return answer(400, 'Unknown account.');
        const moved = await expireLinks(account.sub);
        return answer(200, moved ? `Done: ${account.name}’s waiting link works now.` : `Nothing changed: no link is waiting to join ${account.name}’s wallet.`);
      }
      case 'age': {
        if (!account) return answer(400, 'Unknown account.');
        const moved = await ageLinks(account.sub);
        return answer(200, moved ? `Done: the sign-in added to ${account.name}’s wallet now opens it since ${AGED_LINK_DAYS} days ago.` : `Nothing changed: no sign-in is added to ${account.name}’s wallet.`);
      }
      case 'forget-done': {
        const n = await forgetDone(o.context);
        return answer(200, n ? 'Done: this browser has forgotten it. The next sign-in shows the line again.' : 'Nothing to forget: no Done is remembered in this browser.');
      }
      default:
        return answer(404, 'Not found.');
    }
  } catch (e) {
    return answer(502, `The stack refused: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const relayLine = (e: NearRelayEvent): string => {
  switch (e.kind) {
    case 'refused':
      return `NEAR relay (${e.site}): ${e.path} answered "not recorded yet" (the page retries by itself)`;
    case 'activated':
      return `NEAR relay (${e.site}): account ${e.account.slice(0, 8)}… created`;
    case 'relayed':
      return `NEAR relay (${e.site}): ${e.what} from ${e.account.slice(0, 8)}…${e.panic ? `, refused by the contract: ${e.panic}` : ''}`;
    case 'problem':
      return `NEAR relay: a request that isn't the site's own call was refused: ${e.problem}`;
  }
};

/**
 * Every route the hand browser installs: the suite's own (routeStubs, routeNearRelayer for both sites) and the start
 * page's. `context` may be a recorder (test/hand-browser.test.ts).
 */
export async function installHandRoutes(
  context: Pick<BrowserContext, 'route'>,
  o: { google: GoogleStub; tag: string; accounts: readonly HandAccount[]; browserContext: BrowserContext; log: (line: string) => void },
): Promise<NearRelay> {
  await routeStubs(context, o.google);
  const relay = await routeNearRelayer(context, ['demo', 'stamps'], { onEvent: (e) => o.log(relayLine(e)) });
  await context.route(`${HAND_START_ORIGIN}/**`, (route) => startRoute(route, { tag: o.tag, accounts: o.accounts, context: o.browserContext }));
  return relay;
}

/** Opens the hand-test context in `browser` on the running stack, with its start page. */
export async function openHandSession(browser: Browser, o: HandSessionOptions = {}): Promise<HandSession> {
  const log = o.log ?? ((line: string) => console.log(`[hand-browser] ${line}`));
  const tag = o.tag ?? newHandTag();
  const accounts = handAccounts(tag);
  await ensureSiteApps();
  const context = await browser.newContext({ viewport: o.viewport === undefined ? null : o.viewport });
  const google = new GoogleStub({ key: stackGoogleKey(API_URL) });
  google.accounts = stubAccounts(accounts);
  const relay = await installHandRoutes(context, { google, tag, accounts, browserContext: context, log });
  // Noted, never blocking: a CSP violation on any page (each page reports its own), and uncaught page errors.
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.warn(`[hand-browser] CSP violation: ${e.effectiveDirective} ${e.blockedURI}`));
  });
  context.on('console', (m) => {
    if (m.text().startsWith('[hand-browser] CSP violation')) log(`${m.text().slice('[hand-browser] '.length)} on ${m.page()?.url() ?? 'a page'}`);
  });
  context.on('weberror', (e) => log(`page error on ${e.page()?.url() ?? 'a page'}: ${e.error().message}`));
  const closed = new Promise<'windows-closed' | 'browser-gone'>((resolve) => {
    const watch = (p: Page) =>
      p.on('close', () => {
        if (context.pages().length === 0) resolve('windows-closed');
      });
    context.on('page', watch);
    context.on('close', () => resolve('windows-closed'));
    browser.on('disconnected', () => resolve('browser-gone'));
  });
  const start = await context.newPage();
  await start.goto(HAND_START_URL);
  return { tag, accounts, context, google, relay, start, closed };
}
