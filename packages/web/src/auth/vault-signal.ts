// D400: the login popup's D347 signals (`hana:auth-progress`) to the vault, delivered before the page leaves.
//
// Chromium delivers a message posted in the same task as (or a microtask before) a cross-document navigation with
// `event.source` null; the vault takes a signal only from the popup it answered (`event.source`), so it was dropped
// (seen 2026-11-05: 19 in 20 from a click handler, about 1 in 20 from a message handler). A close in the same task
// keeps the source, and so does a navigation one task later; Firefox and WebKit keep it either way. A page that
// signals and then leaves therefore waits for the vault's `hana:auth-progress-ack` of that stage (about 15 ms in
// Chromium, under 2 ms in Firefox and WebKit), or SIGNAL_ACK_WAIT_MS, whichever comes first, and only then navigates
// or closes. No ack (an older vault, a vault that took no signal: an ended login, another window) costs that wait
// and nothing else: the signal was posted long before the page left.
//
// SECURITY: the signals and their acks carry nothing but a stage. A signal goes only to the windows `targets` names,
// with vaultOrigin as the target origin; an ack counts only from vaultOrigin and from one of those windows. A forged
// or missing ack can only make the page leave sooner or later, which is what it did before D400.
import { parseWindowMessage } from '@hana-id/core';
import type { PageWindow } from './page-window.ts';

export type VaultStage = 'google' | 'email_code' | 'relayed' | 'back';

/** The longest a page waits for the vault's ack before it navigates or closes anyway (D400). */
export const SIGNAL_ACK_WAIT_MS = 150;

export interface SignalTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const GLOBAL_TIMERS: SignalTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface VaultSignals {
  /** Posts `stage` to the vault (every target, vaultOrigin as the target origin); a page that stays needs no more. */
  post(stage: VaultStage): void;
  /**
   * Runs `go` (the navigation or the close) once the vault acked every signal posted so far, or after
   * SIGNAL_ACK_WAIT_MS; at once when none waits for an ack. Resolves after `go` ran.
   */
  leave(go: () => void): Promise<void>;
  /** `post(stage)`, then `leave(go)`. */
  postThenLeave(stage: VaultStage, go: () => void): Promise<void>;
}

/**
 * The page's signals to the vault. `targets` names the windows that may be the vault (read at each post: the opener,
 * or its frames); none (no opener, no vaultOrigin, an export window) posts nothing and never waits.
 */
export function vaultSignals(win: PageWindow, targets: () => readonly unknown[], vaultOrigin: string | undefined, o: { timers?: SignalTimers; waitMs?: number } = {}): VaultSignals {
  const timers = o.timers ?? GLOBAL_TIMERS;
  const waitMs = o.waitMs ?? SIGNAL_ACK_WAIT_MS;
  /** Signals posted and not acked yet: their stage and the windows they went to. */
  const pending: { stage: VaultStage; to: readonly unknown[] }[] = [];
  const leaving: (() => void)[] = [];
  let listening = false;

  const onMessage = (event: Event): void => {
    const e = event as MessageEvent;
    if (e.origin !== vaultOrigin || e.source === null || e.source === undefined) return;
    const ack = parseWindowMessage(e.data, ['hana:auth-progress-ack']);
    if (!ack) return;
    const i = pending.findIndex((p) => p.stage === ack.stage && p.to.includes(e.source));
    if (i < 0) return;
    pending.splice(i, 1);
    if (pending.length === 0) settle();
  };

  const listen = (on: boolean): void => {
    if (on === listening) return;
    listening = on;
    if (on) win.addEventListener('message', onMessage);
    else win.removeEventListener('message', onMessage);
  };

  /** Every waiting leave goes now; nothing is waited for after that. */
  const settle = (): void => {
    pending.length = 0;
    listen(false);
    for (const go of leaving.splice(0)) go();
  };

  const post = (stage: VaultStage): void => {
    if (!vaultOrigin) return;
    const to = targets().filter((t) => t !== null && t !== undefined);
    if (to.length === 0) return;
    // Listening before posting: the ack can't be missed, however soon it comes.
    const entry = { stage, to: [] as unknown[] };
    pending.push(entry);
    listen(true);
    for (const t of to) {
      try {
        entry.to.push(t);
        (t as Window).postMessage({ v: 1, t: 'hana:auth-progress', stage }, vaultOrigin);
      } catch {
        // Gone: nothing to tell there, and no ack to wait for.
        entry.to.pop();
      }
    }
    if (entry.to.length === 0 && pending.includes(entry)) {
      pending.splice(pending.indexOf(entry), 1);
      if (pending.length === 0) settle();
    }
  };

  const leave = (go: () => void): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const run = (): void => {
        try {
          go();
          resolve();
        } catch (err) {
          reject(err);
        }
      };
      if (pending.length === 0) {
        run();
        return;
      }
      let timer: unknown = null;
      leaving.push(() => {
        if (timer !== null) timers.clearTimeout(timer);
        timer = null;
        run();
      });
      // No ack in time: leave anyway. The signal went out at least this long ago, in an earlier task.
      timer = timers.setTimeout(() => {
        timer = null;
        settle();
      }, waitMs);
    });

  return {
    post,
    leave,
    postThenLeave(stage, go) {
      post(stage);
      return leave(go);
    },
  };
}
