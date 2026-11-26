// The Workers runtime pieces apps/api's Worker needs to run in Node: the `cloudflare:workers` module, Durable Object
// namespaces with in-memory storage (so the real LoginRelay class serves the relay), a rate limiter that always
// allows, and an execution context.
import { AsyncLocalStorage } from 'node:async_hooks';
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

/** The longest delay a Node timer takes (2^31 - 1 ms). */
const MAX_TIMER_MS = 2_147_483_647;

/** An alarm asked for at most this far ahead is "soon": `soonAlarmMs` shortens it (the EVM relayer's 15 s run). */
const SOON_WINDOW_MS = 15_000;

/** One run of an object's alarm handler, while it runs (MemoryStorage.runAlarm). */
interface AlarmRun {
  running: boolean;
  /** Something outside this run set the alarm or confirmed writes while it ran: the run's own next alarm is soon too. */
  asked: boolean;
}

/**
 * A Durable Object's storage, in memory: the synchronous KV API (list by prefix, end, limit and order), one alarm,
 * transactionSync (all or nothing), sync, deleteAll. Values are structured clones, as workerd stores them, so an object
 * can't change a stored value by mutating what it put or got.
 *
 * `soonAlarmMs` (D882): the local stack's "run soon after a change", so a user's next look, or a staff member's, needn't
 * wait for the relayer's 15 s alarm. The stored alarm (`getAlarm`) is always the time asked for; only the timer fires
 * earlier, and only for a change from OUTSIDE the alarm handler:
 *   - an alarm set from outside the handler (a request: a send, a staff action) at most 15 s ahead fires after at most
 *     `soonAlarmMs`; a later one keeps its time;
 *   - an outside `sync()` (a request confirming its writes, as the relayer's send does after leaving a pending alarm
 *     at most 15 s away in place) brings that pending alarm's timer forward the same way;
 *   - an alarm the handler sets for itself, from anywhere inside its awaited run, fires at the time it asked: the
 *     relayer's own 15 s, or its backoff, as deployed. So a handler that reschedules itself never loops every
 *     `soonAlarmMs` (it did, D882: a halted relayer ran 4 times a second);
 *   - an outside set or sync while a run is in progress also makes that run's own later sets soon (in workerd the
 *     handler's set replaces the request's, there is one alarm; here the request's "soon" carries over to it). One
 *     outside change shortens at most that run's own next alarm, so nothing loops either.
 * Which run a call belongs to follows the async context (AsyncLocalStorage), so a request served while a run awaits
 * is outside it; a run nested in another, or two runs side by side, each have their own; a call after its run ended
 * is outside. A direct call to the object's `alarm()` (an admin lane's `run`, MemoryNamespace) is a run too.
 * `manual`: an alarm is only recorded (`getAlarm`), never fired by a timer: whoever holds the object runs it (an admin
 * lane's controls, so a test decides when time passes, admin-lane-worker.ts).
 */
export class MemoryStorage {
  private data = new Map<string, unknown>();
  private alarmTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the armed timer fires (ms since the epoch), or null. */
  private timerAt: number | null = null;
  private alarmAt: number | null = null;
  private readonly currentRun = new AsyncLocalStorage<AlarmRun>();
  private readonly runs = new Set<AlarmRun>();
  /** Called when the alarm fires (the object's `alarm()`). */
  onAlarm: () => Promise<void> = async () => undefined;

  constructor(
    private readonly soonAlarmMs: number | null = null,
    private readonly manual = false,
  ) {}

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

  /** Writes are in memory already. From outside the alarm handler, a pending soon alarm then fires soon (above). */
  async sync(): Promise<void> {
    if (!this.outside()) return;
    const at = this.alarmAt;
    if (at === null || this.manual || this.soonAlarmMs === null || this.alarmTimer === null || this.timerAt === null) return;
    if (at - Date.now() <= SOON_WINDOW_MS && this.timerAt > Date.now() + this.soonAlarmMs) {
      clearTimeout(this.alarmTimer);
      this.arm(at, true);
    }
  }

  async deleteAlarm(): Promise<void> {
    this.clearAlarm();
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(at: number | Date): Promise<void> {
    const run = this.ownRun();
    const soon = this.outside() || run?.asked === true;
    this.clearAlarm();
    this.alarmAt = Number(at);
    if (this.manual) return;
    this.arm(Number(at), soon);
  }

  /**
   * Runs the handler as one alarm run: the timer's, or a direct call to the object's `alarm()`. Doesn't touch the
   * stored alarm (the timer clears it when it fires; a direct call leaves it, as a lane's control always has).
   */
  async runAlarm(): Promise<void> {
    const run: AlarmRun = { running: true, asked: false };
    this.runs.add(run);
    try {
      await this.currentRun.run(run, () => this.onAlarm());
    } finally {
      run.running = false;
      this.runs.delete(run);
    }
  }

  /** The alarm run this call is part of, while that run is still running; else null. */
  private ownRun(): AlarmRun | null {
    const run = this.currentRun.getStore();
    return run?.running ? run : null;
  }

  /** True for a call from outside every running alarm run; it marks each running run as asked (above). */
  private outside(): boolean {
    if (this.ownRun() !== null) return false;
    for (const r of this.runs) r.asked = true;
    return true;
  }

  /** Arms the timer for `at`: at most `soonAlarmMs` away when `soon` and `at` is at most 15 s ahead. */
  private arm(at: number, soon: boolean): void {
    const asked = Math.max(0, at - Date.now());
    // Node's timers hold at most 2^31 - 1 ms (about 24.8 days); a later alarm (a staff action's 30-day log, D866) would
    // otherwise fire after 1 ms, again and again. It waits the longest timer, then arms itself again.
    if (asked > MAX_TIMER_MS) {
      this.timerAt = Date.now() + MAX_TIMER_MS;
      this.alarmTimer = setTimeout(() => this.arm(at, soon), MAX_TIMER_MS);
      this.alarmTimer.unref();
      return;
    }
    const ms = soon && this.soonAlarmMs !== null && asked <= SOON_WINDOW_MS ? Math.min(asked, this.soonAlarmMs) : asked;
    this.timerAt = Date.now() + ms;
    this.alarmTimer = setTimeout(() => {
      this.alarmTimer = null;
      this.timerAt = null;
      this.alarmAt = null;
      this.runAlarm().catch((e: unknown) => console.error('[e2e] Durable Object alarm failed:', e instanceof Error ? e.message : e));
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
    this.timerAt = null;
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
    private readonly opts: { soonAlarmMs?: number; manualAlarms?: boolean } = {},
  ) {}

  idFromName(name: string): string {
    return name;
  }

  get(id: string): T {
    let obj = this.objects.get(id);
    if (!obj) {
      const storage = new MemoryStorage(this.opts.soonAlarmMs ?? null, this.opts.manualAlarms === true);
      const created = new this.cls({ storage, id }, this.env());
      const alarm = (created as { alarm?: () => Promise<void> }).alarm;
      if (typeof alarm === 'function') {
        storage.onAlarm = () => alarm.call(created);
        // A direct call (an admin lane's `run` and `until`) is an alarm run too: what the handler sets keeps its time.
        Object.defineProperty(created, 'alarm', { value: () => storage.runAlarm(), configurable: true, writable: true });
      }
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
    reserveFresh: async () => 'ok' as const,
    marked: async () => false,
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
