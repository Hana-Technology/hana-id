// Test doubles: a stub chain that behaves like hana-signer for the four watchdog methods, a recording notifier, a
// fake clock and a scripted JWKS. Nothing here reaches the network.
import type { Jwk } from '@hana-id/jwks';
import { env } from 'cloudflare:workers';
import type { ChainReader, ChainSnapshot, ChainWriter, ConfigView, GovernanceView, KeyChange, TxResult, WatchdogMethod } from '../src/chain.ts';
import type { AlertMessage, Notifier, Pager, Sender, SendResult } from '../src/channels.ts';
import type { Channel } from '../src/checks.ts';
import { type RunDeps, type RunReport, runWatchdog } from '../src/run.ts';
import { Store } from '../src/store.ts';

export const SIGNER = 'signer.test.near';
export const OWNER = 'owner.test.near';
export const WATCHDOG = 'watchdog.test.near';
export const UPDATER_KEYS = ['ed25519:7mEBxCsWzXSq3Rpy2RwEGWb7ux5YX4tdTnRvAYfGHuFc', 'ed25519:4ZBVzQ6SaxiGVF6fHNWZ2NV1Xv1r6WqBmGxe2dwbCDGQ'];
/** 2026-10-29 12:00 UTC. */
export const T0 = Date.UTC(2026, 9, 29, 12, 0);
export const MIN = 60_000;
export const HOUR = 60 * MIN;

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');

/** A 2048-bit-sized modulus (base64url), distinct per seed. */
export function modulus(seed: number, leadingZero = false): string {
  const bytes = new Uint8Array(256).map((_, i) => (seed * 31 + i * 7) & 0xff);
  bytes[0] = 0xc0 | (seed & 0x3f);
  return b64url(leadingZero ? new Uint8Array([0, ...bytes]) : bytes);
}

export function jwk(kid: string, seed: number, leadingZero = false): Jwk {
  return { kid, kty: 'RSA', alg: 'RS256', use: 'sig', n: modulus(seed, leadingZero), e: 'AQAB' };
}

export function baseConfig(): ConfigView {
  return {
    owner: OWNER,
    mpc: 'mpc.test.near',
    ckd_domain_id: 2,
    console_audiences: [['google', 'console.apps']],
    pending_console_audiences: [],
    sponsors: ['relayer.test.near'],
    shared_clients: [],
    pending_shared_clients: [],
    change_delay_ms: 60_000,
    pending_change_delay: null,
    public_registration: false,
    issuer_key_delay_ms: 2 * HOUR,
    pending_issuer_key_delay: null,
    governance_delay_ms: 72 * HOUR,
    pending_governance_delay: null,
    paused: false,
    unpaused_at_ms: 0,
    changes_unlock_floor_ms: 0,
    sessions_valid_from_ms: 0,
  };
}

/** The council DAO policy as contracts/sputnik/policy.json has it (2 of 3 for every kind), for three members. */
export function councilPolicy(members: string[] = ['a.test.near', 'b.test.near', 'c.test.near']): unknown {
  const twoOfThree = { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] };
  return {
    roles: [{ name: 'council', kind: { Group: members }, permissions: ['*:AddProposal', '*:VoteApprove', '*:VoteReject', '*:VoteRemove', '*:Finalize'], vote_policy: {} }],
    default_vote_policy: twoOfThree,
    proposal_bond: '100000000000000000000000',
    proposal_period: '604800000000000',
    bounty_bond: '100000000000000000000000',
    bounty_forgiveness_period: '86400000000000',
  };
}

export function baseGovernance(): GovernanceView {
  return {
    state_version: 2,
    watchdogs: [{ account_id: WATCHDOG, confirm_from_ms: 0 }],
    keys_slow_until_ms: 0,
    updater_keys: [...UPDATER_KEYS],
    updater_methods: ['set_issuer_key', 'propose_issuer_key_removal', 'execute_issuer_key_change'],
    pending_upgrade: null,
    pending_owner: null,
    pending_withdrawal: null,
  };
}

/** hana-signer as far as the watchdog sees it: views, and the effect of the four watchdog methods. */
export class StubChain implements ChainReader {
  chain = 'testnet';
  changes: KeyChange[] = [];
  /** Active keys: kid → material. */
  active = new Map<string, { n: string; e: string }>();
  issuerConfigured = true;
  /** get_issuer(google).iss_values (the owner's set_issuer changes them at once). */
  issValues = ['https://accounts.google.com'];
  /** False: the contract predates get_issuer_keys. */
  hasIssuerKeys = true;
  config = baseConfig();
  governance = baseGovernance();
  /** The owner account: a council DAO with the 2-of-3 policy. */
  owner: { code_hash: string; policy: unknown } = { code_hash: 'DAOcode1111111111111111111111111111111111111', policy: councilPolicy() };
  failReads = false;
  reads = 0;
  private nextId = 10;

  constructor(active: Jwk[] = []) {
    for (const k of active) this.active.set(k.kid, { n: k.n, e: k.e });
  }

  async chainId(): Promise<string> {
    if (this.failReads) throw new Error('rpc down');
    return this.chain;
  }

  async snapshot(): Promise<ChainSnapshot> {
    this.reads++;
    if (this.failReads) throw new Error('rpc down');
    const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
    const kids = [...this.active.keys()].sort();
    return {
      keyChanges: clone(this.changes),
      issuer: this.issuerConfigured ? { provider: 'google', iss_values: [...this.issValues], kids } : null,
      issuerKeys: this.issuerConfigured && this.hasIssuerKeys ? kids.map((kid) => ({ kid, ...this.active.get(kid)! })) : null,
      config: clone(this.config),
      governance: clone(this.governance),
      owner: { account_id: this.config.owner, ...clone(this.owner) },
    };
  }

  /** Queues a key change as the updater (the signer account) or the owner would. */
  propose(op: 'Add' | 'Remove', kid: string, opts: { key?: Jwk; by?: string; provider?: string; at?: number; delay?: number } = {}): KeyChange {
    const at = opts.at ?? T0;
    const change: KeyChange = {
      id: this.nextId++,
      provider: opts.provider ?? 'google',
      kid,
      op,
      n: op === 'Add' ? (opts.key?.n ?? modulus(99)) : null,
      e: op === 'Add' ? (opts.key?.e ?? 'AQAB') : null,
      by: opts.by ?? SIGNER,
      proposed_at_ms: at,
      executable_at_ms: at + (opts.delay ?? 2 * HOUR),
    };
    this.changes.push(change);
    return change;
  }

  /** Executes a change as anyone would after its delay. */
  execute(id: number): void {
    const i = this.changes.findIndex((c) => c.id === id);
    const [c] = this.changes.splice(i, 1);
    if (!c) throw new Error('no such change');
    if (c.op === 'Add') this.active.set(c.kid, { n: c.n!, e: c.e! });
    else this.active.delete(c.kid);
  }
}

export class StubWriter implements ChainWriter {
  calls: { method: WatchdogMethod; args: Record<string, unknown> }[] = [];
  fail = new Set<WatchdogMethod>();
  failError = 'Smart contract panicked: stub failure';
  /** Runs before each call: what others did on chain between the watchdog's read and its transaction. */
  before: ((method: WatchdogMethod, args: Record<string, unknown>) => void) | null = null;
  private n = 0;

  constructor(private readonly chain: StubChain) {}

  async call(method: WatchdogMethod, args: Record<string, unknown>): Promise<TxResult> {
    this.calls.push({ method, args });
    this.before?.(method, args);
    const txHash = `tx${++this.n}`;
    if (this.fail.has(method)) return { ok: false, txHash, error: this.failError };
    const c = this.chain;
    if (method === 'cancel_issuer_key_change') c.changes = c.changes.filter((x) => x.id !== args.id);
    else if (method === 'confirm_issuer_key_change') c.execute(args.id as number);
    else if (method === 'pause') c.config.paused = true;
    else if (method === 'delete_updater_key') c.governance.updater_keys = c.governance.updater_keys.filter((k) => k !== args.public_key);
    return { ok: true, txHash };
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
}

export interface Sent {
  channel: Channel;
  msg: AlertMessage;
}

export class RecordingNotifier implements Notifier {
  sent: Sent[] = [];
  digests: { subject: string; text: string }[] = [];
  pings = 0;
  failing = new Set<Channel | 'heartbeat' | 'digest'>();
  throwing = new Set<Channel>();
  unconfigured = new Set<Channel | 'heartbeat' | 'digest'>();
  /** Pager acknowledgements by ref (Pushover-like). */
  pagerAcks = new Map<string, string>();
  private refs = 0;

  private sender(channel: Channel): Sender {
    const self = this;
    return {
      channel,
      get configured() {
        return !self.unconfigured.has(channel);
      },
      async send(msg: AlertMessage): Promise<SendResult> {
        if (self.throwing.has(channel)) throw new Error('boom');
        if (self.failing.has(channel) || self.unconfigured.has(channel)) return { ok: false, error: 'HTTP 500' };
        self.sent.push({ channel, msg });
        return channel === 'pager' ? { ok: true, ref: `page-${++self.refs}` } : { ok: true };
      },
    };
  }

  readonly pager: Pager = Object.assign(this.sender('pager') as Pager, {
    provider: 'stub',
    acknowledged: async (ref: string) => (this.pagerAcks.has(ref) ? { by: this.pagerAcks.get(ref)! } : null),
  });
  readonly slack = this.sender('slack');
  readonly email = this.sender('email');
  readonly digest = {
    configured: true,
    send: async (subject: string, text: string): Promise<SendResult> => {
      if (this.failing.has('digest')) return { ok: false, error: 'HTTP 500' };
      this.digests.push({ subject, text });
      return { ok: true };
    },
  };
  readonly heartbeat = {
    configured: true,
    ping: async (): Promise<SendResult> => {
      if (this.failing.has('heartbeat')) return { ok: false, error: 'HTTP 503' };
      this.pings++;
      return { ok: true };
    },
  };

  on(channel: Channel): Sent[] {
    return this.sent.filter((s) => s.channel === channel);
  }

  clear(): void {
    this.sent = [];
  }
}

/** Google's JWKS as the watchdog fetches it: `keys`, or the next scripted answer of `queue`, or a failure. */
export class StubJwks {
  queue: (Jwk[] | 'fail')[] = [];
  fetches = 0;
  constructor(public keys: Jwk[]) {}
  fetch = async (): Promise<Jwk[]> => {
    this.fetches++;
    const next = this.queue.length ? this.queue.shift()! : this.keys;
    if (next === 'fail') throw new Error('JWKS down');
    return next.map((k) => ({ ...k }));
  };
}

export interface World {
  chain: StubChain;
  writer: StubWriter;
  jwks: StubJwks;
  notifier: RecordingNotifier;
  store: Store;
  clock: { t: number };
  sleeps: number[];
  deps: RunDeps;
  /** One run at the current time; then the clock moves 5 min. */
  run(): Promise<RunReport>;
}

export function world(opts: { active?: Jwk[]; jwks?: Jwk[]; writer?: boolean; at?: number } = {}): World {
  const chain = new StubChain(opts.active ?? []);
  const writer = new StubWriter(chain);
  const jwks = new StubJwks(opts.jwks ?? opts.active ?? []);
  const notifier = new RecordingNotifier();
  const store = new Store(env.DB);
  const clock = { t: opts.at ?? T0 };
  const sleeps: number[] = [];
  const deps: RunDeps = {
    store,
    chain,
    writer: opts.writer === false ? null : writer,
    fetchJwks: jwks.fetch,
    notifier,
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    config: { envName: 'sandbox-test', network: 'testnet', signer: SIGNER, watchdogAccount: WATCHDOG, digestHourUtc: 0 },
  };
  const w: World = {
    chain,
    writer,
    jwks,
    notifier,
    store,
    clock,
    sleeps,
    deps,
    async run() {
      const r = await runWatchdog(deps);
      clock.t += 5 * MIN;
      return r;
    },
  };
  return w;
}

/** A world past its first run: K1 active and published, initialized, digest already sent today. */
export async function initialized(opts: { active?: Jwk[]; jwks?: Jwk[]; writer?: boolean } = {}): Promise<World> {
  const active = opts.active ?? [jwk('k1', 1)];
  const w = world({ active, jwks: opts.jwks ?? active, ...(opts.writer === false ? { writer: false } : {}) });
  await w.store.setMeta('digest', { date: new Date(T0).toISOString().slice(0, 10), at: T0 });
  const r = await w.run();
  if (!r.firstRun) throw new Error('expected a first run');
  w.notifier.clear();
  w.writer.calls = [];
  return w;
}

export async function alertsOf(store: Store, kind?: string) {
  const all = await store.listAlerts(null, 200);
  return kind ? all.filter((a) => a.kind === kind) : all;
}
