// Image files for the logo tests (batch C11), built byte by byte: the container checks read structure only (chunks,
// segments, RIFF sizes), and the Images binding is a fake (docs/batch-c-spec.md "Tests": the Images binding is
// mocked), so no real pixels are needed. The fake decodes sizes from the same headers a real decoder reads.
import { checkContainer, crc32, PNG_SIGNATURE, sniffLogoType } from '../src/logo-format.ts';

const enc = new TextEncoder();
const u32be = (n: number) => Uint8Array.of(n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
const u32le = (n: number) => Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24);
const u16be = (n: number) => Uint8Array.of(n >>> 8, n & 0xff);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function pngChunk(type: string, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  const body = concat(enc.encode(type), data);
  return concat(u32be(data.length), body, u32be(crc32(body)));
}

/** A PNG of the given size: IHDR, the extra chunks, an IDAT of `idat` bytes, IEND. */
export function png(width: number, height: number, o: { extra?: Uint8Array[]; idat?: number; seed?: number } = {}): Uint8Array {
  const ihdr = concat(u32be(width), u32be(height), Uint8Array.of(8, 6, 0, 0, 0));
  const idat = new Uint8Array(o.idat ?? 32).map((_, i) => (i * 31 + (o.seed ?? 0)) & 0xff);
  return concat(PNG_SIGNATURE, pngChunk('IHDR', ihdr), ...(o.extra ?? []), pngChunk('IDAT', idat), pngChunk('IEND'));
}

/** The metadata an encoder might leave in: text, EXIF, an ICC profile, a timestamp, physical size. */
export const METADATA_CHUNKS = (): Uint8Array[] => [
  pngChunk('tEXt', enc.encode('Comment\0made by someone')),
  pngChunk('iTXt', enc.encode('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>')),
  pngChunk('eXIf', enc.encode('MM\0*GPS')),
  pngChunk('iCCP', enc.encode('icc\0\0profile')),
  pngChunk('tIME', Uint8Array.of(7, 234, 11, 4, 12, 0, 0)),
  pngChunk('pHYs', new Uint8Array(9)),
];

/** A baseline JPEG: SOI, APP0 (JFIF), APP1 (EXIF), SOF0 with the size, SOS, entropy data with a stuffed 0xFF00, EOI. */
export function jpeg(width: number, height: number, o: { trailing?: Uint8Array; sofs?: number } = {}): Uint8Array {
  const seg = (marker: number, data: Uint8Array) => concat(Uint8Array.of(0xff, marker), u16be(data.length + 2), data);
  const sof = seg(0xc0, concat(Uint8Array.of(8), u16be(height), u16be(width), Uint8Array.of(1, 1, 0x11, 0)));
  return concat(
    Uint8Array.of(0xff, 0xd8),
    seg(0xe0, enc.encode('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')),
    seg(0xe1, enc.encode('Exif\0\0MM\0*GPS-here')),
    ...Array.from({ length: o.sofs ?? 1 }, () => sof),
    seg(0xda, Uint8Array.of(1, 1, 0, 0, 63, 0)),
    Uint8Array.of(0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78),
    Uint8Array.of(0xff, 0xd9),
    o.trailing ?? new Uint8Array(0),
  );
}

/** A lossless WebP (VP8L) of the given size, or an extended one (VP8X) with the animation flag. */
export function webp(width: number, height: number, o: { animated?: boolean; extended?: boolean; trailing?: Uint8Array } = {}): Uint8Array {
  const chunk = (fourcc: string, data: Uint8Array) => concat(enc.encode(fourcc), u32le(data.length), data, data.length & 1 ? Uint8Array.of(0) : new Uint8Array(0));
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const vp8l = chunk('VP8L', concat(Uint8Array.of(0x2f), u32le(bits >>> 0), Uint8Array.of(0, 0, 0)));
  const u24 = (n: number) => Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff);
  const vp8x = chunk('VP8X', concat(Uint8Array.of(o.animated ? 0x02 : 0, 0, 0, 0), u24(width - 1), u24(height - 1)));
  const body = concat(enc.encode('WEBP'), ...(o.extended || o.animated ? [vp8x] : []), ...(o.animated ? [chunk('ANIM', new Uint8Array(6))] : []), vp8l);
  return concat(enc.encode('RIFF'), u32le(body.length), body, o.trailing ?? new Uint8Array(0));
}

export const SVG = enc.encode('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><script>alert(1)</script></svg>');
export const GIF = concat(enc.encode('GIF89a'), Uint8Array.of(0, 1, 0, 1, 0, 0, 0), enc.encode(';'));
export const AVIF = concat(u32be(28), enc.encode('ftypavif'), new Uint8Array(16));
export const HTML_TAIL = enc.encode('<!doctype html><script>alert(document.domain)</script>');
/** An archive appended after the image (a GIFAR-style polyglot). */
export const ZIP_TAIL = concat(Uint8Array.of(0x50, 0x4b, 0x03, 0x04), new Uint8Array(26), enc.encode('a.html'));

export interface FakeImages extends ImagesBinding {
  calls: { info: number; transforms: unknown[]; outputs: unknown[] };
}

/**
 * The Images binding as a fake: `info` reads the size from the headers (as a decoder would) unless overridden; the
 * transform answers `output` (default: a 256 × 256 PNG full of metadata chunks), recording what it was asked.
 */
export function fakeImages(o: { info?: (b: Uint8Array) => ImageInfoResponse; output?: Uint8Array; contentType?: string; throwOnInfo?: unknown } = {}): FakeImages {
  const calls = { info: 0, transforms: [] as unknown[], outputs: [] as unknown[] };
  const read = async (s: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(s).arrayBuffer());
  const decode = (b: Uint8Array): ImageInfoResponse => {
    const type = sniffLogoType(b);
    if (!type) throw Object.assign(new Error('not an image'), { code: 9412 });
    const c = checkContainer(type, b);
    if (!c.ok) throw Object.assign(new Error('not an image'), { code: 9412 });
    return { format: type, fileSize: b.length, width: c.width, height: c.height };
  };
  const output = o.output ?? png(256, 256, { extra: METADATA_CHUNKS() });
  const images = {
    calls,
    async info(stream: ReadableStream<Uint8Array>) {
      calls.info += 1;
      const b = await read(stream);
      if (o.throwOnInfo) throw o.throwOnInfo;
      return (o.info ?? decode)(b);
    },
    input(stream: ReadableStream<Uint8Array>) {
      const t = {
        transform(x: unknown) {
          calls.transforms.push(x);
          return t;
        },
        draw() {
          return t;
        },
        async output(x: unknown) {
          calls.outputs.push(x);
          await read(stream);
          return {
            contentType: () => o.contentType ?? 'image/png',
            image: () => new Response(output).body as ReadableStream<Uint8Array>,
            response: () => new Response(output),
          };
        },
      };
      return t;
    },
    text() {
      throw new Error('not used');
    },
    hosted: {} as never,
  };
  return images as unknown as FakeImages;
}
