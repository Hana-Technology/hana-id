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
