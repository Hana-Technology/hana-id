// Cloudflare's v4 API (https://api.cloudflare.com/client/v4) with a token read from a file: the calls
// `access-setup <env>` makes to Zero Trust Access (D409; endpoints and permissions in lib/access-setup.ts) and the
// Hyperdrive configs `usage-setup <env> hyperdrive` creates (D412, lib/usage-setup.ts).
//
// The token is read from .secrets/<env>/<its file> (0600) and goes only into the Authorization header of
// an in-process fetch: never an argument or environment variable of a child process, never printed. No response body
// is printed or put in an error: an error carries the HTTP status and Cloudflare's error codes and messages (trimmed,
// the token removed), and for 401/403 the permission the call needs.
import { CliError } from './cli.ts';
import { scrub } from './neon-api.ts';
import { readOneLineSecret } from './secrets.ts';

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
export const CLOUDFLARE_ACCESS_TOKEN_FILE = 'cloudflare-access-token';
export const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/u;

/** Answers that mean the request wasn't applied (rate limit) or, for an idempotent method, may be sent again. */
const RETRY_ALWAYS = new Set([429]);
const RETRY_IDEMPOTENT = new Set([500, 502, 503, 504]);

export interface CloudflareApiDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly codes: readonly number[] = [],
  ) {
    super(message);
  }
}

/**
 * The token from its file (0600, one line); errors name the file and how to make the token, never the value. `how`
 * defaults to access-setup's token.
 */
export function readCloudflareToken(file: string, shown: string, how?: string): string {
  const access = `create an account API token with "Access: Apps and Policies Edit" and "Access: Organizations, Identity Providers, and Groups Read" on this account only, and save it with \`umask 077; pbpaste > ${shown}\` (docs/operations.md "Admin Worker" step 1)`;
  return readOneLineSecret(file, shown, how ?? access, 'one API token');
}

/** The account: the one given (checked), else the token's only account. */
export async function resolveAccount(api: CloudflareApi, given: string | undefined): Promise<string> {
  if (given) {
    if (!ACCOUNT_ID_RE.test(given)) throw new CliError('The Cloudflare account id is 32 lowercase hex characters');
    return given;
  }
  const list = await api.list('/accounts', "listing the token's accounts", 'access to one account', 50);
  const ids = list.map((a) => (a as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string' && ACCOUNT_ID_RE.test(id));
  if (ids.length === 1) return ids[0]!;
  throw new Error(ids.length === 0 ? "The token lists no account (a token without an account-read permission can't, e.g. one with only Hyperdrive Edit): pass --account-id <id> (the dashboard's Workers & Pages overview shows it) or set CLOUDFLARE_ACCOUNT_ID" : `The token reaches ${ids.length} accounts: pass --account-id (or set CLOUDFLARE_ACCOUNT_ID)`);
}

type Envelope = { success?: unknown; result?: unknown; result_info?: unknown; errors?: unknown };

/** Cloudflare's error codes and messages from an envelope, each trimmed to one short printable line; nothing else. */
function errorDetail(body: unknown, secrets: readonly string[]): { codes: number[]; text: string } {
  const errors = (body as Envelope | undefined)?.errors;
  if (!Array.isArray(errors)) return { codes: [], text: '' };
  const codes: number[] = [];
  const parts = errors.slice(0, 3).flatMap((e) => {
    const { code, message } = (e ?? {}) as { code?: unknown; message?: unknown };
    const c = typeof code === 'number' && Number.isInteger(code) ? code : undefined;
    if (c !== undefined) codes.push(c);
    const m = typeof message === 'string' ? scrub(message, secrets).replace(/[^\x20-\x7e]+/gu, ' ').trim().slice(0, 200) : '';
    const one = [c === undefined ? '' : `code ${c}`, m].filter(Boolean).join(': ');
    return one ? [one] : [];
  });
  return { codes, text: parts.length ? ` (${parts.join('; ')})` : '' };
}

export interface Page {
  page?: number;
  total_pages?: number;
}

export class CloudflareApi {
  constructor(
    private readonly token: string,
    private readonly deps: CloudflareApiDeps,
    private readonly opts: { attempts?: number; backoffMs?: number; base?: string } = {},
  ) {}

  /**
   * One call; returns Cloudflare's `result` (and `result_info`). Retries 429 for any method, and a network error or a
   * 5xx only for GET and PUT (a PUT sends the whole object, so sending it again is harmless); a POST whose answer was
   * lost is never sent again: the script is idempotent, so the user runs it again and it finds what was created.
   * `permission` names the token permission the call needs, for the 401/403 hint.
   */
  async request(method: 'GET' | 'POST' | 'PUT', path: string, what: string, permission: string, body?: unknown): Promise<{ result: unknown; info: Page | undefined }> {
    const attempts = this.opts.attempts ?? 5;
    const backoff = this.opts.backoffMs ?? 2000;
    const idempotent = method !== 'POST';
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.deps.fetch(`${this.opts.base ?? CLOUDFLARE_API}${path}`, {
          method,
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        const name = e instanceof Error ? e.name : 'Error';
        if (idempotent && attempt < attempts) {
          await this.deps.sleep(backoff * attempt);
          continue;
        }
        const after = idempotent ? '' : '; Cloudflare may or may not have applied it: run the command again (it finds what exists)';
        throw new CloudflareApiError(`Cloudflare API: ${what} got no answer (${scrub(name, [this.token])})${after}`, null);
      }
      let env: Envelope | undefined;
      try {
        env = (await res.json()) as Envelope;
      } catch {
        env = undefined;
      }
      if (res.ok && env && env.success === true) {
        const info = env.result_info && typeof env.result_info === 'object' ? (env.result_info as Page) : undefined;
        return { result: env.result, info };
      }
      const detail = errorDetail(env, [this.token]);
      const retry = RETRY_ALWAYS.has(res.status) || (idempotent && RETRY_IDEMPOTENT.has(res.status));
      if (retry && attempt < attempts) {
        this.deps.log(`Cloudflare API: ${what} answered HTTP ${res.status}${detail.text}; trying again (${attempt}/${attempts - 1}).`);
        await this.deps.sleep(backoff * attempt);
        continue;
      }
      const hint =
        res.ok ? `: the answer ${env ? 'says it failed' : "isn't JSON"}`
        : res.status === 401 ? ': the token was refused (expired, revoked or mistyped)'
        : res.status === 403 ? `: the token lacks "${permission}" on this account (or is for another account)`
        : res.status === 404 ? ': not found (check the account id)'
        : !idempotent && RETRY_IDEMPOTENT.has(res.status) ? '; Cloudflare may or may not have applied it: run the command again (it finds what exists)'
        : '';
      throw new CloudflareApiError(`Cloudflare API: ${what} answered HTTP ${res.status}${detail.text}${hint}`, res.status, detail.codes);
    }
  }

  /** Every item of a paginated list (`page`, `per_page`), up to 50 pages. */
  async list(path: string, what: string, permission: string, perPage = 100): Promise<unknown[]> {
    const out: unknown[] = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= 50; page++) {
      const { result, info } = await this.request('GET', `${path}${sep}page=${page}&per_page=${perPage}`, what, permission);
      if (!Array.isArray(result)) throw new CloudflareApiError(`Cloudflare API: ${what} returned no list`, 200);
      out.push(...result);
      const last = typeof info?.total_pages === 'number' ? page >= info.total_pages : result.length < perPage;
      if (last || result.length === 0) return out;
    }
    throw new CloudflareApiError(`Cloudflare API: ${what} has more than 50 pages`, 200);
  }
}
