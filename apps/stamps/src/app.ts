// The stamps site (D798–D802): a partner page on @hana-id/web, NEAR only. It holds the session (signed out, signing
// in, signed in by email or Google through Journear Passport's window), the route (`/` or `/p/<account_id>`), what it
// read from NEAR testnet (the passport, the recent stamps, the totals, the user's balance) and the collect in progress,
// and renders all of it as one PassportView (src/view.ts) through the UI module (src/ui). The client, the UI and
// every clock and fetch are injected (startStamps), so the tests drive the page against fakes.
//
// The page holds nothing secret: it sees the user's NEAR account id and the signatures they approve.
import type { HanaClient, HanaConfig } from '@hana-id/web';
import type { NearRpc } from '../../demo/src/near.ts';
import { type CollectOutcome, type Collector, STAGES, createCollector, newRpc } from './collector.ts';
import type { StampsConfig } from './config.ts';
import { type StampsAction, errorInfo, isSignedOut, plainMessage } from './messages.ts';
import { type Route, explorerTxUrl, isViewableAccount, parseRoute } from './routes.ts';
import { type ChainStamp, type Passport, RECENT_PAGE, type RecentStamp, STAMP_IDS, type StampId, checkNote, parsePassport, parseRecent, parseTotals } from './stamps.ts';
import type { PassportHandlers, PassportView, StampId as UiStampId } from './ui/index.ts';
import { type ViewInput, buildView, heldStamps, layoverCounting } from './view.ts';

/** The part of the partner client the site uses. */
export type StampsClient = Pick<HanaClient, 'ready' | 'status' | 'addresses' | 'vaultOrigin' | 'login' | 'logout' | 'on' | 'near' | 'prepareApproval'>;

export type Mount = (root: HTMLElement, handlers: PassportHandlers) => { update(view: PassportView): void; destroy(): void };

export interface StampsDeps {
  config: StampsConfig;
  createClient(config: HanaConfig): StampsClient;
  mount: Mount;
  root: HTMLElement;
  /** The page's location and history (window's by default). */
  location?: { pathname: string; origin: string };
  history?: { pushState(data: unknown, unused: string, url: string): void };
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: (n: number) => Uint8Array;
  copy?: (text: string) => Promise<void>;
  /** setInterval/clearInterval (window's by default). */
  every?: (fn: () => void, ms: number) => () => void;
  /** Whether the tab is visible (polling pauses while it isn't). */
  visible?: () => boolean;
}

/** How often the passport, the recent stamps and the totals are read while the tab is visible. */
export const POLL_MS = 15_000;
/** How often the user's key, block and balance are read again while signed in (D751's 30 s). */
export const PREP_REFRESH_MS = 30_000;
/** How long a sent, unconfirmed stamp (D788) is shown as confirming before the passport alone decides. */
export const SENT_FOR_MS = 3 * 60_000;
/** After a collect, the passport is read again until it shows the stamp, at most this many times. */
const CONFIRM_TRIES = 4;
const CONFIRM_GAP_MS = 1500;

const STAMP_TITLES: Record<StampId, string> = { arrival: 'Arrival', sponsored: 'Sponsored', own_fare: 'Own fare', signature: 'Signature', postcard: 'Postcard', layover: 'Layover' };

export interface StampsApp {
  client: StampsClient | null;
  /** The view last rendered (tests). */
  view(): PassportView;
  /** Re-reads everything now. */
  reload(): Promise<void>;
}

export function startStamps(deps: StampsDeps): StampsApp {
  const { config } = deps;
  const clock = deps.clock ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const copy = deps.copy ?? ((text: string) => navigator.clipboard.writeText(text));
  const loc = deps.location ?? window.location;
  const hist = deps.history ?? window.history;
  const every =
    deps.every ??
    ((fn: () => void, ms: number) => {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    });
  const visible = deps.visible ?? (() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const rpc: NearRpc = newRpc(config, deps.fetch ?? ((url, init) => fetch(url, init)));

  /** The page's route; an unknown path (only the dev server serves one) shows the home page and says so. */
  const routeOf = (path: string): Route => {
    const r = parseRoute(path);
    return r.kind === 'not_found' ? { kind: 'mine' } : r;
  };
  let route: Route = routeOf(loc.pathname);
  let client: StampsClient | null = null;
  let collector: Collector | null = null;

  // ---- state ----

  /** The passports read, by account (undefined: not read yet; null: none on chain). */
  const passports = new Map<string, Passport | null>();
  let recent: RecentStamp[] = [];
  let totals: { passports: number; stamps: number } | null = null;
  /** The signed-in account this page shows (set once the session has a NEAR account). */
  let me: string | null = null;
  const local = new Map<StampId, ChainStamp>();
  const txs = new Map<StampId, string>();
  const sent = new Map<StampId, { txHash: string; at: number }>();
  const failed = new Map<StampId, string>();
  let fresh = new Set<StampId>();
  let working: { id: StampId; stage: string } | null = null;
  let notice: PassportView['notice'] | null = null;
  let launcherNotice: string | null = null;
  let lastView: PassportView = { mode: 'cover', stamps: [], recent: [] };
  if (parseRoute(loc.pathname).kind === 'not_found') notice = { kind: 'error', text: 'There is no passport at this address. Here is your own.' };

  const ui = deps.mount(deps.root, {
    signIn,
    signOut,
    collect: (id: UiStampId, input?: { note?: string }) => collect(id, input),
    copyAccount,
    refresh: () => {
      notice = null;
      void reload(true);
    },
  });

  // ---- rendering ----

  function mode(): ViewInput['mode'] {
    if (route.kind === 'public') return 'public';
    return me !== null ? 'mine' : 'cover';
  }

  function signingIn(): boolean {
    const s = client?.status;
    return s === 'unlocking' || s === 'logging_in';
  }

  function viewInput(): ViewInput {
    const m = mode();
    const accountId = m === 'public' && route.kind === 'public' ? route.accountId : m === 'mine' ? me : null;
    const prep = m === 'mine' && me !== null ? collector?.latest(me) ?? null : null;
    const now = clock();
    for (const [id, s] of sent) if (now - s.at > SENT_FOR_MS) sent.delete(id);
    return {
      mode: m,
      accountId,
      passport: accountId === null ? undefined : passports.get(accountId),
      local: m === 'mine' ? local : new Map(),
      txs: m === 'mine' ? txs : new Map(),
      sent: m === 'mine' ? new Map([...sent].map(([id, s]) => [id, s.txHash])) : new Map(),
      working: m === 'mine' ? working : null,
      failed: m === 'mine' ? failed : new Map(),
      fresh: m === 'mine' ? fresh : new Set(),
      balance: prep ? { yocto: prep.balance, activated: prep.key !== null } : null,
      recent,
      totals,
      notice,
      busy: working !== null || signingIn(),
      explorer: config.near.explorer,
      faucet: config.near.faucet,
      origin: loc.origin,
    };
  }

  let countdown: (() => void) | null = null;

  function render(): void {
    const input = viewInput();
    lastView = buildView(input, clock());
    ui.update(lastView);
    // `fresh` is for one update only: the UI inks the stamp once.
    if (fresh.size > 0) fresh = new Set();
    // A running layover countdown re-renders every second; none runs otherwise.
    const counting = layoverCounting(input, clock());
    if (counting && countdown === null) countdown = every(render, 1000);
    else if (!counting && countdown !== null) {
      countdown();
      countdown = null;
    }
  }

  function showError(action: StampsAction, e: unknown): void {
    if (isSignedOut(e)) {
      notice = { kind: 'info', text: plainMessage(e, action) };
      return;
    }
    notice = { kind: 'error', text: plainMessage(e, action) };
  }

  // ---- reads ----

  async function readPassport(accountId: string): Promise<Passport | null> {
    const p = parsePassport(await rpc.view(config.near.stamps, 'get_passport', { account_id: accountId }), accountId);
    passports.set(accountId, p);
    // What the chain now holds needs no optimistic copy.
    if (accountId === me) for (const s of p?.stamps ?? []) local.delete(s.stamp), sent.delete(s.stamp);
    return p;
  }

  async function readRecent(): Promise<void> {
    const [a, b, t] = await Promise.all([
      rpc.view(config.near.stamps, 'recent', { from_index: 0, limit: RECENT_PAGE }),
      rpc.view(config.near.stamps, 'recent', { from_index: RECENT_PAGE, limit: RECENT_PAGE }).catch(() => []),
      rpc.view(config.near.stamps, 'totals', {}).catch(() => null),
    ]);
    // Accounts a public passport can't show (and an `0x…` NEAR account that would read as another chain's) are left out.
    recent = parseRecent(a, b).filter((r) => isViewableAccount(r.accountId));
    const parsed = parseTotals(t);
    if (parsed) totals = parsed;
  }

  let reloading: Promise<void> | null = null;
  /** A reload asked for while one ran (the session or the route changed meanwhile): run once more after it. */
  let again: { loud: boolean } | null = null;

  /** Reads the shown passport, the recent stamps, the totals and (signed in) the balance. */
  function reload(loud = false): Promise<void> {
    if (reloading) {
      again = { loud: loud || (again?.loud ?? false) };
      return reloading;
    }
    const accountId = route.kind === 'public' ? route.accountId : me;
    const tasks: Promise<unknown>[] = [readRecent()];
    if (accountId !== null) tasks.push(readPassport(accountId));
    if (route.kind === 'mine' && me !== null && collector) tasks.push(collector.refresh(me));
    reloading = Promise.allSettled(tasks)
      .then((results) => {
        const bad = results.find((r) => r.status === 'rejected');
        // A failed read keeps what was shown; it is said when nothing was (or the user asked).
        if (bad && (loud || (accountId !== null && !passports.has(accountId)))) showError('read', (bad as PromiseRejectedResult).reason);
      })
      .finally(() => {
        reloading = null;
        render();
        if (again) {
          const next = again;
          again = null;
          void reload(next.loud);
        }
      });
    return reloading;
  }

  /** After a collect: read the passport until it shows the stamp (the RPC may answer from a block before it). */
  async function confirm(accountId: string, id: StampId): Promise<void> {
    for (let i = 0; i < CONFIRM_TRIES; i++) {
      try {
        const p = await readPassport(accountId);
        if (p?.stamps.some((s) => s.stamp === id)) break;
      } catch {
        // the next try, or the poll
      }
      await sleep(CONFIRM_GAP_MS);
    }
    await reload();
  }

  // ---- session ----

  function syncSession(): void {
    const c = client;
    const near = c && c.status === 'logged_in' ? c.addresses?.near ?? null : null;
    if (near === me) return;
    me = near;
    working = null;
    local.clear();
    txs.clear();
    sent.clear();
    failed.clear();
    fresh = new Set();
    collector?.reset();
    if (me !== null) {
      if (route.kind === 'mine') void reload();
      collector?.refresh(me).then(render, () => {});
    }
  }

  function signIn(): void {
    const c = client;
    if (!c || signingIn()) return;
    notice = null;
    // Synchronous up to login(): the click's activation opens Journear Passport's window, which offers email and Google.
    const p = c.login();
    render();
    p.then(
      () => {
        notice = null;
        syncSession();
        if (route.kind === 'public') navigate('/');
        else render();
      },
      (e: unknown) => {
        showError('login', e);
        render();
      },
    );
  }

  function signOut(): void {
    const c = client;
    if (!c || working !== null) return;
    notice = null;
    c.logout().then(
      () => {
        notice = { kind: 'info', text: 'Signed out. Your passport stays on NEAR testnet.' };
        syncSession();
        render();
      },
      (e: unknown) => {
        showError('logout', e);
        render();
      },
    );
  }

  function copyAccount(): void {
    const id = route.kind === 'public' ? route.accountId : me;
    if (id === null) return;
    copy(id).then(
      () => {
        notice = { kind: 'info', text: 'Account id copied.' };
        render();
      },
      (e: unknown) => {
        showError('copy', e);
        render();
      },
    );
  }

  function navigate(path: string): void {
    hist.pushState(null, '', path);
    route = routeOf(path);
    render();
    void reload();
  }

  // ---- collecting ----

  function collect(id: StampId, input?: { note?: string }): void {
    const accountId = me;
    const col = collector;
    if (accountId === null || col === null || working !== null || route.kind !== 'mine' || !STAMP_IDS.includes(id)) return;
    if (heldStamps(passports.get(accountId), local).has(id)) return;
    if (id === 'postcard') {
      const check = checkNote(input?.note ?? '');
      if (!check.ok) {
        failed.set(id, check.reason === 'too_long' ? `That note is ${check.chars} characters: a postcard takes at most 140.` : check.reason === 'empty' ? 'Write a note first (1 to 140 characters).' : 'That note has a broken character. Retype it.');
        render();
        return;
      }
    }
    failed.delete(id);
    notice = null;
    working = { id, stage: STAGES.approving };
    const stage = (text: string): void => {
      if (working?.id !== id) return;
      working = { id, stage: text };
      render();
    };
    // Synchronous up to the first signing call (or prepareApproval): the click opens the Journear Passport window.
    let run: Promise<CollectOutcome>;
    try {
      run = col.collect({ accountId, stamp: id, ...(input?.note !== undefined ? { note: input.note } : {}) }, stage);
    } catch (e) {
      run = Promise.reject(e);
    }
    render();
    run.then(
      (r) => {
        if (me !== accountId) return;
        working = null;
        txs.set(id, r.txHash);
        const txUrl = explorerTxUrl(config.near.explorer, r.txHash);
        if (r.status === 'sent') {
          // D788: sent, not confirmed: it may still land. The passport poll decides.
          sent.set(id, { txHash: r.txHash, at: clock() });
          notice = { kind: 'info', text: `${STAMP_TITLES[id]}: sent, still confirming on NEAR testnet.`, ...(txUrl ? { href: txUrl, hrefLabel: 'View the transaction' } : {}) };
        } else {
          local.set(id, { stamp: id, atMs: clock(), sponsored: id !== 'own_fare', ...(r.note !== undefined ? { note: r.note } : {}) });
          fresh.add(id);
          const how = id === 'own_fare' ? 'Your NEAR paid the fee.' : 'You paid no gas.';
          notice = { kind: 'info', text: `${STAMP_TITLES[id]} stamped on NEAR testnet.${r.created ? ' Your NEAR account was created for it.' : ''} ${how}`, ...(txUrl ? { href: txUrl, hrefLabel: 'View the transaction' } : {}) };
        }
        render();
        void confirm(accountId, id);
      },
      (e: unknown) => {
        if (me !== accountId) return;
        working = null;
        if (isSignedOut(e)) showError('collect', e);
        else failed.set(id, plainMessage(e, 'collect'));
        // A refused stamp the contract already holds (another tab): the passport says so.
        if (errorInfo(e).message.includes('ERR_ALREADY')) void readPassport(accountId).then(render, () => {});
        render();
      },
    );
  }

  /** Background preparation on interest (pointer or focus on a collect button or the note box), D751. */
  function interested(e: Event): void {
    const t = e.target;
    if (me === null || collector === null || route.kind !== 'mine' || !(t instanceof Element)) return;
    if (t.closest('[data-action="collect"], [data-field="note"]')) collector.prepare(me, true);
  }

  // ---- start ----

  render();
  try {
    client = deps.createClient({ publishableKey: config.publishableKey, environment: config.environment });
  } catch (e) {
    showError('load', e);
    render();
    void reload();
    return { client: null, view: () => lastView, reload: () => reload(true) };
  }
  const c = client;
  collector = createCollector({ config, client: c, rpc, clock, sleep, random });
  if (c.vaultOrigin !== config.vaultOrigin) {
    // The page's CSP frame-src is the configured vault: another one would be blocked.
    notice = { kind: 'error', text: 'This build doesn’t match its Journear Passport environment. Tell the Journear team.' };
  }
  c.on('statusChanged', () => {
    syncSession();
    render();
  });
  c.on('accountsChanged', () => {
    syncSession();
    render();
  });
  c.on('launcher', ({ visible: shown, label, clickable }) => {
    if (shown && clickable) {
      launcherNotice = `Click “${label}” on the Journear Passport button at the bottom right of the page to continue.`;
      notice = { kind: 'info', text: launcherNotice };
    } else if (launcherNotice !== null && notice?.text === launcherNotice) {
      notice = null;
      launcherNotice = null;
    }
    render();
  });
  c.on('sessionExpired', () => {
    notice = { kind: 'info', text: 'Your session ended. Sign in again to collect more stamps.' };
    syncSession();
    render();
  });
  c.on('disconnect', ({ code, reason }) => {
    showError('load', reason === undefined ? { code } : { code, data: { reason } });
    syncSession();
    render();
  });
  c.ready.then(
    () => {
      syncSession();
      render();
    },
    (e: unknown) => {
      showError('load', e);
      render();
    },
  );

  render();
  deps.root.addEventListener('focusin', interested);
  deps.root.addEventListener('pointerover', interested);
  if (typeof window !== 'undefined') {
    window.addEventListener('popstate', () => {
      route = routeOf(loc.pathname);
      render();
      void reload();
    });
  }
  if (typeof document !== 'undefined') {
    // Back from the faucet's tab: the balance (and Own fare) at once.
    document.addEventListener('visibilitychange', () => {
      if (visible()) void reload();
    });
  }
  every(() => {
    if (visible()) void reload();
  }, POLL_MS);
  every(() => {
    if (visible() && me !== null && route.kind === 'mine') collector?.prepare(me, false);
  }, PREP_REFRESH_MS);
  void reload();
  return { client: c, view: () => lastView, reload: () => reload(true) };
}
