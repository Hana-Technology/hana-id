// The Worker end to end: the cron handler with the real wiring (RPC client, signer, JWKS fetch, channel adapters)
// against one stubbed fetch that plays the NEAR RPC, Google, ntfy, Slack, Resend and the heartbeat service. Also
// proves that no secret appears in any log line or stored alert.
import { KeyPair } from '@near-js/crypto';
import { SignedTransaction } from '@near-js/transactions';
import { baseEncode } from '@near-js/utils';
import { GOOGLE_JWKS_URL } from '@hana-id/jwks';
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Env, SECRET_NAMES } from '../src/env.ts';
import worker from '../src/index.ts';
import { RESEND_URL } from '../src/channels.ts';
import { Store } from '../src/store.ts';
import { baseConfig, baseGovernance, councilPolicy, jwk } from './helpers.ts';

const rand = (n: number) => baseEncode(crypto.getRandomValues(new Uint8Array(n)));
const SECRETS = {
  WATCHDOG_KEY: KeyPair.fromRandom('ed25519').toString(),
  WATCHDOG_STATUS_TOKEN: `tok${rand(32)}`,
  RESEND_API_KEY: `re_${rand(20)}`,
  SLACK_WEBHOOK_URL: `https://hooks.slack.com/services/T0/B0/${rand(16)}`,
  NTFY_TOPIC_URL: `https://ntfy.example.com/${rand(20)}`,
  NTFY_TOKEN: `tk_${rand(20)}`,
  HEARTBEAT_URL: `https://hc-ping.example.com/${rand(16)}`,
} satisfies Partial<Record<(typeof SECRET_NAMES)[number], string>>;

const BLOCK = baseEncode(new Uint8Array(32).fill(5));

/** The chain, Google and every alert service behind one fetch. */
class Net {
  config = baseConfig();
  governance = baseGovernance();
  changes: Record<string, unknown>[] = [];
  active = new Map<string, { n: string; e: string }>([['k1', { n: jwk('k1', 1).n, e: 'AQAB' }]]);
  jwks = [jwk('k1', 1)];
  txs: { signerId: string; receiverId: string; method: string; args: Record<string, unknown> }[] = [];
  posts: { url: string; body: string; headers: Headers }[] = [];
  pings = 0;

  install(): void {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === GOOGLE_JWKS_URL) return Response.json({ keys: this.jwks });
      if (url === SECRETS.HEARTBEAT_URL) {
        this.pings++;
        return new Response('OK');
      }
      if (url === env.NEAR_RPC) return Response.json({ jsonrpc: '2.0', id: 'x', ...this.rpc(JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> }) });
      this.posts.push({ url, body: typeof init?.body === 'string' ? init.body : '', headers: new Headers(init?.headers) });
      return url === RESEND_URL ? Response.json({ id: 'email-1' }) : new Response('ok');
    });
  }

  private view(name: string): unknown {
    const kids = [...this.active.keys()].sort();
    switch (name) {
      case 'get_key_changes':
        return this.changes;
      case 'get_issuer':
        return { provider: 'google', iss_values: ['https://accounts.google.com'], kids };
      case 'get_issuer_keys':
        return kids.map((kid) => ({ kid, ...this.active.get(kid)! }));
      case 'get_config':
        return this.config;
      case 'get_governance':
        return this.governance;
      case 'get_policy':
        return councilPolicy();
    }
    return null;
  }

  private rpc({ method, params }: { method: string; params: Record<string, unknown> }): object {
    if (method === 'status') return { result: { chain_id: 'testnet' } };
    if (method === 'query' && params.request_type === 'call_function') {
      return { result: { result: [...new TextEncoder().encode(JSON.stringify(this.view(params.method_name as string)))] } };
    }
    if (method === 'query' && params.request_type === 'view_access_key') return { result: { nonce: 1, block_hash: BLOCK } };
    if (method === 'query' && params.request_type === 'view_account') return { result: { amount: '1', code_hash: 'DAOcode1111111111111111111111111111111111111' } };
    if (method === 'send_tx') {
      const t = SignedTransaction.decode(Uint8Array.from(atob(params.signed_tx_base64 as string), (c) => c.charCodeAt(0))).transaction;
      const fc = t.actions[0]!.functionCall!;
      const args = JSON.parse(new TextDecoder().decode(new Uint8Array(fc.args))) as Record<string, unknown>;
      this.txs.push({ signerId: t.signerId, receiverId: t.receiverId, method: fc.methodName, args });
      if (fc.methodName === 'cancel_issuer_key_change') this.changes = this.changes.filter((c) => c.id !== args.id);
      if (fc.methodName === 'pause') this.config.paused = true;
      if (fc.methodName === 'delete_updater_key') this.governance.updater_keys = this.governance.updater_keys.filter((k) => k !== args.public_key);
      return { result: { status: { SuccessValue: '' }, receipts_outcome: [] } };
    }
    return { error: { name: 'HANDLER_ERROR', cause: { name: 'UNSUPPORTED' } } };
  }
}

const testEnv = (): Env => ({ ...(env as unknown as Env), ...SECRETS });

async function cron(e: Env): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: '*/5 * * * *', scheduledTime: Date.now() }), e, ctx);
  await waitOnExecutionContext(ctx);
}

afterEach(() => vi.restoreAllMocks());

describe('the cron handler, end to end', () => {
  it('cancels a forged key, deletes the updater keys, pauses on a forged active key, pages, and leaks no secret', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    const net = new Net();
    net.install();
    const e = testEnv();

    await cron(e); // first run: records k1 as known
    expect(net.txs).toEqual([]);
    expect(net.pings).toBe(1);

    net.changes = [{ id: 3, provider: 'google', kid: 'k1x', op: 'Add', n: jwk('k1x', 66).n, e: 'AQAB', by: e.SIGNER_ACCOUNT, proposed_at_ms: Date.now(), executable_at_ms: Date.now() + 7_200_000 }];
    net.jwks = [jwk('k1', 1), jwk('k1x', 7)];
    net.active.set('forged', { n: jwk('forged', 50).n, e: 'AQAB' });
    net.posts = [];
    await cron(e);

    expect(net.txs.map((t) => [t.signerId, t.receiverId, t.method, t.args])).toEqual([
      [e.WATCHDOG_ACCOUNT, e.SIGNER_ACCOUNT, 'cancel_issuer_key_change', { id: 3 }],
      [e.WATCHDOG_ACCOUNT, e.SIGNER_ACCOUNT, 'delete_updater_key', { public_key: baseGovernance().updater_keys[0] }],
      [e.WATCHDOG_ACCOUNT, e.SIGNER_ACCOUNT, 'delete_updater_key', { public_key: baseGovernance().updater_keys[1] }],
      [e.WATCHDOG_ACCOUNT, e.SIGNER_ACCOUNT, 'pause', {}],
    ]);
    // Two critical alerts, each on ntfy, Slack and Resend.
    const hosts = net.posts.map((p) => new URL(p.url).host).sort();
    expect(hosts).toEqual(['api.resend.com', 'api.resend.com', 'hooks.slack.com', 'hooks.slack.com', 'ntfy.example.com', 'ntfy.example.com']);
    expect(net.posts.find((p) => p.url === SECRETS.NTFY_TOPIC_URL)?.headers.get('priority')).toBe('urgent');
    expect(net.pings).toBe(2);

    const store = new Store(env.DB);
    expect((await store.listAlerts(null, 50)).filter((a) => a.severity === 'critical').map((a) => a.kind).sort()).toEqual(['forged_active_key', 'forged_key_change']);

    // No secret value in any log line, stored alert, delivery or action.
    const stored = JSON.stringify(await env.DB.prepare('SELECT * FROM alerts').all()) + JSON.stringify(await env.DB.prepare('SELECT * FROM deliveries').all()) + JSON.stringify(await env.DB.prepare('SELECT * FROM actions').all()) + JSON.stringify(await env.DB.prepare('SELECT * FROM meta').all());
    const privatePart = SECRETS.WATCHDOG_KEY.slice('ed25519:'.length);
    expect(lines.length).toBeGreaterThan(0);
    for (const value of [...Object.values(SECRETS), privatePart]) {
      for (const line of lines) expect(line).not.toContain(value);
      expect(stored).not.toContain(value);
    }
    // ...nor in what was sent to the alert services (beyond each one's own credential in its own request).
    for (const p of net.posts) expect(p.body).not.toContain(privatePart);
  });

  it('alerts without acting when WATCHDOG_KEY is missing', async () => {
    const net = new Net();
    net.install();
    const e = { ...testEnv(), WATCHDOG_KEY: undefined };
    await cron(e);
    net.active.set('forged', { n: jwk('forged', 50).n, e: 'AQAB' });
    await cron(e);
    expect(net.txs).toEqual([]);
    const kinds = (await new Store(env.DB).listAlerts(null, 50)).map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(['watchdog_key_missing', 'forged_active_key']));
  });
});
