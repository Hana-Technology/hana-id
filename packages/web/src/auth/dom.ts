// DOM helpers for the auth pages. Every string reaches the page through textContent or a text node, never innerHTML,
// so partner-controlled values (app names, origins, policy labels, decoded request fields) can't become markup.

export type Child = Node | string | null | undefined | false;

export interface Dom {
  readonly doc: Document;
  /** An element with optional class and attributes, and children (strings become text nodes). */
  h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: { class?: string; attrs?: Record<string, string> }, ...children: Child[]): HTMLElementTagNameMap[K];
  /** Replaces the page's content (the `#app` element, or the body). */
  show(...children: Child[]): void;
}

export function dom(doc: Document): Dom {
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

/** A titled error panel; `code` is the protocol error code, shown small for support. */
export function errorView(d: Dom, title: string, message: string, code?: string): HTMLElement {
  return d.h(
    'section',
    { class: 'panel error', attrs: { role: 'alert' } },
    d.h('h1', {}, title),
    d.h('p', {}, message),
    code ? d.h('p', { class: 'code' }, `Code: ${code}`) : null,
  );
}

/** A labelled value row (`<dt>`/`<dd>` pair inside a `<dl>`). */
export function row(d: Dom, label: string, ...value: Child[]): HTMLElement[] {
  return [d.h('dt', {}, label), d.h('dd', {}, ...value)];
}

/** A `<dl>` of rows. */
export function rows(d: Dom, entries: (HTMLElement[] | null | undefined | false)[]): HTMLDListElement {
  const dl = d.h('dl');
  for (const e of entries) if (e) dl.append(...e);
  return dl;
}
