// Strict RFC 8259 JSON parser for requests the user approves (EIP-712 typed data) and for auto-approve policies.
// `JSON.parse` silently keeps the last of two duplicate keys and rounds big numbers, so the vault could hash a value
// the popup never showed (or the other way round). This parser refuses duplicate keys and lone surrogates, keeps
// every number as its exact lexeme (`JsonNumber`), caps nesting depth and builds null-prototype objects, so
// `__proto__` is just a key.
import { fail } from './errors.ts';

/** A JSON number kept as written (e.g. `"123456789012345678901234567890"` stays exact). */
export class JsonNumber {
  constructor(readonly raw: string) {}
}

export type StrictJson = null | boolean | string | JsonNumber | StrictJson[] | StrictJsonObject;
export interface StrictJsonObject {
  [key: string]: StrictJson;
}

export const JSON_MAX_DEPTH = 64;

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
// Without the `u` flag a regex sees UTF-16 code units, so this finds a surrogate that is not half of a pair.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Parses `text` as one JSON value. Throws DecodeError('malformed' | 'too_large'). */
export function parseStrictJson(text: string, maxDepth = JSON_MAX_DEPTH): StrictJson {
  let at = 0;

  const ws = () => {
    while (at < text.length) {
      const c = text.charCodeAt(at);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
      at++;
    }
  };

  const string = (): string => {
    // Caller checked text[at] === '"'.
    at++;
    let out = '';
    for (;;) {
      if (at >= text.length) fail('malformed', 'Unterminated JSON string');
      const c = text.charCodeAt(at);
      if (c === 0x22) {
        at++;
        break;
      }
      if (c < 0x20) fail('malformed', 'Control character in JSON string');
      if (c === 0x5c) {
        const e = text[at + 1];
        at += 2;
        switch (e) {
          case '"':
            out += '"';
            break;
          case '\\':
            out += '\\';
            break;
          case '/':
            out += '/';
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case 'n':
            out += '\n';
            break;
          case 'r':
            out += '\r';
            break;
          case 't':
            out += '\t';
            break;
          case 'u': {
            const hex = text.slice(at, at + 4);
            if (!/^[0-9a-fA-F]{4}$/u.test(hex)) fail('malformed', 'Bad \\u escape in JSON string');
            at += 4;
            out += String.fromCharCode(Number.parseInt(hex, 16));
            break;
          }
          default:
            fail('malformed', 'Bad escape in JSON string');
        }
        continue;
      }
      out += text[at];
      at++;
    }
    if (LONE_SURROGATE.test(out)) fail('malformed', 'Lone surrogate in JSON string');
    return out;
  };

  const value = (depth: number): StrictJson => {
    ws();
    if (at >= text.length) fail('malformed', 'Unexpected end of JSON');
    const c = text[at];
    if (c === '{' || c === '[') {
      if (depth >= maxDepth) fail('too_large', `JSON nested deeper than ${maxDepth}`);
    }
    if (c === '{') {
      at++;
      const obj = Object.create(null) as StrictJsonObject;
      ws();
      if (text[at] === '}') {
        at++;
        return obj;
      }
      for (;;) {
        ws();
        if (text[at] !== '"') fail('malformed', 'Expected a JSON object key');
        const key = string();
        if (Object.hasOwn(obj, key)) fail('malformed', `Duplicate JSON key "${key}"`);
        ws();
        if (text[at] !== ':') fail('malformed', 'Expected ":" in JSON object');
        at++;
        obj[key] = value(depth + 1);
        ws();
        if (text[at] === ',') {
          at++;
          continue;
        }
        if (text[at] === '}') {
          at++;
          return obj;
        }
        fail('malformed', 'Expected "," or "}" in JSON object');
      }
    }
    if (c === '[') {
      at++;
      const arr: StrictJson[] = [];
      ws();
      if (text[at] === ']') {
        at++;
        return arr;
      }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (text[at] === ',') {
          at++;
          continue;
        }
        if (text[at] === ']') {
          at++;
          return arr;
        }
        fail('malformed', 'Expected "," or "]" in JSON array');
      }
    }
    if (c === '"') return string();
    if (text.startsWith('true', at)) {
      at += 4;
      return true;
    }
    if (text.startsWith('false', at)) {
      at += 5;
      return false;
    }
    if (text.startsWith('null', at)) {
      at += 4;
      return null;
    }
    NUMBER.lastIndex = at;
    const m = NUMBER.exec(text);
    if (m === null) fail('malformed', 'Unexpected character in JSON');
    at += m[0].length;
    return new JsonNumber(m[0]);
  };

  const result = value(0);
  ws();
  if (at !== text.length) fail('malformed', 'Trailing characters after JSON');
  return result;
}

export const isJsonObject = (v: StrictJson | undefined): v is StrictJsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof JsonNumber);
