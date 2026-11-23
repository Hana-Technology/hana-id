// Where each problem with a request labels document shows in the form (D899): core's parser names the part of the
// document that caused it (`display.formats.payment.intent.object`), and this module maps that path to the form
// control that writes it, so the message sits beside the field that caused it. The messages are the parser's own
// (core's plain words, the same the API answers): nothing here decides whether a document is acceptable. A path no
// control writes goes to the form's general list. Also: the few things only the form can get wrong (two requests,
// lists or arguments with one name, which the document's JSON objects can't hold twice). Pure.
import { type LabelError, parseLabelDocument } from '@hana-id/core/partner-labels';
import type { Draft } from './model.ts';

export interface Problem {
  /** The form control's key (`f.0.object`, `book.1.name`, `general`, …). */
  key: string;
  code: string;
  message: string;
}

const AT = /^\[(\d+)\](.*)$/u;

/** The control key for one of the parser's paths, against the draft the document was written from. */
export function keyOfPath(path: string, d: Draft): string {
  if (path === '' || path === 'schema') return 'general';
  if (path.startsWith('context')) {
    if (/(?:codeHash|wasmHash)$/u.test(path)) return 'context.hash';
    if (/(?:account|contract)$/u.test(path)) return 'context.account';
    return 'general';
  }
  if (path === 'metadata' || path === 'metadata.enums') return path === 'metadata' ? 'general' : 'enums';
  if (path.startsWith('metadata.addressBook')) {
    const m = AT.exec(path.slice('metadata.addressBook'.length));
    if (!m) return 'book';
    return /\.name$/u.test(m[2]!) ? `book.${m[1]}.name` : `book.${m[1]}.account`;
  }
  if (path.startsWith('metadata.enums.')) {
    const rest = path.slice('metadata.enums.'.length);
    const i = d.enums.findIndex((e) => rest === e.name || rest.startsWith(`${e.name}.`));
    if (i < 0) return 'enums';
    const raw = rest.slice(d.enums[i]!.name.length + 1);
    if (raw === '') return `enum.${i}`;
    const j = d.enums[i]!.values.findIndex((v) => v.raw === raw);
    return j < 0 ? `enum.${i}` : `enum.${i}.v.${j}`;
  }
  if (path === 'display' || path === 'display.formats') return 'formats';
  if (path.startsWith('display.formats.')) {
    const rest = path.slice('display.formats.'.length);
    const i = d.formats.findIndex((f) => rest === f.key || rest.startsWith(`${f.key}.`));
    if (i < 0) return 'formats';
    const sub = rest.slice(d.formats[i]!.key.length + 1);
    const f = `f.${i}`;
    if (sub === '') return f;
    if (sub === 'intent.object') return `${f}.object`;
    if (sub.startsWith('intent')) return `${f}.verb`;
    if (sub.startsWith('sentence')) return `${f}.sentence`;
    if (sub.startsWith('fields')) {
      const m = AT.exec(sub.slice('fields'.length));
      return m ? `${f}.field.${m[1]}` : `${f}.fields`;
    }
    if (sub.startsWith('call')) {
      const c = sub.slice('call'.length).replace(/^\./u, '');
      if (c === '') return `${f}.call`;
      if (c.startsWith('args')) {
        const after = c.slice('args'.length);
        const pos = AT.exec(after);
        if (pos) return `${f}.arg.${pos[1]}`;
        const name = /^\.([A-Za-z_][A-Za-z0-9_]*)/u.exec(after)?.[1];
        const j = name === undefined ? -1 : d.formats[i]!.args.findIndex((a) => a.name === name);
        return j < 0 ? `${f}.args` : `${f}.arg.${j}`;
      }
      const part: Record<string, string> = { memo: 'memo', assets: 'assets', amountAtMost: 'amount', feeAtMost: 'fee', deposit: 'deposit', gasAtMost: 'gas', relayed: 'relayed', otherArgs: 'args' };
      const k = Object.keys(part).find((p) => c === p || c.startsWith(`${p}.`) || c.startsWith(`${p}[`));
      return k ? `${f}.${part[k]}` : `${f}.call`;
    }
    return f;
  }
  return 'general';
}

/** What only the form can get wrong: a name twice where the document keeps one (a JSON object's keys). */
export function draftProblems(d: Draft): Problem[] {
  const out: Problem[] = [];
  const twice = <T>(list: readonly T[], name: (x: T) => string, key: (i: number) => string, message: (n: string) => string) => {
    const seen = new Set<string>();
    list.forEach((x, i) => {
      const n = name(x);
      if (n !== '' && seen.has(n)) out.push({ key: key(i), code: 'form_duplicate', message: message(n) });
      seen.add(n);
    });
  };
  if (d.kind !== 'stellar') twice(d.formats, (f) => f.key, (i) => `f.${i}`, (n) => `Two requests are named “${n}”: each method is described once.`);
  twice(d.enums, (e) => e.name, (i) => `enum.${i}`, (n) => `Two lists are named “${n}”: give each its own name.`);
  d.enums.forEach((e, i) => twice(e.values, (v) => v.raw, (j) => `enum.${i}.v.${j}`, (n) => `The value “${n}” is listed twice.`));
  d.formats.forEach((f, i) => {
    if (d.kind === 'near') twice(f.args, (a) => a.name, (j) => `f.${i}.arg.${j}`, (n) => `Two arguments are named “${n}”.`);
  });
  return out;
}

/** Every problem of a document's text, each with the control it belongs to (the parser's, then the form's own). */
export function problemsOf(text: string, d: Draft | null): Problem[] {
  const r = parseLabelDocument(text);
  const parsed: readonly LabelError[] = r.ok ? [] : r.errors;
  const mine = d ? draftProblems(d) : [];
  return [...mine, ...parsed.map((e) => ({ key: d ? keyOfPath(e.path, d) : 'general', code: e.code, message: e.message }))];
}

/**
 * The API's `label_invalid` message ("code at path: message; …", D894) as problems, each placed as the parser's would
 * be. A message that isn't in that form is one general problem, its text as the API wrote it.
 */
export function problemsOfApi(message: string, d: Draft | null): Problem[] {
  const parts = message.split(/; (?=[a-z_]+ at )/u);
  return parts.map((p) => {
    const m = /^([a-z_]+) at ([^:]*): ([\s\S]*)$/u.exec(p);
    if (!m) return { key: 'general', code: 'label_invalid', message: p };
    return { key: d ? keyOfPath(m[2]!, d) : 'general', code: m[1]!, message: m[3]! };
  });
}
