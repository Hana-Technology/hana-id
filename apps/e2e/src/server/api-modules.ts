// The API Worker's own code that the local stack runs unchanged (apps/api/src): the vault page renderer, the two page
// hosts, the app lookup and the parent-origin rule. So the suite checks the real frame-ancestors, CSP and page
// headers, not a copy of them.
//
// They are loaded at runtime (tsx compiles them) through a computed specifier, so this package's typecheck doesn't pull
// the Worker sources and their Cloudflare types in; the interfaces below are the slice of their exports used here.

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

export interface ApiModules {
  getAppByKey(db: D1Like, publishableKey: string): Promise<ApiApp | null>;
  /** apps/api/src/vault/origins.ts: whether `origin` may be the vault's parent for this app in this env. */
  parentOriginAllowed(envName: string, app: Pick<ApiApp, 'publishable_key' | 'origins'>, origin: string | null): boolean;
  /** apps/api/src/vault/page.ts: GET {vaultOrigin}/vault?pk=… */
  handleVaultPage(request: Request, env: Record<string, unknown>, requestId: string): Promise<Response>;
  /** apps/api/src/vault/settings.ts. */
  getSettingsRow(db: D1Like, appId: string): Promise<Record<string, unknown> | null>;
  effectiveSettings(row: Record<string, unknown>, appId: string, now: number): Promise<{ autoApprovePolicy: Record<string, unknown> | null }>;
  /** apps/api/src/pages/host.ts: the vault and auth origins' Workers. */
  handleVaultHost(request: Request, env: { VAULT_ORIGIN: string; ASSETS: Fetcher; API: Fetcher }): Promise<Response>;
  handleAuthHost(request: Request, env: { AUTH_ORIGIN: string; API_URL: string; NEAR_RPC: string; ASSETS: Fetcher }): Promise<Response>;
}

/** The part of a Workers `Fetcher` the hosts call. */
export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

const API_SRC = new URL('../../../api/src/', import.meta.url);

const load = async <T>(path: string): Promise<T> => (await import(new URL(path, API_SRC).href)) as T;

export async function loadApiModules(): Promise<ApiModules> {
  const [apps, origins, page, settings, host] = await Promise.all([
    load<Pick<ApiModules, 'getAppByKey'>>('apps.ts'),
    load<Pick<ApiModules, 'parentOriginAllowed'>>('vault/origins.ts'),
    load<Pick<ApiModules, 'handleVaultPage'>>('vault/page.ts'),
    load<Pick<ApiModules, 'getSettingsRow' | 'effectiveSettings'>>('vault/settings.ts'),
    load<Pick<ApiModules, 'handleVaultHost' | 'handleAuthHost'>>('pages/host.ts'),
  ]);
  return {
    getAppByKey: apps.getAppByKey,
    parentOriginAllowed: origins.parentOriginAllowed,
    handleVaultPage: page.handleVaultPage,
    getSettingsRow: settings.getSettingsRow,
    effectiveSettings: settings.effectiveSettings,
    handleVaultHost: host.handleVaultHost,
    handleAuthHost: host.handleAuthHost,
  };
}
