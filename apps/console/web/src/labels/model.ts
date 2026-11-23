// The request labels editor's model (D899): the form's draft of one `journear-labels/1` document, and the two ways
// between the draft and the document's text. The partner fills a form; the text is built from it, never written by
// hand (the "advanced" view shows it and takes edits, but is never the only way). Whether a document is acceptable is
// core's parser's and text rules' answer alone (`@hana-id/core/partner-labels`, the same code the API and the approval
// window run): nothing here checks a rule. Pure: no DOM, no network.
//
// The draft holds the document's own units (stroops, yoctoNEAR, gas) as decimal strings; the form shows them in XLM,
// NEAR and TGas (units.ts converts, exactly). The network is the scope's (a test scope's documents describe the test
// networks, a live scope's the main ones): it is not a choice in the form, and `toDocumentText` writes it.
import { FORMAT_ARG_TYPES, type FieldFormat, LABEL_SCHEMA, LABEL_STELLAR_NETWORKS, type TimeUnit } from '@hana-id/core/partner-labels';

/** What a document describes: classic Stellar payments (shown to users today), a NEAR program or a Soroban contract (not yet: D896). */
export type LabelKind = 'stellar' | 'near' | 'soroban';
export type Environment = 'test' | 'live';
export type Relay = 'either' | 'relayed' | 'direct';
export type MemoKind = 'none' | 'text' | 'id';

/** The argument types each chain's calls declare (core's parser holds the same lists; a test checks each is accepted). */
export const ARG_TYPES: Readonly<Record<'near' | 'soroban', readonly string[]>> = Object.freeze({
  near: ['string', 'accountId', 'u128', 'u64', 'integer', 'boolean'],
  soroban: ['string', 'symbol', 'address', 'i128', 'u128', 'i64', 'u64', 'timepoint', 'duration', 'u32', 'i32', 'bool'],
});

export type ArgFamily = 'text' | 'account' | 'decimal' | 'int' | 'bool';
/** Which constraints a type takes (the parser's groups). */
export function argFamily(type: string): ArgFamily {
  if (type === 'string' || type === 'symbol') return 'text';
  if (type === 'accountId' || type === 'address') return 'account';
  if (type === 'integer' || type === 'u32' || type === 'i32') return 'int';
  if (type === 'boolean' || type === 'bool') return 'bool';
  return 'decimal';
}

export interface ArgDraft {
  name: string;
  type: string;
  /** NEAR only (a Soroban argument is always present). */
  optional: boolean;
  maxLength: string;
  oneOf: string[];
  isSelf: boolean;
  inAddressBook: boolean;
  atLeast: string;
  atMost: string;
  min: string;
  max: string;
  /** '' (any), 'true' or 'false'. */
  equals: '' | 'true' | 'false';
}

export interface FieldDraft {
  path: string;
  label: string;
  format: FieldFormat;
  enumName: string;
  /** A token amount names its token by id (`token`) or by the argument that carries it (`tokenPath`). */
  tokenBy: 'token' | 'tokenPath';
  token: string;
  tokenPath: string;
  unit: TimeUnit;
  min: string;
  max: string;
}

export type PartDraft = { kind: 'verb' } | { kind: 'object' } | { kind: 'field'; path: string } | { kind: 'word'; word: string };

export interface FormatDraft {
  /** The NEAR method's or Soroban function's exact name; `payment` for a classic payment. */
  key: string;
  verb: string;
  /** '' for none. */
  object: string;
  // A classic payment's conditions (stroops).
  memo: MemoKind;
  /** Empty: any asset. Each `native` or `CODE:ISSUER`. */
  assets: string[];
  amountAtMost: string;
  feeAtMost: string;
  // A NEAR call's (yoctoNEAR, gas) and a Soroban call's (stroops) conditions.
  depositKind: 'exactly' | 'atMost';
  deposit: string;
  gasAtMost: string;
  relayed: Relay;
  args: ArgDraft[];
  fields: FieldDraft[];
  sentence: PartDraft[];
}

export interface Draft {
  kind: LabelKind;
  nearAccount: string;
  codeHash: string;
  contract: string;
  wasmHash: string;
  addressBook: { account: string; name: string }[];
  enums: { name: string; values: { raw: string; label: string }[] }[];
  formats: FormatDraft[];
}

export const emptyArg = (name = '', type = 'string'): ArgDraft => ({ name, type, optional: false, maxLength: '', oneOf: [], isSelf: false, inAddressBook: false, atLeast: '', atMost: '', min: '', max: '', equals: '' });

export const emptyField = (path: string, format: FieldFormat): FieldDraft => ({ path, label: '', format, enumName: '', tokenBy: 'token', token: '', tokenPath: '', unit: 'seconds', min: '', max: '' });

export function emptyFormat(kind: LabelKind, key = ''): FormatDraft {
  return {
    key: kind === 'stellar' ? 'payment' : key,
    verb: kind === 'stellar' ? 'pay' : '',
    object: '',
    memo: 'none',
    assets: [],
    amountAtMost: '',
    feeAtMost: '',
    depositKind: 'exactly',
    deposit: '0',
    gasAtMost: '',
    relayed: 'either',
    args: [],
    fields: [],
    sentence: [{ kind: 'verb' }],
  };
}

/** A new document of `kind`: a classic payment starts with its one format; a program's with none yet. */
export function emptyDraft(kind: LabelKind): Draft {
  return { kind, nearAccount: '', codeHash: '', contract: '', wasmHash: '', addressBook: [], enums: [], formats: kind === 'stellar' ? [emptyFormat('stellar')] : [] };
}

/** The network a scope's documents describe (the API refuses any other, D894). */
export const nearNetworkOf = (e: Environment): 'testnet' | 'mainnet' => (e === 'test' ? 'testnet' : 'mainnet');
export const stellarNetworkOf = (e: Environment): string => (e === 'test' ? LABEL_STELLAR_NETWORKS.test : LABEL_STELLAR_NETWORKS.public);

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

const num = (s: string): Json => (/^-?(?:0|[1-9][0-9]*)$/u.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : s);

function argJson(a: ArgDraft, positional: boolean): { [k: string]: Json } {
  const o: { [k: string]: Json } = positional ? { name: a.name, type: a.type } : { type: a.type };
  const f = argFamily(a.type);
  if (f === 'text') {
    if (a.maxLength !== '') o.maxLength = num(a.maxLength);
    if (a.oneOf.length) o.oneOf = [...a.oneOf];
  } else if (f === 'account') {
    if (a.isSelf) o.isSelf = true;
    if (a.inAddressBook) o.inAddressBook = true;
    if (a.oneOf.length) o.oneOf = [...a.oneOf];
  } else if (f === 'decimal') {
    if (a.atLeast !== '') o.atLeast = a.atLeast;
    if (a.atMost !== '') o.atMost = a.atMost;
  } else if (f === 'int') {
    if (a.min !== '') o.min = num(a.min);
    if (a.max !== '') o.max = num(a.max);
  } else if (a.equals !== '') o.equals = a.equals === 'true';
  if (!positional && a.optional) o.optional = true;
  return o;
}

function fieldJson(f: FieldDraft): { [k: string]: Json } {
  const o: { [k: string]: Json } = { path: f.path, label: f.label, format: f.format };
  if (f.format === 'enum') o.params = { enum: f.enumName };
  else if (f.format === 'tokenAmount') o.params = f.tokenBy === 'token' ? { token: f.token } : { tokenPath: f.tokenPath };
  else if (f.format === 'date' || f.format === 'duration') o.params = { unit: f.unit };
  else if (f.format === 'count') o.params = { min: num(f.min), max: num(f.max) };
  return o;
}

const partJson = (p: PartDraft): Json => (p.kind === 'verb' || p.kind === 'object' ? p.kind : p.kind === 'field' ? { field: p.path } : { word: p.word });

function formatJson(kind: LabelKind, f: FormatDraft): { [k: string]: Json } {
  let call: { [k: string]: Json };
  if (kind === 'stellar') {
    call = {};
    if (f.assets.length) call.assets = [...f.assets];
    if (f.amountAtMost !== '') call.amountAtMost = f.amountAtMost;
    call.memo = f.memo;
    if (f.feeAtMost !== '') call.feeAtMost = f.feeAtMost;
  } else if (kind === 'near') {
    call = {};
    // Absent means exactly 0 (the parser's default): written only when it says something else.
    if (!(f.depositKind === 'exactly' && f.deposit === '0')) call.deposit = { [f.depositKind]: f.deposit };
    if (f.gasAtMost !== '') call.gasAtMost = f.gasAtMost;
    if (f.relayed !== 'either') call.relayed = f.relayed;
    call.args = Object.fromEntries(f.args.map((a) => [a.name, argJson(a, false)]));
    call.otherArgs = 'refuse';
  } else {
    call = {};
    if (f.feeAtMost !== '') call.feeAtMost = f.feeAtMost;
    if (f.relayed !== 'either') call.relayed = f.relayed;
    call.args = f.args.map((a) => argJson(a, true));
    call.otherArgs = 'refuse';
  }
  return {
    call,
    intent: f.object === '' ? { verb: f.verb } : { verb: f.verb, object: f.object },
    sentence: f.sentence.map(partJson),
    fields: f.fields.map(fieldJson),
  };
}

/** The document the draft describes, as a JSON value (keys in the document's own order). */
export function toDocumentJson(d: Draft, env: Environment): { [k: string]: Json } {
  const context: { [k: string]: Json } =
    d.kind === 'near'
      ? { near: { network: nearNetworkOf(env), account: d.nearAccount, codeHash: d.codeHash } }
      : d.kind === 'soroban'
        ? { soroban: { networkPassphrase: stellarNetworkOf(env), contract: d.contract, wasmHash: d.wasmHash } }
        : { stellar: { networkPassphrase: stellarNetworkOf(env) } };
  const metadata: { [k: string]: Json } = {};
  if (d.enums.length) metadata.enums = Object.fromEntries(d.enums.map((e) => [e.name, Object.fromEntries(e.values.map((v) => [v.raw, v.label]))]));
  if (d.addressBook.length) metadata.addressBook = d.addressBook.map((e) => ({ account: e.account, name: e.name }));
  const doc: { [k: string]: Json } = { schema: LABEL_SCHEMA, context };
  if (Object.keys(metadata).length) doc.metadata = metadata;
  doc.display = { formats: Object.fromEntries(d.formats.map((f) => [f.key, formatJson(d.kind, f)])) };
  return doc;
}

/** The document's text as the form writes it: two-space JSON, one trailing newline. */
export const toDocumentText = (d: Draft, env: Environment): string => `${JSON.stringify(toDocumentJson(d, env), null, 2)}\n`;

// ---- the text back into the form ----

/** Why the form can't show a text: it says what to fix. Plain words. */
export class NotRepresentable extends Error {}

const no = (why: string): never => {
  throw new NotRepresentable(why);
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function obj(v: unknown, where: string, allowed: readonly string[]): Record<string, unknown> {
  if (!isObj(v)) return no(`${where} isn’t an object`);
  for (const k of Object.keys(v)) if (!allowed.includes(k)) no(`${where} has “${k.slice(0, 40)}”, which the form doesn’t have`);
  return v;
}
const str = (v: unknown, where: string): string => (typeof v === 'string' ? v : no(`${where} isn’t text`));
const optStr = (v: unknown, where: string): string => (v === undefined ? '' : str(v, where));
const intStr = (v: unknown, where: string): string => (v === undefined ? '' : typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : no(`${where} isn’t a whole number`));
const flag = (v: unknown, where: string): boolean => (v === undefined ? false : v === true ? true : no(`${where} isn’t true`));
const strList = (v: unknown, where: string): string[] => (v === undefined ? [] : Array.isArray(v) ? v.map((x, i) => str(x, `${where} ${i + 1}`)) : no(`${where} isn’t a list`));

function readArg(v: unknown, name: string, positional: boolean): ArgDraft {
  const where = `The argument “${name.slice(0, 40)}”`;
  const o = obj(v, where, [...(positional ? ['name'] : []), 'type', 'optional', 'maxLength', 'oneOf', 'isSelf', 'inAddressBook', 'atLeast', 'atMost', 'min', 'max', 'equals']);
  const a = emptyArg(name, str(o.type, `${where}’s type`));
  if (positional && o.optional !== undefined) no(`${where} is marked optional, which a Soroban argument can’t be`);
  a.optional = flag(o.optional, `${where}’s “optional”`);
  a.maxLength = intStr(o.maxLength, `${where}’s longest length`);
  a.oneOf = strList(o.oneOf, `${where}’s allowed values`);
  a.isSelf = flag(o.isSelf, `${where}’s “isSelf”`);
  a.inAddressBook = flag(o.inAddressBook, `${where}’s “inAddressBook”`);
  a.atLeast = optStr(o.atLeast, `${where}’s least value`);
  a.atMost = optStr(o.atMost, `${where}’s most value`);
  a.min = intStr(o.min, `${where}’s least value`);
  a.max = intStr(o.max, `${where}’s most value`);
  a.equals = o.equals === undefined ? '' : o.equals === true ? 'true' : o.equals === false ? 'false' : no(`${where}’s “equals” isn’t true or false`);
  return a;
}

const FORMATS = Object.keys(FORMAT_ARG_TYPES) as FieldFormat[];

function readField(v: unknown, i: number): FieldDraft {
  const where = `Shown value ${i + 1}`;
  const o = obj(v, where, ['path', 'label', 'format', 'params']);
  const format = str(o.format, `${where}’s format`);
  if (!(FORMATS as string[]).includes(format)) no(`${where}’s format “${format.slice(0, 40)}” isn’t one the form has`);
  const f = emptyField(str(o.path, `${where}’s path`), format as FieldFormat);
  f.label = str(o.label, `${where}’s label`);
  const p = o.params === undefined ? {} : obj(o.params, `${where}’s params`, ['enum', 'token', 'tokenPath', 'unit', 'min', 'max']);
  if (p.enum !== undefined) f.enumName = str(p.enum, `${where}’s list`);
  if (p.token !== undefined) f.token = str(p.token, `${where}’s token`);
  if (p.tokenPath !== undefined) {
    f.tokenBy = 'tokenPath';
    f.tokenPath = str(p.tokenPath, `${where}’s token argument`);
  }
  if (p.unit !== undefined) {
    const u = str(p.unit, `${where}’s unit`);
    if (u !== 'seconds' && u !== 'milliseconds' && u !== 'nanoseconds') return no(`${where}’s unit isn’t seconds, milliseconds or nanoseconds`);
    f.unit = u;
  }
  f.min = intStr(p.min, `${where}’s least count`);
  f.max = intStr(p.max, `${where}’s most count`);
  return f;
}

function readPart(v: unknown, i: number): PartDraft {
  if (v === 'verb' || v === 'object') return { kind: v };
  const o = obj(v, `Sentence part ${i + 1}`, ['field', 'word']);
  if (Object.keys(o).length !== 1) no(`Sentence part ${i + 1} isn’t a value or a joining word`);
  return o.field !== undefined ? { kind: 'field', path: str(o.field, `Sentence part ${i + 1}`) } : { kind: 'word', word: str(o.word, `Sentence part ${i + 1}`) };
}

function readFormat(kind: LabelKind, key: string, v: unknown): FormatDraft {
  const where = `The request “${key.slice(0, 40)}”`;
  const o = obj(v, where, ['call', 'intent', 'sentence', 'fields']);
  const f = emptyFormat(kind, key);
  const intent = obj(o.intent, `${where}’s words`, ['verb', 'object']);
  f.verb = str(intent.verb, `${where}’s verb`);
  f.object = optStr(intent.object, `${where}’s phrase`);
  if (kind === 'stellar') {
    const c = obj(o.call, `${where}’s conditions`, ['assets', 'amountAtMost', 'memo', 'feeAtMost']);
    const memo = str(c.memo, `${where}’s memo`);
    if (memo !== 'none' && memo !== 'text' && memo !== 'id') return no(`${where}’s memo isn’t none, text or id`);
    f.memo = memo;
    f.assets = strList(c.assets, `${where}’s assets`);
    f.amountAtMost = optStr(c.amountAtMost, `${where}’s most amount`);
    f.feeAtMost = optStr(c.feeAtMost, `${where}’s most fee`);
  } else if (kind === 'near') {
    const c = obj(o.call, `${where}’s conditions`, ['deposit', 'gasAtMost', 'relayed', 'args', 'otherArgs']);
    if (c.deposit !== undefined) {
      const d = obj(c.deposit, `${where}’s deposit`, ['exactly', 'atMost']);
      const keys = Object.keys(d);
      if (keys.length !== 1) no(`${where}’s deposit needs exactly one of “exactly” or “atMost”`);
      f.depositKind = keys[0] as 'exactly' | 'atMost';
      f.deposit = str(d[keys[0]!], `${where}’s deposit`);
    }
    f.gasAtMost = optStr(c.gasAtMost, `${where}’s most gas`);
    f.relayed = readRelay(c.relayed, where);
    if (c.otherArgs !== undefined && c.otherArgs !== 'refuse') no(`${where}’s “otherArgs” isn’t “refuse”`);
    const args = obj(c.args, `${where}’s arguments`, isObj(c.args) ? Object.keys(c.args) : []);
    f.args = Object.entries(args).map(([n, a]) => readArg(a, n, false));
  } else {
    const c = obj(o.call, `${where}’s conditions`, ['feeAtMost', 'relayed', 'args', 'otherArgs']);
    f.feeAtMost = optStr(c.feeAtMost, `${where}’s most fee`);
    f.relayed = readRelay(c.relayed, where);
    if (c.otherArgs !== undefined && c.otherArgs !== 'refuse') no(`${where}’s “otherArgs” isn’t “refuse”`);
    if (!Array.isArray(c.args)) no(`${where}’s arguments aren’t a list`);
    f.args = (c.args as unknown[]).map((a, i) => readArg(a, isObj(a) && typeof a.name === 'string' ? a.name : no(`${where}’s argument ${i + 1} has no name`), true));
  }
  if (!Array.isArray(o.sentence)) no(`${where}’s sentence isn’t a list`);
  f.sentence = (o.sentence as unknown[]).map(readPart);
  if (!Array.isArray(o.fields)) no(`${where}’s shown values aren’t a list`);
  f.fields = (o.fields as unknown[]).map(readField);
  return f;
}

function readRelay(v: unknown, where: string): Relay {
  if (v === undefined) return 'either';
  if (v === 'either' || v === 'relayed' || v === 'direct') return v;
  return no(`${where}’s “relayed” isn’t relayed, direct or either`);
}

/** Two JSON values equal, keys in any order. */
function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
  }
  return a === b;
}

/** The parser's defaults written out, so a text that leaves them out reads the same as the form's. */
function withDefaults(doc: Record<string, unknown>, kind: LabelKind): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
  const formats = ((copy.display as Record<string, unknown> | undefined)?.formats ?? {}) as Record<string, Record<string, unknown>>;
  for (const f of Object.values(formats)) {
    const call = f.call as Record<string, unknown> | undefined;
    if (!isObj(call) || kind === 'stellar') continue;
    if (call.otherArgs === undefined) call.otherArgs = 'refuse';
    if (call.relayed === 'either') delete call.relayed;
    if (kind === 'near' && isObj(call.deposit) && call.deposit.exactly === '0' && Object.keys(call.deposit).length === 1) delete call.deposit;
  }
  if (isObj(copy.metadata) && Object.keys(copy.metadata).length === 0) delete copy.metadata;
  return copy;
}

/**
 * The form's draft of a document's text, or why the form can't show it (the text stays as it is, and the partner fixes
 * it there). The network isn't read back: the form writes the scope's, so a text naming another one comes back out
 * with the scope's (the editor says so when it differs). Checked last by building the text again: anything the form
 * would drop or change makes it not representable, so the form never silently loses a part of a document.
 */
export function fromDocumentText(text: string, env: Environment): { ok: true; draft: Draft; networkChanged: boolean } | { ok: false; reason: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'This isn’t valid JSON yet.' };
  }
  try {
    const top = obj(json, 'The document', ['schema', 'context', 'metadata', 'display']);
    const ctx = obj(top.context, 'The context', ['near', 'soroban', 'stellar']);
    const keys = Object.keys(ctx);
    if (keys.length !== 1) no('The context needs exactly one of near, soroban or stellar');
    const kind = keys[0] as LabelKind;
    const d = emptyDraft(kind);
    d.formats = [];
    let networkChanged = false;
    if (kind === 'near') {
      const n = obj(ctx.near, 'The NEAR context', ['network', 'account', 'codeHash']);
      d.nearAccount = optStr(n.account, 'The program’s account');
      d.codeHash = optStr(n.codeHash, 'The code hash');
      networkChanged = n.network !== nearNetworkOf(env);
    } else if (kind === 'soroban') {
      const s = obj(ctx.soroban, 'The Soroban context', ['networkPassphrase', 'contract', 'wasmHash']);
      d.contract = optStr(s.contract, 'The contract');
      d.wasmHash = optStr(s.wasmHash, 'The Wasm hash');
      networkChanged = s.networkPassphrase !== stellarNetworkOf(env);
    } else {
      const s = obj(ctx.stellar, 'The Stellar context', ['networkPassphrase']);
      networkChanged = s.networkPassphrase !== stellarNetworkOf(env);
    }
    if (top.metadata !== undefined) {
      const m = obj(top.metadata, 'The metadata', ['enums', 'addressBook']);
      if (m.enums !== undefined) {
        const e = obj(m.enums, 'The lists of values', isObj(m.enums) ? Object.keys(m.enums) : []);
        d.enums = Object.entries(e).map(([name, values]) => ({ name, values: Object.entries(obj(values, `The list “${name.slice(0, 40)}”`, isObj(values) ? Object.keys(values) : [])).map(([raw, label]) => ({ raw, label: str(label, `The label of “${raw.slice(0, 40)}”`) })) }));
      }
      if (m.addressBook !== undefined) {
        if (!Array.isArray(m.addressBook)) no('Your accounts aren’t a list');
        d.addressBook = (m.addressBook as unknown[]).map((x, i) => {
          const e = obj(x, `Account ${i + 1}`, ['account', 'name']);
          return { account: str(e.account, `Account ${i + 1}`), name: str(e.name, `Account ${i + 1}’s name`) };
        });
      }
    }
    const display = obj(top.display, 'The display', ['formats']);
    const formats = obj(display.formats, 'The requests', isObj(display.formats) ? Object.keys(display.formats) : []);
    d.formats = Object.entries(formats).map(([k, v]) => readFormat(kind, k, v));
    if (top.schema !== undefined && top.schema !== LABEL_SCHEMA) no(`The schema isn’t “${LABEL_SCHEMA}”`);
    // The safety net: the form's text for this draft must say what the text said (the scope's network aside).
    const mine = withDefaults(toDocumentJson(d, env), kind);
    const theirs = withDefaults({ ...top, schema: LABEL_SCHEMA, context: toDocumentJson(d, env).context as Json } as Record<string, unknown>, kind);
    if (!same(mine, theirs)) no('Part of it is written in a way the form can’t show');
    return { ok: true, draft: d, networkChanged };
  } catch (e) {
    if (e instanceof NotRepresentable) return { ok: false, reason: `${e.message}.` };
    throw e;
  }
}
