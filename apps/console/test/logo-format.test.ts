// The byte-level logo checks (src/logo-format.ts, batch C11): type by magic bytes, one well-formed image with nothing
// after it (polyglots), no animation, and the output PNG stripped to its image chunks.
import { describe, expect, it } from 'vitest';
import { KEPT_PNG_CHUNKS, PNG_SIGNATURE, checkContainer, crc32, pngChunkTypes, sniffLogoType, stripPng } from '../src/logo-format.ts';
import { AVIF, GIF, HTML_TAIL, METADATA_CHUNKS, SVG, ZIP_TAIL, concat, jpeg, png, pngChunk, webp } from './logo-fixtures.ts';

describe('sniffLogoType', () => {
  it('PNG, JPEG and WebP by their magic bytes', () => {
    expect(sniffLogoType(png(200, 200))).toBe('image/png');
    expect(sniffLogoType(jpeg(200, 200))).toBe('image/jpeg');
    expect(sniffLogoType(webp(200, 200))).toBe('image/webp');
  });

  it('nothing else: SVG, GIF, AVIF, HTML, text, empty', () => {
    for (const b of [SVG, GIF, AVIF, HTML_TAIL, new TextEncoder().encode('\u{FEFF}<svg/>'), new Uint8Array(0), PNG_SIGNATURE.slice(0, 7)]) expect(sniffLogoType(b)).toBeNull();
  });
});

describe('checkContainer', () => {
  it('reads the size from each format’s header', () => {
    expect(checkContainer('image/png', png(300, 280))).toEqual({ ok: true, width: 300, height: 280 });
    expect(checkContainer('image/jpeg', jpeg(640, 512))).toEqual({ ok: true, width: 640, height: 512 });
    expect(checkContainer('image/webp', webp(1024, 900))).toEqual({ ok: true, width: 1024, height: 900 });
    expect(checkContainer('image/webp', webp(300, 300, { extended: true }))).toEqual({ ok: true, width: 300, height: 300 });
  });

  it('refuses a polyglot: anything after the image’s own end (an HTML page, an archive, a second image)', () => {
    for (const tail of [HTML_TAIL, ZIP_TAIL, png(10, 10), Uint8Array.of(0)]) {
      expect(checkContainer('image/png', concat(png(200, 200), tail))).toEqual({ ok: false, reason: 'trailing_data' });
      expect(checkContainer('image/jpeg', jpeg(200, 200, { trailing: tail }))).toEqual({ ok: false, reason: 'trailing_data' });
      expect(checkContainer('image/webp', webp(200, 200, { trailing: tail }))).toEqual({ ok: false, reason: 'trailing_data' });
    }
  });

  it('refuses a PNG with a bad CRC, a truncated chunk, a first chunk that isn’t IHDR, no IDAT', () => {
    const good = png(200, 200);
    const flipped = Uint8Array.from(good);
    flipped[PNG_SIGNATURE.length + 10]! ^= 1;
    expect(checkContainer('image/png', flipped)).toEqual({ ok: false, reason: 'png_crc' });
    expect(checkContainer('image/png', good.slice(0, good.length - 4)).ok).toBe(false);
    expect(checkContainer('image/png', concat(PNG_SIGNATURE, pngChunk('IDAT', new Uint8Array(4)), pngChunk('IEND'))).ok).toBe(false);
    const noIdat = concat(PNG_SIGNATURE, pngChunk('IHDR', new Uint8Array(13)), pngChunk('IEND'));
    expect(checkContainer('image/png', noIdat)).toEqual({ ok: false, reason: 'png_structure' });
  });

  it('refuses animation: APNG and animated WebP', () => {
    expect(checkContainer('image/png', png(200, 200, { extra: [pngChunk('acTL', new Uint8Array(8))] }))).toEqual({ ok: false, reason: 'animated' });
    expect(checkContainer('image/webp', webp(200, 200, { animated: true }))).toEqual({ ok: false, reason: 'animated' });
  });

  it('refuses a JPEG without EOI, with two frames, or with a WebP RIFF size that lies', () => {
    const j = jpeg(200, 200);
    expect(checkContainer('image/jpeg', j.slice(0, j.length - 2)).ok).toBe(false);
    expect(checkContainer('image/jpeg', jpeg(200, 200, { sofs: 2 }))).toEqual({ ok: false, reason: 'jpeg_structure' });
    const w = webp(200, 200);
    expect(checkContainer('image/webp', w.slice(0, w.length - 2)).ok).toBe(false);
  });
});

describe('stripPng', () => {
  it('keeps only the image chunks (no text, EXIF, ICC, time or size metadata), still a valid PNG of the size', () => {
    const encoded = png(256, 256, { extra: METADATA_CHUNKS() });
    expect(pngChunkTypes(encoded)).toEqual(['IHDR', 'tEXt', 'iTXt', 'eXIf', 'iCCP', 'tIME', 'pHYs', 'IDAT', 'IEND']);
    const out = stripPng(encoded, 256)!;
    expect(pngChunkTypes(out)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(checkContainer('image/png', out)).toEqual({ ok: true, width: 256, height: 256 });
    expect(new TextDecoder().decode(out)).not.toMatch(/Comment|xmpmeta|Exif|GPS|icc/u);
    expect([...KEPT_PNG_CHUNKS].sort()).toEqual(['IDAT', 'IEND', 'IHDR', 'PLTE', 'tRNS']);
  });

  it('keeps a palette and its transparency', () => {
    const out = stripPng(png(256, 256, { extra: [pngChunk('PLTE', new Uint8Array(6)), pngChunk('tRNS', new Uint8Array(2)), pngChunk('tEXt', new Uint8Array(3))] }), 256)!;
    expect(pngChunkTypes(out)).toEqual(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
  });

  it('null for an output of another size, an animated or malformed one', () => {
    expect(stripPng(png(256, 255), 256)).toBeNull();
    expect(stripPng(png(256, 256, { extra: [pngChunk('acTL', new Uint8Array(8))] }), 256)).toBeNull();
    expect(stripPng(concat(png(256, 256), HTML_TAIL), 256)).toBeNull();
    expect(stripPng(jpeg(256, 256), 256)).toBeNull();
  });

  it('crc32 is PNG’s (the IEND chunk’s known CRC)', () => {
    expect(crc32(new TextEncoder().encode('IEND')).toString(16)).toBe('ae426082');
  });
});
