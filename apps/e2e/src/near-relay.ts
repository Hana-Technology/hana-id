// Journear's NEAR relayer, mocked at the network layer for the hosted demo's guestbook and the stamps site (the stack
// runs no relay account, so its API answers `503 relayer_unconfigured` on /v1/near/*). One definition for the specs
// (tests/demo.spec.ts, tests/stamps.spec.ts, tests/demo-near-shots.spec.ts) and the hand-test browser
// (src/hand-test.ts, D880), so what a person tries by hand is what the tests run.
//
// POST /v1/near/activate creates the account on the mocked testnet (`e2e_near_activate`); POST /v1/near/relay decodes
// the signed delegate action, checks it is the site's own call, and delivers it: the demo's `add_message` to the
// guestbook (`e2e_guestbook_add`), the stamps site's `collect` to the stamps contract (`e2e_stamps_collect`, whose
// panic is the API's 422 `contract_rejected`). Both answer CORS for the site's origin, as the API does, and 409
// near_account_unrecorded (retryable, retry-after 2), as the API does, while the stack's real wallet directory doesn't
// hold the user's NEAR account yet (the vault records it just after login), and for the first `unrecorded` calls.
//
// A request that isn't the site's own (another key, another receiver or method, a deposit, too much gas) is answered
// 400 `e2e_relay_mismatch` and kept in `problems`: a spec asserts it stays empty; the hand browser prints it. A request
// from an origin that is none of the sites' falls through to the stack's API.
import type { BrowserContext, Page, Route } from '@playwright/test';
import { base64Decode, decodeNearSignedDelegateAction } from '@hana-id/core';
import { API_URL, DEMO_ORIGIN, DEMO_PK, E2E_GUESTBOOK, E2E_STAMPS, NEAR_RPC, STAMPS_ORIGIN, STAMPS_PK } from './stack.ts';

/** The routed URL pattern: the API's NEAR relay endpoints. */
export const NEAR_RELAY_ROUTE = `${API_URL}/v1/near/*`;
/** The relayer's transaction in the mocked answers (base58, as NEAR's hashes). */
export const RELAY_TX = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
/** The relay's gas cap (apps/api's NEAR relay: 10 Tgas per call). */
export const RELAY_MAX_GAS = 10_000_000_000_000n;

export type NearRelaySite = 'demo' | 'stamps';

interface SiteSpec {
  origin: string;
  pk: string;
  cors: Record<string, string>;
}

export const NEAR_RELAY_SITES: Readonly<Record<NearRelaySite, SiteSpec>> = Object.freeze({
  demo: {
    origin: DEMO_ORIGIN,
    pk: DEMO_PK,
    cors: { 'access-control-allow-origin': DEMO_ORIGIN, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type, x-hana-key', vary: 'Origin' },
  },
  stamps: {
    origin: STAMPS_ORIGIN,
    pk: STAMPS_PK,
    cors: { 'access-control-allow-origin': STAMPS_ORIGIN, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type, x-hana-key', 'access-control-expose-headers': 'retry-after', vary: 'Origin' },
  },
});

/** A request as the relay sees it (from a Playwright route, or built by a unit test). */
export interface NearRelayRequest {
  method: string;
  url: string;
  /** The `Origin` header, or null. */
  origin: string | null;
  /** The `x-hana-key` header, or null. */
  key: string | null;
  /** The JSON body (null for a preflight or an unreadable body). */
  body: unknown;
}

export interface NearRelayAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** What the relay reads from and writes to the stack (default: its wallet directory and mocked NEAR RPC). */
export interface NearRelayDeps {
  /** Whether the stack's wallet directory lists `account` as a NEAR wallet. */
  recorded(account: string): Promise<boolean>;
  /** A JSON-RPC call to the mocked chain; its `result`. */
  chain(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export const STACK_RELAY_DEPS: NearRelayDeps = {
  async recorded(account) {
    const res = await fetch(`${API_URL}/__e2e/wallets?address=${encodeURIComponent(account)}`);
    const users = (await res.json()) as { wallets: { chain: string; address: string }[] }[];
    return users.some((u) => u.wallets.some((w) => w.chain === 'near' && w.address === account));
  },
  async chain(method, params) {
    const res = await fetch(NEAR_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return ((await res.json()) as { result: Record<string, unknown> }).result;
  },
};

/** One thing the relay did, for a log (the hand browser prints these). */
export type NearRelayEvent =
  | { kind: 'refused'; site: NearRelaySite; path: string }
  | { kind: 'activated'; site: NearRelaySite; account: string }
  | { kind: 'relayed'; site: NearRelaySite; account: string; what: string; panic: string | null }
  | { kind: 'problem'; site: NearRelaySite | null; problem: string };

export interface NearRelayOptions {
  /** The first `unrecorded` calls are answered 409 near_account_unrecorded even once the account is recorded. */
  unrecorded?: number;
  /**
   * Called once a call passed the site's checks, before anything else: may wait (a spec holding a stage on screen) or
   * answer in the relay's place (a refusal).
   */
  intercept?: (kind: 'activate' | 'relay', site: NearRelaySite) => Promise<NearRelayAnswer | undefined>;
  onEvent?: (e: NearRelayEvent) => void;
  deps?: NearRelayDeps;
}

const json = (status: number, headers: Record<string, string>, body: unknown): NearRelayAnswer => ({ status, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });

export class NearRelay {
  /** The demo's guestbook texts delivered, in order. */
  readonly guestbook: string[] = [];
  /** The stamps site's `collect` arguments delivered, in order. */
  readonly stamps: Record<string, unknown>[] = [];
  /** The paths answered 409 near_account_unrecorded. */
  readonly refused: string[] = [];
  /** Requests that weren't the site's own call (a spec asserts this stays empty). */
  readonly problems: string[] = [];
  private unrecorded: number;
  private readonly deps: NearRelayDeps;

  constructor(
    readonly sites: readonly NearRelaySite[],
    private readonly o: NearRelayOptions = {},
  ) {
    this.unrecorded = o.unrecorded ?? 0;
    this.deps = o.deps ?? STACK_RELAY_DEPS;
  }

  private siteOf(origin: string | null): NearRelaySite | null {
    return this.sites.find((s) => NEAR_RELAY_SITES[s].origin === origin) ?? null;
  }

  private problem(site: NearRelaySite | null, cors: Record<string, string>, problem: string): NearRelayAnswer {
    this.problems.push(problem);
    this.o.onEvent?.({ kind: 'problem', site, problem });
    return json(400, cors, { error: problem, code: 'e2e_relay_mismatch' });
  }

  /** The answer to `r`, or null when it isn't from one of the sites (the stack's API answers it then). */
  async answer(r: NearRelayRequest): Promise<NearRelayAnswer | null> {
    const site = this.siteOf(r.origin);
    if (!site) return null;
    const { pk, cors } = NEAR_RELAY_SITES[site];
    const path = new URL(r.url).pathname;
    if (r.method === 'OPTIONS') return { status: 204, headers: cors, body: '' };
    if (r.method !== 'POST' || (path !== '/v1/near/activate' && path !== '/v1/near/relay')) return this.problem(site, cors, `${r.method} ${path}: not a relay call`);
    if (r.key !== pk) return this.problem(site, cors, `${path}: x-hana-key ${JSON.stringify(r.key)}, not the ${site} app's`);
    const body = (r.body ?? {}) as Record<string, unknown>;
    const activate = path === '/v1/near/activate';
    let sender: string;
    let delegate: ReturnType<typeof decodeNearSignedDelegateAction>['delegateAction'] | null = null;
    if (activate) {
      if (typeof body.accountId !== 'string') return this.problem(site, cors, 'activate without an accountId');
      sender = body.accountId;
    } else {
      if (typeof body.signedDelegateAction !== 'string') return this.problem(site, cors, 'relay without a signedDelegateAction');
      try {
        delegate = decodeNearSignedDelegateAction(base64Decode(body.signedDelegateAction)).delegateAction;
      } catch (e) {
        return this.problem(site, cors, `relay: the signed delegate action doesn't decode (${String(e)})`);
      }
      sender = delegate.senderId;
      const mismatch = site === 'demo' ? guestbookMismatch(delegate) : stampsMismatch(delegate);
      if (mismatch) return this.problem(site, cors, mismatch);
    }
    const early = await this.o.intercept?.(activate ? 'activate' : 'relay', site);
    if (early) return { ...early, headers: { ...cors, ...early.headers } };
    if (!(await this.deps.recorded(sender)) || this.unrecorded > 0) {
      this.unrecorded -= 1;
      this.refused.push(path);
      this.o.onEvent?.({ kind: 'refused', site, path });
      return json(409, { ...cors, 'retry-after': '2' }, { error: 'not recorded yet', code: 'near_account_unrecorded', retryable: true });
    }
    if (activate) {
      const answer = await this.deps.chain('e2e_near_activate', { account_id: sender });
      this.o.onEvent?.({ kind: 'activated', site, account: sender });
      return json(200, cors, answer);
    }
    const d = delegate!;
    const call = d.actions[0] as { args: Uint8Array };
    const args = new TextDecoder().decode(call.args);
    if (site === 'demo') {
      const { text } = JSON.parse(args) as { text: string };
      this.guestbook.push(text);
      await this.deps.chain('e2e_guestbook_add', { account_id: d.senderId, text, nonce: String(d.nonce) });
      this.o.onEvent?.({ kind: 'relayed', site, account: d.senderId, what: `guestbook: ${text}`, panic: null });
      return json(200, cors, { transactionHash: RELAY_TX, status: 'executed' });
    }
    const parsed = JSON.parse(args) as Record<string, unknown>;
    this.stamps.push(parsed);
    const { panic } = (await this.deps.chain('e2e_stamps_collect', { account_id: d.senderId, args, sponsored: true, nonce: String(d.nonce) })) as { panic: string | null };
    this.o.onEvent?.({ kind: 'relayed', site, account: d.senderId, what: `stamp: ${String(parsed.stamp)}`, panic });
    // The API's answers as apps/api/src/near/relay.ts relayAnswerBody writes them (the panic text as NEAR's
    // ExecutionError gives it, the failed receipt's executor, the relay's transaction).
    const tx = { transactionHash: RELAY_TX, nearTx: RELAY_TX };
    if (panic) return json(422, cors, { error: `Smart contract panicked: ${panic}`, code: 'contract_rejected', status: 'failed', executor: E2E_STAMPS, ...tx });
    return json(200, cors, { status: 'executed', ...tx });
  }

  /** A Playwright route handler for NEAR_RELAY_ROUTE. */
  readonly handle = async (route: Route): Promise<void> => {
    const req = route.request();
    let body: unknown = null;
    try {
      body = req.method() === 'POST' ? req.postDataJSON() : null;
    } catch {
      body = null;
    }
    const headers = req.headers();
    const answer = await this.answer({ method: req.method(), url: req.url(), origin: headers['origin'] ?? null, key: headers['x-hana-key'] ?? null, body });
    if (!answer) return route.fallback();
    return route.fulfill(answer);
  };
}

/** The demo's one call: `add_message` on the guestbook. */
function guestbookMismatch(d: ReturnType<typeof decodeNearSignedDelegateAction>['delegateAction']): string | null {
  const call = d.actions[0] as { type: string; methodName?: string } | undefined;
  if (d.receiverId !== E2E_GUESTBOOK || call?.type !== 'functionCall' || call.methodName !== 'add_message') {
    return `relay: ${d.receiverId} ${call?.type ?? 'no action'} ${call?.methodName ?? ''}, not ${E2E_GUESTBOOK} add_message`;
  }
  return null;
}

/** The stamps site's one call: one `collect` on the stamps contract, no deposit, at most the relay's gas. */
function stampsMismatch(d: ReturnType<typeof decodeNearSignedDelegateAction>['delegateAction']): string | null {
  if (d.actions.length !== 1) return `relay: ${d.actions.length} actions, not one`;
  const call = d.actions[0] as { type: string; methodName?: string; gas?: bigint; deposit?: bigint };
  if (d.receiverId !== E2E_STAMPS || call.type !== 'functionCall' || call.methodName !== 'collect' || call.deposit !== 0n) {
    return `relay: ${d.receiverId} ${call.type} ${call.methodName ?? ''} deposit ${String(call.deposit)}, not ${E2E_STAMPS} collect with no deposit`;
  }
  if ((call.gas ?? 0n) > RELAY_MAX_GAS) return `relay: ${String(call.gas)} gas, over the relay's ${String(RELAY_MAX_GAS)}`;
  return null;
}

/** Routes NEAR_RELAY_ROUTE in `target` (a page, or a whole context: the hand browser) to a relay for `sites`. */
export async function routeNearRelayer(target: Pick<Page | BrowserContext, 'route'>, sites: readonly NearRelaySite[], o: NearRelayOptions = {}): Promise<NearRelay> {
  const relay = new NearRelay(sites, o);
  await target.route(NEAR_RELAY_ROUTE, relay.handle);
  return relay;
}
