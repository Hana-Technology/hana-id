// Test doubles for the auth pages: a fake page window (opener, frames, message events, window.open) over the real
// happy-dom document, fake remote windows that record postMessage, a test env, and an RS256 Google-token signer.
import { type Jwk, base64UrlEncode, utf8 } from '@hana-id/core';
import { vi } from 'vitest';
import type { PageWindow } from '../../src/auth/page-window.ts';
import type { HanaEnv } from '../../src/hana-env.ts';
import { mpcNetwork } from '../../../core/test/helpers.ts';

/** A fixed MPC network for the export tests (its key is the env's pinned ckdNetworkKey). */
export const NET = mpcNetwork(123456789n);

export const ENV: HanaEnv = Object.freeze({
  name: 'sandbox-test',
  network: 'testnet',
  apiUrl: 'https://api.hana.test',
  vaultOrigin: 'https://vault.hana-vault.test',
  authOrigin: 'https://auth.hana-auth.test',
  signer: 'hana-signer.testnet',
  relayer: 'hana-relayer.testnet',
  rpc: 'https://rpc.near.test',
  ckdNetworkKey: NET.networkKey,
  devEnv: true,
});

export const PARTNER = 'https://partner.example';
export const EVIL = 'https://evil.test';
export const PK = 'pk_test_1111111111111111';
export const CLIENT_ID = 'shared-client.apps.googleusercontent.com';

/** A window on another origin (the vault, the partner, a child popup): records what is posted to it. */
export interface RemoteWindow {
  postMessage: ReturnType<typeof vi.fn>;
  /** Structured clones of every message posted, as the receiver would see them. */
  received: unknown[];
  frames: Record<string, unknown>;
  parent: unknown;
  location: { pathname: string };
  closed: boolean;
  close(): void;
}

export function remoteWindow(over: Partial<RemoteWindow> = {}): RemoteWindow {
  const received: unknown[] = [];
  const w: RemoteWindow = {
    postMessage: vi.fn((m: unknown) => {
      received.push(structuredClone(m));
    }),
    received,
    frames: {},
    parent: null,
    location: { pathname: '/' },
    closed: false,
    close() {
      w.closed = true;
    },
    ...over,
  };
  return w;
}

/** A cross-origin window: reading `location` throws, as in a browser. */
export function crossOriginWindow(): RemoteWindow {
  const w = remoteWindow();
  Object.defineProperty(w, 'location', {
    get() {
      throw new DOMException('Blocked a frame with origin', 'SecurityError');
    },
  });
  return w;
}

type Listener = (e: Event) => void;

/**
 * The page's session history as a browser keeps it: entries with their state, the one in view, and `popstate` (a
 * microtask later, as a browser queues it) when the user or the page moves between them. Going back before the first
 * entry leaves the page (`left` counts it). D893: Passport Home's Back and Forward.
 */
export class FakeHistory {
  readonly entries: { state: unknown }[] = [{ state: null }];
  index = 0;
  /** How many times Back went past the first entry: the browser left the page. */
  left = 0;
  scrollRestoration = 'auto';
  /** While true, popstate events wait for `release()` (a browser under load delivering them late). */
  hold = false;
  private readonly held: (() => void)[] = [];
  constructor(private readonly win: FakeWindow) {}
  /** Delivers the popstate events held so far, in order. */
  release(): void {
    for (const fire of this.held.splice(0)) fire();
  }
  get state(): unknown {
    return this.entries[this.index]?.state ?? null;
  }
  readonly pushState = vi.fn((data: unknown, _unused: string, url?: string | null) => {
    if (url !== undefined && url !== null) this.win.replaced.push(url);
    this.entries.splice(this.index + 1);
    this.entries.push({ state: structuredClone(data) });
    this.index += 1;
  });
  readonly replaceState = vi.fn((data: unknown, _unused: string, url?: string | null) => {
    this.win.replaced.push(url ?? '');
    this.win.location.hash = '';
    const entry = this.entries[this.index];
    if (entry) entry.state = structuredClone(data ?? null);
  });
  /**
   * As a browser does: the traversal lands later (a task), and only then do `index` and `state` change and popstate fire.
   * While `hold` is on, it lands at `release()` (PR 130's review: `history.state` must not change before the traversal
   * lands, or a page that reads it in between is tested against a browser that doesn't exist). A `go` made while another
   * is on its way counts from where the browser will be, as the browsers queue them.
   */
  private pendingIndex: number | null = null;
  readonly go = vi.fn((delta: number) => {
    const from = this.pendingIndex ?? this.index;
    const to = from + delta;
    if (to < 0) {
      this.left += 1;
      return;
    }
    if (to >= this.entries.length || delta === 0) return;
    this.pendingIndex = to;
    const land = (): void => {
      this.index = to;
      if (this.pendingIndex === to) this.pendingIndex = null;
      this.win.dispatch('popstate', { state: this.state });
    };
    if (this.hold) this.held.push(land);
    else queueMicrotask(land);
  });
  /** The browser's Back and Forward buttons. */
  back(): void {
    this.go(-1);
  }
  forward(): void {
    this.go(1);
  }
}

export class FakeWindow implements PageWindow {
  readonly document: Document = document;
  readonly location: { search: string; hash: string; pathname: string; assigned: string[]; assign(url: string): void };
  readonly history: FakeHistory = new FakeHistory(this);
  readonly replaced: string[] = [];
  readonly sessionStorage: Storage = window.sessionStorage;
  opener: Window | null = null;
  top: unknown = this;
  name = '';
  closed = false;
  readonly opened: { url: string; target: string; features: string }[] = [];
  openResult: unknown = null;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(path = '/login', search = '', hash = '') {
    const loc = {
      search,
      hash,
      pathname: path,
      assigned: [] as string[],
      assign(url: string) {
        loc.assigned.push(url);
      },
    };
    this.location = loc;
  }

  addEventListener(type: string, l: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(l);
  }

  removeEventListener(type: string, l: Listener): void {
    this.listeners.get(type)?.delete(l);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  dispatch(type: string, event: Partial<Event> & Record<string, unknown> = {}): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l({ type, ...event } as unknown as Event);
  }

  /** A message event as the browser delivers it. */
  message(data: unknown, origin: string, source: unknown): void {
    this.dispatch('message', { data, origin, source } as never);
  }

  open(url: string, target: string, features: string): Window | null {
    this.opened.push({ url, target, features });
    return this.openResult as Window | null;
  }

  close(): void {
    this.closed = true;
  }
}

export const asWindow = (w: RemoteWindow): Window => w as unknown as Window;

/**
 * D400: `vault` acks each `hana:auth-progress` posted to it with vaultOrigin as the target, to `page`, as the vault's
 * PopupTask does (`hana:auth-progress-ack`, from vaultOrigin, a task later: here a microtask). Returns the acks sent.
 */
export function vaultAcks(vault: RemoteWindow, page: FakeWindow, origin = ENV.vaultOrigin): string[] {
  const acked: string[] = [];
  const record = vault.postMessage.getMockImplementation() as ((m: unknown, targetOrigin: string) => void) | undefined;
  vault.postMessage.mockImplementation((m: unknown, targetOrigin: string) => {
    record?.(m, targetOrigin);
    const msg = m as { t?: string; stage?: string };
    if (msg.t !== 'hana:auth-progress' || targetOrigin !== origin) return;
    queueMicrotask(() => {
      acked.push(msg.stage as string);
      page.message({ v: 1, t: 'hana:auth-progress-ack', stage: msg.stage }, origin, vault);
    });
  });
  return acked;
}

/** Resets the shared happy-dom document and storage between tests. */
export function resetDom(): void {
  document.body.replaceChildren();
  const main = document.createElement('main');
  main.id = 'app';
  document.body.append(main);
  window.sessionStorage.clear();
}

export const pageText = (): string => document.getElementById('app')?.textContent ?? '';

/** Lets pending promise callbacks run. */
export const flush = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

// ---- Google tokens ----

export interface TokenSigner {
  jwk: Jwk;
  sign(claims: Record<string, unknown>): Promise<string>;
}

/** An email issuer key: tokens in the issuer's JWS General JSON form, and the key as the chain lists it. */
export async function emailIssuerSigner(kid = 'email-kid-1'): Promise<{ chainKey: { kid: string; n: string; e: string }; token(claims: Record<string, unknown>): Promise<string> }> {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const b64 = (v: unknown) => base64UrlEncode(utf8(JSON.stringify(v)));
  return {
    chainKey: { kid, n: pub.n as string, e: pub.e as string },
    async token(claims) {
      const payload = b64(claims);
      const protectedHeader = b64({ alg: 'RS256', kid });
      const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, utf8(`${protectedHeader}.${payload}`)));
      return JSON.stringify({ payload, signatures: [{ protected: protectedHeader, signature: base64UrlEncode(sig) }] });
    },
  };
}

export async function tokenSigner(kid = 'kid-1'): Promise<TokenSigner> {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    jwk: { kid, kty: 'RSA', alg: 'RS256', use: 'sig', n: pub.n as string, e: pub.e as string },
    async sign(claims) {
      const head = base64UrlEncode(utf8(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })));
      const body = base64UrlEncode(utf8(JSON.stringify(claims)));
      const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, utf8(`${head}.${body}`)));
      return `${head}.${body}.${base64UrlEncode(sig)}`;
    },
  };
}
