// Test harness for the partner client: a HanaClient on happy-dom with a scripted vault on the other end of the port,
// fake login popups, and a MessageChannel that delivers on microtasks (so fake timers and the port interleave
// deterministically). The fake vault sees exactly what the real one would: the hello and every port request.
import { type PortMethod, type ProtocolError, type StatusResult, checksumEvmAddress, parsePortRequest, stellarAddress } from '@hana-id/core';
import { vi } from 'vitest';
import { HanaClient, type HanaConfig } from '../../src/client/client.ts';
import type { FetchLike } from '../../src/client/rpc.ts';

export const ORIGINS = { vaultOrigin: 'https://vault.hana.test', authOrigin: 'https://auth.hana.test' } as const;
export const PK = 'pk_test_4bd7ZqGiPcDdRx8Fk2mN9w';
export const STELLAR = stellarAddress(new Uint8Array(32).fill(7));
export const EVM = checksumEvmAddress(Uint8Array.from({ length: 20 }, (_, i) => 0xa0 + i));
export const STELLAR_2 = stellarAddress(new Uint8Array(32).fill(9));
export const EVM_2 = checksumEvmAddress(new Uint8Array(20).fill(0x42));
export const LOGGED_OUT: StatusResult = { status: 'logged_out', persistence: 'session' };
export const LOGGED_IN: StatusResult = { status: 'logged_in', addresses: { stellar: STELLAR, evm: EVM }, expiresAtMs: 1_900_000_000_000, persistence: 'session' };

/** Lets every queued microtask (port deliveries and promise chains) run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

// ---- MessageChannel delivering on microtasks, with structured clone ----

class FakePort {
  other!: FakePort;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  closed = false;
  postMessage(data: unknown): void {
    if (this.closed) return;
    const clone = structuredClone(data);
    queueMicrotask(() => {
      if (!this.other.closed) this.other.onmessage?.({ data: clone });
    });
  }
  close(): void {
    this.closed = true;
  }
  start(): void {}
}

export class FakeMessageChannel {
  readonly port1 = new FakePort();
  readonly port2 = new FakePort();
  constructor() {
    this.port1.other = this.port2;
    this.port2.other = this.port1;
  }
}

// ---- popups ----

export class FakePopup {
  closed = false;
  readonly close = vi.fn(() => {
    this.closed = true;
  });
  focus(): void {}
}

// ---- the vault ----

export interface SeenRequest {
  id: string;
  method: PortMethod;
  params: unknown;
  /** The raw message as it arrived (after structured clone). */
  raw: Record<string, unknown>;
}

type Handler = (params: unknown, req: SeenRequest) => { result: unknown } | { error: ProtocolError } | 'manual';

export class FakeVault {
  port: FakePort | null = null;
  hello: { message: unknown; targetOrigin: string; transfer: unknown[] } | null = null;
  readonly requests: SeenRequest[] = [];
  readonly invalid: unknown[] = [];
  readonly #handlers = new Map<string, Handler>();

  constructor(readonly frame: HTMLIFrameElement) {
    Object.defineProperty(frame, 'contentWindow', {
      configurable: true,
      value: {
        postMessage: (message: unknown, targetOrigin: string, transfer: unknown[] = []) => {
          this.hello = { message, targetOrigin, transfer };
          const port = transfer[0] as FakePort | undefined;
          if (!port) return;
          this.port = port;
          port.onmessage = (e) => this.#onRequest(e.data);
        },
      },
    });
  }

  /** Fires the iframe's load event (the vault page loaded). */
  load(): void {
    this.frame.dispatchEvent(new Event('load'));
  }

  /** load + ready with `status`. */
  async connect(status: StatusResult & { warning?: 'storage_unavailable' } = LOGGED_OUT): Promise<void> {
    this.load();
    await flush();
    this.emit('ready', status);
    await flush();
  }

  emit(event: string, data?: unknown): void {
    this.port?.postMessage(data === undefined ? { v: 1, event } : { v: 1, event, data });
  }

  /** Auto-replies to `method` (return 'manual' to leave a request for reply()). */
  handle(method: PortMethod, h: Handler): void {
    this.#handlers.set(method, h);
  }

  reply(id: string, result: unknown): void {
    this.port?.postMessage({ v: 1, id, result });
  }

  replyError(id: string, code: ProtocolError['code'], message = String(code), data?: unknown): void {
    this.port?.postMessage({ v: 1, id, error: data === undefined ? { code, message } : { code, message, data } });
  }

  /** Requests seen for `method`. */
  seen(method: PortMethod): SeenRequest[] {
    return this.requests.filter((r) => r.method === method);
  }

  last(method: PortMethod): SeenRequest {
    const all = this.seen(method);
    const r = all[all.length - 1];
    if (!r) throw new Error(`No ${method} request`);
    return r;
  }

  #onRequest(data: unknown): void {
    // The real vault validates with the same parser; the client must never send anything it would drop.
    const parsed = parsePortRequest(data);
    if (!parsed) {
      this.invalid.push(data);
      return;
    }
    const req: SeenRequest = { id: parsed.id, method: parsed.method, params: parsed.params, raw: data as Record<string, unknown> };
    this.requests.push(req);
    const h = this.#handlers.get(parsed.method);
    if (!h) return;
    const out = h(parsed.params, req);
    if (out === 'manual') return;
    if ('error' in out) this.port?.postMessage({ v: 1, id: req.id, error: out.error });
    else this.reply(req.id, out.result);
  }
}

// ---- setup ----

export interface Setup {
  client: HanaClient;
  vault: FakeVault;
  frame: HTMLIFrameElement;
  popups: FakePopup[];
  open: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
}

export interface SetupOptions {
  config?: Partial<HanaConfig>;
  /** 'blocked': window.open returns null. */
  popup?: 'open' | 'blocked';
  fetch?: FetchLike;
}

/**
 * happy-dom logs every iframe and script it won't load, through the Node console it captured before vitest's (so console spies
 * miss it); the harness stands in for the vault page itself, so those lines are dropped at stderr.
 */
let quiet = false;
export function quietIframeLoads(): void {
  if (quiet) return;
  quiet = true;
  const write = process.stderr.write.bind(process.stderr) as (chunk: unknown, ...rest: unknown[]) => boolean;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (/(?:Iframe page|JavaScript file) loading is disabled/u.test(String(chunk))) return true;
    return write(chunk, ...rest);
  }) as typeof process.stderr.write;
}

export function setup(o: SetupOptions = {}): Setup {
  quietIframeLoads();
  vi.stubGlobal('MessageChannel', FakeMessageChannel);
  const popups: FakePopup[] = [];
  const open = vi.fn((..._args: unknown[]) => {
    if (o.popup === 'blocked') return null;
    const p = new FakePopup();
    popups.push(p);
    return p;
  });
  window.open = open as unknown as typeof window.open;
  const fetch = vi.fn(o.fetch ?? (async () => new Response('{}')));
  const client = new HanaClient({ publishableKey: PK, environment: 'test', ...o.config }, { win: window, origins: ORIGINS, fetch: fetch as unknown as FetchLike });
  const frame = document.querySelector('iframe[name^="hana-vault-"]') as HTMLIFrameElement;
  const vault = new FakeVault(frame);
  return { client, vault, frame, popups, open, fetch };
}

/** A JSON-RPC endpoint answering from `answers` (method → result, or a function of params). Unknown methods → -32601. */
export function rpcFetch(answers: Record<string, unknown | ((params: unknown[]) => unknown)>): FetchLike & { calls: { method: string; params: unknown[] }[] } {
  const calls: { method: string; params: unknown[] }[] = [];
  const f = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] };
    calls.push({ method: body.method, params: body.params });
    if (!Object.hasOwn(answers, body.method)) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } }));
    }
    const a = answers[body.method];
    const result = typeof a === 'function' ? (a as (p: unknown[]) => unknown)(body.params) : a;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  };
  return Object.assign(f, { calls });
}
