// RFC 8785 JSON Canonicalization Scheme (JCS): the bytes the generic step-up digest commits to
// (docs/batch-c-spec.md "Nonce and digest layouts"). Objects' keys are sorted by UTF-16 code units, numbers use
// ECMAScript's Number-to-string (what JSON.stringify writes), strings JSON.stringify's escapes (lowercase \u00xx for
// other controls). I-JSON only: lone surrogates, non-finite numbers and anything that isn't JSON are refused.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

function str(s: string): string {
  if (LONE_SURROGATE.test(s)) throw new TypeError('JCS: a string has a lone surrogate (not I-JSON)');
  return JSON.stringify(s);
}

export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('JCS: numbers must be finite');
      return JSON.stringify(value);
    case 'string':
      return str(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(',')}]`;
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) throw new TypeError('JCS: only plain objects, arrays and JSON values');
      const entries = Object.keys(value).map((k) => {
        const v = (value as Record<string, unknown>)[k];
        if (v === undefined) throw new TypeError(`JCS: ${k} is undefined`);
        return [k, v] as const;
      });
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${str(k)}:${canonicalize(v)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`JCS: ${typeof value} is not JSON`);
  }
}
