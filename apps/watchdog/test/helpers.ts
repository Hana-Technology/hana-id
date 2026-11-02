// Test doubles: a stub chain that behaves like hana-signer for the four watchdog methods, a recording notifier, a
// fake clock and a scripted JWKS. Nothing here reaches the network.
import { type Jwk, rsaThumbprint } from '@hana-id/jwks';
import { env } from 'cloudflare:workers';
import type { ChainReader, ChainSnapshot, ChainWriter, ConfigView, GovernanceView, KeyChange, LinkStatsView, LinkWindow, TxResult, WatchdogMethod } from '../src/chain.ts';
import type { AlertMessage, Notifier, Pager, Sender, SendResult } from '../src/channels.ts';
import type { Channel } from '../src/checks.ts';
import type { SignerPins } from '../src/pins.ts';
import { type AccessKeyEntry, nearToYocto, type RelayerFunds, relayerFundsFrom, relayerThresholds } from '../src/relayer.ts';
import { type RunDeps, type RunReport, runWatchdog } from '../src/run.ts';
import { Store } from '../src/store.ts';

export const SIGNER = 'signer.test.near';
export const OWNER = 'owner.test.near';
export const WATCHDOG = 'watchdog.test.near';
export const RELAYER = 'relayer.test.near';
export const SESSION_METHODS = ['create_session', 'create_session_and_derive', 'derive_key', 'revoke_session', 'prune_sessions'];
export const OWNER_POOL_METHODS = ['propose_change', 'cancel_change', 'remove_client', 'disable_shared_login', 'execute_change', 'register_scope', 'apply_pending_config'];
export const SESSION_KEYS = ['ed25519:3PXtH5yGjK4qrKpZuS4ZBc6fMSu1yBU4ZPR3XDjBmVvH', 'ed25519:5rKxnZ3ZQ9cYgHPzcDk7Ln3AokBdtpLwrqX1Bc4hiVj8', 'ed25519:8AxjGhhmV6rTwQhSCRRmzz6sU2dFqDswnRbXYoC2b7rk'];
export const OWNER_POOL_KEY = 'ed25519:9mE3bS7YWXaKXg8tjLfV1JpCcRhDmBzQkYsNuHv2TfGa';
export const NEAR = 10n ** 24n;

/** A function-call key of the relayer for the signer, as view_access_key_list returns it. */
export function relayerKey(publicKey: string, methods: string[], allowanceNear: number | null): AccessKeyEntry {
  return { public_key: publicKey, access_key: { nonce: 1, permission: { FunctionCall: { allowance: allowanceNear === null ? null : nearToYocto(allowanceNear).toString(), receiver_id: SIGNER, method_names: methods } } } };
}

/** A funded relayer as deploy-contract leaves it: 3 session keys × 2 NEAR, 1 owner key × 0.5 NEAR, a full-access key. */
export function healthyRelayer(): { view: { amount: string; locked: string; storage_usage: number } | null; keys: AccessKeyEntry[] } {
  return {
    view: { amount: (50n * NEAR).toString(), locked: '0', storage_usage: 1000 },
    keys: [
      { public_key: 'ed25519:FuLLaccessKey1111111111111111111111111111111', access_key: { nonce: 1, permission: 'FullAccess' } },
      ...SESSION_KEYS.map((k) => relayerKey(k, SESSION_METHODS, 2)),
      relayerKey(OWNER_POOL_KEY, OWNER_POOL_METHODS, 0.5),
    ],
  };
}
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

/** An email issuer key as Hana's issuer makes it: kid = its RFC 7638 thumbprint. */
export async function emailJwk(seed: number): Promise<Jwk> {
  const n = modulus(seed);
  return { kid: (await rsaThumbprint({ n, e: 'AQAB' }))!, kty: 'RSA', alg: 'RS256', use: 'sig', n, e: 'AQAB' };
}

/** Pins `{required, signers}` with each signer's keys' thumbprints. */
export function pinsOf(signers: Record<string, Jwk[]>, required = 1): SignerPins {
  return { required, signers: Object.fromEntries(Object.entries(signers).map(([id, keys]) => [id, keys.map((k) => k.kid)])) };
}

export const EMAIL_ISS = 'https://api.test/v1/email';

/** The UTC hour `at` falls in. */
export const hourOf = (at: number) => at - (at % HOUR);

/** One window of `get_link_stats()`. */
export function linkWindow(at: number, total = 0, over: Partial<LinkWindow> = {}): LinkWindow {
  return { window_start_ms: hourOf(at), total, total_cap_reached: false, capped_scopes: [], ...over };
}

/** `get_link_stats()` as D200's contract answers it: the default caps, nothing linked yet. */
export function linkStats(over: Partial<LinkStatsView> = {}): LinkStatsView {
  return { window_ms: HOUR, limits: { per_scope_per_hour: 50, total_per_hour: 500 }, pending_limits: null, links_total: 0, current: linkWindow(T0), previous: null, ...over };
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
  /** Contract v3 (false: v2, no get_self_issued and no `unrecorded_wallets` in get_config). */
  v3 = true;
  unrecordedWallets = false;
  /** get_issuer("email").iss_values (null: no email issuer). */
  emailIss: string[] | null = null;
  /** Active email keys: kid → material and the signer it was posted for. */
  emailActive = new Map<string, { n: string; e: string; signer: string | null }>();
  /** `get_link_stats()` (D200); null: a contract without the view (v2, or v3 before the link cap). */
  linkStats: LinkStatsView | null = linkStats();
  /** As the reader reports a view of another shape, or one that errored (`linkStats` then reads as null). */
  linkStatsProblem: 'malformed' | 'read_failed' | null = null;
  /** The email signer policy (null: not self-issued). */
  selfIssued: { signers: string[]; required: number; overlap_until_ms?: number | null } | null = null;
  failReads = false;
  reads = 0;
  /** The relayer account (`view_account`, null: it doesn't exist) and its access keys. */
  relayer = healthyRelayer();
  failRelayer = false;
  relayerReads = 0;
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
    const emailKids = [...this.emailActive.keys()].sort();
    const si = this.v3 && this.selfIssued;
    const config = clone(this.config);
    if (this.v3) config.unrecorded_wallets = this.unrecordedWallets;
    return {
      keyChanges: clone(this.changes),
      issuer: this.issuerConfigured ? { provider: 'google', iss_values: [...this.issValues], kids } : null,
      issuerKeys: this.issuerConfigured && this.hasIssuerKeys ? kids.map((kid) => ({ kid, ...this.active.get(kid)! })) : null,
      email: {
        issuer: this.emailIss ? { provider: 'email', iss_values: [...this.emailIss], kids: emailKids } : null,
        issuerKeys: this.emailIss ? emailKids.map((kid) => ({ kid, n: this.emailActive.get(kid)!.n, e: this.emailActive.get(kid)!.e })) : null,
        selfIssued: si
          ? { provider: 'email', signers: si.signers.map((id) => ({ id, kids: emailKids.filter((k) => this.emailActive.get(k)!.signer === id) })), required: si.required, overlap_until_ms: si.overlap_until_ms ?? null }
          : null,
        hasSelfIssuedView: this.v3,
      },
      linkStats: this.linkStatsProblem ? null : this.linkStats && clone(this.linkStats),
      linkStatsProblem: this.linkStatsProblem,
      config,
      governance: clone(this.governance),
      owner: { account_id: this.config.owner, ...clone(this.owner) },
    };
  }

  async relayerFunds(account: string): Promise<RelayerFunds> {
    this.relayerReads++;
    if (this.failReads || this.failRelayer) throw new Error('rpc down');
    return relayerFundsFrom(account, SIGNER, this.relayer.view && { ...this.relayer.view }, JSON.parse(JSON.stringify(this.relayer.keys)) as AccessKeyEntry[]);
  }

  /** Sets one relayer key's remaining allowance (NEAR; null: unlimited). */
  setAllowance(publicKey: string, near: number | null): void {
    const k = this.relayer.keys.find((x) => x.public_key === publicKey);
    if (!k || typeof k.access_key.permission !== 'object') throw new Error('no such function-call key');
    k.access_key.permission.FunctionCall.allowance = near === null ? null : nearToYocto(near).toString();
  }

  /** Sets the relayer's balance (NEAR) on top of its storage (1000 bytes = 0.01 NEAR). */
  setBalance(near: number): void {
    if (!this.relayer.view) throw new Error('no relayer account');
    this.relayer.view.amount = (nearToYocto(near) + 1000n * 10n ** 19n).toString();
  }

  /** A v2 contract: no get_self_issued, no email issuer, no `unrecorded_wallets` (what sandbox-dev runs today). */
  asV2(): this {
    this.v3 = false;
    this.selfIssued = null;
    this.linkStats = null;
    return this;
  }

  /** The email issuer set up as batch 6 does: `set_issuer`, `mark_self_issued` (1-of-1 `hana`), and active keys. */
  emailIssuer(keys: Jwk[] = [], signer = 'hana'): this {
    this.emailIss = [EMAIL_ISS];
    this.selfIssued = { signers: [signer], required: 1 };
    for (const k of keys) this.emailActive.set(k.kid, { n: k.n, e: k.e, signer });
    return this;
  }

  /** Queues a key change as the updater (the signer account) or the owner would. */
  propose(op: 'Add' | 'Remove', kid: string, opts: { key?: Jwk; by?: string; provider?: string; at?: number; delay?: number; signer?: string } = {}): KeyChange {
    const at = opts.at ?? T0;
    const change: KeyChange = {
      id: this.nextId++,
      provider: opts.provider ?? 'google',
      kid,
      op,
      n: op === 'Add' ? (opts.key?.n ?? modulus(99)) : null,
      e: op === 'Add' ? (opts.key?.e ?? 'AQAB') : null,
      ...(opts.signer !== undefined ? { signer: opts.signer } : {}),
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
    if (c.provider === 'email') {
      if (c.op === 'Add') this.emailActive.set(c.kid, { n: c.n!, e: c.e!, signer: c.signer ?? null });
      else this.emailActive.delete(c.kid);
      return;
    }
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
    if (method === 'confirm_issuer_key_change' && c.changes.find((x) => x.id === args.id)?.provider === 'email' && c.selfIssued) {
      return { ok: false, txHash, error: "Smart contract panicked: Keys of a self-issued issuer can't be confirmed early" };
    }
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

/** Hana's published email JWKS: `keys`, or a failure while `fail`. */
export class StubEmailJwks {
  /** null: an honest issuer, publishing exactly the chain's active email keys. */
  keys: Jwk[] | null = null;
  fail = false;
  fetches = 0;
  constructor(private readonly chain: StubChain) {}
  fetch = async (): Promise<Jwk[]> => {
    this.fetches++;
    if (this.fail) throw new Error('email JWKS down');
    const keys = this.keys ?? [...this.chain.emailActive].map(([kid, k]) => ({ kid, kty: 'RSA', alg: 'RS256', use: 'sig', n: k.n, e: k.e }));
    return keys.map((k) => ({ ...k }));
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
  emailJwks: StubEmailJwks;
  /** One run at the current time; then the clock moves 5 min. */
  run(): Promise<RunReport>;
}

export interface WorldOpts {
  active?: Jwk[];
  jwks?: Jwk[];
  writer?: boolean;
  at?: number;
  /** The manifest's email pins (default: none, as on sandbox-dev today). */
  pins?: SignerPins | null;
}

export function world(opts: WorldOpts = {}): World {
  const chain = new StubChain(opts.active ?? []);
  const writer = new StubWriter(chain);
  const jwks = new StubJwks(opts.jwks ?? opts.active ?? []);
  const notifier = new RecordingNotifier();
  const store = new Store(env.DB);
  const clock = { t: opts.at ?? T0 };
  const sleeps: number[] = [];
  const emailJwks = new StubEmailJwks(chain);
  const deps: RunDeps = {
    store,
    chain,
    writer: opts.writer === false ? null : writer,
    fetchJwks: jwks.fetch,
    fetchEmailJwks: emailJwks.fetch,
    notifier,
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    config: {
      envName: 'sandbox-test',
      network: 'testnet',
      signer: SIGNER,
      watchdogAccount: WATCHDOG,
      digestHourUtc: 0,
      relayer: RELAYER,
      relayerThresholds: relayerThresholds(undefined),
      emailPins: { pins: opts.pins ?? null, problems: [] },
      devEnv: true,
    },
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
    emailJwks,
    async run() {
      const r = await runWatchdog(deps);
      clock.t += 5 * MIN;
      return r;
    },
  };
  return w;
}

/** A world past its first run: K1 active and published, initialized, digest already sent today. */
export async function initialized(opts: Omit<WorldOpts, 'at'> & { before?: (w: World) => void | Promise<void> } = {}): Promise<World> {
  const active = opts.active ?? [jwk('k1', 1)];
  const { before, ...rest } = opts;
  const w = world({ ...rest, active, jwks: opts.jwks ?? active });
  await before?.(w);
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
