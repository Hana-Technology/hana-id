// The preview harness's Vite plugin (dev only: `apply: 'serve'`, never part of a build). It answers `/api/*` with
// preview/mock-api.ts, loaded through the dev server itself (`ssrLoadModule`), since the fixtures import workspace
// TypeScript that Node can't load while Vite reads its config. `GET /__preview/<scenario>?to=<path>` sets the
// scenario cookie and goes to the path.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

export const SCENARIO_RE = /^[a-z-]{1,20}$/u;

/** Only a path on this server: `/x`, never `//host`, a backslash trick or a URL. */
export const safeTo = (to: string | null): string => (to && /^\/(?![/\\])[^\s\\]*$/u.test(to) ? to : '/');

/** The scenario named by the `hana_preview` cookie, or `owner`. */
export const scenarioOf = (cookie: string | undefined, known: readonly string[]): string => {
  const m = /(?:^|;\s*)hana_preview=([a-z-]+)/u.exec(cookie ?? '');
  return m && known.includes(m[1]!) ? m[1]! : 'owner';
};

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? (JSON.parse(text) as unknown) : {});
      } catch {
        resolve({});
      }
    });
  });
}

type MockModule = typeof import('./mock-api.ts');

export function mockApi(): Plugin {
  return {
    name: 'hana-console-preview-api',
    apply: 'serve',
    configureServer(server) {
      let mod: Promise<{ m: MockModule; state: InstanceType<MockModule['PreviewState']> }> | undefined;
      const load = () =>
        (mod ??= (server.ssrLoadModule(fileURLToPath(new URL('./mock-api.ts', import.meta.url))) as Promise<MockModule>).then((m) => ({ m, state: new m.PreviewState() })));
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const pick = /^\/__preview\/([^/]+)$/u.exec(url.pathname);
        if (!pick && !url.pathname.startsWith('/api/')) return next();
        void load().then(async ({ m, state }) => {
          if (pick) {
            const s = SCENARIO_RE.test(pick[1]!) && (m.SCENARIOS as readonly string[]).includes(pick[1]!) ? pick[1]! : 'owner';
            // The Email login page's state (a screenshot picks one with `?email=<state>`; fixtures.ts emailStatus).
            const e = url.searchParams.get('email');
            if (e && /^[a-z-]{1,20}$/u.test(e)) state.emailState = e;
            res.writeHead(302, { location: safeTo(url.searchParams.get('to')), 'set-cookie': `hana_preview=${s}; Path=/; SameSite=Lax` });
            res.end();
            return;
          }
          const body = await readBody(req);
          const a = m.answer(scenarioOf(req.headers.cookie, m.SCENARIOS) as (typeof m.SCENARIOS)[number], req.method ?? 'GET', url, body, state);
          res.writeHead(a.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...a.headers });
          res.end(a.body === undefined ? '' : JSON.stringify(a.body));
        });
      });
    },
  };
}
