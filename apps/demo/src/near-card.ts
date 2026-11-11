// The NEAR card: the user's implicit account, a gasless write to the demo guestbook (activate, sign a NEP-366 delegate
// action, relay), the guestbook's latest messages, and NEP-413 and transaction signing. Written the way
// docs/integration.md section 8 tells partners to do it.
//
// The popup rule (section 8, "Call the SDK directly in your click handler"): a signing call opens Hana's approval
// window only while the click's user activation lasts, so the click must reach `signDelegateAction` before any await.
// Everything the request needs from NEAR (the account's existence, the key's nonce, the latest final block) is
// therefore read before the click: when the card appears, again when the user focuses or types in the message box
// (which also activates a new account), and every REFRESH_MS while they're interested. A click with a fresh read
// (PREP_MAX_AGE_MS) builds the bytes and signs synchronously. Without one (the first seconds, a slow RPC, an expired
// read), the click calls `hana.prepareApproval()` first, which opens the window inside the click, then reads, then
// signs into that window; if reading fails, the ticket is cancelled.
import type { ApprovalTicket, NearActivateResult } from '@hana-id/web';
import type { DemoConfig } from './config.ts';
import { type DemoAction, errorInfo } from './errors.ts';
import {
  type AccessKeyState,
  type FetchLike,
  GUESTBOOK_LIST_LIMIT,
  GUESTBOOK_MAX_CHARS,
  NearRpc,
  TX_FEE_RESERVE,
  addMessageDelegate,
  addMessageTransaction,
  checkGuestbookText,
  delegateNonce,
  displayText,
  formatNear,
  nearPageError,
  parseMessages,
  scalarCount,
  shortAccount,
  transactionNonce,
  trimLikeRust,
} from './near.ts';
import type { DemoClient } from './page.ts';
import { shorten } from './requests.ts';

/** How old a read of the key and block may be for a click to sign at once. */
export const PREP_MAX_AGE_MS = 60_000;
/** How often the reads are renewed while the user is interested (focused or typed within INTEREST_MS). */
export const REFRESH_MS = 30_000;
const INTEREST_MS = 5 * 60_000;
const BACKGROUND_GAP_MS = 5_000;
/** How long activate and relay are retried while the account isn't in Hana's wallet directory yet. */
export const UNRECORDED_WAIT_MS = 20_000;
/**
 * The API's answers (HTTP 409) while the vault hasn't recorded the user's NEAR account in the wallet directory yet: the
 * coordinator's `near_account_unrecorded`, and `near_account_unknown`, which the relayer build's docs mark retryable.
 */
const UNRECORDED_REASONS: ReadonlySet<string> = new Set(['near_account_unrecorded', 'near_account_unknown']);
/** How long the card waits for a new account to show its key after activation (1 s per try). */
const ACTIVATION_TRIES = 10;

/** NEP-413's demo message: harmless to sign, proves the account only to whoever checks the nonce. */
export const NEAR_TEST_MESSAGE = 'Hana ID testnet demo: sign in with NEAR (NEP-413). This signature moves nothing.';
/** The text "Sign a transaction" uses when the message box holds no valid message. */
export const DEFAULT_TX_TEXT = 'Hello from Hana ID (a signed NEAR transaction)';

export const STAGES = {
  reading: 'Reading your NEAR account on testnet…',
  activating: 'Preparing your NEAR account…',
  approving: 'Waiting for your approval in the Hana window…',
  relaying: 'Sending it through Hana’s relayer, which pays the fee…',
} as const;

export interface NearCardDeps {
  config: DemoConfig;
  client: Pick<DemoClient, 'near' | 'prepareApproval'>;
  fetch: FetchLike;
  /** Wall-clock ms. */
  clock: () => number;
  copy: (text: string) => Promise<void>;
  random: (n: number) => Uint8Array;
  /** NEP-413's recipient: this page's host. */
  recipient: string;
  sleep: (ms: number) => Promise<void>;
  /** The page's one-request-at-a-time runner (synchronous up to the task's first await); errors go to `box`. */
  run: (action: DemoAction, task: () => Promise<void>, box?: string) => void;
  notice: (text: string | null) => void;
  showError: (action: DemoAction, e: unknown, box?: string) => void;
  plainMessage: (e: unknown, action: DemoAction) => string;
}

export interface NearCard {
  /** Shows or hides the card for the session's NEAR account; `pending`: a request is running. */
  render(loggedIn: boolean, pending: boolean): void;
}

/** What the card read from NEAR for one account. */
interface Prep {
  accountId: string;
  /** null: the account (or its key) isn't on testnet yet. */
  key: AccessKeyState | null;
  height: bigint;
  hash: string;
  balance: bigint;
  at: number;
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

function h(tag: string, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}


export function startNearCard(deps: NearCardDeps): NearCard {
  const { config, client: c, clock } = deps;
  const guestbook = config.near.guestbook;
  const explorer = config.near.explorer;
  const rpc = new NearRpc([config.near.rpcUrl, ...(config.near.rpcFallbackUrl ? [config.near.rpcFallbackUrl] : [])], deps.fetch);

  let shownFor: string | null = null;
  let prep: Prep | null = null;
  let reading: { accountId: string; promise: Promise<Prep> } | null = null;
  /** Accounts known to exist on testnet this session (a key was read, or activate answered). */
  const activated = new Set<string>();
  const activating = new Map<string, Promise<NearActivateResult>>();
  /** Accounts this page's activation created, until their first write says so. */
  const justCreated = new Set<string>();
  /** The highest nonce this page signed per account, so a second write before the next read still goes up. */
  const lastNonce = new Map<string, bigint>();
  let interestAt = -Infinity;
  let listToken = 0;

  const input = el<HTMLInputElement>('near-text');

  // ---- reads ----

  async function read(accountId: string): Promise<Prep> {
    const publicKey = c.near.publicKey;
    if (publicKey === null) throw nearPageError('near_page_rpc_failed', 'No NEAR key');
    const [key, block, balance] = await Promise.all([rpc.accessKey(accountId, publicKey), rpc.finalBlock(), rpc.balance(accountId)]);
    const p: Prep = { accountId, key, height: block.height, hash: block.hash, balance, at: clock() };
    if (key) activated.add(accountId);
    if (c.near.accountId === accountId) {
      prep = p;
      renderBalance();
    }
    return p;
  }

  /** One read at a time per account. */
  function refresh(accountId: string): Promise<Prep> {
    if (reading?.accountId === accountId) return reading.promise;
    const promise = read(accountId).finally(() => {
      if (reading?.promise === promise) reading = null;
    });
    reading = { accountId, promise };
    return promise;
  }

  const fresh = (accountId: string): Prep | null => (prep !== null && prep.accountId === accountId && clock() - prep.at < PREP_MAX_AGE_MS ? prep : null);

  /**
   * Retries `call` while Hana's API answers `near_account_unrecorded` (HTTP 409: the vault records the user's NEAR
   * account in Hana's wallet directory in the background after login, within about 15 s), for UNRECORDED_WAIT_MS
   * with a growing pause; then the last refusal stands. Safe for relay too: a refused relay sent nothing.
   */
  async function whileUnrecorded<T>(call: () => Promise<T>): Promise<T> {
    let waited = 0;
    for (let pause = 500; ; pause = Math.min(pause * 2, 4000)) {
      try {
        return await call();
      } catch (e) {
        const reason = errorInfo(e).reason;
        if (reason === null || !UNRECORDED_REASONS.has(reason) || waited + pause > UNRECORDED_WAIT_MS) throw e;
        waited += pause;
        await deps.sleep(pause);
      }
    }
  }

  /** hana.near.activate once per account and session (a failure is forgotten, so the next try asks again). */
  function activateOnce(): Promise<NearActivateResult> {
    const accountId = c.near.accountId!;
    let p = activating.get(accountId);
    if (!p) {
      p = whileUnrecorded(() => c.near.activate()).then(
        (r) => {
          activated.add(accountId);
          if (r.created) justCreated.add(accountId);
          return r;
        },
        (e: unknown) => {
          activating.delete(accountId);
          throw e;
        },
      );
      activating.set(accountId, p);
    }
    return p;
  }

  /**
   * A read showing the account's key: activates a new account first. The relayer's answer carries the key's nonce and
   * the height it read them at, which serve as the read (the RPC may lag a block behind the new account); without
   * them, the card reads the RPC until the key shows.
   */
  async function ensureReady(accountId: string, stage: (text: string) => void): Promise<{ prep: Prep }> {
    let p = fresh(accountId) ?? (await refresh(accountId));
    if (p.key) return { prep: p };
    stage(STAGES.activating);
    const a = await activateOnce();
    if (typeof a.accessKeyNonce === 'string' && a.blockHeight !== undefined) {
      const height = BigInt(a.blockHeight);
      p = { ...p, key: { nonce: BigInt(a.accessKeyNonce), blockHeight: height, blockHash: p.hash }, height: height > p.height ? height : p.height, at: clock() };
      if (c.near.accountId === accountId) {
        prep = p;
        renderBalance();
      }
      return { prep: p };
    }
    for (let i = 0; i < ACTIVATION_TRIES && !p.key; i++) {
      if (i > 0 || !a.created) await deps.sleep(1000);
      p = await refresh(accountId);
    }
    if (!p.key) throw nearPageError('near_account_pending', 'The account has no key on testnet yet');
    return { prep: p };
  }

  /**
   * Background preparation (focus, typing, the timer): failures are left for the click to report. At most one start
   * per BACKGROUND_GAP_MS, so typing into a failing state doesn't call the RPC or the relayer on every key.
   */
  let backgroundAt = -Infinity;
  function prepareInBackground(activate: boolean): void {
    const accountId = c.near.accountId;
    if (accountId === null || shownFor !== accountId || clock() - backgroundAt < BACKGROUND_GAP_MS) return;
    backgroundAt = clock();
    const task = activate && guestbook !== null ? ensureReady(accountId, () => {}) : refresh(accountId);
    task.catch(() => {});
  }

  // ---- rendering ----

  function stage(text: string | null): void {
    const s = el('near-stage');
    s.textContent = text ?? '';
    s.hidden = text === null;
  }

  function done(text: string | null, txHash?: string): void {
    el('near-done').hidden = text === null;
    el('near-done-text').textContent = text ?? '';
    const link = el<HTMLAnchorElement>('near-tx-link');
    link.hidden = !txHash || explorer === null;
    if (txHash && explorer) link.href = `${explorer}/txns/${encodeURIComponent(txHash)}`;
  }

  function hint(text: string | null): void {
    el('near-hint').textContent = text ?? '';
    el('near-hint').hidden = text === null;
  }

  function clearCardError(): void {
    el('near-error').hidden = true;
    el('near-error').textContent = '';
  }

  function renderCount(): void {
    const n = scalarCount(trimLikeRust(input.value));
    const count = el('near-count');
    count.textContent = `${n} / ${GUESTBOOK_MAX_CHARS}`;
    count.classList.toggle('over', n > GUESTBOOK_MAX_CHARS);
  }

  function renderBalance(): void {
    const b = el('near-balance');
    const p = prep;
    if (!p || p.accountId !== c.near.accountId) {
      b.hidden = true;
      return;
    }
    b.hidden = false;
    b.textContent = p.key
      ? `Balance: ${formatNear(p.balance)} NEAR${p.balance < TX_FEE_RESERVE ? '. The guestbook write needs none.' : '.'}`
      : 'Not on NEAR testnet yet: your first guestbook write creates it (Hana’s relayer sends it a zero-value transfer), for free.';
  }

  function result(label: string, value: string | null, note: string | null, ok: boolean, txHash?: string): void {
    const item = h('li', {}, h('div', {}, h('span', { class: ok ? 'ok' : 'fail' }, ok ? '✓ ' : '✗ '), label));
    if (value) item.append(h('code', {}, value));
    if (note) item.append(h('div', { class: 'muted small' }, note));
    if (txHash && explorer) item.append(h('div', { class: 'small' }, h('a', { href: `${explorer}/txns/${encodeURIComponent(txHash)}`, target: '_blank', rel: 'noopener noreferrer' }, 'View the transaction ↗')));
    el('near-results').prepend(item);
  }

  function renderMessages(list: ReturnType<typeof parseMessages>): void {
    const me = c.near.accountId;
    el('near-messages').replaceChildren(
      ...list.map((m) => {
        const mine = m.accountId === me;
        const meta = h('div', { class: 'meta' }, h('span', { class: 'author', title: m.accountId }, shortAccount(m.accountId)));
        if (mine) meta.append(h('span', { class: 'you' }, 'you'));
        meta.append(h('time', { datetime: new Date(m.timestampMs).toISOString() }, new Date(m.timestampMs).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })));
        return h('li', mine ? { class: 'mine' } : {}, meta, h('p', { class: 'text', dir: 'auto' }, displayText(m.text)));
      }),
    );
    el('near-book-status').textContent = list.length === 0 ? 'No messages yet. Be the first.' : '';
  }

  /** Reads the latest messages; with `expect`, retries a few times until that message shows (a fresh write). */
  async function loadList(expect?: { accountId: string; text: string }): Promise<void> {
    if (guestbook === null) return;
    const token = ++listToken;
    el('near-book-status').textContent = 'Reading the guestbook…';
    for (let attempt = 0; ; attempt++) {
      try {
        const list = parseMessages(await rpc.view(guestbook, 'get_messages', { limit: GUESTBOOK_LIST_LIMIT }));
        if (token !== listToken) return;
        const found = !expect || list.some((m) => m.accountId === expect.accountId && m.text === expect.text);
        if (found || attempt >= 3) {
          renderMessages(list);
          return;
        }
      } catch (e) {
        if (token !== listToken) return;
        if (!expect || attempt >= 3) {
          el('near-book-status').textContent = `Couldn’t read the guestbook. ${deps.plainMessage(e, 'near')}`;
          return;
        }
      }
      await deps.sleep(1500);
    }
  }

  // ---- actions ----

  /** The gasless write. Synchronous up to signDelegateAction when the reads are fresh; else prepareApproval first. */
  function write(): void {
    const accountId = c.near.accountId;
    if (accountId === null || guestbook === null) return;
    const check = checkGuestbookText(input.value);
    if (!check.ok) {
      hint(check.reason === 'empty' ? 'Write a message first (1 to 200 characters).' : check.reason === 'too_long' ? `That is ${check.chars} characters: the guestbook takes at most 200.` : 'That text has a broken character the guestbook can’t store. Retype it.');
      input.focus();
      return;
    }
    hint(null);
    deps.run(
      'near',
      async () => {
        done(null);
        clearCardError();
        try {
          let ready = fresh(accountId);
          if (ready === null || ready.key === null) {
            // Not prepared: Hana's window opens now, in the click, and the next signing call uses it.
            const ticket: ApprovalTicket = c.prepareApproval();
            try {
              stage(STAGES.reading);
              ({ prep: ready } = await ensureReady(accountId, stage));
            } catch (e) {
              ticket.cancel();
              throw e;
            }
          }
          const nonce = delegateNonce({ keyNonce: ready.key!.nonce, blockHeight: ready.height, lastSigned: lastNonce.get(accountId) });
          const delegateAction = addMessageDelegate({ accountId, guestbook, text: check.text, nonce, blockHeight: ready.height });
          stage(STAGES.approving);
          const signing = c.near.signDelegateAction({ network: 'testnet', delegateAction });
          const { signedDelegateAction } = await signing;
          lastNonce.set(accountId, nonce);
          stage(STAGES.relaying);
          const { transactionHash } = await whileUnrecorded(() => c.near.relay({ network: 'testnet', signedDelegateAction }));
          stage(null);
          // The first write after this page's activation (in the click or in the background) says so.
          const created = justCreated.delete(accountId);
          done(`Written to the guestbook on NEAR testnet.${created ? ' Your NEAR account was created for it.' : ''} You paid no gas.`, transactionHash);
          input.value = '';
          renderCount();
          refresh(accountId).catch(() => {});
          await loadList({ accountId, text: check.text });
        } catch (e) {
          stage(null);
          // The relayer gave up waiting (504 `timeout`, the transaction pending): it may still land, so look again.
          if (errorInfo(e).reason === 'timeout') loadList({ accountId, text: check.text }).catch(() => {});
          throw e;
        }
      },
      'near-error',
    );
  }

  /** A real add_message transaction, signed; sent only when the account holds NEAR for its fee. */
  function signTransaction(): void {
    const accountId = c.near.accountId;
    if (accountId === null || guestbook === null) return;
    const check = checkGuestbookText(input.value);
    const text = check.ok ? check.text : DEFAULT_TX_TEXT;
    const label = 'NEAR transaction (add_message on the guestbook)';
    deps.run('sign', async () => {
      try {
        let ready = fresh(accountId);
        if (ready === null) {
          const ticket = c.prepareApproval();
          try {
            ready = await refresh(accountId);
          } catch (e) {
            ticket.cancel();
            throw e;
          }
        }
        const nonce = transactionNonce({ keyNonce: ready.key?.nonce ?? null, lastSigned: lastNonce.get(accountId) });
        const transaction = addMessageTransaction({ accountId, guestbook, text, nonce, blockHash: ready.hash });
        const r = await c.near.signTransaction({ network: 'testnet', transaction });
        if (ready.key !== null && ready.balance >= TX_FEE_RESERVE) {
          await rpc.sendTx(r.signedTransaction);
          lastNonce.set(accountId, nonce);
          result(`${label}: signed and sent`, r.hash, 'Your account paid the fee.', true, r.hash);
          refresh(accountId).catch(() => {});
          await loadList();
          return;
        }
        result(
          `${label}: signed, not sent`,
          shorten(r.signedTransaction, 24, 16),
          `Not sent: your NEAR account has no NEAR to pay the network fee. Use “Write to the guestbook (no NEAR needed)” above, where Hana’s relayer pays. Transaction hash ${r.hash}.`,
          true,
        );
      } catch (e) {
        result(`${label}: not signed`, null, deps.plainMessage(e, 'sign'), false);
        throw e;
      }
    });
  }

  function signMessage(): void {
    if (c.near.accountId === null) return;
    const label = 'NEAR message (NEP-413)';
    deps.run('sign', async () => {
      try {
        const r = await c.near.signMessage({ message: NEAR_TEST_MESSAGE, recipient: deps.recipient, nonce: deps.random(32) });
        result(`${label}: signed`, r.signature, `For ${deps.recipient}, by ${shortAccount(r.accountId)} with ${shorten(r.publicKey, 16, 6)}.`, true);
      } catch (e) {
        result(`${label}: not signed`, null, deps.plainMessage(e, 'sign'), false);
        throw e;
      }
    });
  }

  // ---- wiring ----

  el('near-write-button').addEventListener('click', write);
  el('sign-near-tx').addEventListener('click', signTransaction);
  el('sign-near-message').addEventListener('click', signMessage);
  el('near-refresh').addEventListener('click', () => {
    loadList().catch(() => {});
  });
  el('copy-near').addEventListener('click', () => {
    const id = c.near.accountId;
    if (!id) return;
    deps.copy(id).then(
      () => deps.notice('NEAR account copied.'),
      (e: unknown) => deps.showError('copy', e),
    );
  });
  const interested = (): void => {
    const first = clock() - interestAt > INTEREST_MS;
    interestAt = clock();
    // Activate (if new) and read on the first sign of interest, and whenever the last read is getting old.
    const accountId = c.near.accountId;
    if (accountId !== null && (first || fresh(accountId) === null || !activated.has(accountId))) prepareInBackground(true);
  };
  input.addEventListener('focus', interested);
  input.addEventListener('input', () => {
    renderCount();
    hint(null);
    interested();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) write();
  });
  setInterval(() => {
    if (shownFor === null || clock() - interestAt > INTEREST_MS || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
    prepareInBackground(false);
  }, REFRESH_MS);

  if (guestbook !== null) el('near-guestbook').textContent = guestbook;

  return {
    render(loggedIn: boolean, pending: boolean): void {
      const id = loggedIn ? c.near.accountId : null;
      el('near').hidden = id === null;
      if (id === null) {
        if (shownFor !== null) {
          shownFor = null;
          prep = null;
          interestAt = -Infinity;
          backgroundAt = -Infinity;
          stage(null);
          done(null);
          hint(null);
          clearCardError();
          el('near-results').replaceChildren();
          el('near-messages').replaceChildren();
          el('near-book-status').textContent = '';
          renderBalance();
        }
        return;
      }
      el('near-account').textContent = shortAccount(id);
      el('near-account-full').textContent = id;
      const link = el<HTMLAnchorElement>('near-link');
      link.hidden = explorer === null;
      if (explorer) link.href = `${explorer}/address/${encodeURIComponent(id)}`;
      el('near-write').hidden = guestbook === null;
      el('near-book').hidden = guestbook === null;
      const unavailable = el('near-unavailable');
      unavailable.hidden = guestbook !== null;
      unavailable.textContent = guestbook === null ? 'This environment has no demo guestbook (manifest near.demoGuestbook), so there is nothing to write to.' : '';
      for (const b of ['near-write-button', 'sign-near-message']) el<HTMLButtonElement>(b).disabled = pending;
      el<HTMLButtonElement>('sign-near-tx').disabled = pending || guestbook === null;
      if (shownFor !== id) {
        shownFor = id;
        prep = null;
        renderBalance();
        renderCount();
        refresh(id).catch(() => {});
        loadList().catch(() => {});
      }
    },
  };
}
