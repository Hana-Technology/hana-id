// Neon's control-plane API (https://console.neon.tech/api/v2), the few calls `usage-setup <env> roles` makes (D403):
// list a branch's endpoints, reset a role's password, wait for the operations a reset starts.
//
// The API key is read from .secrets/<env>/neon-api-key (0600) and goes only into the Authorization header of an
// in-process fetch: never an argument or environment variable of a child process, never printed. A reset's success
// body holds the new password, so no response body is ever printed or put in an error: an error carries the HTTP
// status and, for a non-2xx answer, Neon's `code` and `message` (an error answer has no password: none was set),
// trimmed and with every secret the caller names removed.
import { readOneLineSecret } from './secrets.ts';

export const NEON_API = 'https://console.neon.tech/api/v2';
export const NEON_API_KEY_FILE = 'neon-api-key';

/** Statuses that mean the request wasn't applied and may be sent again: busy (another operation), rate limit, unavailable. */
const RETRY_STATUSES = new Set([409, 423, 429, 503]);
/** Operation statuses: done, failed; anything else (scheduling, running, cancelling) is still pending. */
const OP_DONE = new Set(['finished', 'skipped']);
const OP_FAILED = new Set(['failed', 'error', 'cancelled']);

export interface NeonApiDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

export interface NeonOperation {
  id: string;
  status: string;
  action?: string;
}

export class NeonApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * The API key from its file: present, 0600 (no group or other permission), one printable token. Errors name the file
 * and how to fix it, never the value.
 */
export function readNeonApiKey(file: string, shown: string): string {
  const how = `create a project-scoped API key in Neon's console and save it with \`umask 077; pbpaste > ${shown}\` (docs/operations.md "Usage capture" step 2)`;
  return readOneLineSecret(file, shown, how, 'one API key');
}

/** Removes each secret (and its URL-encoded form) from a message. */
export function scrub(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join('<redacted>');
    const enc = encodeURIComponent(s);
    if (enc !== s) out = out.split(enc).join('<redacted>');
  }
  return out;
}

/** Neon's `code` and `message` from an error body, trimmed to one short printable line; nothing else of the body. */
function errorDetail(body: unknown, secrets: readonly string[]): { code?: string; text: string } {
  if (!body || typeof body !== 'object') return { text: '' };
  const { code, message } = body as { code?: unknown; message?: unknown };
  const clean = (v: unknown, max: number) =>
    typeof v === 'string' ? scrub(v, secrets).replace(/[^\x20-\x7e]+/gu, ' ').trim().slice(0, max) : '';
  const c = clean(code, 64);
  const m = clean(message, 200);
  const text = [c, m].filter(Boolean).join(': ');
  return { code: c || undefined, text: text ? ` (${text})` : '' };
}

export class NeonApi {
  constructor(
    private readonly key: string,
    private readonly deps: NeonApiDeps,
    /** Secrets to remove from any error text besides the key (the owner's password, passwords received so far). */
    private readonly secrets: string[] = [],
    private readonly opts: { attempts?: number; backoffMs?: number; base?: string } = {},
  ) {}

  /** Adds a secret to remove from later error text. */
  addSecret(s: string): void {
    this.secrets.push(s);
  }

  private get all(): string[] {
    return [this.key, ...this.secrets];
  }

  /**
   * One call. Retries only answers that say the request wasn't applied (RETRY_STATUSES), and for a GET also a
   * network error; a POST whose answer was lost is never sent again (it may have been applied).
   */
  async request(method: 'GET' | 'POST', path: string, what: string): Promise<unknown> {
    const attempts = this.opts.attempts ?? 8;
    const backoff = this.opts.backoffMs ?? 2000;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.deps.fetch(`${this.opts.base ?? NEON_API}${path}`, {
          method,
          headers: { Authorization: `Bearer ${this.key}`, Accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        const name = e instanceof Error ? e.name : 'Error';
        if (method === 'GET' && attempt < attempts) {
          await this.deps.sleep(backoff * attempt);
          continue;
        }
        const after = method === 'POST' ? '; Neon may or may not have applied it' : '';
        throw new NeonApiError(`Neon API: ${what} got no answer (${scrub(name, this.all)})${after}`, null);
      }
      if (res.ok) {
        try {
          return await res.json();
        } catch {
          // The body is never shown: a success body can hold a password.
          throw new NeonApiError(`Neon API: ${what} answered HTTP ${res.status} with a body that isn't JSON`, res.status);
        }
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      const detail = errorDetail(body, this.all);
      if (RETRY_STATUSES.has(res.status) && attempt < attempts) {
        this.deps.log(`Neon API: ${what} answered HTTP ${res.status}${detail.text}; trying again (${attempt}/${attempts - 1}).`);
        await this.deps.sleep(backoff * attempt);
        continue;
      }
      const hint =
        res.status === 401 ? ': the API key was refused (revoked, or mistyped)'
        : res.status === 403 ? ': the API key has no access to this project (a project-scoped key of another project?)'
        : res.status === 404 ? ': not found (check project_id and branch_id in neon.json, and the role name)'
        : RETRY_STATUSES.has(res.status) ? `: still busy after ${attempts} tries; wait a minute and run it again`
        : '';
      throw new NeonApiError(`Neon API: ${what} answered HTTP ${res.status}${detail.text}${hint}`, res.status, detail.code);
    }
  }

  /** The hosts of a branch's endpoints. */
  async branchEndpointHosts(projectId: string, branchId: string): Promise<string[]> {
    const body = await this.request('GET', `/projects/${enc(projectId)}/branches/${enc(branchId)}/endpoints`, `listing branch ${branchId}'s endpoints`);
    const endpoints = (body as { endpoints?: unknown })?.endpoints;
    if (!Array.isArray(endpoints)) throw new NeonApiError(`Neon API: the endpoint list of branch ${branchId} has no endpoints array`, 200);
    return endpoints.map((e) => (e as { host?: unknown })?.host).filter((h): h is string => typeof h === 'string');
  }

  /**
   * Resets a role's password: Neon generates it and answers it once. Returns the password (never printed) and the
   * operations the reset started.
   */
  async resetRolePassword(projectId: string, branchId: string, role: string): Promise<{ password: string; operations: NeonOperation[] }> {
    const body = await this.request('POST', `/projects/${enc(projectId)}/branches/${enc(branchId)}/roles/${enc(role)}/reset_password`, `resetting ${role}'s password`);
    const r = (body as { role?: { name?: unknown; password?: unknown } })?.role;
    if (r?.name !== role || typeof r.password !== 'string' || !r.password) {
      throw new NeonApiError(`Neon API: the answer to resetting ${role}'s password has no password for ${role} (body not shown); its password may have changed, so run roles --yes again`, 200);
    }
    this.addSecret(r.password);
    return { password: r.password, operations: operations((body as { operations?: unknown }).operations) };
  }

  /** Waits until every operation is finished (or skipped); a failed one, or one still pending at the deadline, throws. */
  async waitForOperations(projectId: string, ops: readonly NeonOperation[], what: string, { pollMs = 2000, timeoutMs = 180_000 } = {}): Promise<void> {
    let pending = ops.filter((o) => !OP_DONE.has(o.status));
    let waited = 0;
    while (pending.length) {
      const failed = pending.find((o) => OP_FAILED.has(o.status));
      if (failed) throw new NeonApiError(`Neon API: operation ${failed.id} (${failed.action ?? 'unknown action'}) of ${what} ended ${failed.status}`, null);
      if (waited >= timeoutMs) throw new NeonApiError(`Neon API: ${what} still has operations running after ${Math.round(timeoutMs / 1000)} s (${pending.map((o) => o.id).join(', ')}); check Neon's console`, null);
      await this.deps.sleep(pollMs);
      waited += pollMs;
      const next: NeonOperation[] = [];
      for (const o of pending) {
        const body = await this.request('GET', `/projects/${enc(projectId)}/operations/${enc(o.id)}`, `reading operation ${o.id}`);
        const [op] = operations([(body as { operation?: unknown })?.operation]);
        if (!op) throw new NeonApiError(`Neon API: operation ${o.id} has no status`, 200);
        if (!OP_DONE.has(op.status)) next.push(op);
      }
      pending = next;
    }
  }
}

const enc = encodeURIComponent;

function operations(v: unknown): NeonOperation[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((o) => {
    const { id, status, action } = (o ?? {}) as { id?: unknown; status?: unknown; action?: unknown };
    return typeof id === 'string' && typeof status === 'string' ? [{ id, status, ...(typeof action === 'string' ? { action } : {}) }] : [];
  });
}
