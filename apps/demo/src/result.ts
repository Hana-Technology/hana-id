// A signing result, in the design system's confirm-and-sign pattern read back: the outcome first (an icon, the
// request's name and what happened, the chain's badge), then the facts as mono key/value rows (a signature, a
// transaction hash, a link), then a note in plain words. Text nodes only: values come from the SDK and the chain.
import { icon } from './toast.ts';

export type ResultChain = 'stellar' | 'evm' | 'near';

export interface ResultFact {
  label: string;
  value: string;
  /** A link instead of a mono value (explorer pages: opened in a new tab, no referrer). */
  href?: string;
}

export interface ResultSpec {
  title: string;
  ok: boolean;
  chain: { kind: ResultChain; name: string };
  facts?: readonly ResultFact[];
  note?: string | null;
}

function h(tag: string, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

export function resultItem(r: ResultSpec): HTMLElement {
  const head = h(
    'div',
    { class: 'result-head' },
    h('span', { class: 'result-icon' }, icon(r.ok ? 'i-check-c' : 'i-x-c')),
    h('span', { class: 'result-title' }, r.title),
    h('span', { class: `jp-chain chain-${r.chain.kind}` }, h('i'), r.chain.name),
  );
  const item = h('li', { class: `result ${r.ok ? 'ok' : 'fail'}` }, head);
  const facts = r.facts ?? [];
  if (facts.length) {
    const dl = h('dl', { class: 'jp-kv' });
    for (const f of facts) {
      const value = f.href ? h('a', { href: f.href, target: '_blank', rel: 'noopener noreferrer' }, f.value) : h('code', {}, f.value);
      dl.append(h('dt', {}, f.label), h('dd', {}, value));
    }
    item.append(dl);
  }
  if (r.note) item.append(h('p', { class: 'result-note' }, r.note));
  return item;
}
