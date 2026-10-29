// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://localhost:5173/spike.html"}
// spike.html (sweep OPER-10): a fragment handed over by spike-callback.html is checked against the run's state before
// anything of it is shown, and nothing reaches the page as HTML.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const html = readFileSync(join(import.meta.dirname, '..', 'spike.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/u.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/gu, '');
const script = /<script type="module">([\s\S]*?)<\/script>/u.exec(html)![1]!;

beforeEach(() => {
  document.body.innerHTML = body;
  localStorage.clear();
  // The page's module script, run in this document (it only wires listeners and reads the DOM).
  new Function(script)();
});

const deliver = (hash: string) => window.dispatchEvent(new StorageEvent('storage', { key: 'spike-callback', newValue: hash }));

describe('spike.html', () => {
  it('uses no HTML sinks', () => {
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/u);
  });

  it('ignores a fragment without the run’s state, error included, and shows nothing of it', () => {
    (document.getElementById('client') as HTMLInputElement).value = 'x.apps.googleusercontent.com';
    window.open = (() => null) as never;
    (document.getElementById('go') as HTMLButtonElement).click();
    deliver('error=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E&state=wrong');
    const out = document.getElementById('out')!;
    expect(out.querySelector('img')).toBeNull();
    expect(out.textContent).toBe('state mismatch: ignored');
  });
});
