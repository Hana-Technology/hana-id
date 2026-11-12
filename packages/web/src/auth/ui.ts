// The design system's pieces the auth pages build in code (D765: the Journear Passport design system's components,
// packages/brand components.css). Icons are inline SVG made with createElementNS (no image request, no innerHTML, no
// URL), on the system's 20 px grid with a 1.75 px round stroke (auth.css `.ic`). Alerts are the system's `.jp-alert`:
// an icon, then the content in `.body`, so inline text (an app's name, an origin) keeps flowing as a paragraph.
import type { Child, Dom } from './dom.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The system's icons (its specimen page's symbols), as [viewBox, shapes]. Each shape is an element name and its attributes. */
const ICONS = {
  check: ['0 0 16 16', [['path', { d: 'M3 8.5l3 3 7-7' }]]],
  'check-c': ['0 0 20 20', [['circle', { cx: '10', cy: '10', r: '8' }], ['path', { d: 'M6.5 10.5l2.3 2.3L13.5 8' }]]],
  x: ['0 0 16 16', [['path', { d: 'M4 4l8 8M12 4l-8 8' }]]],
  info: ['0 0 20 20', [['circle', { cx: '10', cy: '10', r: '8' }], ['path', { d: 'M10 9v5M10 6.5v.1' }]]],
  warn: ['0 0 20 20', [['path', { d: 'M10 3l8 14H2z' }], ['path', { d: 'M10 8v4M10 14.5v.1' }]]],
  arrow: ['0 0 16 16', [['path', { d: 'M3 8h10M9 4l4 4-4 4' }]]],
  'chev-r': ['0 0 16 16', [['path', { d: 'M6 4l4 4-4 4' }]]],
  copy: ['0 0 16 16', [['rect', { x: '5.5', y: '5.5', width: '8', height: '8', rx: '1.5' }], ['path', { d: 'M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2' }]]],
  key: ['0 0 20 20', [['circle', { cx: '7', cy: '12', r: '4' }], ['path', { d: 'M10 9l7-7M14 5l2 2M12 7l2 2' }]]],
  mail: ['0 0 20 20', [['rect', { x: '2.5', y: '4.5', width: '15', height: '11', rx: '2' }], ['path', { d: 'M3 6l7 5 7-5' }]]],
  google: [
    '0 0 20 20',
    [
      ['path', { d: 'M17 10.2c0-.6-.1-1.2-.2-1.7H10v3.3h4a3.4 3.4 0 0 1-1.5 2.2v1.9h2.4c1.4-1.3 2.1-3.2 2.1-5.7z', class: 'fill' }],
      ['path', { d: 'M10 17c2 0 3.6-.6 4.9-1.7l-2.4-1.9c-.7.4-1.5.7-2.5.7-1.9 0-3.5-1.3-4.1-3H3.4v2C4.6 15.5 7.1 17 10 17z', class: 'fill', opacity: '.75' }],
      ['path', { d: 'M5.9 11.1A4.3 4.3 0 0 1 5.9 8.9v-2H3.4a7 7 0 0 0 0 6.3l2.5-2z', class: 'fill', opacity: '.55' }],
      ['path', { d: 'M10 5.9c1.1 0 2 .4 2.8 1.1l2.1-2.1A7 7 0 0 0 3.4 6.9l2.5 2c.6-1.8 2.2-3 4.1-3z', class: 'fill', opacity: '.9' }],
    ],
  ],
  wallet: ['0 0 20 20', [['rect', { x: '2.5', y: '5', width: '15', height: '11', rx: '2' }], ['path', { d: 'M2.5 8h15M13 12h2' }]]],
  ext: ['0 0 16 16', [['path', { d: 'M7 3H3.5A.5.5 0 0 0 3 3.5v9a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V9M9 3h4v4M13 3L7 9' }]]],
  shield: ['0 0 16 16', [['path', { d: 'M8 1.5l5.5 2v4c0 3.5-2.5 5.8-5.5 7-3-1.2-5.5-3.5-5.5-7v-4z' }]]],
  trash: ['0 0 16 16', [['path', { d: 'M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.6 8.5h5.8l.6-8.5' }]]],
  plus: ['0 0 16 16', [['path', { d: 'M8 3v10M3 8h10' }]]],
  clock: ['0 0 16 16', [['circle', { cx: '8', cy: '8', r: '6' }], ['path', { d: 'M8 4.5V8l2.5 1.5' }]]],
  eye: ['0 0 16 16', [['path', { d: 'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z' }], ['circle', { cx: '8', cy: '8', r: '2' }]]],
  'eye-off': ['0 0 16 16', [['path', { d: 'M1.5 8s2.5-4.5 6.5-4.5c1.2 0 2.3.4 3.2.9M14.5 8s-2.5 4.5-6.5 4.5c-1.2 0-2.3-.4-3.2-.9M2 14L14 2' }]]],
} as const satisfies Record<string, readonly [string, readonly (readonly [string, Record<string, string>])[]]>;

export type IconName = keyof typeof ICONS;

/** An inline icon (`svg.ic`), decorative (`aria-hidden`): the text beside it says what it means. */
export function icon(d: Dom, name: IconName, cls?: string): SVGSVGElement {
  const [viewBox, shapes] = ICONS[name];
  const svg = d.doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls ? `ic ${cls}` : 'ic');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [tag, attrs] of shapes) {
    const el = d.doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';
const ALERT_ICON: Record<AlertTone, IconName> = { info: 'info', success: 'check-c', warning: 'warn', danger: 'shield' };

/**
 * The system's inline alert (`.jp-alert-{tone}`): its icon, then the content in `.body`. `cls` keeps the page's own
 * classes (`warn`, `note`, `danger`, …: what the page and its tests key on) on the outer element, which is a `p` by
 * default so a one-line notice stays a paragraph. Never floating, never dismissable here (the user can't act on one).
 */
export function alert(d: Dom, tone: AlertTone, props: { tag?: 'p' | 'div' | 'section'; class?: string; attrs?: Record<string, string> }, ...children: Child[]): HTMLElement {
  const body = d.h(props.tag === 'p' || props.tag === undefined ? 'span' : 'div', { class: 'body' }, ...children);
  return d.h(props.tag ?? 'p', { class: `${props.class ? `${props.class} ` : ''}jp-alert jp-alert-${tone}`, ...(props.attrs ? { attrs: props.attrs } : {}) }, icon(d, ALERT_ICON[tone]), body);
}

/** The content element of an alert made by `alert` (where later text goes). */
export const alertBody = (el: HTMLElement): HTMLElement => (el.querySelector(':scope > .body') as HTMLElement | null) ?? el;

/** Button classes (the system's `.jp-btn`): one primary per view, secondary for the others, danger only behind a confirm. */
export const BTN = Object.freeze({
  primary: 'jp-btn jp-btn-primary',
  secondary: 'jp-btn jp-btn-secondary',
  ghost: 'jp-btn jp-btn-ghost',
  danger: 'jp-btn jp-btn-danger',
});
