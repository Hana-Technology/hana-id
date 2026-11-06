// Checks of the brand's files for tests (Node only: node:zlib): what a WOFF2 file says about itself (its name table:
// family, version, licence), the tokens' colours, and WCAG contrast. Used by this package's tests and by the apps that
// ship a copy of the fonts (the admin's public/fonts) or the tokens.
import { brotliDecompressSync } from 'node:zlib';

// ---- WOFF2 (https://www.w3.org/TR/WOFF2/): the header, the table directory, one Brotli stream of every table ----

const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp',
  'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL',
  'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx',
  'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];

function base128(buf: Buffer, at: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const b = buf[at + i]!;
    value = value * 128 + (b & 0x7f);
    if (!(b & 0x80)) return [value, at + i + 1];
  }
  throw new Error('bad UIntBase128');
}

/** The name table's English (Windows, en-US) strings of a WOFF2 file, by name ID. */
export function woff2Names(buf: Buffer): Map<number, string> {
  if (buf.subarray(0, 4).toString('latin1') !== 'wOF2') throw new Error('not a WOFF2 file');
  const numTables = buf.readUInt16BE(12);
  const totalCompressedSize = buf.readUInt32BE(20);
  let at = 48;
  const tables: { tag: string; length: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[at++]!;
    const known = flags & 0x3f;
    let tag: string;
    if (known === 0x3f) {
      tag = buf.subarray(at, at + 4).toString('latin1');
      at += 4;
    } else tag = KNOWN_TAGS[known]!;
    const transform = (flags >> 6) & 0x03;
    let origLength: number;
    [origLength, at] = base128(buf, at);
    let length = origLength;
    // glyf and loca are transformed unless their version is 3; every other table only with a non-zero version.
    const transformed = tag === 'glyf' || tag === 'loca' ? transform !== 3 : transform !== 0;
    if (transformed) [length, at] = base128(buf, at);
    tables.push({ tag, length });
  }
  const data = brotliDecompressSync(buf.subarray(at, at + totalCompressedSize));
  let offset = 0;
  for (const t of tables) {
    if (t.tag === 'name') return parseName(data.subarray(offset, offset + t.length));
    offset += t.length;
  }
  throw new Error('no name table');
}

function parseName(t: Buffer): Map<number, string> {
  const count = t.readUInt16BE(2);
  const strings = t.readUInt16BE(4);
  const out = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    const [platform, encoding, language, id, length, off] = [0, 2, 4, 6, 8, 10].map((o) => t.readUInt16BE(r + o)) as [number, number, number, number, number, number];
    if (platform !== 3 || encoding !== 1 || language !== 0x409) continue;
    const raw = t.subarray(strings + off, strings + off + length);
    let s = '';
    for (let j = 0; j + 1 < raw.length; j += 2) s += String.fromCharCode(raw.readUInt16BE(j));
    out.set(id, s);
  }
  return out;
}

// ---- tokens and contrast ----

/** `--name: #rrggbb` declarations of a CSS block (hex colours only). */
export function hexVars(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{6})\b/giu)) out.set(m[1]!, m[2]!.toLowerCase());
  return out;
}

/** The light and dark colours of tokens.css: the first :root block, and the one inside prefers-color-scheme: dark. */
export function tokenSchemes(css: string): { light: Map<string, string>; dark: Map<string, string> } {
  const darkAt = css.indexOf('@media (prefers-color-scheme: dark)');
  if (darkAt < 0) throw new Error('no dark block');
  const light = hexVars(css.slice(0, darkAt));
  // Dark inherits what it doesn't redefine.
  const dark = new Map([...light, ...hexVars(css.slice(darkAt))]);
  return { light, dark };
}

const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** The WCAG 2 contrast ratio of two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
