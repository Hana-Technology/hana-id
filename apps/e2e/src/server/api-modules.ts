// The API Worker's own code that the local stack runs unchanged (apps/api/src): the Worker itself (routing, the app
// gate and origin rule, GET /v1/app, the vault endpoints, the login relay and its Durable Object), the vault page
// renderer and the two page hosts. So the suite checks the real wire format, CORS, frame-ancestors, CSP and page
// headers, not a copy of them. Only POST /v1/login and /v1/derive are mocked (api.ts): they need the relayer and the
// MPC.
//
// They are loaded at runtime (tsx compiles them) through a computed specifier, so this package's typecheck doesn't pull
// the Worker sources and their Cloudflare types in; the interfaces below are the slice of their exports used here.
import { registerCloudflareModule } from './workers.ts';

/** apps/api/src/apps.ts App. */
export interface ApiApp {
  id: string;
  name: string;
  scope_id: string;
  publishable_key: string;
  status: string;
  google_web_client_id: string | null;
  scope_conflict: boolean;
  origins: string[];
}

/** What apps/api reads from D1 (see d1.ts). */
export interface D1Like {
  prepare(sql: string): unknown;
}

/** The part of a Workers `Fetcher` the hosts call. */
export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

/** apps/api/src/env.ts Env, as the stack fills it (api.ts). */
export type ApiEnv = Record<string, unknown>;

/** apps/api/src/handlers.ts Ctx: the request's log context; `cors` is what its answers carry. */
export interface ApiCtx {
  cors: Record<string, string>;
  /** handlers.ts Ctx.exposeTimings: a pk_test_ app's success carries the request's own timings. */
  exposeTimings?: boolean;
}

/** apps/api/src/handlers.ts Gate. */
export type ApiGate = { ok: true; app: ApiApp } | { ok: false; response: Response };

export interface ExecutionContextLike {
  waitUntil(p: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface ApiModules {
  /** apps/api/src/index.ts: the Worker. */
  worker: { fetch(request: Request, env: ApiEnv, ctx: ExecutionContextLike): Promise<Response> };
  /** apps/api/src/login-relay.ts: the relay's Durable Object class. */
  LoginRelay: new (state: unknown, env: unknown) => object;
  /** apps/api/src/handlers.ts: what every app endpoint runs first (key, origin rule, rate limits). */
  appGate(request: Request, env: ApiEnv, ctx: ApiCtx, kind: 'relay' | 'config'): Promise<ApiGate>;
  newCtx(env: ApiEnv, requestId: string, endpoint: string, request?: Request): ApiCtx;
  /** A JSON answer with the request's CORS and request id, logged as the Worker logs it. */
  done(ctx: ApiCtx, status: number, body: Record<string, unknown>): Response;
  getAppByKey(db: D1Like, publishableKey: string): Promise<ApiApp | null>;
  /** apps/api/src/vault/page.ts: GET {vaultOrigin}/vault?pk=… */
  handleVaultPage(request: Request, env: ApiEnv, requestId: string): Promise<Response>;
  /** apps/api/src/pages/host.ts: the vault and auth origins' Workers. */
  handleVaultHost(request: Request, env: { VAULT_ORIGIN: string; ASSETS: Fetcher; API: Fetcher }): Promise<Response>;
  handleAuthHost(request: Request, env: { AUTH_ORIGIN: string; API_URL: string; NEAR_RPC: string; ASSETS: Fetcher }): Promise<Response>;
}

const API_SRC = new URL('../../../api/src/', import.meta.url);

const load = async <T>(path: string): Promise<T> => (await import(new URL(path, API_SRC).href)) as T;

export async function loadApiModules(): Promise<ApiModules> {
  // The Worker's Durable Object classes extend `cloudflare:workers`' DurableObject.
  registerCloudflareModule();
  const [index, handlers, apps, page, host] = await Promise.all([
    load<{ default: ApiModules['worker']; LoginRelay: ApiModules['LoginRelay'] }>('index.ts'),
    load<Pick<ApiModules, 'appGate' | 'newCtx' | 'done'>>('handlers.ts'),
    load<Pick<ApiModules, 'getAppByKey'>>('apps.ts'),
    load<Pick<ApiModules, 'handleVaultPage'>>('vault/page.ts'),
    load<Pick<ApiModules, 'handleVaultHost' | 'handleAuthHost'>>('pages/host.ts'),
  ]);
  return {
    worker: index.default,
    LoginRelay: index.LoginRelay,
    appGate: handlers.appGate,
    newCtx: handlers.newCtx,
    done: handlers.done,
    getAppByKey: apps.getAppByKey,
    handleVaultPage: page.handleVaultPage,
    handleVaultHost: host.handleVaultHost,
    handleAuthHost: host.handleAuthHost,
  };
}
