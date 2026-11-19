// The staff admin portal's test kit (D873; src/server/admin-lane.ts): each browser project has its own lane (its own
// admin Worker, API copy and relayer), signed in through the stack's Cloudflare Access stand-in, its relayer put in a
// state by the lane's controls. Every page of a test is watched: a console error, an uncaught error or a CSP violation
// fails the test (unless the test expects that one response's error), and no response but the Access stand-in's
// sign-in sets a cookie (the admin Worker never does).
import { type BrowserContext, type Locator, type Page, type TestInfo, test as base, expect } from '@playwright/test';
import { ADMIN_LANES, type AdminLaneName } from '../src/stack.ts';

export { expect };

/** The lane of this test's browser project. */
export function laneOf(info: TestInfo): string {
  const origin = (ADMIN_LANES as Record<string, string>)[info.project.name];
  if (!origin || info.project.name === 'demo') throw new Error(`no admin lane for project ${info.project.name}`);
  return origin;
}

export const STAFF = 'staff@e2e.invalid';
export const OUTSIDER = 'outsider@e2e.invalid';

export interface LaneState {
  appId: string;
  relayer: string;
  nextSlot: number | null;
  halted: null | { reason: string; nonce?: number; code?: string; leakSeen?: boolean; since: number };
  waiting: number;
  records: { slot: number; kind: string; onChain: boolean; taken: boolean; deadlineMs: number; copies: string[] }[];
  staffLog: { seq: number; tool: string; done: boolean; refused: string | null; who: string; note: string }[];
  chain: { latest: number; pending: number; pooled: { nonce: number; foreign: boolean }[]; hold: boolean; refuse: boolean; balanceWei: string };
  clockOffsetMs: number;
  /** The lane's "now" (its clock). */
  nowMs: number;
  /** Connections the lane's ledger listener has accepted so far. */
  ledgerConnections: number;
}

async function control(lane: string, path: string, body?: Record<string, unknown>): Promise<LaneState> {
  const res = await fetch(`${lane}/__e2e/lane/${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const text = await res.text();
  expect(res.status, `${path} ${JSON.stringify(body ?? {})}: ${text}`).toBe(200);
  return JSON.parse(text) as LaneState;
}

/** Puts the lane's relayer in a state (src/server/admin-lane-worker.ts SCENARIOS) and answers it. */
export const scenario = (lane: string, name: string): Promise<LaneState> => control(lane, 'scenario', { name });
export const laneState = (lane: string): Promise<LaneState> => control(lane, 'state');
/** Time passes for the relayer: its alarm runs (then the API cron's relay check). */
export const laneRun = (lane: string, times = 1): Promise<LaneState> => control(lane, 'run', { times });
/** The lane's clock moves forward (the status page's 30 s cache too). */
export const laneClock = (lane: string, advanceMs: number): Promise<LaneState> => control(lane, 'clock', { advanceMs });

/** Signs in through the Access stand-in (as Cloudflare Access would, before the page) and opens `to`. */
export async function signIn(page: Page, lane: string, as: 'staff' | 'outsider' = 'staff', to = '/'): Promise<void> {
  await page.goto(`${lane}/__e2e/access/sign-in?as=${as}&to=${encodeURIComponent(to)}`);
  await expect(page).toHaveURL(`${lane}${to}`);
}

/** What the pages of a test did wrong: console errors, uncaught errors, CSP violations, a cookie set by the Worker. */
export class PageWatch {
  readonly problems: string[] = [];
  private readonly allowed: RegExp[] = [];

  constructor(context: BrowserContext, lane: string, browserName: string) {
    void context.addInitScript((origin) => {
      if (location.origin !== origin) return;
      document.addEventListener('securitypolicyviolation', (e) => {
        const t = e.target as Node | null;
        console.error(`CSP violation: ${e.effectiveDirective} ${e.blockedURI} ${t && t.nodeType === 1 ? (t as Element).tagName : (t?.nodeName ?? '')}`);
      });
    }, lane);
    // WebKit's own <select> control trips any CSP without 'unsafe-inline' styles (style-src-attr), on any page with
    // one, the admin's or a bare test page (a finding of D873, reported: the admin's selects render and work). Only
    // that exact violation is let through, in WebKit only; every other one fails the test.
    if (browserName === 'webkit') {
      this.allowed.push(/^console: CSP violation: style-src-attr inline (SELECT|#document)$/u);
      this.allowed.push(/^console: Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy\.$/u);
    }
    const watch = (page: Page) => {
      page.on('console', (m) => {
        if (m.type() === 'error') this.note(`console: ${m.text()}`);
      });
      page.on('pageerror', (e) => this.note(`uncaught: ${e.message}`));
    };
    context.pages().forEach(watch);
    context.on('page', watch);
    context.on('response', (r) => {
      if (!r.url().startsWith(lane) || new URL(r.url()).pathname.startsWith('/__e2e/access/')) return;
      void r
        .headerValue('set-cookie')
        .then((v) => {
          if (v !== null) this.problems.push(`set-cookie on ${r.request().method()} ${r.url()}`);
        })
        .catch(() => undefined);
    });
  }

  /** A console error the test causes on purpose (a refused request's "Failed to load resource" line). */
  allow(re: RegExp): void {
    this.allowed.push(re);
  }

  private note(p: string): void {
    if (!this.allowed.some((re) => re.test(p))) this.problems.push(p);
  }
}

export const test = base.extend<{ lane: string; watch: PageWatch }>({
  // The browser's lane, held for the whole test: another run on the same stack (or `--repeat-each`) waits its turn.
  lane: async ({}, use, info) => {
    const lane = laneOf(info);
    const res = await fetch(`${lane}/__e2e/lane/acquire`, { method: 'POST' });
    expect(res.status, 'the lane’s lease').toBe(200);
    const { lease } = (await res.json()) as { lease: string };
    try {
      await use(lane);
    } finally {
      await fetch(`${lane}/__e2e/lane/release`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lease }) });
    }
  },
  watch: [
    async ({ context, lane, browserName }, use) => {
      const w = new PageWatch(context, lane, browserName);
      await use(w);
      expect(w.problems, 'console errors, CSP violations or cookies on the admin pages').toEqual([]);
    },
    { auto: true },
  ],
});

// ---- the "Free network fees" page ----

export const CHAIN = 31337;
export const DETAIL = `/free-network-fees/${CHAIN}`;

/** A staff tool's section on the page (its heading). */
export const tool = (page: Page, name: string): Locator => page.locator('.tool').filter({ has: page.getByRole('heading', { name, exact: true }) });

/** The answer shown at the top after a tool ran (the page re-read). */
export const actResult = (page: Page): Locator => page.locator('.act-result');

/**
 * Uses a tool's form: the note (and any other field), its button, then the confirmation strip, whose text must be
 * `confirm`; answers once the page has re-read.
 */
export async function useTool(form: Locator, o: { button: string; note: string; confirm: string | RegExp; fill?: (f: Locator) => Promise<void> }): Promise<void> {
  await form.locator('[name="note"]').fill(o.note);
  if (o.fill) await o.fill(form);
  await form.getByRole('button', { name: o.button, exact: true }).click();
  const strip = form.getByRole('group', { name: `Confirm: ${o.button}` });
  await expect(strip).toContainText(o.confirm);
  await strip.getByRole('button', { name: o.button, exact: true }).click();
}

/** The page's state chip and its one line under it ("Now"). */
export const nowPanel = (page: Page): Locator => page.locator('.panel', { has: page.getByRole('heading', { name: 'Now', exact: true }) });

/** One "Waiting transactions" row by slot. */
export const slotRow = (page: Page, slot: number): Locator => page.locator('.panel', { has: page.getByRole('heading', { name: 'Waiting transactions', exact: true }) }).locator('tbody tr').filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^${slot}$`, 'u') }) });

/** The lane's name of a browser project (for messages). */
export const laneName = (info: TestInfo): AdminLaneName => info.project.name as AdminLaneName;
