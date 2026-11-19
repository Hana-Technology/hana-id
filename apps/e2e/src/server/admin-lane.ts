// The staff admin portal on the local stack (D873): apps/admin's real Worker and SPA, one LANE per origin
// (stack.ts ADMIN_LANES: `demo` for a person's hand test, one per browser project for the suite), each in a worker
// thread of its own (admin-lane-worker.ts) with its own copy of the API, relayer, chain, audit log and clock. A thread
// is the lane's isolate: the Worker's per-isolate caches (the status page's 30 s, the Access certs), and the lane's
// clock, are its alone. A lane starts on its first request (so the stack's start-up costs nothing more).
//
// This file is the main thread's side: it owns the lanes' ports, hands each HTTP request to the lane's thread and
// back (as structured clones), and answers the lane's ISSUER binding with the stack's email issuer's real DirectoryRpc
// (issuer.ts `directoryRpc`), so the Users screen, the issuer's audit rows and its status tile are the stack's own.
import { Worker } from 'node:worker_threads';
import type { AccessKeys } from './access.ts';
import type { LaneData } from './admin-lane-worker.ts';
import type { Handler } from './http.ts';

const WORKER = new URL('./admin-lane-worker.ts', import.meta.url);
/** DirectoryRpc's methods the admin Worker calls (apps/admin src/env.ts DirectoryRpcClient). */
const ISSUER_METHODS = new Set(['search', 'get', 'auditSince', 'issuerStats', 'health']);

interface HttpAnswer {
  status: number;
  headers: [string, string][];
  setCookie: string[];
  body: ArrayBuffer;
}

class LaneThread {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private seq = 0;
  private readonly pending = new Map<number, (a: HttpAnswer) => void>();

  constructor(
    private readonly data: LaneData,
    private readonly issuer: Record<string, (...args: unknown[]) => Promise<unknown>> | null,
  ) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const w = new Worker(WORKER, { workerData: this.data });
      this.worker = w;
      w.on('message', (m: { type: string; id: number; target?: string; method?: string; args?: unknown[] } & Partial<HttpAnswer>) => {
        if (m.type === 'ready') resolve();
        else if (m.type === 'http') {
          const done = this.pending.get(m.id);
          this.pending.delete(m.id);
          done?.(m as HttpAnswer);
        } else if (m.type === 'rpc') void this.rpc(m.id, m.target, m.method, m.args ?? []);
      });
      w.on('error', (e) => {
        console.error(`[e2e] admin lane ${this.data.name} failed:`, e instanceof Error ? e.message : e);
        reject(e);
        this.ready = null;
        this.worker = null;
        for (const done of this.pending.values()) done({ status: 503, headers: [['content-type', 'text/plain; charset=utf-8']], setCookie: [], body: new TextEncoder().encode('The admin lane stopped: see the stack log.\n').buffer as ArrayBuffer });
        this.pending.clear();
      });
    });
    return this.ready;
  }

  /** The lane's service binding call into this thread: the issuer's DirectoryRpc only, its listed methods only. */
  private async rpc(id: number, target: string | undefined, method: string | undefined, args: unknown[]): Promise<void> {
    try {
      const issuer = this.issuer;
      if (target !== 'issuer' || !method || !ISSUER_METHODS.has(method) || !issuer || typeof issuer[method] !== 'function') throw new Error(`no such binding method: ${target}.${method}`);
      // Structured clones both ways (postMessage), as over workerd's RPC.
      const value = await issuer[method](...args);
      this.worker?.postMessage({ type: 'rpc', id, ok: true, value });
    } catch (e) {
      this.worker?.postMessage({ type: 'rpc', id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  handler(): Handler {
    return async (request) => {
      await this.start();
      this.seq += 1;
      const id = this.seq;
      const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer();
      const headers: [string, string][] = [];
      request.headers.forEach((v, k) => headers.push([k, v]));
      const answer = await new Promise<HttpAnswer>((resolve) => {
        this.pending.set(id, resolve);
        this.worker!.postMessage({ type: 'http', id, method: request.method, url: request.url, headers, body }, body ? [body] : []);
      });
      const h = new Headers(answer.headers.filter(([k]) => k !== 'set-cookie'));
      for (const c of answer.setCookie) h.append('set-cookie', c);
      return new Response(request.method === 'HEAD' || answer.status === 204 || answer.status === 304 ? null : answer.body, { status: answer.status, headers: h });
    };
  }
}

/** Every lane's thread, made on its first request. */
export class AdminLanes {
  private readonly threads = new Map<string, LaneThread>();

  constructor(private readonly o: { access: AccessKeys; issuer: object | null }) {}

  /** The handler of lane `name` on `origin`: the hand-test lane's relayer also runs by itself; the suite's only when told. */
  handler(name: string, origin: string): Handler {
    let t = this.threads.get(name);
    if (!t) {
      t = new LaneThread({ name, origin, access: this.o.access, manualAlarms: name !== 'demo' }, this.o.issuer as Record<string, (...args: unknown[]) => Promise<unknown>> | null);
      this.threads.set(name, t);
    }
    return t.handler();
  }
}
