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
 * A Durable Object's storage, in memory: the synchronous KV API (list by prefix, end, limit and order), one alarm,
 * transactionSync (all or nothing), sync, deleteAll. Values are structured clones, as workerd stores them, so an object
 * can't change a stored value by mutating what it put or got.
 *
 * `soonAlarmMs`: an alarm asked for at most 15 s ahead fires after at most this long instead (the EVM relayer's run
 * after a change, so a user's next action needn't wait for it); a later one keeps its time.
 */
export class MemoryStorage {
  private data = new Map<string, unknown>();
  private alarmTimer: ReturnType<typeof setTimeout> | null = null;
  /** Called when the alarm fires (the object's `alarm()`). */
  onAlarm: () => Promise<void> = async () => undefined;

  constructor(private readonly soonAlarmMs: number | null = null) {}

  readonly kv = {
    get: <T>(key: string): T | undefined => (this.data.has(key) ? (structuredClone(this.data.get(key)) as T) : undefined),
    put: (key: string, value: unknown): void => {
      this.data.set(key, structuredClone(value));
    },
    delete: (key: string): boolean => this.data.delete(key),
    /** Entries in key order (or reversed), under a prefix, before `end`, at most `limit`. */
    list: <T>(options: { prefix?: string; end?: string; limit?: number; reverse?: boolean } = {}): Iterable<[string, T]> => {
      const keys = [...this.data.keys()]
        .filter((k) => (options.prefix === undefined || k.startsWith(options.prefix)) && (options.end === undefined || k < options.end))
        .sort();
      if (options.reverse) keys.reverse();
      return keys.slice(0, options.limit ?? keys.length).map((k): [string, T] => [k, structuredClone(this.data.get(k)) as T]);
    },
  };

  /** Runs `fn` against the storage; if it throws, every change it made is undone. */
  transactionSync<T>(fn: () => T): T {
    const before = new Map(this.data);
    try {
      return fn();
    } catch (e) {
      this.data = before;
      throw e;
    }
  }

  /** Writes are in memory already. */
  async sync(): Promise<void> {}

  async deleteAlarm(): Promise<void> {
    this.clearAlarm();
  }
  private alarmAt: number | null = null;

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(at: number | Date): Promise<void> {
    this.clearAlarm();
    this.alarmAt = Number(at);
    const asked = Math.max(0, Number(at) - Date.now());
    const ms = this.soonAlarmMs !== null && asked <= 15_000 ? Math.min(asked, this.soonAlarmMs) : asked;
    this.alarmTimer = setTimeout(() => {
      this.alarmTimer = null;
      this.alarmAt = null;
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
    this.alarmAt = null;
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
    private readonly opts: { soonAlarmMs?: number } = {},
  ) {}

  idFromName(name: string): string {
    return name;
  }

  get(id: string): T {
    let obj = this.objects.get(id);
    if (!obj) {
      const storage = new MemoryStorage(this.opts.soonAlarmMs ?? null);
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
 * relay's 10 writes per minute would fail a parallel run. apps/api's own tests cover the limits, and the single-use
 * markers (`reserve`: the identity token's and the sponsorship's session proofs, a sponsored batch's digest), which
 * this always grants, and the amounts (`spend`: the sponsorship's budgets and slots), never short here; a nonce floor
 * (`floor`) is always 0.
 */
export const allowAllLimiter = {
  idFromName: (name: string): string => name,
  get: (_id: string) => ({
    hit: async () => ({ ok: true as const }),
    unhit: async () => undefined,
    hitSliding: async () => ({ ok: true as const }),
    unhitSliding: async () => undefined,
    reserve: async () => true,
    release: async () => undefined,
    spend: async () => ({ ok: true as const, spent: '0' }),
    spent: async () => '0',
    giveBack: async () => undefined,
    charge: async () => undefined,
    floor: async () => '0',
    raiseFloor: async () => undefined,
  }),
};

/** A Rate Limiting binding (the vault's VAULT_IP_LIMIT, VAULT_SHARE_LIMIT, VAULT_STATUS_*) that always allows, for the same reason. */
export const allowAllRateLimit = { limit: async (_options: { key: string }) => ({ success: true }) };

/** An ExecutionContext: waitUntil work runs on after the answer, as in workerd (a failure there is the Worker's to log). */
export class ExecContext {
  waitUntil(p: Promise<unknown>): void {
    p.catch(() => undefined);
  }

  passThroughOnException(): void {}

  readonly props = {};
}
