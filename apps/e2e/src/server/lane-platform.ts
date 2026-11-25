// The partner platform in an admin lane (D930; docs/partner-platform-spec.md piece P5's e2e run): the lane labels org
// (lane-labels.ts: its owner is the console member the console lane signs in, an on-chain owner of its scope) becomes a
// network. Everything goes through the product's own code; the lane only stands in for the network's backend and for
// the email provider:
//
//   RESET     a fresh labels org whose scope staff mark as shared (AdminRpc.setScopeAppUserIds) and a fresh ECDSA P-256
//             key pair for its backend, made here: the public half is answered (the test pastes it into the staff
//             portal's Register form); the private half never leaves this thread and is never logged or answered.
//   NOTICES   the admin Worker's REAL notice step (apps/admin src/notices.ts `runNotices`) on the lane's admin env, with
//             a sender that keeps every message in memory (the lane has no EMAIL_API_KEY: nothing leaves the stack); the
//             answer is what was "sent" since the last call, and each change's cancel link token (from the email's own
//             link, so the test opens it on the console lane's origin; the links name an https `.invalid` stand-in).
//   SWITCH    the org's platform switch on, with the review of every key (AdminRpc.setPlatformOrg as the lane's staff).
//   CREATE    the network's backend: a signed `POST /v1/platform/apps` (console-core `signPlatformRequest`) through
//             apps/api's own Worker, with the lane's env name and signer, as a network's backend sends it.
//   STATE     the org's waiting platform proposals (the hot DB), for the test's checks.
import { API_URL, E2E_ENV, ENV_NAME } from '../stack.ts';
import { ACCESS_SUBS, E2E_STAFF } from './access.ts';
import type { ApiModules } from './api-modules.ts';
import type { D1Shim } from './d1.ts';
import type { LabelsLane } from './lane-labels.ts';
import type { MockApi } from './api.ts';
import { ExecContext } from './workers.ts';

const SRC = (app: string, path: string): string => new URL(`../../../${app}/src/${path}`, import.meta.url).href;
const CONSOLE_CORE = new URL('../../../../packages/console-core/src/index.ts', import.meta.url).href;

interface ConsoleCore {
  signPlatformRequest(privateKey: CryptoKey, i: { envName: string; signerAccount: string; method: 'GET' | 'POST'; path: string; keyId: string; idempotencyKey?: string; body?: string }): Promise<{ headers: Record<string, string>; body: Uint8Array }>;
}
const core = (await import(CONSOLE_CORE)) as ConsoleCore;
type Message = { to: string; subject: string; text: string; html: string };
const { runNotices } = (await import(SRC('admin', 'notices.ts'))) as { runNotices(env: unknown, sender: { configured: boolean; send(m: Message): Promise<{ ok: true; id: string }> }, budget: unknown): Promise<unknown> };
const { Budget } = (await import(SRC('admin', 'mail.ts'))) as { Budget: new (left?: number, rpc?: number) => unknown };

type Rpc = Record<string, (c: unknown) => Promise<unknown>>;

export interface PlatformLaneDeps {
  api: MockApi;
  d1: D1Shim;
  modules: ApiModules;
  adminRpc: Rpc;
  labels: LabelsLane;
  /** The lane's admin env (its API binding, link keys, alias and console origin), for the real notice step. */
  adminEnv: Record<string, unknown>;
}

const rid = (p: string): string => `req_e2e_platform_${p}_${crypto.randomUUID().replaceAll('-', '')}`;

async function ok<T>(p: Promise<unknown>, what: string): Promise<T> {
  const r = (await p) as { ok: boolean; code?: string; error?: string };
  if (!r.ok) throw new Error(`${what}: ${r.code ?? 'refused'}${r.error ? `: ${r.error}` : ''}`);
  return r as T;
}

export class PlatformLane {
  private privateKey: CryptoKey | null = null;
  private org: { orgId: string; scopeId: string } | null = null;
  private outbox: Message[] = [];
  private readonly exec = new ExecContext();
  constructor(private readonly d: PlatformLaneDeps) {}

  private staff() {
    return { actor: { kind: 'hana' as const, id: ACCESS_SUBS[E2E_STAFF]!, email: E2E_STAFF }, requestId: rid('staff'), clientIp: '127.0.0.1' };
  }

  /** A fresh network: the labels org (reset), its scope marked as shared, a new key pair (the public half answered). */
  async reset(): Promise<{ orgId: string; scopeId: string; publicKey: string }> {
    const s = (await this.d.labels.reset()) as { orgId: string; scopeId: string };
    await ok(this.d.adminRpc.setScopeAppUserIds!({ ...this.staff(), orgId: s.orgId, scopeId: s.scopeId }), 'setScopeAppUserIds');
    const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    this.privateKey = kp.privateKey;
    const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey;
    this.org = { orgId: s.orgId, scopeId: s.scopeId };
    this.outbox = [];
    return { orgId: s.orgId, scopeId: s.scopeId, publicKey: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }) };
  }

  private current(): { orgId: string; scopeId: string } {
    if (!this.org) throw new Error('platform: reset first');
    return this.org;
  }

  /** The admin Worker's notice step as its cron runs it; the messages "sent" by this call. */
  async notices(): Promise<{ sent: Message[] }> {
    const before = this.outbox.length;
    const sender = {
      configured: true,
      send: async (m: Message) => {
        this.outbox.push(m);
        return { ok: true as const, id: `e2e-${this.outbox.length}` };
      },
    };
    // The designed mails' buttons are https only: the links name an https stand-in of the console (`.invalid`, RFC
    // 6761); the test takes each token from its link and opens the console lane's own origin.
    await runNotices({ ...this.d.adminEnv, CONSOLE_ORIGIN: 'https://console.e2e.invalid' }, sender, new Budget(1000));
    return { sent: this.outbox.slice(before) };
  }

  /** The org's switch on, naming every key working or waiting (the review). */
  async switchOn(): Promise<{ keys: string[] }> {
    const s = this.current();
    const list = await ok<{ keys: { id: string; state: string }[] }>(this.d.adminRpc.listPlatformKeys!({ ...this.staff(), orgId: s.orgId }), 'listPlatformKeys');
    const reviewed = list.keys.filter((k) => ['awaiting_acceptance', 'waiting', 'in_force'].includes(k.state)).map((k) => k.id);
    await ok(this.d.adminRpc.setPlatformOrg!({ ...this.staff(), orgId: s.orgId, enabled: true, reason: 'E2E: switched on after reviewing every key', reviewedKeys: reviewed }), 'setPlatformOrg');
    return { keys: reviewed };
  }

  /** The network's backend creates an app with `origins`, signed with the org's key in force. */
  async create(i: { name: string; origins: string[] }): Promise<{ status: number; body: Record<string, unknown> }> {
    const s = this.current();
    if (!this.privateKey) throw new Error('platform: no key pair');
    const list = await ok<{ keys: { id: string; state: string }[] }>(this.d.adminRpc.listPlatformKeys!({ ...this.staff(), orgId: s.orgId }), 'listPlatformKeys');
    const key = list.keys.find((k) => k.state === 'in_force');
    if (!key) throw new Error('platform create: the org has no key in force');
    const path = '/v1/platform/apps';
    const body = JSON.stringify({ scopeId: s.scopeId, name: i.name, origins: i.origins });
    const signed = await core.signPlatformRequest(this.privateKey, { envName: ENV_NAME, signerAccount: E2E_ENV.signer, method: 'POST', path, keyId: key.id, idempotencyKey: `e2e-${crypto.randomUUID()}`, body });
    const req = new Request(`${API_URL}${path}`, { method: 'POST', headers: { ...signed.headers, 'cf-connecting-ip': '203.0.113.50' }, body });
    const res = await this.d.modules.worker.fetch(req, this.d.api.env, this.exec);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  /** The org's platform proposals and their state. */
  state(): { proposals: { id: string; origin: string; status: string; notified: boolean }[] } {
    const s = this.current();
    const rows = this.d.d1.db
      .prepare("SELECT g.id, g.origin, g.status, g.notified_at FROM guarded_changes g JOIN apps a ON a.id = g.app_id WHERE a.org_id = ? AND g.proposed_by_kind = 'platform' ORDER BY g.proposed_at, g.id")
      .all(s.orgId) as { id: string; origin: string; status: string; notified_at: number | null }[];
    return { proposals: rows.map((r) => ({ id: r.id, origin: r.origin, status: r.status, notified: r.notified_at !== null })) };
  }
}
