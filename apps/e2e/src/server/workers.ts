// The Workers runtime pieces apps/api's Worker needs to run in Node: the `cloudflare:workers` module, Durable Object
// namespaces with in-memory storage (so the real LoginRelay class serves the relay), a rate limiter that always
// allows, and an execution context.
import { registerHooks } from 'node:module';

const CLOUDFLARE_WORKERS = new URL('./cloudflare-workers.ts', import.meta.url).href;
let hooked = false;

/**
 * Resolves `cloudflare:workers` to cloudflare-workers.ts for Node's loader (the stack runs under tsx). Vitest resolves
 * it through its own alias (vitest.config.ts). Idempotent.
 */
export function registerCloudflareModule(): void {
  if (hooked) return;
  if (typeof registerHooks !== 'function') throw new Error('The e2e stack needs Node 22.15 or later (module.registerHooks)');
  registerHooks({
    resolve: (specifier, context, next) => (specifier === 'cloudflare:workers' ? { url: CLOUDFLARE_WORKERS, shortCircuit: true } : next(specifier, context)),
  });
  hooked = true;
}

/**
 * A Durable Object's storage, in memory: the synchronous KV API, one alarm, deleteAll. Values are structured clones,
 * as workerd stores them, so an object can't change a stored value by mutating what it put or got.
 */
export class MemoryStorage {
  private readonly data = new Map<string, unknown>();
  private alarmTimer: ReturnType<typeof setTimeout> | null = null;
  /** Called when the alarm fires (the object's `alarm()`). */
  onAlarm: () => Promise<void> = async () => undefined;

  readonly kv = {
    get: <T>(key: string): T | undefined => (this.data.has(key) ? (structuredClone(this.data.get(key)) as T) : undefined),
    put: (key: string, value: unknown): void => {
      this.data.set(key, structuredClone(value));
    },
    delete: (key: string): boolean => this.data.delete(key),
  };

  async setAlarm(at: number | Date): Promise<void> {
    this.clearAlarm();
    const ms = Math.max(0, Number(at) - Date.now());
    this.alarmTimer = setTimeout(() => {
      this.alarmTimer = null;
      this.onAlarm().catch((e: unknown) => console.error('[e2e] Durable Object alarm failed:', e instanceof Error ? e.message : e));
    }, ms);
    // A pending alarm never keeps the process alive.
    this.alarmTimer.unref();
  }

  async deleteAll(): Promise<void> {
    this.data.clear();
    this.clearAlarm();
  }

  private clearAlarm(): void {
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    this.alarmTimer = null;
  }
}

/** The slice of a Durable Object class the namespace constructs. */
export type DurableObjectClass<T> = new (state: { storage: MemoryStorage; id: string }, env: unknown) => T;

/**
 * A Durable Object namespace in this process: one instance per name, created on first use, its methods called
 * directly (the stub is the object). Ids are the names.
 */
export class MemoryNamespace<T extends object> {
  private readonly objects = new Map<string, T>();

  constructor(
    private readonly cls: DurableObjectClass<T>,
    private readonly env: () => unknown,
  ) {}

  idFromName(name: string): string {
    return name;
  }

  get(id: string): T {
    let obj = this.objects.get(id);
    if (!obj) {
      const storage = new MemoryStorage();
      const created = new this.cls({ storage, id }, this.env());
      const alarm = (created as { alarm?: () => Promise<void> }).alarm;
      if (typeof alarm === 'function') storage.onAlarm = () => alarm.call(created);
      obj = created;
      this.objects.set(id, obj);
    }
    return obj;
  }
}

/**
 * RATE_LIMITER that always allows. The real windows are per IP, and every page in the suite is the same client: the
 * relay's 10 writes per minute would fail a parallel run. apps/api's own tests cover the limits.
 */
export const allowAllLimiter = {
  idFromName: (name: string): string => name,
  get: (_id: string) => ({ hit: async () => ({ ok: true as const }) }),
};

/** A Rate Limiting binding (the vault's VAULT_IP_LIMIT, VAULT_SHARE_LIMIT) that always allows, for the same reason. */
export const allowAllRateLimit = { limit: async (_options: { key: string }) => ({ success: true }) };

/** An ExecutionContext: waitUntil work runs on after the answer, as in workerd (a failure there is the Worker's to log). */
export class ExecContext {
  waitUntil(p: Promise<unknown>): void {
    p.catch(() => undefined);
  }

  passThroughOnException(): void {}

  readonly props = {};
}
