// The wallet-picker name and icon (EIP-6963, SWK): the product's name and the Journear mark, as @hana-id/brand has them.
import { BRAND, MARK_CHEVRON, MARK_FRAME } from '@hana-id/brand';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HANA_ID_ICON, HANA_ID_NAME } from '../../src/client/icon.ts';

const PREFIX = 'data:image/svg+xml,';
const svg = decodeURIComponent(HANA_ID_ICON.slice(PREFIX.length));
const brandMark = readFileSync(fileURLToPath(new URL('../../../brand/logo/journear-mark.svg', import.meta.url)), 'utf8');
const attrs = (tag: string, source: string): string[] => [...source.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'gu'))].map((m) => m[0]);
const attr = (el: string, name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`, 'u').exec(el)?.[1];

describe('the wallet-picker name and icon', () => {
  it('names the product (BRAND.product)', () => {
    expect(HANA_ID_NAME).toBe(BRAND.product);
  });

  it('is a self-contained 96×96 SVG data: URI with a square viewBox (EIP-6963)', () => {
    expect(HANA_ID_ICON.startsWith(PREFIX)).toBe(true);
    const root = attrs('svg', svg)[0]!;
    expect(attr(root, 'width')).toBe('96');
    expect(attr(root, 'height')).toBe('96');
    const [, , w, h] = attr(root, 'viewBox')!.split(' ').map(Number);
    expect(w).toBe(h);
    expect(svg).not.toMatch(/href|url\(|<image|<script|<style/iu);
  });

  it('draws the mark with its own geometry and colours, uncropped', () => {
    const [rect] = attrs('rect', svg);
    expect(attrs('rect', svg)).toHaveLength(1);
    for (const k of ['x', 'y', 'width', 'height', 'rx'] as const) expect(Number(attr(rect!, k))).toBe(MARK_FRAME[k]);
    expect(Number(attr(rect!, 'stroke-width'))).toBe(MARK_FRAME.strokeWidth);
    const paths = attrs('path', svg);
    expect(paths.map((p) => attr(p, 'd'))).toEqual([...MARK_CHEVRON.paths]);
    for (const p of paths) expect(Number(attr(p, 'stroke-width'))).toBe(MARK_CHEVRON.strokeWidth);
    // The colours are journear-mark.svg's: frame, then chevron and tail.
    const brandStrokes = [...attrs('rect', brandMark), ...attrs('path', brandMark)].map((e) => attr(e, 'stroke'));
    expect([rect, ...paths].map((e) => attr(e!, 'stroke'))).toEqual(brandStrokes);
    // The viewBox holds the tail's round cap (x up to 100 + 12/2) and the frame's stroke, and centres the mark.
    const [x, y, w, h] = attr(attrs('svg', svg)[0]!, 'viewBox')!.split(' ').map(Number) as [number, number, number, number];
    const left = MARK_FRAME.x - MARK_FRAME.strokeWidth / 2;
    const right = 100 + MARK_CHEVRON.strokeWidth / 2;
    expect(left - x).toBe(x + w - right);
    expect(left - x).toBeGreaterThanOrEqual(0);
    const top = MARK_FRAME.y - MARK_FRAME.strokeWidth / 2;
    const bottom = MARK_FRAME.y + MARK_FRAME.height + MARK_FRAME.strokeWidth / 2;
    expect(top - y).toBe(y + h - bottom);
  });
});
