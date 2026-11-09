// The partner side of the vault iframe (docs/batch-b-spec.md "Partner ↔ vault handshake", "Port methods", "Approval
// flow" step 1):
//
// 1. Insert `<iframe name="hana-vault-<32 hex>" src="{vaultOrigin}/vault?pk=…" hidden>`, with no `sandbox` and no
//    `allow` attribute.
// 2. On its first `load`, create a MessageChannel and post `{v:1, t:"hana:hello", sdk}` to the frame with
//    targetOrigin = vaultOrigin, transferring port2. From then on everything goes over port1.
// 3. Wait for the vault's answer: `connected` (it took the hello and is starting) or `ready`, within ANSWER_TIMEOUT_MS
//    of the frame's insertion, and within POST_LOAD_ANSWER_MS of its `load` once it has loaded (the vault takes the
//    hello in the same task it arrives in, so a loaded frame that is silent for that long was refused); then `ready` within READY_AFTER_CONNECT_MS of `connected` (the vault's unlock waits on
//    the Hana API). At the deadline one task is drained first (an answer already queued still counts). A frame still
//    loading gets one more ANSWER_TIMEOUT_MS, then fails `frame_timeout`; a frame that loaded but didn't answer is
//    replaced once (FRAME_ATTEMPTS, same name and src). Then, or when `ready` is late, `vault_unavailable` with
//    `data.reason` saying which (VAULT_UNAVAILABLE_MESSAGES), and the frame and its port are removed. A CSP
//    `frame-src` violation for vaultOrigin fails at once, without a retry (partner requirement, detected); a
//    report-only one doesn't block anything. The vault reports nothing before `connected`: a hello it refuses and its
//    error page (403/503, framed nowhere) get no answer, by design, so a framing page learns nothing from it.
// 4. Send requests `{v:1, id, method, params}` and match replies by id. Requests are validated with the vault's own
//    parser first (parsePortRequest), because the vault drops an invalid one without a reply and the caller would hang.
//
// The frame is hidden except while the vault shows its launcher (`ui {launcher: 'show'}`): then it is a fixed
// 320×72 px element. A second `load` means the vault document was replaced (navigated or reloaded), so the port is
// dead: pending requests reject with 4900 and the connection reports itself disconnected.
import {
  ErrorCode,
  type PortEvent,
  type PortEventMap,
  type PortMethod,
  type PortParamsMap,
  type PortResultMap,

  isPortEventShape,
  parsePortEvent,
  parsePortReply,
  parsePortRequest,
} from '@hana-id/core';
import { HanaError, RpcCode, hanaError } from './errors.ts';
import { randomHex } from './random.ts';

/** A frame's vault must answer (`connected`, or `ready` from a vault that predates it) this long after insertion. */
export const ANSWER_TIMEOUT_MS = 5000;
/**
 * Once the frame has loaded (its script has run: `load` waits for it), its vault must answer the hello within this. The
 * vault says `connected` synchronously on the hello, so a working vault answers in milliseconds; a frame refused by
 * `frame-ancestors`, the vault's own origin check or an error page loads and stays silent. This keeps a wrong origin
 * from costing two full ANSWER_TIMEOUT_MS deadlines (about 10 s) before the partner learns of it.
 */
export const POST_LOAD_ANSWER_MS = 1500;
/** After `connected`, `ready` must arrive within this. */
export const READY_AFTER_CONNECT_MS = 20_000;
/** Frames tried before `vault_unavailable`: one automatic retry of a frame that didn't answer. */
export const FRAME_ATTEMPTS = 2;

/** `vault_unavailable`'s `data.reason`, and its message. */
export const VAULT_UNAVAILABLE_MESSAGES = {
  csp_frame_src: "This page's Content-Security-Policy blocks the Hana vault frame (frame-src must allow the vault origin)",
  frame_timeout: "The Hana vault page didn't load in time (check the network)",
  no_answer:
    "The Hana vault frame loaded but the vault didn't answer: this page's origin (or a page framing it) is probably not exactly one of the app's allowed origins (scheme, host and port must match), or the publishable key is unknown or suspended",
  ready_timeout: "The Hana vault answered but didn't finish starting in time (the Hana API was slow or unreachable)",
  frame_replaced: 'The Hana vault frame was navigated away before it was ready',
} as const;
export type VaultUnavailableReason = keyof typeof VAULT_UNAVAILABLE_MESSAGES;

/**
 * `no_answer`'s message, naming the page's origin: the vault refuses an origin it doesn't list without saying why (by
 * design: a framing page learns nothing about a key or an origin), so the SDK says which origin was checked. A dev
 * server that moved to another port when its own was busy is the usual case.
 */
export function noAnswerMessage(origin: string): string {
  return `The Hana vault didn't answer this page (${origin}). Check that ${origin} is exactly one of your app's allowed origins (scheme, host and port: a dev server that moved to another port is another origin) and that every page framing it is too; otherwise the publishable key is unknown or the app is suspended`;
}
export const LAUNCHER_WIDTH_PX = 320;
export const LAUNCHER_HEIGHT_PX = 72;

export type ReadyStatus = PortEventMap['ready'];

export interface VaultConnectionOptions {
  win: Window;
  /** Where the iframe goes; null = the document body (waits for it if the script runs in `<head>`). */
  container: HTMLElement | null;
  vaultOrigin: string;
  publishableKey: string;
  sdkVersion: string;
  /** Every valid vault event, `ready` included. */
  onEvent: (event: PortEvent) => void;
  /** The port died (frame replaced, or destroy()). Called once. */
  /** The port died (or destroy); `launcherWasVisible` when the launcher was showing, now hidden. */
  onDisconnect: (launcherWasVisible: boolean) => void;
  /** Monotonic ms for the handshake marks (pk_test_ timings); defaults to performance.now. */
  now?: () => number;
}

/** When the handshake's steps happened, on the partner page's clock (ms, performance.now). */
export interface HandshakeMarks {
  /** The first iframe was put in the document (the same as `appendedAt` without a retry). */
  firstAppendedAt: number;
  /** The iframe that answered was put in the document. */
  appendedAt: number;
  /** Its first `load`, when the hello is posted. */
  loadAt: number;
  /** `ready` arrived. */
  readyAt: number;
}

/** Envelope fields beside the params: `popupOpened` when the SDK opened the approval popup for the request. */
export interface RequestExtra {
  popupOpened?: boolean;
}

interface Pending {
  method: PortMethod;
  resolve: (result: never) => void;
  reject: (e: HanaError) => void;
}

const CSP_FRAME_DIRECTIVES = new Set(['frame-src', 'child-src', 'default-src']);

export class VaultConnection {
  /** The iframe's window name, which the login popup looks up as `window.opener.frames[name]`. */
  readonly frameName = `hana-vault-${randomHex(16)}`;
  /** Resolves with the vault's first status; rejects with `vault_unavailable`. Never rejects unhandled. */
  readonly ready: Promise<ReadyStatus>;

  readonly #o: VaultConnectionOptions;
  readonly #pending = new Map<string, Pending>();
  #frame: HTMLIFrameElement | null = null;
  #port: MessagePort | null = null;
  #seq = 0;
  #loads = 0;
  /** Frames inserted so far (FRAME_ATTEMPTS at most). */
  #attempts = 0;
  /** The current frame's vault said `connected`. */
  #connected = false;
  /** The current frame's answer deadline was extended once because it was still loading. */
  #extended = false;
  #readyDone = false;
  /** `ready` arrived in time: requests may be sent. */
  #readyOk = false;
  #disconnected = false;
  #readyTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #now: () => number;
  #firstAppendedAt = 0;
  #appendedAt = 0;
  #loadAt = 0;
  #readyAt = 0;
  #resolveReady!: (s: ReadyStatus) => void;
  #rejectReady!: (e: HanaError) => void;
  readonly #onCsp = (e: Event) => this.#cspViolation(e as SecurityPolicyViolationEvent);
  readonly #onDomReady = () => this.#mount();

  constructor(o: VaultConnectionOptions) {
    this.#o = o;
    this.#now = o.now ?? (() => performance.now());
    this.ready = new Promise<ReadyStatus>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.ready.catch(() => {});
    o.win.document.addEventListener('securitypolicyviolation', this.#onCsp);
    if (o.container === null && !o.win.document.body) o.win.document.addEventListener('DOMContentLoaded', this.#onDomReady, { once: true });
    else this.#mount();
  }

  get frame(): HTMLIFrameElement | null {
    return this.#frame;
  }

  get disconnected(): boolean {
    return this.#disconnected;
  }

  /** The handshake's marks once `ready` arrived, else null. */
  get handshakeMarks(): HandshakeMarks | null {
    return this.#readyOk ? { firstAppendedAt: this.#firstAppendedAt, appendedAt: this.#appendedAt, loadAt: this.#loadAt, readyAt: this.#readyAt } : null;
  }

  #mount(): void {
    if (this.#disconnected || this.#frame) return;
    const doc = this.#o.win.document;
    const container = this.#o.container ?? doc.body;
    const frame = doc.createElement('iframe');
    frame.name = this.frameName;
    frame.title = 'Hana ID';
    frame.src = `${this.#o.vaultOrigin}/vault?pk=${encodeURIComponent(this.#o.publishableKey)}`;
    this.#hide(frame);
    frame.addEventListener('load', () => this.#onLoad(frame));
    this.#frame = frame;
    this.#attempts += 1;
    this.#extended = false;
    this.#connected = false;
    this.#armAnswer();
    container.append(frame);
    this.#appendedAt = this.#now();
    if (this.#attempts === 1) this.#firstAppendedAt = this.#appendedAt;
  }

  /**
   * The current frame's answer deadline. At it, one task is drained (setTimeout 0) before deciding, so a `connected`
   * or `ready` already queued on the port still lands.
   */
  #armAnswer(ms: number = ANSWER_TIMEOUT_MS): void {
    const frame = this.#frame;
    this.#arm(ms, () => {
      this.#readyTimer = setTimeout(() => {
        if (frame === this.#frame) this.#noAnswer();
      }, 0);
    });
  }

  #arm(ms: number, then: () => void): void {
    clearTimeout(this.#readyTimer);
    this.#readyTimer = setTimeout(then, ms);
  }

  #onLoad(frame: HTMLIFrameElement): void {
    // A replaced frame's late load counts for nothing.
    if (this.#disconnected || frame !== this.#frame) return;
    this.#loads += 1;
    if (this.#loads > 1) {
      this.#disconnect('frame_replaced');
      return;
    }
    this.#loadAt = this.#now();
    // Loaded: the vault's script has run, so its answer to the hello is due within moments (POST_LOAD_ANSWER_MS).
    if (!this.#connected && !this.#readyDone) this.#armAnswer(POST_LOAD_ANSWER_MS);
    const target = frame.contentWindow;
    // No window to talk to: as good as no answer (the deadline decides, and may retry).
    if (!target) return;
    const channel = new MessageChannel();
    const port = channel.port1;
    this.#port = port;
    port.onmessage = (e) => {
      if (this.#port === port) this.#onPortMessage(e.data);
    };
    target.postMessage({ v: 1, t: 'hana:hello', sdk: this.#o.sdkVersion }, this.#o.vaultOrigin, [channel.port2]);
  }

  /**
   * The current frame didn't answer in time. Still loading: one more deadline, then `frame_timeout` (a slow page isn't
   * helped by asking for it again). Loaded without an answer: replace it once, else `no_answer`.
   */
  #noAnswer(): void {
    if (this.#readyDone || this.#disconnected || this.#connected) return;
    if (this.#loads === 0) {
      if (!this.#extended) {
        this.#extended = true;
        this.#armAnswer();
        return;
      }
      this.#failReady('frame_timeout');
      return;
    }
    if (this.#attempts >= FRAME_ATTEMPTS) {
      this.#failReady('no_answer');
      return;
    }
    // A fresh frame, same name and src. The old one's port is closed and its late events dropped.
    this.#dropFrame();
    this.#loads = 0;
    this.#loadAt = 0;
    this.#mount();
  }

  /** Closes the current frame's port (its late events dropped) and removes the frame. */
  #dropFrame(): void {
    if (this.#port) {
      this.#port.onmessage = null;
      this.#port.close();
    }
    this.#port = null;
    this.#frame?.remove();
    this.#frame = null;
  }

  #cspViolation(e: SecurityPolicyViolationEvent): void {
    if (this.#readyDone || this.#disconnected) return;
    // A Content-Security-Policy-Report-Only policy fires the same event, but the frame still loads.
    if (e.disposition === 'report') return;
    const directive = e.effectiveDirective || e.violatedDirective || '';
    const blocked = e.blockedURI || '';
    if (!CSP_FRAME_DIRECTIVES.has(directive.split(' ')[0] ?? '')) return;
    if (blocked !== this.#o.vaultOrigin && !blocked.startsWith(`${this.#o.vaultOrigin}/`)) return;
    this.#failReady('csp_frame_src');
  }

  /** `reason` undefined: destroy() before the handshake finished. */
  #failReady(reason?: VaultUnavailableReason): void {
    if (this.#readyDone) return;
    this.#readyDone = true;
    clearTimeout(this.#readyTimer);
    // A failed handshake leaves nothing behind (as destroy() does): no frame, no port.
    if (reason) this.#dropFrame();
    if (!reason) {
      this.#rejectReady(hanaError('vault_unavailable'));
      return;
    }
    if (reason === 'no_answer') {
      const origin = this.#pageOrigin();
      this.#rejectReady(hanaError('vault_unavailable', noAnswerMessage(origin), { reason, attempts: this.#attempts, origin }));
      return;
    }
    this.#rejectReady(hanaError('vault_unavailable', VAULT_UNAVAILABLE_MESSAGES[reason], { reason, attempts: this.#attempts }));
  }

  /** This page's origin as the vault saw it (`null` for an opaque one). */
  #pageOrigin(): string {
    try {
      return this.#o.win.location.origin;
    } catch {
      return 'null';
    }
  }

  #onPortMessage(data: unknown): void {
    // After a failed handshake the vault is treated as absent: nothing it sends later counts.
    if (this.#disconnected || (this.#readyDone && !this.#readyOk)) return;
    if (isPortEventShape(data)) {
      const event = parsePortEvent(data);
      if (!event) return;
      if (event.event === 'connected') {
        // The vault is alive and starting: `ready` gets longer, and a late one is a slow start, not a missing vault.
        if (this.#readyDone || this.#connected) return;
        this.#connected = true;
        this.#arm(READY_AFTER_CONNECT_MS, () => this.#failReady('ready_timeout'));
      }
      if (event.event === 'ready') {
        if (this.#readyDone) return;
        this.#readyAt = this.#now();
        this.#readyDone = true;
        this.#readyOk = true;
        clearTimeout(this.#readyTimer);
        this.#resolveReady(event.data);
      }
      if (event.event === 'ui') {
        if (event.data.launcher === 'show') this.#show();
        else if (this.#frame) this.#hide(this.#frame);
      }
      this.#o.onEvent(event);
      return;
    }
    const id = (data as { id?: unknown } | null)?.id;
    if (typeof id !== 'string') return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    const reply = parsePortReply(data, pending.method);
    // The port reaches only the vault, so a malformed reply is a vault fault: fail the call instead of hanging it.
    if (!reply) pending.reject(new HanaError(RpcCode.internal, `Malformed reply from the Hana vault to ${pending.method}`));
    else if ('error' in reply) pending.reject(HanaError.from(reply.error));
    else pending.resolve(reply.result as never);
  }

  /**
   * Sends a port request once `ready` has resolved. Rejects with the vault's error, `vault_unavailable`, 4900 when the
   * port dies, or -32602 when the vault's own validator would drop the request.
   */
  async request<M extends PortMethod>(method: M, params?: PortParamsMap[M], extra?: RequestExtra): Promise<PortResultMap[M]> {
    if (this.#disconnected) throw hanaError(ErrorCode.disconnected);
    await this.ready;
    if (this.#disconnected || !this.#port) throw hanaError(ErrorCode.disconnected);
    return this.send(method, params, extra);
  }

  /** As request(), without waiting for `ready` (the caller already has). */
  send<M extends PortMethod>(method: M, params?: PortParamsMap[M], extra?: RequestExtra): Promise<PortResultMap[M]> {
    const port = this.#port;
    if (this.#disconnected || !port || !this.#readyOk) return Promise.reject(hanaError(ErrorCode.disconnected));
    this.#seq += 1;
    const id = String(this.#seq);
    const message = { ...(params === undefined ? { v: 1, id, method } : { v: 1, id, method, params }), ...(extra?.popupOpened ? { popupOpened: true } : {}) };
    if (!parsePortRequest(message)) return Promise.reject(new HanaError(RpcCode.invalidParams, `Invalid params for ${method}`));
    return new Promise<PortResultMap[M]>((resolve, reject) => {
      this.#pending.set(id, { method, resolve: resolve as (r: never) => void, reject });
      try {
        port.postMessage(message);
      } catch (e) {
        this.#pending.delete(id);
        reject(new HanaError(RpcCode.invalidParams, e instanceof Error ? e.message : `Can't send ${method}`));
      }
    });
  }

  #show(): void {
    const f = this.#frame;
    if (!f) return;
    f.hidden = false;
    // CSSOM setters, not a style attribute, so a partner CSP without 'unsafe-inline' styles still allows them.
    const s = f.style;
    s.setProperty('display', 'block', 'important');
    s.setProperty('position', 'fixed', 'important');
    s.setProperty('right', '16px', 'important');
    s.setProperty('bottom', '16px', 'important');
    s.setProperty('width', `${LAUNCHER_WIDTH_PX}px`, 'important');
    s.setProperty('height', `${LAUNCHER_HEIGHT_PX}px`, 'important');
    s.setProperty('border', '0', 'important');
    s.setProperty('z-index', '2147483647', 'important');
    s.setProperty('color-scheme', 'normal', 'important');
  }

  #hide(f: HTMLIFrameElement): void {
    f.hidden = true;
    f.style.setProperty('display', 'none', 'important');
  }

  get launcherVisible(): boolean {
    return this.#frame !== null && !this.#frame.hidden;
  }

  #disconnect(reason?: VaultUnavailableReason): void {
    if (this.#disconnected) return;
    this.#disconnected = true;
    // A dead port's frame is hidden at once (sweep PART-1): a second load means the frame's document was replaced
    // (another frame on the page can navigate it), so whatever now shows in the launcher's spot isn't Hana's.
    const launcherWasVisible = this.launcherVisible;
    if (this.#frame) this.#hide(this.#frame);
    clearTimeout(this.#readyTimer);
    if (!this.#readyDone) this.#failReady(reason);
    this.#readyDone = true;
    for (const p of this.#pending.values()) p.reject(hanaError(ErrorCode.disconnected));
    this.#pending.clear();
    if (this.#port) {
      this.#port.onmessage = null;
      this.#port.close();
    }
    this.#port = null;
    this.#o.onDisconnect(launcherWasVisible);
  }

  /** Removes the iframe and closes the port; pending and later requests reject with 4900. */
  destroy(): void {
    this.#o.win.document.removeEventListener('securitypolicyviolation', this.#onCsp);
    this.#o.win.document.removeEventListener('DOMContentLoaded', this.#onDomReady);
    this.#disconnect();
    this.#frame?.remove();
    this.#frame = null;
  }
}
