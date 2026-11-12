// @vitest-environment happy-dom
// The approval page marks boxes that hold more than they show (render-approval.ts markOverflowing): once a request is
// rendered, and again when a box's size changes (a ResizeObserver on each box, or the window's resize event where the
// browser has none). happy-dom lays nothing out, so the boxes' sizes are stubbed.
import { newRequestId, utf8 } from '@hana-id/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startApprovePage } from '../../src/auth/approve-page.ts';
import { USER } from '../../../core/test/stellar-fixtures.ts';
import { ENV, FakeWindow, PARTNER, type RemoteWindow, asWindow, remoteWindow, resetDom } from './helpers.ts';

let win: FakeWindow;
let vault: RemoteWindow;
let page: ReturnType<typeof startApprovePage>;

let overflowing = false;
const sizes = { scrollHeight: () => (overflowing ? 900 : 100), clientHeight: () => (overflowing ? 320 : 100) };
const saved: Record<string, PropertyDescriptor | undefined> = {};

const message = () => ({
  v: 1,
  t: 'hana:approve-request',
  id: newRequestId(),
  appName: 'Partner App',
  parentOrigin: PARTNER,
  kind: 'stellar_message',
  chain: 'stellar',
  address: USER,
  bytes: utf8(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')),
  context: {},
  position: 1,
  queued: 1,
});
const send = (m: unknown) => win.message(m, ENV.vaultOrigin, vault);
const notes = () => document.querySelectorAll('p.overflow-note').length;

function start(withObserver?: unknown): void {
  win = new FakeWindow('/approve');
  if (withObserver) (win as unknown as { ResizeObserver: unknown }).ResizeObserver = withObserver;
  vault = remoteWindow();
  win.opener = asWindow(vault);
  page = startApprovePage({ win, env: ENV, isGesture: () => true });
  win.dispatch('focus');
}

beforeEach(() => {
  resetDom();
  vi.useFakeTimers();
  overflowing = false;
  for (const k of ['scrollHeight', 'clientHeight'] as const) {
    saved[k] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, k);
    Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: sizes[k] });
  }
});
afterEach(() => {
  page.stop();
  vi.useRealTimers();
  for (const k of ['scrollHeight', 'clientHeight'] as const) {
    if (saved[k]) Object.defineProperty(HTMLElement.prototype, k, saved[k]!);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  }
});

describe('/approve: boxes that hold more than they show', () => {
  it('flags a box that overflows once the request is rendered', () => {
    start();
    overflowing = true;
    send(message());
    expect(notes()).toBe(1);
    expect(document.querySelector('pre.message')?.classList.contains('overflows')).toBe(true);
  });

  it('without ResizeObserver: marks again on the window’s resize', () => {
    start();
    send(message());
    expect(notes()).toBe(0);
    overflowing = true;
    win.dispatch('resize');
    expect(notes()).toBe(1);
  });

  it('with ResizeObserver: watches each box (a width change no resize event reports)', () => {
    const observed: Element[] = [];
    let callback: ((entries: { target: Element }[]) => void) | null = null;
    start(
      class {
        constructor(cb: (entries: { target: Element }[]) => void) {
          callback = cb;
        }
        observe(el: Element) {
          observed.push(el);
        }
        disconnect() {}
      },
    );
    send(message());
    expect(observed).toEqual([document.querySelector('pre.message')]);
    expect(notes()).toBe(0);
    overflowing = true;
    win.dispatch('resize');
    expect(notes()).toBe(0);
    callback!(observed.map((target) => ({ target })));
    expect(notes()).toBe(1);
  });
});
