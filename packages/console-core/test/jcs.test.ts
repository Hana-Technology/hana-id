import { describe, expect, it } from 'vitest';
import { canonicalize } from '../src/index.ts';
import vectors from './vectors.json' with { type: 'json' };

describe('canonicalize (RFC 8785)', () => {
  it("gives RFC 8785's own example output", () => {
    const input = JSON.parse(vectors.jcs[0]!.input_json) as unknown;
    // RFC 8785 section 3.2.2 / appendix: the canonical form of the sample object.
    expect(canonicalize(input)).toBe('{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}');
  });

  it('sorts keys by UTF-16 code units (RFC 8785 section 3.2.3)', () => {
    const input = JSON.parse(vectors.jcs[1]!.input_json) as Record<string, string>;
    // The values in output order (Object.values would put the integer-like key "1" first).
    expect([...canonicalize(input).matchAll(/:"([^"]+)"/gu)].map((m) => m[1])).toEqual([
      'Carriage Return',
      'One',
      'Control',
      'Latin Small Letter O With Diaeresis',
      'Euro Sign',
      'Emoji: Grinning Face',
      'Hebrew Letter Dalet With Dagesh',
    ]);
  });

  it('matches the independent implementation', () => {
    for (const j of vectors.jcs) expect(canonicalize(JSON.parse(j.input_json))).toBe(j.canonical);
  });

  it('writes -0 as 0 and large numbers in exponent form', () => {
    expect(canonicalize({ a: -0, b: 1e21, c: 1e-7, d: 123456789012345680000 })).toBe('{"a":0,"b":1e+21,"c":1e-7,"d":123456789012345680000}');
  });

  it('refuses what is not I-JSON', () => {
    for (const bad of [NaN, Infinity, undefined, () => 1, 1n, new Date(0), new Map(), { a: undefined }, '\ud800', { '\udc00': 1 }]) {
      expect(() => canonicalize(bad), String(bad)).toThrow(TypeError);
    }
  });

  it('keeps valid surrogate pairs', () => {
    expect(canonicalize('😀')).toBe('"😀"');
  });
});
