// Shared fixtures and steps for the Playwright specs.
//
// Every test gets a fresh browser context with the Google stub routed in (src/google-stub.ts), a log of every request
// its pages, frames and popups make (so "zero /v1/derive calls" is counted per test, not across the shared stack), and
// its own app(s) on the mocked API: test apps on the partner's loopback origins, or live apps (`newLiveApp`, opened
// with `{ live: true }`) in the stack's live mode, whose https origins the context routes to the stack (src/stack.ts
// LIVE_UPSTREAMS). The partner test app (partner/app.ts) is driven through `window.e2e`: gesture
// actions are armed and then started by a real click on its #act button, so window.open runs with user activation.
import { type APIResponse, type BrowserContext, type Frame, type FrameLocator, type Page, type Route, test as base, expect } from '@playwright/test';
import { GOOGLE_AUTH_URL, GOOGLE_CERTS_URL, GoogleStub, stackGoogleKey } from '../src/google-stub.ts';
import type { AppSpec as ServerAppSpec } from '../src/server/api.ts';
import {
  API_URL,
  AUTH_ORIGIN,
  EVIL_ORIGIN,
  EVM_RPC,
  LIVE_API_URL,
  LIVE_AUTH_ORIGIN,
  LIVE_ENV_NAME,
  LIVE_PARTNER_ORIGIN,
  LIVE_UPSTREAMS,
  LIVE_VAULT_ORIGIN,
  PARTNER_ORIGIN,
  VAULT_ORIGIN,
} from '../src/stack.ts';

export { expect };

/** An app for POST /__e2e/apps; `origins` defaults to the partner origin. */
export type AppSpec = Partial<ServerAppSpec>;

export interface App {
  appId: string;
  pk: string;
}

export type Result = { state: 'pending' } | { state: 'ok'; value: unknown } | { state: 'error'; code: unknown; message: string; reason: unknown; data: unknown };

/** POST /v1/login exactly (not /v1/login-relay/…). */
export const LOGIN_ENDPOINT = new RegExp(`^${API_URL.replace(/[.]/gu, '\\.')}/v1/login$`, 'u');

/** Every request the context's pages make (frames and popups included), in order. */
export class RequestLog {
  readonly entries: { method: string; url: string }[] = [];

  constructor(context: BrowserContext) {
    context.on('request', (r) => this.entries.push({ method: r.method(), url: r.url() }));
  }

  /** A position to count from (`since`). */
  mark(): number {
    return this.entries.length;
  }

  /** Requests (not CORS preflights) whose URL starts with `match` (or matches it), after `since`. */
  count(match: string | RegExp, since = 0): number {
    const hit = (url: string) => (typeof match === 'string' ? url.startsWith(match) : match.test(url));
    return this.entries.slice(since).filter((e) => e.method !== 'OPTIONS' && hit(e.url)).length;
  }
}

/** The page script of a foreign site (EVIL_ORIGIN): never Hana code, served only by a route in the test's context. */
const EVIL_HTML = `<!doctype html><meta charset="utf-8"><title>evil</title><script>
window.received = [];
addEventListener('message', (e) => { window.received.push({ origin: e.origin, t: e.data && e.data.t }); });
</script><h1>evil</h1>`;

/**
 * Routes Google's two endpoints to `google`, the foreign site to its static page, and live mode's https origins to the
 * stack (LIVE_UPSTREAMS), in `context`.
 */
export async function routeStubs(context: BrowserContext, google: GoogleStub): Promise<void> {
  await context.route(`${GOOGLE_AUTH_URL}**`, async (route) => route.fulfill(await google.authorize(new URL(route.request().url()))));
  await context.route(GOOGLE_CERTS_URL, async (route) =>
    route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }, body: JSON.stringify(await google.jwks()) }),
  );
  await context.route(`${EVIL_ORIGIN}/**`, (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/html' }, body: EVIL_HTML }));
  await context.route((url) => Object.hasOwn(LIVE_UPSTREAMS, url.origin), forwardLive);
}

/**
 * A request to one of live mode's https origins, forwarded to the stack server behind it (as a TLS-terminating front
 * would: method, headers and body unchanged, the server's response, headers included, as is). The servers rewrite the
 * URL back to the https origin (src/server/http.ts servedAt). Long polls (the login relay) take as long as they take.
 */
async function forwardLive(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  const upstream = LIVE_UPSTREAMS[url.origin] as string;
  let response: APIResponse;
  try {
    response = await route.fetch({ url: `${upstream}${url.pathname}${url.search}`, maxRedirects: 0, timeout: 0 });
  } catch {
    // The page went away mid-request (a closed popup, the end of a test).
    await route.abort().catch(() => undefined);
    return;
  }
  await route.fulfill({ response }).catch(() => undefined);
}

/**
 * Keeps every hana:approve-request the approval popups receive in `window.__approveRequests` (an init script on each
 * authOrigin's /approve), so a test can forge an answer for the request on show.
 */
export async function recordApproveRequests(context: BrowserContext): Promise<void> {
  await context.addInitScript(
    ([auth]) => {
      if (!auth.includes(location.origin) || location.pathname !== '/approve') return;
      const seen: unknown[] = [];
      (window as any).__approveRequests = seen;
      addEventListener('message', (e) => {
        if (e.data && e.data.t === 'hana:approve-request') seen.push(e.data);
      });
    },
    [[AUTH_ORIGIN, LIVE_AUTH_ORIGIN]] as const,
  );
}

/** The Hana origins: none of their responses may set a cookie, and none may hold one after a test. */
const HANA_ORIGINS: readonly string[] = [VAULT_ORIGIN, AUTH_ORIGIN, new URL(API_URL).origin, LIVE_VAULT_ORIGIN, LIVE_AUTH_ORIGIN, LIVE_API_URL];

export const test = base.extend<{ google: GoogleStub; requests: RequestLog; noCookies: void }>({
  google: [
    async ({ context }, use) => {
      const google = new GoogleStub({ key: stackGoogleKey(API_URL) });
      await routeStubs(context, google);
      await use(google);
    },
    { auto: true },
  ],
  requests: [async ({ context }, use) => use(new RequestLog(context)), { auto: true }],
  // No Hana page or API response sets a cookie (docs/security.md): checked on every response of every test, and no
  // cookie exists for a Hana origin at the end (a script can't have set one either).
  noCookies: [
    async ({ context }, use) => {
      const seen: Promise<string | null>[] = [];
      context.on('response', (r) => {
        const url = r.url();
        if (!HANA_ORIGINS.some((o) => url.startsWith(`${o}/`) || url === o)) return;
        seen.push(r.headerValue('set-cookie').then((v) => (v === null ? null : `${r.request().method()} ${url.split('?')[0]}`)).catch(() => null));
      });
      await use();
      expect((await Promise.all(seen)).filter((v) => v !== null)).toEqual([]);
      expect(await context.cookies([...HANA_ORIGINS])).toEqual([]);
    },
    { auto: true },
  ],
});

// ---- the mocked API's control endpoints ----

export async function newApp(spec: AppSpec = {}): Promise<App> {
  const res = await fetch(`${API_URL}/__e2e/apps`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origins: [PARTNER_ORIGIN], ...spec }) });
  if (res.status !== 201) throw new Error(`creating the app failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as App;
}

/**
 * A live (`pk_live_`) app on LIVE_PARTNER_ORIGIN and the live scope (src/stack.ts): open it with
 * `openPartner(page, app, { live: true })`. Only a live app reaches what the vault refuses a test app (raw signing,
 * D39).
 */
export async function newLiveApp(spec: AppSpec = {}): Promise<App> {
  return newApp({ origins: [LIVE_PARTNER_ORIGIN], ...spec, live: true });
}

/** Revokes every share of the app on the API (its next unlock gets 410 share_revoked). */
export async function revokeShares(app: App): Promise<number> {
  const res = await fetch(`${API_URL}/__e2e/apps/${app.pk}/revoke`, { method: 'POST' });
  return ((await res.json()) as { revoked: number }).revoked;
}

export async function shares(app: App): Promise<{ counter: number; revoked: boolean; partnerOrigin: string }[]> {
  return (await (await fetch(`${API_URL}/__e2e/apps/${app.pk}/shares`)).json()) as { counter: number; revoked: boolean; partnerOrigin: string }[];
}

/** A relayed hana-signer transaction that carried ID tokens (src/server/chain.ts RelayedTx): identities and claim names. */
export interface RelayedTx {
  method: string;
  tokens: { provider: string; sub: string; claims: string[] }[];
}

/**
 * What reached the mocked chain through the relayer (GET /__e2e/chain): the transactions that carried a token and the
 * live sessions, of the Google or email `sub` when given (else of every test so far).
 */
export async function chainView(sub?: string): Promise<{ relayed: RelayedTx[]; sessions: number }> {
  const q = sub === undefined ? '' : `?sub=${encodeURIComponent(sub)}`;
  return (await (await fetch(`${API_URL}/__e2e/chain${q}`)).json()) as { relayed: RelayedTx[]; sessions: number };
}

/** Raw EVM transactions the mocked chain received. */
export async function evmBroadcasts(): Promise<`0x${string}`[]> {
  return (await (await fetch(`${EVM_RPC}/__e2e/txs`)).json()) as `0x${string}`[];
}

// ---- the partner test app ----

export interface PartnerOptions {
  origin?: string;
  /** Live mode (src/stack.ts): LIVE_ENV, on LIVE_PARTNER_ORIGIN unless `origin` says otherwise. */
  live?: boolean;
  /**
   * window.open returns null on the partner page (a popup blocker), so the SDK uses the vault's launcher; 'approve':
   * only for the approval popup (Safari blocking a window.open after an await), so login still opens its popup.
   */
  blockPopups?: boolean | 'approve';
  coop?: string;
}

export function partnerUrl(app: App, o: PartnerOptions = {}): string {
  const q = new URLSearchParams({ pk: app.pk });
  if (o.blockPopups) q.set('blockPopups', o.blockPopups === 'approve' ? 'approve' : '1');
  if (o.coop) q.set('coop', o.coop);
  if (o.live) q.set('env', LIVE_ENV_NAME);
  return `${o.origin ?? (o.live ? LIVE_PARTNER_ORIGIN : PARTNER_ORIGIN)}/?${q.toString()}`;
}

/** Opens the partner app and waits for the vault handshake (ready or failed). */
export async function openPartner(page: Page, app: App, o: PartnerOptions = {}): Promise<'ok' | 'error'> {
  await page.goto(partnerUrl(app, o));
  return waitReady(page);
}

export async function waitReady(page: Page): Promise<'ok' | 'error'> {
  await page.waitForFunction(() => (window as any).e2e?.ready !== 'pending' && (window as any).e2e?.ready !== undefined, null, { timeout: 15_000 });
  return page.evaluate(() => (window as any).e2e.ready as 'ok' | 'error');
}

/** Arms `action` and clicks #act, so it starts inside a real click (user activation). */
export async function clickAction(page: Page, name: string, action: string, ...args: unknown[]): Promise<void> {
  await page.evaluate(([n, a, rest]) => (window as any).e2e.arm(n, a, ...(rest as unknown[])), [name, action, args] as const);
  await page.click('#act');
}

/** Starts `action` without a user gesture. */
export async function runAction(page: Page, name: string, action: string, ...args: unknown[]): Promise<void> {
  await page.evaluate(([n, a, rest]) => (window as any).e2e.run(n, a, ...(rest as unknown[])), [name, action, args] as const);
}

export async function peek(page: Page, name: string): Promise<Result | undefined> {
  return page.evaluate((n) => (window as any).e2e.results[n] as Result | undefined, name);
}

/** Waits for the action's outcome. */
export async function settled(page: Page, name: string, timeout = 30_000): Promise<Result> {
  await page.waitForFunction((n) => (window as any).e2e.results[n] && (window as any).e2e.results[n].state !== 'pending', name, { timeout });
  return (await peek(page, name)) as Result;
}

export async function okValue<T = unknown>(page: Page, name: string, timeout?: number): Promise<T> {
  const r = await settled(page, name, timeout);
  if (r.state !== 'ok') throw new Error(`${name} failed: ${JSON.stringify(r)}`);
  return r.value as T;
}

export async function errorCode(page: Page, name: string, timeout?: number): Promise<unknown> {
  return (await errorOf(page, name, timeout)).code;
}

/** The action's error: its code and the vault's `data.reason` (null when it has none). */
export async function errorOf(page: Page, name: string, timeout?: number): Promise<{ code: unknown; reason: unknown }> {
  const r = await settled(page, name, timeout);
  if (r.state !== 'error') throw new Error(`${name} did not fail: ${JSON.stringify(r)}`);
  return { code: r.code, reason: r.reason };
}

export const status = (page: Page): Promise<string> => page.evaluate(() => (window as any).e2e.status() as string);
export const addresses = (page: Page): Promise<{ stellar: string; evm: string } | null> => page.evaluate(() => (window as any).e2e.addresses());

// ---- the vault frame and its launcher ----

export const VAULT_FRAME = 'iframe[name^="hana-vault-"]';

export function vaultFrame(page: Page): Frame {
  const f = page.frames().find((x) => x.url().startsWith(`${VAULT_ORIGIN}/vault`) || x.url().startsWith(`${LIVE_VAULT_ORIGIN}/vault`));
  if (!f) throw new Error('no vault frame');
  return f;
}

export const launcher = (page: Page): FrameLocator => page.frameLocator(VAULT_FRAME);

/** Waits for the launcher to show `label`, then clicks it and returns the window it opens. */
export async function clickLauncher(page: Page, label: string | RegExp): Promise<Page> {
  const button = launcher(page).getByRole('button', { name: label });
  await expect(button).toBeVisible();
  const popup = page.waitForEvent('popup');
  await button.click();
  return popup;
}

/**
 * The record keys in the vault frame's IndexedDB (as this top-level site's partition sees them). The root pins
 * beside them (`pin|…`, D263: they outlive a logout on purpose) are listed by vaultPinKeys.
 */
export async function vaultRecordKeys(page: Page): Promise<string[]> {
  return (await vaultStoreKeys(page)).filter((k) => !k.startsWith('pin|'));
}

/** The root pins' keys in the vault frame's IndexedDB (D263). */
export async function vaultPinKeys(page: Page): Promise<string[]> {
  return (await vaultStoreKeys(page)).filter((k) => k.startsWith('pin|'));
}

async function vaultStoreKeys(page: Page): Promise<string[]> {
  return vaultFrame(page).evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('hana-vault');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('records')) {
            db.close();
            resolve([]);
            return;
          }
          const req = db.transaction('records', 'readonly').objectStore('records').getAllKeys();
          req.onsuccess = () => {
            db.close();
            resolve(req.result.map(String));
          };
          req.onerror = () => reject(req.error);
        };
      }),
  );
}

// ---- login ----

/** In the login popup: waits for the Google stub's chooser, picks `account`, and waits for the callback to close it. */
export async function chooseAccount(popup: Page, account = 0): Promise<void> {
  await popup.waitForURL(`${GOOGLE_AUTH_URL}**`);
  await popup.click(`#account-${account}`);
  await popup.waitForEvent('close', { timeout: 20_000 });
}

/**
 * One click on the partner's login button, the stub's chooser, and the result. In 'session' mode the vault replies
 * before it makes the share and record (D79): this then waits for the record too, so a reload right after unlocks.
 */
export async function login(page: Page, opts: { account?: number; name?: string } = {}): Promise<{ stellar: string; evm: string }> {
  const name = opts.name ?? 'login';
  const popup = page.waitForEvent('popup');
  await clickAction(page, name, 'login');
  await chooseAccount(await popup, opts.account);
  const result = await okValue<{ stellar: string; evm: string }>(page, name);
  if ((await page.evaluate(() => (window as any).e2e.hana.lastLogin?.persistence)) === 'session') await waitPersisted(page, result.evm);
  return result;
}

/** Waits until the vault's IndexedDB holds a record for the wallet `evm` (the background persist after a login). */
export async function waitPersisted(page: Page, evm: string): Promise<void> {
  const vault = vaultFrame(page);
  await expect
    .poll(
      () =>
        vault.evaluate(
          (want) =>
            new Promise<boolean>((resolve) => {
              const open = indexedDB.open('hana-vault');
              open.onerror = () => resolve(false);
              open.onsuccess = () => {
                const db = open.result;
                if (!db.objectStoreNames.contains('records')) {
                  db.close();
                  resolve(false);
                  return;
                }
                const req = db.transaction('records', 'readonly').objectStore('records').getAll();
                req.onsuccess = () => {
                  db.close();
                  resolve(req.result.some((r: { addresses?: { evm?: string } }) => r?.addresses?.evm === want));
                };
                req.onerror = () => resolve(false);
              };
            }),
          evm,
        ),
      { timeout: 10_000, message: 'the vault record after login' },
    )
    .toBe(true);
}

// ---- approval ----

/**
 * Approve, as a user does: wait past the guard's 1 s marks (render and focus), move the pointer inside the window,
 * then click. The guard also requires the click's own pointerdown to come after the arming move.
 */
export async function approve(popup: Page, label: 'Approve' | 'Allow' = 'Approve'): Promise<void> {
  const button = popup.getByRole('button', { name: label, exact: true });
  await expect(button).toBeVisible();
  await popup.waitForTimeout(1_100);
  await popup.mouse.move(5, 5);
  await popup.mouse.move(40, 40, { steps: 3 });
  await expect(button).toBeEnabled();
  await button.click();
}

export async function reject(popup: Page): Promise<void> {
  await popup.getByRole('button', { name: 'Reject', exact: true }).click();
}

