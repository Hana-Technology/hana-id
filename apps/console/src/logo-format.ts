// The byte-level checks of a logo upload and of its re-encoded output (docs/batch-c-spec.md "Other app settings, name
// and logo"; batch C11), with no Workers imports so they are tested on their own:
//
// - sniff: the type by magic bytes only (never the request's Content-Type or a filename): PNG, JPEG or WebP; SVG, GIF,
//   AVIF and everything else are refused;
// - container: the file must be exactly one well-formed image of that type, ending where the format says it ends: no
//   bytes after PNG's IEND, JPEG's EOI or WebP's RIFF size (a polyglot: a second file, HTML or an archive appended),
//   every PNG chunk's CRC right, and no animation (APNG, animated WebP); its header's width and height are returned
//   so the caller can hold them against the decoder's;
// - the output PNG: well formed, 256 × 256, then stripped to its image chunks (IHDR, PLTE, tRNS, IDAT, IEND), so no
//   text, EXIF, ICC profile or timestamp survives whatever the encoder wrote.

export type LogoType = 'image/png' | 'image/jpeg' | 'image/webp';

export const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

const startsWith = (b: Uint8Array, prefix: ArrayLike<number>, at = 0): boolean => {
  if (b.length < at + prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (b[at + i] !== prefix[i]) return false;
  return true;
};
const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n));
const u16be = (b: Uint8Array, at: number): number => (b[at]! << 8) | b[at + 1]!;
const u32be = (b: Uint8Array, at: number): number => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const u32le = (b: Uint8Array, at: number): number => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
const u24le = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);

/** The upload's type by its magic bytes, or null for anything that isn't PNG, JPEG or WebP. */
export function sniffLogoType(b: Uint8Array): LogoType | null {
  if (startsWith(b, PNG_SIGNATURE)) return 'image/png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
  return null;
}

export type ContainerResult = { ok: true; width: number; height: number } | { ok: false; reason: string };
const bad = (reason: string): ContainerResult => ({ ok: false, reason });

// ---- PNG ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (ISO 3309), as PNG computes it over a chunk's type and data. */
export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface PngChunk {
  type: string;
  /** Offset of the chunk's length field. */
  start: number;
  /** Offset just past its CRC. */
  end: number;
}

function pngChunks(b: Uint8Array): { ok: true; chunks: PngChunk[] } | { ok: false; reason: string } {
  if (!startsWith(b, PNG_SIGNATURE)) return { ok: false, reason: 'png_signature' };
  const chunks: PngChunk[] = [];
  let at = PNG_SIGNATURE.length;
  for (;;) {
    if (at + 12 > b.length) return { ok: false, reason: 'png_truncated' };
    const length = u32be(b, at);
    if (length > 0x7fffffff || at + 12 + length > b.length) return { ok: false, reason: 'png_truncated' };
    const type = ascii(b, at + 4, 4);
    if (!/^[A-Za-z]{4}$/u.test(type)) return { ok: false, reason: 'png_chunk_type' };
    if (crc32(b.subarray(at + 4, at + 8 + length)) !== u32be(b, at + 8 + length)) return { ok: false, reason: 'png_crc' };
    const end = at + 12 + length;
    chunks.push({ type, start: at, end });
    at = end;
    if (type === 'IEND') break;
  }
  // Exactly one image: nothing after IEND (an appended archive or page is a polyglot).
  if (at !== b.length) return { ok: false, reason: 'trailing_data' };
  return { ok: true, chunks };
}

function checkPng(b: Uint8Array): ContainerResult {
  const parsed = pngChunks(b);
  if (!parsed.ok) return bad(parsed.reason);
  const { chunks } = parsed;
  const first = chunks[0]!;
  if (first.type !== 'IHDR' || first.end - first.start !== 12 + 13) return bad('png_ihdr');
  if (chunks.filter((c) => c.type === 'IHDR').length !== 1 || !chunks.some((c) => c.type === 'IDAT')) return bad('png_structure');
  // APNG: an animation control chunk (the encoder would keep only the default image; refused, not silently flattened).
  if (chunks.some((c) => c.type === 'acTL' || c.type === 'fcTL' || c.type === 'fdAT')) return bad('animated');
  return { ok: true, width: u32be(b, first.start + 8), height: u32be(b, first.start + 12) };
}

// ---- JPEG ----

/** SOFn markers that carry the frame size (not DHT C4, JPG C8 or DAC CC). */
const isSof = (m: number): boolean => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

function checkJpeg(b: Uint8Array): ContainerResult {
  if (!startsWith(b, [0xff, 0xd8])) return bad('jpeg_soi');
  let at = 2;
  let size: { width: number; height: number } | null = null;
  let scanned = false;
  for (;;) {
    if (at >= b.length || b[at] !== 0xff) return bad('jpeg_marker');
    // Fill bytes before a marker.
    while (at < b.length && b[at] === 0xff) at++;
    if (at >= b.length) return bad('jpeg_truncated');
    const marker = b[at]!;
    at++;
    if (marker === 0xd9) {
      // EOI: the image ends here, and so must the file.
      if (!size || !scanned) return bad('jpeg_structure');
      if (at !== b.length) return bad('trailing_data');
      return { ok: true, ...size };
    }
    if (marker === 0xd8 || marker === 0x00) return bad('jpeg_marker');
    // Markers with no length: TEM and RSTn.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > b.length) return bad('jpeg_truncated');
    const length = u16be(b, at);
    if (length < 2 || at + length > b.length) return bad('jpeg_truncated');
    if (isSof(marker)) {
      if (length < 8 || size) return bad('jpeg_structure');
      size = { height: u16be(b, at + 3), width: u16be(b, at + 5) };
    }
    at += length;
    if (marker === 0xda) {
      // Entropy-coded data up to the next marker that isn't a stuffed 0xFF00 or a restart marker.
      scanned = true;
      for (;;) {
        if (at + 1 >= b.length) return bad('jpeg_truncated');
        if (b[at] === 0xff && b[at + 1] !== 0x00 && !(b[at + 1]! >= 0xd0 && b[at + 1]! <= 0xd7) && b[at + 1] !== 0xff) break;
        at++;
      }
    }
  }
}

// ---- WebP ----

function checkWebp(b: Uint8Array): ContainerResult {
  if (b.length < 20 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return bad('webp_header');
  // The RIFF size covers the rest of the file exactly: anything after it is a second file.
  const riff = u32le(b, 4);
  if (riff + 8 !== b.length) return bad(riff + 8 < b.length ? 'trailing_data' : 'webp_truncated');
  let at = 12;
  let size: { width: number; height: number } | null = null;
  let first = true;
  while (at < b.length) {
    if (at + 8 > b.length) return bad('webp_truncated');
    const fourcc = ascii(b, at, 4);
    const length = u32le(b, at + 4);
    const data = at + 8;
    if (data + length > b.length) return bad('webp_truncated');
    if (fourcc === 'ANIM' || fourcc === 'ANMF') return bad('animated');
    if (first) {
      if (fourcc === 'VP8X') {
        if (length < 10) return bad('webp_vp8x');
        // Flags: bit 1 is animation.
        if (b[data]! & 0x02) return bad('animated');
        size = { width: u24le(b, data + 4) + 1, height: u24le(b, data + 7) + 1 };
      } else if (fourcc === 'VP8L') {
        if (length < 5 || b[data] !== 0x2f) return bad('webp_vp8l');
        const bits = u32le(b, data + 1);
        size = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      } else if (fourcc === 'VP8 ') {
        // Frame tag (3 bytes), start code 9d 01 2a, then 14-bit width and height.
        if (length < 10 || !startsWith(b, [0x9d, 0x01, 0x2a], data + 3)) return bad('webp_vp8');
        size = { width: u16le(b, data + 6) & 0x3fff, height: u16le(b, data + 8) & 0x3fff };
      } else return bad('webp_structure');
      first = false;
    }
    at = data + length + (length & 1);
  }
  if (at !== b.length || !size) return bad('webp_structure');
  return { ok: true, ...size };
}

const u16le = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8);

/** The container check for the sniffed type. */
export function checkContainer(type: LogoType, b: Uint8Array): ContainerResult {
  switch (type) {
    case 'image/png':
      return checkPng(b);
    case 'image/jpeg':
      return checkJpeg(b);
    case 'image/webp':
      return checkWebp(b);
  }
}

// ---- the re-encoded output ----

/** The chunks an image needs; every other one (tEXt, zTXt, iTXt, eXIf, iCCP, tIME, pHYs, …) is dropped. */
export const KEPT_PNG_CHUNKS: ReadonlySet<string> = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);

/**
 * The encoder's PNG with only KEPT_PNG_CHUNKS, after checking it is one well-formed, static PNG of exactly
 * `size` × `size`; null when it isn't.
 */
export function stripPng(b: Uint8Array, size: number): Uint8Array | null {
  const check = checkPng(b);
  if (!check.ok || check.width !== size || check.height !== size) return null;
  const parsed = pngChunks(b);
  if (!parsed.ok) return null;
  const kept = parsed.chunks.filter((c) => KEPT_PNG_CHUNKS.has(c.type));
  const out = new Uint8Array(PNG_SIGNATURE.length + kept.reduce((n, c) => n + (c.end - c.start), 0));
  out.set(PNG_SIGNATURE);
  let at = PNG_SIGNATURE.length;
  for (const c of kept) {
    out.set(b.subarray(c.start, c.end), at);
    at += c.end - c.start;
  }
  return out;
}

/** The chunk types of a PNG, in order (tests and checks). */
export function pngChunkTypes(b: Uint8Array): string[] | null {
  const parsed = pngChunks(b);
  return parsed.ok ? parsed.chunks.map((c) => c.type) : null;
}
