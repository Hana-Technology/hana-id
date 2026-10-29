// A Fetch-API handler on a Node HTTP server, so the API Worker's own request handlers (vault page, page hosts) run
// unchanged, and the mocks are written against the same Request/Response types.
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';

export type Handler = (request: Request, signal: AbortSignal) => Promise<Response> | Response;

/** Bodies above this are refused before they reach a handler (the largest real body, /v1/login, is a few KiB). */
const MAX_BODY_BYTES = 256 * 1024;

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

function toHeaders(req: IncomingMessage): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) h.append(k, one);
  }
  return h;
}

async function respond(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((v, k) => {
    headers[k] = v;
  });
  res.writeHead(response.status, headers);
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}

/** Listens on `port` at each host and serves `handler`. Resolves once every listener is up. */
export async function serve(port: number, hosts: readonly string[], handler: Handler): Promise<Server[]> {
  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) abort.abort();
      });
      try {
        const method = req.method ?? 'GET';
        const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
        if (body === null) {
          await respond(res, new Response('Payload too large\n', { status: 413 }));
          return;
        }
        const url = `http://${req.headers.host ?? `127.0.0.1:${port}`}${req.url ?? '/'}`;
        const request = new Request(url, { method, headers: toHeaders(req), ...(body ? { body: new Uint8Array(body) } : {}) });
        await respond(res, await handler(request, abort.signal));
      } catch (e) {
        if (abort.signal.aborted) return;
        console.error(`[e2e] ${req.method} ${req.url} failed:`, e instanceof Error ? e.message : e);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('Internal error\n');
      }
    })();
  };
  const servers: Server[] = [];
  for (const host of hosts) {
    const server = createServer(onRequest);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    servers.push(server);
  }
  return servers;
}

/**
 * `handler` as served at `origin` behind a TLS-terminating front: each request's URL is rewritten to `origin` (path
 * and query kept), so apps/api's hosts, which serve only their own origin, see the URL the browser used. Live mode's
 * https origins reach the stack this way (src/stack.ts LIVE_UPSTREAMS).
 */
export function servedAt(origin: string, handler: Handler): Handler {
  return (request, signal) => {
    const url = new URL(request.url);
    const method = request.method;
    const init: RequestInit & { duplex?: 'half' } = { method, headers: request.headers, signal: request.signal };
    if (method !== 'GET' && method !== 'HEAD') {
      init.body = request.body;
      init.duplex = 'half';
    }
    return handler(new Request(`${origin}${url.pathname}${url.search}`, init), signal);
  };
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
