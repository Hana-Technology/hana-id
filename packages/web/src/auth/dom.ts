// DOM helpers for the auth pages. Every string reaches the page through textContent or a text node, never innerHTML,
// so partner-controlled values (app names, origins, policy labels, decoded request fields) can't become markup.
import type { FrameSite } from '@hana-id/core';

export type Child = Node | string | null | undefined | false;

export interface Dom {
  readonly doc: Document;
  /** An element with optional class and attributes, and children (strings become text nodes). */
  h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: { class?: string; attrs?: Record<string, string> }, ...children: Child[]): HTMLElementTagNameMap[K];
  /** Replaces the page's content (the `#app` element, or the body). */
  show(...children: Child[]): void;
}

export interface DomOptions {
  /**
   * D881: the window's title follows the screen. One page file shows many screens (the sign-in window's email page
   * shows a Google sign-in's follow-up screens too), so its built `<title>` can be wrong for the screen in view: each
   * `show` sets the title to the screen's heading (its first `h1`), or back to the built title when it has none.
   */
  titleFromHeading?: boolean;
}

/** The sign-in window's pages (/login, /login/callback, /login/email, /home/callback): their title follows the screen. */
export const SIGN_IN_WINDOW: DomOptions = Object.freeze({ titleFromHeading: true });

/** The title each document was built with, before any screen changed it (several `dom()` calls may share a page). */
const BUILT_TITLES = new WeakMap<Document, string>();

/** The text a heading reads as: its text content, white space collapsed. */
export const headingText = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/gu, ' ').trim();

export function dom(doc: Document, options: DomOptions = {}): Dom {
  if (options.titleFromHeading && !BUILT_TITLES.has(doc)) BUILT_TITLES.set(doc, doc.title);
  const append = (el: Element, children: Child[]) => {
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      el.append(typeof c === 'string' ? doc.createTextNode(c) : c);
    }
  };
  return {
    doc,
    h(tag, props, ...children) {
      const el = doc.createElement(tag);
      if (props?.class) el.className = props.class;
      for (const [k, v] of Object.entries(props?.attrs ?? {})) el.setAttribute(k, v);
      append(el, children);
      return el;
    },
    show(...children) {
      const root = doc.getElementById('app') ?? doc.body;
      root.replaceChildren();
      append(root, children);
      if (options.titleFromHeading) doc.title = headingText(root.querySelector('h1')) || (BUILT_TITLES.get(doc) ?? doc.title);
    },
  };
}

/**
 * A web origin (the partner's, as text) that wraps only at sensible points: after `://`, and before each `.`, `:` and `/`
 * of the rest (`<wbr>`), never inside a label, unless one label alone is wider than the line (auth.css `.origin`). Its
 * text content is the origin exactly.
 */
export function originText(d: Dom, origin: string, tag: 'span' | 'p' = 'span'): HTMLElement {
  const el = d.h(tag, { class: 'origin' });
  const scheme = origin.indexOf('://');
  const head = scheme >= 0 ? origin.slice(0, scheme + 3) : '';
  const rest = scheme >= 0 ? origin.slice(scheme + 3) : origin;
  if (head) el.append(d.doc.createTextNode(head), d.h('wbr'));
  rest.split(/(?=[.:/])/u).forEach((part, i) => {
    if (i > 0) el.append(d.h('wbr'));
    el.append(d.doc.createTextNode(part));
  });
  return el;
}

/**
 * P11 (D934): the words for where the person is, when the page asking for the wallet sits inside another page (a
 * network's widget on a partner's site). Plain words; the vault checked every address itself (vault/frame.ts).
 */
export const FRAME_TEXT = Object.freeze({
  youAreOn: 'You’re on ',
  widgetFrom: 'This uses a widget from ',
  unknown: 'Your browser didn’t say which site you’re on.',
  expectedLead: 'It should be ',
  expectedEnd: ': check your browser’s address bar.',
  checkAny: 'Check your browser’s address bar shows a site you trust.',
});

/**
 * The lines that say where the page asking is, for a box of who is asking (FrameSite, core protocol.ts): the top-level
 * page the browser named, then the widget's address; or the widget's address, then that the browser didn't say, with
 * the page to expect when the vault had exactly one.
 */
export function frameLines(d: Dom, parentOrigin: string, frame: FrameSite): HTMLElement[] {
  const widget = d.h('p', { class: 'frame-widget' }, FRAME_TEXT.widgetFrom, originText(d, parentOrigin), '.');
  if (frame.top !== null) return [d.h('p', { class: 'frame-top' }, FRAME_TEXT.youAreOn, originText(d, frame.top), '.'), widget];
  const check = frame.expected !== undefined ? [FRAME_TEXT.expectedLead, originText(d, frame.expected), FRAME_TEXT.expectedEnd] : [FRAME_TEXT.checkAny];
  return [widget, d.h('p', { class: 'frame-unknown' }, FRAME_TEXT.unknown, ' ', ...check)];
}

/**
 * Who is asking, as the sign-in, export and email windows say it: "{lead} at {site}" in one box (`.asker`). Framed
 * (P11): the site is the top-level page the browser named, then a line for the widget; or, when the browser didn't
 * say, "{lead}." and the widget's and the check's lines. Not framed: exactly the one paragraph it always was.
 */
export function askerBox(d: Dom, lead: Child[], parentOrigin: string, frame?: FrameSite): HTMLElement {
  if (!frame) return d.h('p', { class: 'asker' }, ...lead, ' at ', originText(d, parentOrigin));
  if (frame.top !== null) return d.h('div', { class: 'asker asker-framed' }, d.h('p', {}, ...lead, ' at ', originText(d, frame.top)), frameLines(d, parentOrigin, frame)[1]!);
  return d.h('div', { class: 'asker asker-framed' }, d.h('p', {}, ...lead, '.'), ...frameLines(d, parentOrigin, frame));
}

/**
 * An email address as text that wraps at its own break points, the same rule as `originText`: a line may break before
 * `@` and before each `.` (`<wbr>`), and inside a part only when that part alone is wider than the line (auth.css
 * `.mail-address`). Its text content is the address exactly; every part is a text node, so nothing in it can become
 * markup.
 */
export function addressText(d: Dom, address: string, tag: 'span' | 'strong' = 'span', id?: string): HTMLElement {
  const el = d.h(tag, { class: 'mail-address', ...(id ? { attrs: { id } } : {}) });
  address.split(/(?=[@.])/u).forEach((part, i) => {
    if (i > 0) el.append(d.h('wbr'));
    el.append(d.doc.createTextNode(part));
  });
  return el;
}

/**
 * An email address with its mailbox name hidden, for a screen whose sign-in has ended: the first character of the
 * local part, `•••`, then `@` and the domain in full ("a•••@example.com"). A first character that isn't a letter, digit,
 * mark, punctuation or symbol (a control, format or bidi character, a space) is hidden too; so is everything when the
 * address has no `@`. The first character is a whole code point, never half a surrogate pair.
 */
export function maskedAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 0) return '•••';
  const first = Array.from(address.slice(0, at))[0] ?? '';
  const shown = /^[\p{L}\p{N}\p{M}\p{P}\p{S}]$/u.test(first) ? first : '';
  return `${shown}•••@${address.slice(at + 1)}`;
}

/** D853: how a page names an error's code and its request for support, below the plain sentence. */
export const supportCode = (code: string): string => `Error code (for support): ${code}`;
export const supportRequest = (id: string): string => `Request ID (for support): ${id}`;

/** A titled error panel; `code` is the protocol error code, shown small for support. */
export function errorView(d: Dom, title: string, message: string, code?: string): HTMLElement {
  return d.h(
    'section',
    { class: 'panel error', attrs: { role: 'alert' } },
    d.h('h1', {}, title),
    d.h('p', {}, message),
    code ? d.h('p', { class: 'code' }, supportCode(code)) : null,
  );
}

/** A labelled value row (`<dt>`/`<dd>` pair inside a `<dl>`). */
export function row(d: Dom, label: string, ...value: Child[]): HTMLElement[] {
  return [d.h('dt', {}, label), d.h('dd', {}, ...value)];
}

/** A `<dl>` of rows; `cls` adds classes (the design system's `jp-kv`: muted keys, mono values). */
export function rows(d: Dom, entries: (HTMLElement[] | null | undefined | false)[], cls?: string): HTMLDListElement {
  const dl = d.h('dl', cls ? { class: cls } : {});
  for (const e of entries) if (e) dl.append(...e);
  return dl;
}

/**
 * Leaves out every list with no rows (D884's note, 2026-11-23): a list's rules are drawn by where it sits
 * (css/approval.css "the dividers"), so an empty one would draw lines around nothing and hide its neighbours from
 * each other.
 */
export function withoutEmptyLists<T extends HTMLElement>(el: T): T {
  for (const dl of Array.from(el.querySelectorAll('dl'))) if (!dl.firstElementChild) dl.remove();
  return el;
}
