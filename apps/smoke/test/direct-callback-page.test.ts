// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://localhost:5173/direct-callback.html#id_token=e30.e30.c2ln&state=s"}
// direct-callback.html (the direct page's Google redirect): hands the fragment to the opener on this origin only, or
// over a same-origin BroadcastChannel when the opener was severed; clears the fragment from the URL; stores nothing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync(join(import.meta.dirname, '..', 'direct-callback.html'), 'utf8');
const script = /<script type="module">([\s\S]*?)<\/script>/u.exec(html)![1]!;
const HASH = 'id_token=e30.e30.c2ln&state=s';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, '', `/direct-callback.html#${HASH}`);
  window.close = vi.fn() as never;
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, 'opener', { value: null, configurable: true });
});

describe('direct-callback.html', () => {
  it('posts the fragment to the opener for this origin only, then clears the URL and closes', () => {
    const postMessage = vi.fn();
    Object.defineProperty(window, 'opener', { value: { postMessage }, configurable: true });
    new Function(script)();
    expect(postMessage).toHaveBeenCalledWith({ t: 'hana-smoke-direct-callback', hash: HASH }, 'http://localhost:5173');
    expect(location.hash).toBe('');
    expect(window.close).toHaveBeenCalled();
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('without an opener, uses the BroadcastChannel and stores nothing', async () => {
    Object.defineProperty(window, 'opener', { value: null, configurable: true });
    const got = new Promise<unknown>((resolve) => {
      const listener = new BroadcastChannel('hana-smoke-direct-callback');
      listener.onmessage = (e) => {
        listener.close();
        resolve(e.data);
      };
    });
    new Function(script)();
    expect(await got).toEqual({ t: 'hana-smoke-direct-callback', hash: HASH });
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it('uses no HTML sinks', () => {
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage/u);
  });
});
