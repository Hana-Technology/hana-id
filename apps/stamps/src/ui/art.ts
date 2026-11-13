// The passport's artwork, drawn in code as inline SVG (no image files, nothing loaded): the six stamps, their empty
// outlines, the "no gas" chop, the small icons of the recent list, the Journear mark (the brand's own geometry), the
// identity page's portrait and the guilloche behind the pages. Every shape, word and number here is a constant of this
// file, except the stamp's date and time, which are formatted from a number (text.ts); nothing from the view is ever
// put in an attribute. Colours are never set here: every stroke and fill is `currentColor` or a class, and ui.css
// gives each stamp its ink from the brand's tokens, so the art follows the light and dark schemes.
import { MARK_BRACKET, MARK_CARD, MARK_VIEWBOX } from '@hana-id/brand';
import type { StampId } from './types.ts';

const NS = 'http://www.w3.org/2000/svg';
type Attrs = Record<string, string | number>;

/** An SVG element with constant attributes and children (strings become text nodes). */
export function svg(tag: string, attrs: Attrs = {}, ...kids: (Node | string | null | false)[]): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  for (const k of kids) if (k) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e as SVGElement;
}

const g = (attrs: Attrs, ...kids: (Node | string | null | false)[]) => svg('g', attrs, ...kids);
const path = (d: string, attrs: Attrs = {}) => svg('path', { d, ...attrs });
const circle = (cx: number, cy: number, r: number, attrs: Attrs = {}) => svg('circle', { cx, cy, r, ...attrs });

/** A five-pointed star. */
function star(cx: number, cy: number, r: number): SVGElement {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * 0.42;
    pts.push(`${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`);
  }
  return svg('polygon', { points: pts.join(' '), class: 'pp-fill' });
}

/** Straight text, centred on x. */
function text(x: number, y: number, s: string, cls: string, attrs: Attrs = {}): SVGElement {
  return svg('text', { x, y, 'text-anchor': 'middle', class: cls, ...attrs }, s);
}

/** Text along a path kept in the stamp's own <defs>, centred on it. */
function arcText(defs: SVGElement, id: string, d: string, s: string, cls: string): SVGElement {
  defs.append(path(d, { id, fill: 'none' }));
  return svg('text', { class: cls }, svg('textPath', { href: `#${id}`, startOffset: '50%', 'text-anchor': 'middle' }, s));
}

// ---- the six stamps ------------------------------------------------------------------------------------------------
// Each is drawn in a 200 × 200 box, centred on (100, 100), and turned by its own small angle (a hand-stamped look).
// The outline is the stamp's silhouette alone, for the empty slot; the glyph is shared by the stamp and its outline.

interface Design {
  /** Degrees, about the centre. */
  turn: number;
  /** The noise seed of the ink filter (each stamp its own grain). */
  seed: number;
  /** The silhouette, as a path, for the outline and the small icon. */
  silhouette: string;
  glyph(): SVGElement;
  draw(defs: SVGElement, uid: string, date: { day: string; time: string; year: string; dm: string }): SVGElement[];
}

const SHIELD = 'M100 16 C122 26 146 30 168 30 V92 C168 134 140 164 100 184 C60 164 32 134 32 92 V30 C54 30 78 26 100 16 Z';
const HEX = (r: number) => {
  const p: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    p.push(`${(100 + r * Math.cos(a)).toFixed(2)} ${(100 + r * Math.sin(a)).toFixed(2)}`);
  }
  return `M${p.join(' L')} Z`;
};
const CUT_RECT = (x0: number, y0: number, x1: number, y1: number, c: number) =>
  `M${x0 + c} ${y0} H${x1 - c} L${x1} ${y0 + c} V${y1 - c} L${x1 - c} ${y1} H${x0 + c} L${x0} ${y1 - c} V${y0 + c} Z`;
const ELLIPSE = (rx: number, ry: number, cx = 100) => `M${cx - rx} 100 A${rx} ${ry} 0 1 1 ${cx + rx} 100 A${rx} ${ry} 0 1 1 ${cx - rx} 100 Z`;
/** The postmark's silhouette: its ring and the space of its wavy lines. */
const POSTMARK_RING = ELLIPSE(62, 62, 80);
const WAVES = [70, 85, 100, 115, 130].map((y) => `M146 ${y} q3.75 -5 7.5 0 t7.5 0 t7.5 0 t7.5 0 t7.5 0 t7.5 0`);

/** An airliner seen from above, nose up, about 24 units long, centred on its own origin. */
const PLANE =
  'M0 -12.5 C1.6 -12.5 2.2 -10.8 2.2 -9.2 V-3.2 L11.5 2.2 V4.8 L2.2 2.2 V7.2 L5.4 9.8 V11.6 L0 10.3 L-5.4 11.6 V9.8 L-2.2 7.2 V2.2 L-11.5 4.8 V2.2 L-2.2 -3.2 V-9.2 C-2.2 -10.8 -1.6 -12.5 0 -12.5 Z';

const DESIGNS: Record<StampId, Design> = {
  arrival: {
    turn: -8,
    seed: 3,
    silhouette: ELLIPSE(90, 90),
    glyph: () =>
      g(
        {},
        path(PLANE, { transform: 'translate(100 73) rotate(118) scale(1.25)', class: 'pp-fill' }),
        path('M70 96 H130', { class: 'pp-line', 'stroke-width': 2.2 }),
      ),
    draw(defs, uid, d) {
      return [
        circle(100, 100, 90, { class: 'pp-line', 'stroke-width': 4.5 }),
        circle(100, 100, 84, { class: 'pp-line', 'stroke-width': 1.2 }),
        circle(100, 100, 53, { class: 'pp-line', 'stroke-width': 1.6 }),
        arcText(defs, `${uid}-t`, 'M37 100 A63 63 0 0 1 163 100', 'ARRIVAL', 'pp-t pp-t-arc'),
        arcText(defs, `${uid}-b`, 'M26 100 A74 74 0 0 0 174 100', 'NEAR · TESTNET', 'pp-t pp-t-small'),
        star(31, 100, 5.5),
        star(169, 100, 5.5),
        this.glyph(),
        path('M48 103 H152 M54 127 H146', { class: 'pp-line', 'stroke-width': 1.4 }),
        text(100, 120, d.day, 'pp-t pp-t-date pp-t-date-sm'),
        text(100, 142, 'JOURNEAR', 'pp-t pp-t-tiny'),
      ];
    },
  },
  sponsored: {
    turn: 5,
    seed: 7,
    silhouette: CUT_RECT(18, 42, 182, 158, 14),
    glyph: () =>
      g(
        {},
        path('M40 78 H160 Q164 78 164 82 V93 A7 7 0 0 0 164 107 V118 Q164 122 160 122 H40 Q36 122 36 118 V107 A7 7 0 0 0 36 93 V82 Q36 78 40 78 Z', {
          class: 'pp-line',
          'stroke-width': 2.2,
        }),
        path('M57 82 V118', { class: 'pp-line', 'stroke-width': 1.4, 'stroke-dasharray': '3 3' }),
        star(47.5, 100, 4.5),
      ),
    draw(_defs, _uid, d) {
      return [
        path(CUT_RECT(18, 42, 182, 158, 14), { class: 'pp-line', 'stroke-width': 4.5 }),
        path(CUT_RECT(24, 48, 176, 152, 11), { class: 'pp-line', 'stroke-width': 1.2 }),
        text(100, 68, 'JOURNEAR RELAY', 'pp-t pp-t-small'),
        this.glyph(),
        text(108.5, 105, 'FARE PAID', 'pp-t pp-t-ticket'),
        text(100, 142, d.day, 'pp-t pp-t-date'),
      ];
    },
  },
  own_fare: {
    turn: -3,
    seed: 11,
    silhouette: ELLIPSE(90, 62),
    glyph: () =>
      g(
        {},
        circle(100, 91, 16, { class: 'pp-line', 'stroke-width': 2.4 }),
        circle(100, 91, 11.5, { class: 'pp-line', 'stroke-width': 0.9 }),
        path('M94.5 97.5 V84.5 L105.5 97.5 V84.5', { class: 'pp-line', 'stroke-width': 2.2 }),
      ),
    draw(defs, uid, d) {
      return [
        path(ELLIPSE(90, 62), { class: 'pp-line', 'stroke-width': 4.5 }),
        path(ELLIPSE(84, 56), { class: 'pp-line', 'stroke-width': 1.2 }),
        arcText(defs, `${uid}-t`, 'M32 100 A68 41 0 0 1 168 100', 'OWN FARE', 'pp-t pp-t-arc'),
        arcText(defs, `${uid}-b`, 'M24 100 A76 49 0 0 0 176 100', 'PAID IN NEAR', 'pp-t pp-t-small'),
        star(27, 100, 5),
        star(173, 100, 5),
        this.glyph(),
        text(100, 127, d.day, 'pp-t pp-t-date'),
      ];
    },
  },
  signature: {
    turn: 6,
    seed: 17,
    silhouette: SHIELD,
    glyph: () =>
      g(
        {},
        path('M52 114 C58 98 68 90 71 101 C74 113 64 124 75 119 C86 114 87 98 95 103 C102 107 97 121 107 116 C117 111 120 100 128 105 C134 109 132 117 146 108', {
          class: 'pp-line',
          'stroke-width': 2.8,
        }),
        path('M141 104 L154 95 L157 99 L145 108 Z', { class: 'pp-fill' }),
        path('M56 127 H144', { class: 'pp-line', 'stroke-width': 1.2 }),
      ),
    draw(defs, uid, d) {
      const clip = svg('clipPath', { id: `${uid}-c` }, path(SHIELD, { transform: 'translate(100 100) scale(.9) translate(-100 -100)' }));
      const mask = svg(
        'mask',
        { id: `${uid}-m`, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: 200, height: 200 },
        svg('rect', { x: 0, y: 0, width: 200, height: 200, fill: 'white' }),
        text(100, 67.5, 'SIGNATURE', 'pp-t pp-t-knock', { fill: 'black' }),
      );
      defs.append(clip, mask);
      return [
        path(SHIELD, { class: 'pp-line', 'stroke-width': 4.5 }),
        path(SHIELD, { class: 'pp-line', 'stroke-width': 1.3, transform: 'translate(100 100) scale(.9) translate(-100 -100)' }),
        svg('rect', { x: 20, y: 50, width: 160, height: 24, class: 'pp-fill', 'clip-path': `url(#${uid}-c)`, mask: `url(#${uid}-m)` }),
        this.glyph(),
        text(100, 143, d.day, 'pp-t pp-t-date pp-t-date-sm'),
        text(100, 157, 'NEP-413', 'pp-t pp-t-tiny'),
      ];
    },
  },
  postcard: {
    turn: -5,
    seed: 23,
    silhouette: `${POSTMARK_RING} ${WAVES.join(' ')}`,
    glyph: () =>
      g(
        {},
        svg('rect', { x: 66, y: 70, width: 28, height: 19, rx: 1.5, class: 'pp-line', 'stroke-width': 2 }),
        path('M67 71.5 L80 81.5 L93 71.5', { class: 'pp-line', 'stroke-width': 1.6 }),
      ),
    draw(defs, uid, d) {
      return [
        path(ELLIPSE(62, 62, 80), { class: 'pp-line', 'stroke-width': 4 }),
        path(ELLIPSE(56, 56, 80), { class: 'pp-line', 'stroke-width': 1.2 }),
        arcText(defs, `${uid}-t`, 'M37 100 A43 43 0 0 1 123 100', 'POSTCARD', 'pp-t pp-t-arc pp-t-arc-sm'),
        arcText(defs, `${uid}-b`, 'M29 100 A51 51 0 0 0 131 100', 'JOURNEAR POST', 'pp-t pp-t-tiny'),
        this.glyph(),
        text(80, 105, d.dm, 'pp-t pp-t-date'),
        text(80, 119, d.year, 'pp-t pp-t-date pp-t-date-sm'),
        ...WAVES.map((w) => path(w, { class: 'pp-line', 'stroke-width': 3 })),
      ];
    },
  },
  layover: {
    turn: 4,
    seed: 29,
    silhouette: HEX(88),
    glyph: () => {
      const cy = 72;
      const ticks: string[] = [];
      for (let i = 0; i < 12; i++) {
        const a = (Math.PI / 6) * i;
        const r0 = i % 3 === 0 ? 14 : 16;
        ticks.push(`M${(100 + r0 * Math.sin(a)).toFixed(2)} ${(cy - r0 * Math.cos(a)).toFixed(2)} L${(100 + 18.5 * Math.sin(a)).toFixed(2)} ${(cy - 18.5 * Math.cos(a)).toFixed(2)}`);
      }
      return g(
        {},
        path(`M100 ${cy} L100 ${cy - 18.5} A18.5 18.5 0 0 1 ${(100 + 18.5 * Math.sin(Math.PI / 3)).toFixed(2)} ${(cy - 18.5 * Math.cos(Math.PI / 3)).toFixed(2)} Z`, { class: 'pp-fill pp-soft' }),
        circle(100, cy, 21.5, { class: 'pp-line', 'stroke-width': 2.4 }),
        path(ticks.join(' '), { class: 'pp-line', 'stroke-width': 1.3 }),
        path(`M100 ${cy} V${cy - 15} M100 ${cy} L109 ${cy + 5}`, { class: 'pp-line', 'stroke-width': 2.4 }),
        circle(100, cy, 2.2, { class: 'pp-fill' }),
      );
    },
    draw(_defs, _uid, d) {
      return [
        path(HEX(88), { class: 'pp-line', 'stroke-width': 4.5 }),
        path(HEX(81), { class: 'pp-line', 'stroke-width': 1.2 }),
        star(62, 72, 5),
        star(138, 72, 5),
        this.glyph(),
        path('M34 101 H166', { class: 'pp-line', 'stroke-width': 1.3 }),
        text(100, 122, 'LAYOVER', 'pp-t pp-t-band pp-t-wide'),
        path('M38 130 H162', { class: 'pp-line', 'stroke-width': 1.3 }),
        text(100, 152, d.day, 'pp-t pp-t-date pp-t-date-sm'),
      ];
    },
  },
};

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const;

/** The ink filters, one per stamp (its own grain), kept once in each mounted passport's hidden <svg>. */
export function inkDefs(prefix: string): SVGElement {
  const defs = svg('defs');
  for (const [id, design] of Object.entries(DESIGNS)) defs.append(inkFilter(`${prefix}-ink-${id}`, design.seed));
  defs.append(inkFilter(`${prefix}-ink-chop`, 41));
  return svg('svg', { class: 'pp-defs', 'aria-hidden': 'true', focusable: 'false', width: 0, height: 0 }, defs);
}

/**
 * Rubber-stamp ink, cheaply: the edges roughened a little (displacement by a low-frequency noise), then the ink thinned
 * in a fine grain and in broad patches of lighter pressure (two noises turned into alpha and multiplied).
 */
function inkFilter(id: string, seed: number): SVGElement {
  return svg(
    'filter',
    { id, x: '-6%', y: '-6%', width: '112%', height: '112%', 'color-interpolation-filters': 'sRGB' },
    svg('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.045', numOctaves: 2, seed, result: 'warp' }),
    svg('feDisplacementMap', { in: 'SourceGraphic', in2: 'warp', scale: 2.6, xChannelSelector: 'R', yChannelSelector: 'G', result: 'rough' }),
    svg('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.85', numOctaves: 1, seed: seed + 1, result: 'grain' }),
    svg('feColorMatrix', { in: 'grain', type: 'matrix', values: '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -4.2 0 0 0 3.05', result: 'grainA' }),
    svg('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.018', numOctaves: 2, seed: seed + 2, result: 'press' }),
    svg('feColorMatrix', { in: 'press', type: 'matrix', values: '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -1.7 0 0 0 1.78', result: 'pressA' }),
    svg('feComposite', { in: 'grainA', in2: 'pressA', operator: 'arithmetic', k1: 1, k2: 0, k3: 0, k4: 0, result: 'mask' }),
    svg('feComposite', { in: 'rough', in2: 'mask', operator: 'in' }),
  );
}

/** A collected stamp, inked, with its date (UTC) in it. `label` is the accessible name (constant words and the date). */
export function stampArt(id: StampId, atMs: number, prefix: string, label: string): SVGElement {
  const design = DESIGNS[id];
  const ok = Number.isFinite(atMs) && Math.abs(atMs) <= 8.64e15;
  const dt = new Date(ok ? atMs : 0);
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  const mon = MONTHS[dt.getUTCMonth()]!;
  const year = String(dt.getUTCFullYear());
  const date = ok
    ? { day: `${dd} ${mon} ${year}`, dm: `${dd} ${mon}`, year, time: `${String(dt.getUTCHours()).padStart(2, '0')}:${String(dt.getUTCMinutes()).padStart(2, '0')}` }
    : { day: '', dm: '', year: '', time: '' };
  const uid = `${prefix}-${id}-${ok ? atMs : 'x'}`;
  const defs = svg('defs');
  const parts = design.draw(defs, uid, date);
  return svg(
    'svg',
    { class: 'pp-stamp', viewBox: '0 0 200 200', role: 'img', 'aria-label': label, focusable: 'false' },
    defs,
    g({ transform: `rotate(${design.turn} 100 100)`, filter: `url(#${prefix}-ink-${id})` }, ...parts),
  );
}

/** The empty slot: the stamp's silhouette and glyph, faint (CSS draws it dashed when it can be collected). */
export function outlineArt(id: StampId): SVGElement {
  const design = DESIGNS[id];
  return svg(
    'svg',
    { class: 'pp-outline', viewBox: '0 0 200 200', 'aria-hidden': 'true', focusable: 'false' },
    g(
      { transform: `rotate(${design.turn} 100 100)` },
      path(design.silhouette, { class: 'pp-sil' }),
      g({ class: 'pp-ghost' }, design.glyph()),
      // A padlock, shown only while the slot is locked.
      g(
        { class: 'pp-lock' },
        svg('rect', { x: 89, y: 128, width: 22, height: 17, rx: 3, class: 'pp-fill' }),
        path('M93.5 128 V123 A6.5 6.5 0 0 1 106.5 123 V128', { class: 'pp-line', 'stroke-width': 2.4 }),
      ),
    ),
  );
}

/** The relay's "no gas" chop, stamped over the corner of a sponsored stamp. */
export function chopArt(prefix: string): SVGElement {
  return svg(
    'svg',
    { class: 'pp-chop', viewBox: '0 0 96 46', 'aria-hidden': 'true', focusable: 'false' },
    g(
      { transform: 'rotate(-12 48 23)', filter: `url(#${prefix}-ink-chop)` },
      svg('rect', { x: 4, y: 5, width: 88, height: 36, rx: 5, class: 'pp-line', 'stroke-width': 2.6 }),
      svg('rect', { x: 8.5, y: 9.5, width: 79, height: 27, rx: 2.5, class: 'pp-line', 'stroke-width': 0.9 }),
      text(48, 26.5, 'NO GAS', 'pp-t pp-t-chop'),
      text(48, 34, 'RELAY PAID', 'pp-t pp-t-chop-sm'),
    ),
  );
}

/** A small icon of a stamp for the recent list: its silhouette and glyph, in its ink. */
export function miniArt(id: StampId): SVGElement {
  const design = DESIGNS[id];
  return svg(
    'svg',
    { class: 'pp-mini', viewBox: '0 0 200 200', 'aria-hidden': 'true', focusable: 'false' },
    g({ transform: `rotate(${design.turn} 100 100)` }, path(design.silhouette, { class: 'pp-line pp-mini-sil' }), design.glyph()),
  );
}

/** The Journear mark, from the brand's geometry (D789): the card and the bracket, coloured by ui.css. */
export function markArt(cls: string): SVGElement {
  return svg(
    'svg',
    { class: cls, viewBox: MARK_VIEWBOX, 'aria-hidden': 'true', focusable: 'false' },
    path(MARK_CARD, { class: 'pp-mark-card' }),
    path(MARK_BRACKET, { class: 'pp-mark-bracket' }),
  );
}

/** The e-passport symbol (a chip: a circle between two bars, in a rectangle), as on a real biometric passport's cover. */
export function chipArt(): SVGElement {
  return svg(
    'svg',
    { class: 'pp-chip', viewBox: '0 0 48 30', 'aria-hidden': 'true', focusable: 'false' },
    svg('rect', { x: 1.5, y: 1.5, width: 45, height: 27, rx: 2, class: 'pp-line', 'stroke-width': 2 }),
    path('M8 15 H15 M33 15 H40', { class: 'pp-line', 'stroke-width': 2 }),
    circle(24, 15, 7, { class: 'pp-line', 'stroke-width': 2 }),
  );
}

/** FNV-1a, 32 bits: a small stable hash for the portrait. */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The identity page's "photo": a mirrored 5 × 5 pattern from the account id, the same every time for one account. */
export function portraitArt(accountId: string): SVGElement {
  const h1 = fnv(accountId);
  const h2 = fnv(`${accountId}#`);
  const cells: SVGElement[] = [];
  let bit = 0;
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 3; x++) {
      const on = ((bit < 32 ? h1 >>> bit : h2 >>> (bit - 32)) & 1) === 1;
      bit++;
      if (!on) continue;
      for (const xx of x === 2 ? [2] : [x, 4 - x]) cells.push(svg('rect', { x: 4 + xx * 8, y: 4 + y * 8, width: 8, height: 8 }));
    }
  }
  return svg('svg', { class: 'pp-portrait', viewBox: '0 0 48 56', 'aria-hidden': 'true', focusable: 'false' }, g({ class: 'pp-portrait-cells' }, ...cells));
}

/**
 * The fine security print of a passport page (a guilloche): rows of interlaced sine waves, drawn once per page
 * behind its content, in a hairline of the page's tint.
 */
export function guillocheArt(): SVGElement {
  const rows: string[] = [];
  for (let k = 0; k < 2; k++) {
    for (let row = 0; row < 14; row++) {
      const y0 = 20 + row * 40;
      let d = `M-20 ${y0}`;
      for (let x = -20; x <= 620; x += 10) {
        const phase = k === 0 ? 0 : Math.PI;
        const y = y0 + 9 * Math.sin((x / 80) * Math.PI * 2 + phase + row * 0.6);
        d += ` L${x} ${y.toFixed(1)}`;
      }
      rows.push(d);
    }
  }
  return svg(
    'svg',
    { class: 'pp-guilloche', viewBox: '0 0 600 600', preserveAspectRatio: 'xMidYMid slice', 'aria-hidden': 'true', focusable: 'false' },
    path(rows.join(' '), { class: 'pp-guil-line' }),
  );
}
