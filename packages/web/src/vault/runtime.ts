// The vault's view of its surroundings, injected so every flow can be tested without a browser: the server-corrected
// clock, timers, locks, the per-app BroadcastChannel and the windows it talks to.

/** A window the vault posts to or opens (a WindowProxy; cross-origin, so only these members are used). */
export interface WindowRef {
  postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void;
  readonly closed: boolean;
  focus(): void;
  close(): void;
}

/** A window `message` event, as the vault reads it. */
export interface WindowMessageEvent {
  readonly data: unknown;
  readonly origin: string;
  readonly source: unknown;
  readonly ports: readonly MessagePort[];
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

/** Resolves after `ms` (or at once when `signal` aborts). */
export function sleep(timers: Timers, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const handle = timers.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      timers.clearTimeout(handle);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The server-corrected clock (docs/batch-b-spec.md "Clock"): `offset = serverTimeMs − Date.now()` at start, refreshed
 * from every `/v1/app` and relay response, and `now() = Date.now() + offset` for every time check and expiry the vault
 * computes. A device clock minutes or hours off then can't break token checks or produce an expiry the contract refuses.
 */
export class Clock {
  private offset: number;
  /** The latest time now() returned: it never goes back (sweep VAUL-2). */
  private last = Number.NEGATIVE_INFINITY;

  constructor(
    serverTimeMs: number,
    private readonly deviceNow: () => number = () => Date.now(),
  ) {
    this.offset = serverTimeMs - deviceNow();
  }

  /**
   * Server-corrected time, monotonic: a device clock set back, or a server time behind the one already seen, holds it
   * where it was until real time catches up, so the idle limit, expiries, consents and the policy re-read can't be
   * stretched by a backwards step. A forward step only ends things earlier.
   */
  now(): number {
    const t = this.deviceNow() + this.offset;
    if (t > this.last) this.last = t;
    return this.last;
  }

  /** Re-anchors on a server time just received (ignored unless it is a plausible ms timestamp). */
  refresh(serverTimeMs: unknown): void {
    if (Number.isSafeInteger(serverTimeMs) && (serverTimeMs as number) > 0) this.offset = (serverTimeMs as number) - this.deviceNow();
  }
}

/** The part of the Web Locks API the vault uses (navigator.locks). */
export interface Locks {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/** An in-page lock (when navigator.locks is missing): serialises callers in this document only. */
export function localLocks(): Locks {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request<T>(name: string, callback: () => Promise<T>): Promise<T> {
      const prev = tails.get(name) ?? Promise.resolve();
      const run = prev.then(callback, callback);
      const tail = run.catch(() => undefined);
      tails.set(name, tail);
      void tail.then(() => {
        if (tails.get(name) === tail) tails.delete(name);
      });
      return run;
    },
  };
}

/** navigator.locks when present (it serialises across this app's tabs), else localLocks(). */
export function browserLocks(nav: { locks?: { request(name: string, cb: () => Promise<unknown>): Promise<unknown> } } | undefined): Locks {
  const locks = nav?.locks;
  if (!locks || typeof locks.request !== 'function') return localLocks();
  return { request: <T>(name: string, callback: () => Promise<T>) => locks.request(name, callback) as Promise<T> };
}

/** The per-app BroadcastChannel (outcomes only, never key material). */
export interface Channel {
  postMessage(message: unknown): void;
  onMessage(listener: (data: unknown) => void): void;
  close(): void;
}

export function browserChannel(name: string): Channel | null {
  if (typeof BroadcastChannel !== 'function') return null;
  try {
    const bc = new BroadcastChannel(name);
    return {
      postMessage: (m) => bc.postMessage(m),
      onMessage: (listener) => bc.addEventListener('message', (e) => listener((e as MessageEvent).data)),
      close: () => bc.close(),
    };
  } catch {
    return null;
  }
}

/** 32 lowercase hex characters (128 random bits), for window names. */
export const randomHex128 = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
