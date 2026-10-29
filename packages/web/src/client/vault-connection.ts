// The partner side of the vault iframe (docs/batch-b-spec.md "Partner ↔ vault handshake", "Port methods", "Approval
// flow" step 1):
//
// 1. Insert `<iframe name="hana-vault-<32 hex>" src="{vaultOrigin}/vault?pk=…" hidden>`, with no `sandbox` and no
//    `allow` attribute.
// 2. On its first `load`, create a MessageChannel and post `{v:1, t:"hana:hello", sdk}` to the frame with
//    targetOrigin = vaultOrigin, transferring port2. From then on everything goes over port1.
// 3. Wait for the `ready` event; without it within 5 s of insertion, fail with `vault_unavailable`. A CSP `frame-src`
//    violation for vaultOrigin fails at once (partner requirement, detected); a report-only one doesn't block anything.
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

/** `ready` must arrive this long after the iframe is inserted. */
export const READY_TIMEOUT_MS = 5000;
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
  /** The iframe was put in the document. */
  appendedAt: number;
  /** Its first `load`, when the hello is posted. */
  loadAt: number;
  /** `ready` arrived. */
  readyAt: number;
}

/** Envelope fields beside the params: `popupOpened` when the SDK opened the approval popup for the request (D99). */
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
  #readyDone = false;
  /** `ready` arrived in time: requests may be sent. */
  #readyOk = false;
  #disconnected = false;
  #readyTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #now: () => number;
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
    return this.#readyOk ? { appendedAt: this.#appendedAt, loadAt: this.#loadAt, readyAt: this.#readyAt } : null;
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
    frame.addEventListener('load', () => this.#onLoad());
    this.#frame = frame;
    this.#readyTimer = setTimeout(() => this.#failReady(), READY_TIMEOUT_MS);
    container.append(frame);
    this.#appendedAt = this.#now();
  }

  #onLoad(): void {
    if (this.#disconnected) return;
    this.#loads += 1;
    if (this.#loads > 1) {
      this.#disconnect();
      return;
    }
    const target = this.#frame?.contentWindow;
    if (!target) {
      this.#failReady();
      return;
    }
    this.#loadAt = this.#now();
    const channel = new MessageChannel();
    this.#port = channel.port1;
    channel.port1.onmessage = (e) => this.#onPortMessage(e.data);
    target.postMessage({ v: 1, t: 'hana:hello', sdk: this.#o.sdkVersion }, this.#o.vaultOrigin, [channel.port2]);
  }

  #cspViolation(e: SecurityPolicyViolationEvent): void {
    if (this.#readyDone || this.#disconnected) return;
    // A Content-Security-Policy-Report-Only policy fires the same event, but the frame still loads.
    if (e.disposition === 'report') return;
    const directive = e.effectiveDirective || e.violatedDirective || '';
    const blocked = e.blockedURI || '';
    if (!CSP_FRAME_DIRECTIVES.has(directive.split(' ')[0] ?? '')) return;
    if (blocked !== this.#o.vaultOrigin && !blocked.startsWith(`${this.#o.vaultOrigin}/`)) return;
    this.#failReady({ reason: 'csp_frame_src' });
  }

  #failReady(data?: unknown): void {
    if (this.#readyDone) return;
    this.#readyDone = true;
    clearTimeout(this.#readyTimer);
    this.#rejectReady(hanaError('vault_unavailable', undefined, data));
  }

  #onPortMessage(data: unknown): void {
    // After a failed handshake the vault is treated as absent: nothing it sends later counts.
    if (this.#disconnected || (this.#readyDone && !this.#readyOk)) return;
    if (isPortEventShape(data)) {
      const event = parsePortEvent(data);
      if (!event) return;
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

  #disconnect(): void {
    if (this.#disconnected) return;
    this.#disconnected = true;
    // A dead port's frame is hidden at once (sweep PART-1): a second load means the frame's document was replaced
    // (another frame on the page can navigate it), so whatever now shows in the launcher's spot isn't Hana's.
    const launcherWasVisible = this.launcherVisible;
    if (this.#frame) this.#hide(this.#frame);
    clearTimeout(this.#readyTimer);
    if (!this.#readyDone) this.#failReady();
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
