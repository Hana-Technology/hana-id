// @vitest-environment happy-dom
// The vault page in a DOM: it refuses to run top-level or without its inlined config, reads the config only from the
// non-executable JSON element, and renders launcher labels as text.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootVault } from '../../src/vault/boot.ts';
import { readInlinedConfig } from '../../src/vault/config.ts';
import { domLauncherView } from '../../src/vault/launcher.ts';
import { ENV, makeConfig } from './harness.ts';

function setConfig(text: string, type = 'application/json', tag = 'script'): void {
  const el = document.createElement(tag);
  el.id = 'hana-config';
  if (tag === 'script') el.setAttribute('type', type);
  el.textContent = text;
  document.head.append(el);
}

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
});

/** A framed window: the real document, a parent that is another window. */
const framed = (parent: unknown = {}) =>
  ({
    parent,
    document,
    location: { ancestorOrigins: undefined },
    addEventListener: vi.fn(),
    open: vi.fn(),
    indexedDB: undefined,
    navigator: {},
  }) as unknown as Window;

describe('boot', () => {
  it('does nothing when the page is top-level', () => {
    setConfig(JSON.stringify(makeConfig()));
    expect(window.parent).toBe(window);
    expect(bootVault(window, ENV)).toBeNull();
  });

  it('does nothing without the config, or with a malformed one', () => {
    const w = framed();
    expect(bootVault(w, ENV)).toBeNull();
    setConfig('{not json');
    expect(bootVault(w, ENV)).toBeNull();
    document.head.replaceChildren();
    setConfig(JSON.stringify({ ...makeConfig(), signer: 'evil.testnet' }));
    expect(bootVault(w, ENV)).toBeNull();
    expect(w.addEventListener).not.toHaveBeenCalled();
  });

  it('starts with a valid config and listens for the hello', () => {
    setConfig(JSON.stringify(makeConfig()));
    const w = framed();
    expect(bootVault(w, ENV)).not.toBeNull();
    expect(w.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
  });
});

describe('readInlinedConfig', () => {
  it('reads only a <script type="application/json" id="hana-config">', () => {
    setConfig(JSON.stringify(makeConfig()), 'text/javascript');
    expect(readInlinedConfig(document)).toBeNull();
    document.head.replaceChildren();
    setConfig(JSON.stringify(makeConfig()), 'application/json', 'div');
    expect(readInlinedConfig(document)).toBeNull();
    document.head.replaceChildren();
    setConfig(JSON.stringify(makeConfig()));
    expect(readInlinedConfig(document)).toEqual(makeConfig());
  });

  it('reads JSON escaped for HTML (the API escapes <, >, &, U+2028, U+2029)', () => {
    const name = '</script><base href=//x>&';
    const escaped = JSON.stringify(makeConfig({ appName: name })).replace(new RegExp('[<>&\\u2028\\u2029]', 'gu'), (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    setConfig(escaped);
    expect(readInlinedConfig(document)?.appName).toBe(name);
  });

  it.each([
    ['a line separator', '\u2028'],
    ['a right-to-left override', '\u202e'],
    ['a zero-width space', '\u200b'],
    ['a soft hyphen', '\u00ad'],
    ['a Hangul filler', '\u3164'],
    ['a tag character', '\u{e0041}'],
    ['a newline', '\n'],
  ])('refuses an app name with %s (AUTH-2)', (_, c) => {
    setConfig(JSON.stringify(makeConfig({ appName: `Partner${c}App` })));
    expect(readInlinedConfig(document)).toBeNull();
  });
});

describe('the launcher button', () => {
  it('renders the label as text, and ignores untrusted clicks', () => {
    const view = domLauncherView(document);
    const onClick = vi.fn();
    view.show('<img src=x onerror=alert(1)>', onClick);
    const button = document.querySelector('button')!;
    expect(button.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(button.querySelector('img')).toBeNull();
    expect(button.style.display).toBe('block');
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClick).not.toHaveBeenCalled();
    view.hide();
    expect(button.style.display).toBe('none');
  });

  it('a flash (no action) is disabled', () => {
    const view = domLauncherView(document);
    view.show('Signed by Hana under Swaps', null);
    expect(document.querySelector('button')!.disabled).toBe(true);
  });
});
