// DOM helpers shared by the smoke pages. textContent only: API, chain and vault strings are never parsed as HTML.

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

export type Child = Node | string;

export function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

export const code = (text: string): HTMLElement => h('code', {}, text);

export const txLink = (hash: string | null): Child =>
  hash ? h('a', { href: `https://testnet.nearblocks.io/txns/${encodeURIComponent(hash)}`, target: '_blank', rel: 'noreferrer' }, hash) : '—';

export function fillDl(dl: HTMLElement, rows: [string, Child][]): void {
  dl.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}

export const ms = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : String(Math.round(v)));

export function logEvent(text: string, kind: 'info' | 'error' = 'info'): void {
  const line = h('div', kind === 'error' ? { class: 'fail' } : {}, `${new Date().toLocaleTimeString()}  ${text}`);
  $('log').prepend(line);
}

export const setDisabled = (id: string, disabled: boolean): void => {
  ($(id) as HTMLButtonElement).disabled = disabled;
};
