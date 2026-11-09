// A local preview of the admin SPA for design work and screenshots only: `corepack pnpm --filter @hana-id/admin
// preview` serves public/ on http://127.0.0.1:8788 (PORT to change it) with the Worker's own security headers and CSP,
// and answers /api/* from test-spa/preview-data.ts (fake data, no network, no Access, no secret). Dev only: it is not
// part of the Worker (wrangler serves public/ alone), binds to the loopback address, and keeps nothing between runs.
// Writes answer as the real routes do on success, except the refusals the real services give for org_legacy, so the
// guarded paths can be seen too.
//
// The Access sign-in (the session-expiry banners): GET /api/me answers `accessExp`, PREVIEW_SESSION_MIN minutes after
// the start (default 60). Past it, every /api/* request is a 302 to a fake Access login on another origin, as Access
// answers an ended session (the SPA, with `redirect: 'manual'`, sees an opaqueredirect). Opening /signed-in (the tab
// "Sign in again" and "Renew" open) stands for a new sign-in: the session runs 60 more minutes. So
// `PREVIEW_SESSION_MIN=4` shows the warning at once and the expired banner 4 minutes later; `0.2` after 12 s.
//
// The System status page (D425): `/api/status` is the real `buildStatus` over the fake sources of one scenario
// (test-spa/preview-status.ts: green, warnings, critical, mixed-build, watchdog-down). `PREVIEW_STATUS=<scenario>` picks
// it at start (green by default); opening /preview/status/<scenario> switches it and goes to the page.
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { securityHeaders } from '../src/headers.ts';
import { getPlaybookRoute, listPlaybooksRoute } from '../src/playbooks.ts';
import * as data from './preview-data.ts';
// The status scenarios run the Worker's own src/status.ts (Workers types): loaded by a specifier TypeScript doesn't follow
// here, typechecked with test-ops/ instead (its tsconfig has the Workers types; this one has the DOM's).
const STATUS_MODULE = './preview-status.ts';
type Scenario = 'green' | 'warnings' | 'critical' | 'mixed-build' | 'watchdog-down';
const { SCENARIOS, previewStatus } = (await import(STATUS_MODULE)) as { SCENARIOS: readonly Scenario[]; previewStatus: (s: Scenario) => Promise<unknown> };

const PUBLIC = new URL('../public/', import.meta.url);
const PORT = Number(process.env.PORT ?? 8788);
const SESSION_MIN = Number(process.env.PREVIEW_SESSION_MIN ?? 60);
/** When the fake Access sign-in ends (ms); a load of /signed-in signs in again for 60 minutes. */
let sessionEndsAt = Date.now() + SESSION_MIN * 60_000;
const FAKE_ACCESS_LOGIN = 'https://preview-team.cloudflareaccess.invalid/cdn-cgi/access/login/127.0.0.1';
let statusScenario: Scenario = (SCENARIOS as readonly string[]).includes(process.env.PREVIEW_STATUS ?? '') ? (process.env.PREVIEW_STATUS as Scenario) : 'green';
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

type Answer = { status: number; body: unknown };
const ok = (body: unknown): Answer => ({ status: 200, body });
const refuse = (status: number, code: string, message: string): Answer => ({ status, body: { error: { code, message } } });

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = '';
  for await (const chunk of req) s += String(chunk);
  try {
    return s ? (JSON.parse(s) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The fake admin API: the GET routes the SPA reads, and a success (or the real refusal) for each write. */
async function apiAnswer(method: string, url: URL, body: Record<string, unknown>): Promise<Answer> {
  const p = url.pathname;
  const q = url.searchParams;
  let m: RegExpExecArray | null;
  if (method === 'GET') {
    if (p === '/api/me') return ok({ ...data.me, accessExp: Math.floor(sessionEndsAt / 1000) });
    if (p === '/api/status') return ok(await previewStatus(statusScenario));
    if (p === '/api/orgs') return ok({ orgs: data.orgs });
    if ((m = /^\/api\/orgs\/([^/]+)\/changes$/u.exec(p))) return ok(data.orgChanges(decodeURIComponent(m[1]!)));
    if ((m = /^\/api\/orgs\/([^/]+)$/u.exec(p))) {
      const d = data.orgDetail[decodeURIComponent(m[1]!)];
      return d ? ok(d) : refuse(404, 'not_found', 'No such org');
    }
    if ((m = /^\/api\/apps\/([^/]+)$/u.exec(p))) return ok(data.appDetail(q.get('org') ?? '', decodeURIComponent(m[1]!)));
    if (p === '/api/audit') return ok(data.audit(q.get('orgId')));
    if (p === '/api/security') return ok(data.security);
    if (p === '/api/monitoring') return ok(data.monitoring);
    if (p === '/api/monitoring/alerts') return ok(q.get('severity') ? { ...data.alerts, alerts: data.alerts.alerts.filter((a) => a.severity === q.get('severity')) } : data.alerts);
    if (p === '/api/monitoring/actions') return ok(data.actions);
    if (p === '/api/governance/pending-upgrades') return ok(data.pendingUpgrades);
    if (p === '/api/playbooks') return fromResponse(listPlaybooksRoute(url));
    if ((m = /^\/api\/playbooks\/([^/]+)$/u.exec(p))) return fromResponse(getPlaybookRoute(decodeURIComponent(m[1]!)));
    if (p === '/api/reports') return ok(data.reports);
    if (p === '/api/statements') return ok(data.statements(q.get('org') ?? ''));
    if ((m = /^\/api\/statements\/([^/]+)\/(\d{4}-\d{2})$/u.exec(p))) return ok(data.statement(decodeURIComponent(m[1]!), m[2]!));
    if (p === '/api/rates') return ok(data.rates(q.get('month') ?? new Date().toISOString().slice(0, 7)));
    if (p === '/api/retention') return ok(data.retention);
    if (p === '/api/email/issuer') return ok(data.emailIssuer(Number(q.get('days') ?? 14)));
    if (p === '/api/email/links') return ok(data.emailLinks(Number(q.get('days') ?? 14)));
    return refuse(404, 'not_found', 'Not found');
  }
  // Writes: the refusals the console and the API give for org_legacy, then success.
  if (p === '/api/invites' && body.orgId === 'org_legacy') return refuse(403, 'forbidden', 'org_legacy has no members');
  if (p === '/api/orgs/org_legacy/freeze') return refuse(403, 'forbidden', "org_legacy can't be frozen");
  if (/^\/api\/orgs\/org_legacy\/members\//u.test(p)) return refuse(403, 'forbidden', 'org_legacy has no members');
  if ((m = /^\/api\/scopes\/[^/]+\/assign$/u.exec(p)) && body.orgId === 'org_legacy') return refuse(400, 'bad_request', "A scope can't be assigned to org_legacy");
  if (p === '/api/users/search') return ok(data.userSearch);
  if (p === '/api/users/find') return body.ticket ? ok({ users: [data.walletUser] }) : refuse(400, 'bad_request', 'A support reference (ticket: 1–64 letters, digits or ._#:-) is required to find a user');
  if (p === '/api/users/get') return body.ticket ? ok(data.userGet(String(body.provider), String(body.sub))) : refuse(400, 'bad_request', 'A support reference (ticket: 1–64 letters, digits or ._#:-) is required to open a user');
  if (p === '/api/support/lookup') return ok(data.supportLookup(Array.isArray(body.requestIds) ? body.requestIds.length : 0));
  if (p === '/api/apps') return ok({ app: { id: 'app_01jdzpreview' }, publishableKey: 'pk_test_previewfakekey000004' });
  if ((m = /^\/api\/exports\/([^/]+)\/(\d{4}-\d{2})$/u.exec(p))) return ok({ rows: 8241, asOf: Date.now(), finalGas: '551264900000000000', finalTokens: '55126490000000000000000000', sha256: 'c0ffee11'.repeat(8), file: `ledger-${m[2]}.csv` });
  if (p === '/api/statements' || /\/issue$/u.test(p)) return ok({ ok: true });
  return ok({ ok: true });
}

async function fromResponse(res: Response): Promise<Answer> {
  return { status: res.status, body: await res.json() };
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, api: boolean) {
  const headers: Record<string, string> = { ...securityHeaders('https://files.preview.invalid'), 'content-type': type };
  if (api) headers['cache-control'] = 'no-store';
  res.writeHead(status, headers);
  res.end(body);
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const method = req.method ?? 'GET';
    if (url.pathname.startsWith('/api/') && Date.now() >= sessionEndsAt) {
      // Access's answer to a request without a live sign-in: a redirect to its login page, cross-origin.
      res.writeHead(302, { ...securityHeaders('https://files.preview.invalid'), location: `${FAKE_ACCESS_LOGIN}?redirect_url=${encodeURIComponent(url.pathname)}` });
      res.end();
      return;
    }
    if (url.pathname === '/signed-in') sessionEndsAt = Date.now() + 60 * 60_000;
    const pick = /^\/preview\/status\/([a-z-]+)$/u.exec(url.pathname);
    if (pick && (SCENARIOS as readonly string[]).includes(pick[1]!)) {
      statusScenario = pick[1] as Scenario;
      res.writeHead(302, { ...securityHeaders('https://files.preview.invalid'), location: '/' });
      res.end();
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const body = method === 'GET' ? {} : await readBody(req);
      // A short delay, so the loading states can be seen.
      await new Promise((r) => setTimeout(r, Number(process.env.PREVIEW_DELAY_MS ?? 120)));
      const a = await apiAnswer(method, url, body);
      send(res, a.status, 'application/json; charset=utf-8', JSON.stringify(a.body), true);
      return;
    }
    // Static files from public/, everything else the SPA's index (the Worker's single-page-application fallback).
    // The brand fonts and their licence (public/fonts, D426) too, as the assets binding serves them.
    const file = /^\/(?:[a-z0-9-]+\.(js|css|svg|ico)|fonts\/[A-Za-z0-9-]+\.woff2|fonts\/OFL\.txt)$/u.test(url.pathname) ? url.pathname.slice(1) : 'index.html';
    try {
      send(res, 200, TYPES[extname(file)] ?? 'application/octet-stream', readFileSync(new URL(file, PUBLIC)), false);
    } catch {
      send(res, 404, 'text/plain; charset=utf-8', 'Not found', false);
    }
  })();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`admin SPA preview (fake data): http://127.0.0.1:${PORT}/`);
  console.log(`System status scenario: ${statusScenario} (switch: /preview/status/<${SCENARIOS.join('|')}>)`);
});
