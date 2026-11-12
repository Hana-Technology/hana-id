// The wallet-picker name and icon (EIP-6963, SWK): the product's name and the Journear mark, as @hana-id/brand has them.
import { BRAND, MARK_BRACKET, MARK_CARD, MARK_SQUARE_VIEWBOX } from '@hana-id/brand';
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

  it('draws the mark with its own geometry and colours, uncropped and centred (D789)', () => {
    // The brand file's two shapes and colours, in the same order, and its square viewBox (which holds the mark whole and
    // centres it: @hana-id/brand's test checks that against the shapes' bounds).
    const paths = attrs('path', svg);
    expect(paths.map((p) => attr(p, 'd'))).toEqual([MARK_CARD, MARK_BRACKET]);
    expect(paths.map((p) => attr(p, 'fill'))).toEqual(attrs('path', brandMark).map((p) => attr(p, 'fill')));
    expect(attrs('path', brandMark).map((p) => attr(p, 'd'))).toEqual([MARK_CARD, MARK_BRACKET]);
    expect(attr(attrs('svg', svg)[0]!, 'viewBox')).toBe(MARK_SQUARE_VIEWBOX);
    expect(attr(attrs('svg', brandMark)[0]!, 'viewBox')).toBe(MARK_SQUARE_VIEWBOX);
    expect(svg).not.toMatch(/<svg\b[\s\S]*<svg\b|<text|<rect|stroke/u);
  });

  it('stays small: a data: URI of under 1 KB', () => {
    expect(HANA_ID_ICON.length).toBeLessThan(1024);
  });
});
