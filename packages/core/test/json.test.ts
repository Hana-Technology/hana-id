import { describe, expect, it } from 'vitest';
import { DecodeError, JSON_MAX_DEPTH, JsonNumber, isJsonObject, parseStrictJson } from '../src/index.ts';

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof DecodeError ? e.code : `not a DecodeError: ${String(e)}`;
  }
  return 'no error';
};

describe('parseStrictJson', () => {
  it('parses every JSON value kind', () => {
    const v = parseStrictJson(' {"a": [1, -2.5e3, "x\\u00e9\\n", true, false, null, {}], "b": {"c": "d"}} ');
    expect(isJsonObject(v)).toBe(true);
    const o = v as Record<string, unknown>;
    const a = o.a as unknown[];
    expect((a[0] as JsonNumber).raw).toBe('1');
    expect((a[1] as JsonNumber).raw).toBe('-2.5e3');
    expect(a.slice(2)).toEqual(['xé\n', true, false, null, Object.create(null)]);
    expect((o.b as Record<string, unknown>).c).toBe('d');
  });

  it('keeps big numbers exact', () => {
    const v = parseStrictJson('123456789012345678901234567890123456789');
    expect(v).toBeInstanceOf(JsonNumber);
    expect((v as JsonNumber).raw).toBe('123456789012345678901234567890123456789');
  });

  it('refuses duplicate keys, including after unescaping', () => {
    expect(code(() => parseStrictJson('{"a":1,"a":2}'))).toBe('malformed');
    expect(code(() => parseStrictJson('{"a":1,"\\u0061":2}'))).toBe('malformed');
    expect(code(() => parseStrictJson('{"x":{"a":1,"a":1}}'))).toBe('malformed');
  });

  it('builds null-prototype objects, so __proto__ is an ordinary key', () => {
    const v = parseStrictJson('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(v)).toBeNull();
    expect(Object.keys(v)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses lone surrogates but accepts pairs', () => {
    expect(code(() => parseStrictJson('"\\ud800"'))).toBe('malformed');
    expect(code(() => parseStrictJson('"\\udc00x"'))).toBe('malformed');
    expect(parseStrictJson('"\\ud83d\\ude00"')).toBe('\u{1f600}');
  });

  it.each([
    ['trailing characters', '{} x'],
    ['two values', '1 2'],
    ['a trailing comma', '[1,]'],
    ['a leading zero', '01'],
    ['a bare decimal point', '1.'],
    ['single quotes', "{'a':1}"],
    ['an unquoted key', '{a:1}'],
    ['a raw control character', '"a\nb"'],
    ['a bad escape', '"\\x41"'],
    ['a short \\u escape', '"\\u12"'],
    ['NaN', 'NaN'],
    ['an empty string', ''],
    ['an unterminated string', '"abc'],
    ['an unterminated object', '{"a":1'],
  ])('refuses %s', (_, text) => {
    expect(code(() => parseStrictJson(text))).toBe('malformed');
  });

  it('caps nesting depth', () => {
    expect(() => parseStrictJson('['.repeat(JSON_MAX_DEPTH) + ']'.repeat(JSON_MAX_DEPTH))).not.toThrow();
    expect(code(() => parseStrictJson('['.repeat(JSON_MAX_DEPTH + 1) + ']'.repeat(JSON_MAX_DEPTH + 1)))).toBe(
      'too_large',
    );
    expect(code(() => parseStrictJson('{"a":'.repeat(10_000)))).toBe('too_large');
  });
});
