// The SPA in a fresh happy-dom window, as the browser runs it: the page's body from public/index.html, public/app.js
// evaluated with this window's globals, and the admin Worker's API answered at `fetch` by the test (GET /api/me is
// answered here). The browser's own dialogs throw: the console confirms in the page, never with window.confirm.
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

export const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const BODY = /<body>([\s\S]*)<\/body>/u.exec(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'))![1]!;

export interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
}
/** An API answer; `network: true` makes fetch fail as a dropped connection does. */
export type Answer = { status?: number; body?: unknown; network?: true };

let open: Window | null = null;
/** Closes the last window (each test file's afterEach). */
export async function closeWindow() {
  await open?.happyDOM.close();
  open = null;
}

/** The SPA at `path`, answering each API call with `answer`. */
export function boot(path: string, answer: (c: Call) => Answer) {
  const w = new Window({ url: `https://admin.test${path}` });
  open = w;
  w.document.body.innerHTML = BODY.replace(/<script[^>]*><\/script>/gu, '');
  const dialogs: string[] = [];
  for (const k of ['alert', 'confirm', 'prompt'] as const) {
    (w as unknown as Record<string, unknown>)[k] = (msg: string) => {
      dialogs.push(`${k}: ${msg}`);
      throw new Error(`window.${k} called`);
    };
  }
  const calls: Call[] = [];
  const fetch = async (p: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const c: Call = { method: init.method, path: p, headers: init.headers, ...(init.body !== undefined ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}) };
    calls.push(c);
    const a = p === '/api/me' ? { body: { email: 'staff@hana.example', env: 'sandbox-dev' } } : answer(c);
    if (a.network) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  // The page's globals, from this window (the script is the same text the browser runs).
  const globals = { window: w, document: w.document, history: w.history, location: w.location, navigator: w.navigator, Node: w.Node, fetch, URL: w.URL, URLSearchParams: w.URLSearchParams, Event: w.Event };
  new Function(...Object.keys(globals), SRC)(...Object.values(globals));
  const doc = w.document;
  const main = () => doc.getElementById('app')!;
  const text = () => main().textContent ?? '';
  const form = () => main().querySelector('form')!;
  const field = (name: string) => form().querySelector(`[name="${name}"]`) as unknown as HTMLInputElement;
  /** Submits `f` (a form of the page, as the DOM types it in a test), or the page's first form. */
  const submit = (f: unknown = form()) => (f as ReturnType<typeof form>).dispatchEvent(new w.Event('submit', { cancelable: true }));
  const buttons = (label: string) => [...main().querySelectorAll('button')].filter((b) => (b.textContent ?? '').startsWith(label) && !b.hidden && !b.closest('[hidden]')) as unknown as HTMLButtonElement[];
  const button = (label: string) => buttons(label)[0]!;
  const api = () => calls.filter((c) => c.path !== '/api/me');
  return { w, doc, calls, api, main, text, form, field, submit, button, buttons, dialogs };
}
