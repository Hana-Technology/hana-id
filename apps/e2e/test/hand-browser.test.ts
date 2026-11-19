// The hand-test browser (D880, src/hand-test.ts): its route set is the suite's (so it can't silently fall behind what
// the tests run with), the specs take those routes from the shared modules rather than defining their own, its test
// accounts are what the start page promises, and its start page answers only its own buttons.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { routeStubs } from '../src/browser-routes.ts';
import { GOOGLE_AUTH_URL, GOOGLE_CERTS_URL, GOOGLE_TOKENINFO_URL, GoogleStub } from '../src/google-stub.ts';
import { HAND_START_ORIGIN, chooserLabel, handAccounts, installHandRoutes, isHandTag, newHandTag, startPageHtml, stubAccounts } from '../src/hand-test.ts';
import { NEAR_RELAY_ROUTE, routeNearRelayer } from '../src/near-relay.ts';
import { ADMIN_LANES, AUTH_ORIGIN, DEMO_ORIGIN, ISSUER_URL, STAMPS_ORIGIN } from '../src/stack.ts';

type Handler = (route: unknown) => unknown;

/** A context that records the routes installed on it: each pattern as text (a predicate by its source). */
function recorder(): { route: (pattern: unknown, handler: Handler) => Promise<void>; patterns: string[]; handlers: Map<string, Handler> } {
  const patterns: string[] = [];
  const handlers = new Map<string, Handler>();
  return {
    patterns,
    handlers,
    async route(pattern, handler) {
      const key = typeof pattern === 'function' ? `predicate: ${pattern.toString()}` : String(pattern);
      patterns.push(key);
      handlers.set(key, handler);
    },
  };
}

const TESTS_DIR = new URL('../tests/', import.meta.url);
const specSource = (name: string): string => readFileSync(new URL(name, TESTS_DIR), 'utf8');

describe('the hand browser’s routes are the suite’s (D880)', () => {
  it('the same set the suite installs: the Google stub’s, the foreign site’s, live mode’s, the NEAR relay’s; plus only its own start page', async () => {
    const suite = recorder();
    await routeStubs(suite as never, new GoogleStub());
    await routeNearRelayer(suite as never, ['demo', 'stamps']);
    const hand = recorder();
    const tag = newHandTag();
    await installHandRoutes(hand as never, { google: new GoogleStub(), tag, accounts: handAccounts(tag), browserContext: {} as never, log: () => undefined });
    expect(hand.patterns.filter((p) => p !== `${HAND_START_ORIGIN}/**`)).toEqual(suite.patterns);
    expect(hand.patterns.filter((p) => p === `${HAND_START_ORIGIN}/**`)).toHaveLength(1);
    // What those are, so a change to the set is seen here too.
    expect(suite.patterns.slice(0, 3)).toEqual([`${GOOGLE_AUTH_URL}**`, GOOGLE_CERTS_URL, `${GOOGLE_TOKENINFO_URL}**`]);
    expect(suite.patterns.at(-1)).toBe(NEAR_RELAY_ROUTE);
    // Google is never served by the stack: only routed inside the browser context.
    expect(hand.patterns.some((p) => p.includes('accounts.google.com'))).toBe(true);
  });

  it('every spec takes Google’s routes from the fixtures (routeStubs) and the NEAR relay from src/near-relay.ts: none routes them itself', () => {
    const specs = readdirSync(TESTS_DIR).filter((f) => f.endsWith('.ts'));
    const own: string[] = [];
    for (const f of specs) {
      const lines = specSource(f).split('\n');
      lines.forEach((line, i) => {
        if (/\.route\(/u.test(line) && /GOOGLE_|googleapis|accounts\.google|\/v1\/near\//u.test(line)) own.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(own).toEqual([]);
    // The fixtures' `google` fixture (every test's context) installs routeStubs from the shared module.
    const fixtures = specSource('fixtures.ts');
    expect(fixtures).toContain("import { routeStubs } from '../src/browser-routes.ts';");
    expect(fixtures).toMatch(/const google = new GoogleStub\(\{ key: stackGoogleKey\(API_URL\) \}\);\s+await routeStubs\(context, google\);/u);
    // The NEAR relay's specs use the shared relay.
    for (const f of ['demo.spec.ts', 'stamps.spec.ts', 'demo-near-shots.spec.ts']) {
      expect(specSource(f), f).toContain("import { routeNearRelayer } from '../src/near-relay.ts';");
      expect(specSource(f), f).toMatch(/await routeNearRelayer\(page, \[/u);
    }
  });
});

describe('the hand browser’s test accounts', () => {
  it('six named accounts, fixed by the tag: two different Google accounts at least, and Ada’s Gmail address for case A', () => {
    const a = handAccounts('abcd');
    expect(a.map((x) => x.name)).toEqual(['Ada', 'Ben', 'Cleo', 'Dev', 'Eve', 'Finn']);
    expect(handAccounts('abcd')).toEqual(a);
    expect(new Set(a.map((x) => x.sub)).size).toBe(6);
    expect(new Set(a.map((x) => x.email)).size).toBe(6);
    for (const x of a) expect(x.sub).toMatch(/^1\d{20}$/u);
    // Ada: Google-hosted (case A links it with nothing to decide), no dots (the issuer mails a Gmail address without them).
    expect(a[0]!.email).toBe('adaabcd@gmail.com');
    // The others: not Google-hosted (a link to a Google wallet waits 24 hours, case B).
    for (const x of a.slice(1)) expect(x.email).toMatch(/^[a-z]+-abcd@mail-e2e\.example\.com$/u);
    // Another tag: other people.
    const b = handAccounts('wxyz');
    expect(b.some((x) => a.some((y) => y.sub === x.sub || y.email === x.email))).toBe(false);
    expect(stubAccounts(a)).toEqual(a.map((x) => ({ sub: x.sub, label: chooserLabel(x), email: x.email, emailVerified: true })));
  });

  it('tags are short lowercase words; anything else is refused', () => {
    for (let i = 0; i < 20; i++) expect(isHandTag(newHandTag())).toBe(true);
    for (const bad of ['', 'ABCD', 'a.b', 'a b', 'x'.repeat(13), '../x']) expect(() => handAccounts(bad), bad).toThrow(/a tag is/u);
  });
});

describe('the start page', () => {
  const tag = 'abcd';
  const accounts = handAccounts(tag);

  it('lists the local sites and every account with its address and helpers', () => {
    const html = startPageHtml(tag, accounts);
    for (const url of [`${DEMO_ORIGIN}/`, `${STAMPS_ORIGIN}/`, `${AUTH_ORIGIN}/home`, `${ADMIN_LANES.demo}/__e2e/access/sign-in?as=staff`, `${ISSUER_URL}/__e2e/outbox?to=&lt;address&gt;`]) expect(html).toContain(url);
    for (const a of accounts) {
      expect(html).toContain(a.email);
      expect(html).toContain(`data-account="${a.id}"`);
    }
    expect(html).toContain('Make its waiting link take effect');
    expect(html).toContain('Make its link 8 days old');
    expect(html).toContain('hand-browser --tag abcd');
  });

  it('its buttons are answered only for the start page itself (same Origin and its own header)', async () => {
    const hand = recorder();
    await installHandRoutes(hand as never, { google: new GoogleStub(), tag, accounts, browserContext: {} as never, log: () => undefined });
    const handler = hand.handlers.get(`${HAND_START_ORIGIN}/**`)!;
    const call = async (method: string, path: string, headers: Record<string, string>) => {
      let answer: { status: number; body?: string } | null = null;
      await handler({
        request: () => ({ method: () => method, url: () => `${HAND_START_ORIGIN}${path}`, headers: () => headers, postDataJSON: () => ({ address: 'nobody' }) }),
        fulfill: async (a: { status: number; body?: string }) => void (answer = a),
      });
      return answer as unknown as { status: number; body?: string };
    };
    expect((await call('GET', '/', {})).status).toBe(200);
    // From another page (another origin, or none), or without the header: not answered.
    expect((await call('POST', '/control/code', { origin: DEMO_ORIGIN, 'x-hand-test': '1' })).status).toBe(404);
    expect((await call('POST', '/control/code', { 'x-hand-test': '1' })).status).toBe(404);
    expect((await call('POST', '/control/code', { origin: HAND_START_ORIGIN })).status).toBe(404);
    expect((await call('OPTIONS', '/control/code', { origin: DEMO_ORIGIN })).status).toBe(404);
    // From the start page: answered (here: an address with no @ is asked for again, without calling the stack).
    const own = await call('POST', '/control/code', { origin: HAND_START_ORIGIN, 'x-hand-test': '1' });
    expect(own.status).toBe(400);
    expect(JSON.parse(own.body!)).toEqual({ message: 'Type an address first.' });
  });
});
