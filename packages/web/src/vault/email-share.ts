// The vault's side of email sharing with partners (D411, D420–D425; docs/email-sharing-spec.md): the consent calls'
// session proofs, and the sheet (`/share-email` on the auth origin) the vault drives through postMessage.
//
//   /share-email ──hana:email-share-hello──▶ vault       (only from the window the vault expects)
//   vault ──hana:email-share-request──▶ /share-email     (the app, the state, the sealed address and a preview proof)
//   /share-email → POST /v1/identity/email-consent/preview (Origin: the auth origin) → shows the address
//   /share-email ──hana:email-share-answer──▶ vault      (granted / declined / revoke / keep)
//   vault → POST /v1/identity/email-consent(/revoke) → hana:email-share-done ──▶ /share-email (closes)
//
// The window is the login popup at the end of an `at_login` sign-in (the hello's source must be that window), the one
// `requestEmailSharing()` opened in the partner's click (its opener must be the partner page), or the one the vault's
// launcher opened (that exact window). Nothing is ever mandatory: a closed window, no hello in time or any failure ends
// the sheet without a decision (`dismissed`), and the caller goes on.
//
// SECURITY: the vault never sees the address: the sheet reads it from the API with a single-use proof made for
// `preview` only. Every message is checked for origin and source; the answer counts only from the window that said
// hello. Nothing here logs.
import {
  type EmailConsentAction,
  type EmailConsentProof,
  IDENTITY_NONCE_BYTES,
  emailConsentPayload,
  identityMessage,
  parseWindowMessage,
} from '@hana-id/core';
import type { Clock, Timers, WindowMessageEvent, WindowRef } from './runtime.ts';

/** How long the sheet waits for the window's hello: a login popup navigates there at once; a launcher needs a click. */
export const SHARE_HELLO_MS = 20_000;
export const SHARE_LAUNCHER_HELLO_MS = 5 * 60_000;
/** How long the user has to answer (the login popup's own 5-minute limit). */
export const SHARE_ANSWER_MS = 5 * 60_000;
/** How often the window's `closed` is read while waiting. */
export const SHARE_POLL_MS = 500;

/** The session a consent call is for. */
export interface ConsentSigner {
  signer: string;
  appId: string;
  parentOrigin: string;
  sessionPublicKey: Uint8Array;
  privateKey: CryptoKey;
}

/** A consent call's session proof (core identity.ts emailConsentPayload), signed by the session key. */
export async function consentProof(s: ConsentSigner, action: EmailConsentAction, sealedEmail: string | null, issuedAtMs: number): Promise<EmailConsentProof> {
  const nonce = crypto.getRandomValues(new Uint8Array(IDENTITY_NONCE_BYTES));
  const payload = emailConsentPayload({ action, parentOrigin: s.parentOrigin, sealedEmail });
  const message = identityMessage({ signer: s.signer, appId: s.appId, sessionPublicKey: s.sessionPublicKey, issuedAtMs, nonce, payload });
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, s.privateKey, message));
  return { sessionPublicKey: Array.from(s.sessionPublicKey), issuedAtMs, nonce: Array.from(nonce), signature: Array.from(signature) };
}

/** What the sheet ended with: the recorded decision, nothing (`dismissed`), or a decision the API refused (`failed`). */
export type SheetOutcome = 'granted' | 'declined' | 'kept' | 'dismissed' | 'failed';

export interface SheetDeps {
  authOrigin: string;
  /** window.parent: a partner-opened sheet's opener must be this window. */
  parentWindow: unknown;
  timers: Timers;
  clock: Clock;
  /** Records the answer (the vault's API call with a fresh proof); resolves the state, or throws. */
  record(answer: 'granted' | 'declined' | 'revoke'): Promise<'granted' | 'declined'>;
}

export interface SheetRequest {
  pk: string;
  appName: string;
  parentOrigin: string;
  logoUrl: string | null;
  ownGoogleClient: boolean;
  state: 'not_asked' | 'declined' | 'granted';
  sealedEmail: string;
  /** The preview proof, made for this sheet (single use, ±60 s: made when the hello arrives). */
  previewProof: () => Promise<EmailConsentProof>;
}

/**
 * One email sharing sheet. `expect` names the window: a known WindowRef (the login popup, a launcher's window), or
 * 'partner' (the first hello from a window the partner page opened). `run` resolves once, never rejects.
 */
export class ShareSheet {
  private window: WindowRef | null;
  private said = false;
  private closed = false;
  private resolveHello: (() => void) | null = null;
  private resolveAnswer: ((a: 'granted' | 'declined' | 'revoke' | 'keep' | null) => void) | null = null;
  private readonly helloSeen: Promise<void>;

  constructor(
    private readonly d: SheetDeps,
    private expect: WindowRef | 'partner' | null,
  ) {
    this.window = expect === 'partner' ? null : expect;
    this.helloSeen = new Promise((resolve) => {
      this.resolveHello = resolve;
    });
  }

  /** Whether the sheet is over (a dismissed one stays routable until its window's late hello, or SHARE_HELLO_MS). */
  get ended(): boolean {
    return this.closed;
  }

  /** The window the vault's launcher opened (popup-blocked `requestEmailSharing`). */
  adopt(w: WindowRef): void {
    if (this.said || this.closed) return;
    this.expect = w;
    this.window = w;
  }

  /** A `hana:email-share-hello` or `hana:email-share-answer`; true when it was this sheet's. */
  handleMessage(e: WindowMessageEvent): boolean {
    const m = parseWindowMessage(e.data, ['hana:email-share-hello', 'hana:email-share-answer']);
    if (!m || e.origin !== this.d.authOrigin || !e.source) return false;
    if (m.t === 'hana:email-share-hello') {
      if (this.said || this.closed || !this.fromExpected(e.source)) return false;
      this.said = true;
      this.window = e.source as WindowRef;
      this.resolveHello?.();
      return true;
    }
    if (!this.said || e.source !== this.window || !this.resolveAnswer) return false;
    const resolve = this.resolveAnswer;
    this.resolveAnswer = null;
    resolve(m.answer);
    return true;
  }

  private fromExpected(source: unknown): boolean {
    if (this.expect === null) return false;
    if (this.expect !== 'partner') return source === this.expect;
    try {
      return (source as { opener?: unknown }).opener === this.d.parentWindow && this.d.parentWindow !== null && this.d.parentWindow !== undefined;
    } catch {
      return false;
    }
  }

  private post(message: Record<string, unknown>): void {
    try {
      this.window?.postMessage({ v: 1, ...message }, this.d.authOrigin);
    } catch {
      // Gone, or navigated away: nothing to tell.
    }
  }

  private isClosed(): boolean {
    try {
      return this.window?.closed === true;
    } catch {
      return false;
    }
  }

  /** Waits for `p`, the window closing, or `ms`; null for the last two. */
  private wait<T>(p: Promise<T>, ms: number): Promise<T | null> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: T | null) => {
        if (done) return;
        done = true;
        this.d.timers.clearTimeout(deadline);
        if (poll !== null) this.d.timers.clearTimeout(poll);
        resolve(v);
      };
      const deadline = this.d.timers.setTimeout(() => finish(null), ms);
      let poll: unknown = null;
      const tick = () => {
        poll = null;
        if (this.closed || this.isClosed()) return finish(null);
        poll = this.d.timers.setTimeout(tick, SHARE_POLL_MS);
      };
      poll = this.d.timers.setTimeout(tick, SHARE_POLL_MS);
      void p.then((v) => finish(v));
    });
  }

  /**
   * Nothing to ask: a window that says hello (now, or within SHARE_HELLO_MS) is told to close. Ends the sheet.
   */
  dismiss(): void {
    if (this.closed) return;
    if (this.said) {
      this.post({ t: 'hana:email-share-close' });
      this.end();
      return;
    }
    // The window may still be on its way (the login popup navigates after its relay): answer its hello, briefly.
    void this.wait(this.helloSeen, SHARE_HELLO_MS).then(() => {
      if (this.said) this.post({ t: 'hana:email-share-close' });
      this.end();
    });
  }

  /** Ends the sheet without a decision (a newer login, a logout): the window is told to close. */
  cancel(): void {
    if (this.closed) return;
    if (this.said) this.post({ t: 'hana:email-share-close' });
    this.end();
  }

  private end(): void {
    this.closed = true;
    this.resolveHello?.();
    this.resolveHello = null;
    const answer = this.resolveAnswer;
    this.resolveAnswer = null;
    answer?.(null);
  }

  /** Shows `request` once the window says hello, records the answer, tells the window. */
  async run(request: SheetRequest, helloMs: number = SHARE_HELLO_MS): Promise<SheetOutcome> {
    try {
      await this.wait(this.helloSeen, helloMs);
      if (!this.said || this.closed) return 'dismissed';
      let proof: EmailConsentProof;
      try {
        proof = await request.previewProof();
      } catch {
        this.post({ t: 'hana:email-share-close' });
        return 'failed';
      }
      const answered = new Promise<'granted' | 'declined' | 'revoke' | 'keep' | null>((resolve) => {
        this.resolveAnswer = resolve;
      });
      this.post({
        t: 'hana:email-share-request',
        pk: request.pk,
        appName: request.appName,
        parentOrigin: request.parentOrigin,
        ownGoogleClient: request.ownGoogleClient,
        state: request.state,
        sealedEmail: request.sealedEmail,
        proof: {
          sessionPublicKey: Uint8Array.from(proof.sessionPublicKey),
          issuedAtMs: proof.issuedAtMs,
          nonce: Uint8Array.from(proof.nonce),
          signature: Uint8Array.from(proof.signature),
        },
        ...(request.logoUrl ? { logoUrl: request.logoUrl } : {}),
      });
      const answer = await this.wait(answered, SHARE_ANSWER_MS);
      if (answer === null || this.closed) return 'dismissed';
      if (answer === 'keep') {
        this.post({ t: 'hana:email-share-done', state: 'granted' });
        return 'kept';
      }
      try {
        const state = await this.d.record(answer);
        this.post({ t: 'hana:email-share-done', state });
        return state;
      } catch {
        this.post({ t: 'hana:email-share-done', state: 'failed' });
        return 'failed';
      }
    } finally {
      this.end();
    }
  }
}
