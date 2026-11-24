// A partner label document as the API reads it (D894): core's parser and text rules (piece 1, D892) decide what the
// document may say; the server adds the one rule only it can check, that the document's network is its scope's
// environment's (a test scope's documents are for the test networks, a live scope's for the main ones). The preview
// (every format with example values, core's plain-text form) and the diff against the version in force are built from
// the parsed document, never from the raw text, so a staff page or an email never shows anything the parser didn't
// accept.
import { LABEL_SCHEMA, LABEL_STELLAR_NETWORKS, type LabelDocument, addressBookLines, parseLabelDocument, previewLabelDocument } from '@hana-id/core/partner-labels';

const STELLAR_TESTNET_PASSPHRASE = LABEL_STELLAR_NETWORKS.test;
const STELLAR_MAINNET_PASSPHRASE = LABEL_STELLAR_NETWORKS.public;
import type { LabelDiffLine, LabelPreview } from '@hana-id/console-core';
import { sha256Hex } from '../owner-actions.ts';

export interface LabelProblem {
  code: string;
  path: string;
  message: string;
}

export type CheckedDocument =
  | { ok: true; doc: LabelDocument; text: string; schema: typeof LABEL_SCHEMA; sha256: string; bytes: number }
  | { ok: false; problems: LabelProblem[] };

const utf8 = new TextEncoder();

/** The network a scope's documents must name: the test networks for a test scope, the main ones for a live scope. */
function networkProblem(doc: LabelDocument, environment: 'test' | 'live'): LabelProblem | null {
  const c = doc.context;
  if (c.chain === 'near') {
    const want = environment === 'test' ? 'testnet' : 'mainnet';
    return c.network === want ? null : { code: 'wrong_environment', path: 'context.near.network', message: environment === 'test' ? 'These apps are test apps: describe calls on the NEAR test network (testnet).' : 'These apps are live apps: describe calls on the NEAR main network (mainnet).' };
  }
  const want = environment === 'test' ? STELLAR_TESTNET_PASSPHRASE : STELLAR_MAINNET_PASSPHRASE;
  const path = c.chain === 'soroban' ? 'context.soroban.networkPassphrase' : 'context.stellar.networkPassphrase';
  return c.networkPassphrase === want ? null : { code: 'wrong_environment', path, message: environment === 'test' ? 'These apps are test apps: describe calls on the Stellar test network.' : 'These apps are live apps: describe calls on the Stellar public network.' };
}

/** The document parsed (core's parser and text rules), with its sha256 and size; or every problem (at most 20). */
export async function parseDocument(text: string): Promise<CheckedDocument> {
  const r = parseLabelDocument(text);
  if (!r.ok) return { ok: false, problems: r.errors.map((e) => ({ code: e.code, path: e.path, message: e.message })) };
  return { ok: true, doc: r.document, text, schema: LABEL_SCHEMA, sha256: await sha256Hex(text), bytes: utf8.encode(text).length };
}

/** The document parsed and checked for a scope of `environment`. */
export async function checkDocument(text: string, environment: 'test' | 'live'): Promise<CheckedDocument> {
  const r = await parseDocument(text);
  if (!r.ok) return r;
  const wrong = networkProblem(r.doc, environment);
  return wrong ? { ok: false, problems: [wrong] } : r;
}

export { networkProblem };

/** A stored version's document, parsed again (it passed at its proposal; a stored text that no longer parses is null). */
export function storedDocument(text: string): LabelDocument | null {
  const r = parseLabelDocument(text);
  return r.ok ? r.document : null;
}

/** What a document describes, in words: "NEAR test network, stamps.testnet". */
export function contextText(doc: LabelDocument): string {
  const c = doc.context;
  if (c.chain === 'near') return `NEAR ${c.network === 'testnet' ? 'test' : 'main'} network, ${c.account}`;
  const net = c.networkPassphrase === STELLAR_TESTNET_PASSPHRASE ? 'Stellar test network' : 'Stellar public network';
  return c.chain === 'soroban' ? `${net}, contract ${c.contract}` : `${net}, payments`;
}

export function previewOf(doc: LabelDocument, appName: string): LabelPreview {
  return { appName, context: contextText(doc), examples: true, formats: previewLabelDocument(doc, appName).map((f) => ({ key: f.key, line: f.line, sentence: f.sentence, parts: f.parts.map((p) => ({ kind: p.kind, text: p.text })), fields: f.fields.map((x) => ({ label: x.label, value: x.value })) })), accounts: addressBookLines(doc) };
}

/** One format as one comparable line: its sentence, then each row as "label: value". */
const formatText = (f: LabelPreview['formats'][number]): string => [f.line, ...f.fields.map((x) => `${x.label}: ${x.value}`)].join(' · ');

/** Each address book account as a line of the diff, keyed by its account: a rename is "changed", a new account "added". */
const accountLines = (doc: LabelDocument): [string, string][] => doc.metadata.addressBook.map((e, i) => [`(account) ${e.account}`, addressBookLines(doc)[i]!]);

/** The formats of `after` against `before` (null: no version in force, so every format is added). */
export function diffOf(before: LabelDocument | null, after: LabelDocument, appName: string): LabelDiffLine[] {
  // What the document describes comes first (its key can't be a format's: those are method names), then each
  // account of its address book (the lines name one example account; a renamed or re-pointed one must show).
  const b = new Map<string, string>([...(before ? [['(contract)', contextText(before)] as [string, string]] : []), ...(before ? accountLines(before) : []), ...(before ? previewOf(before, appName).formats : []).map((f): [string, string] => [f.key, formatText(f)])]);
  const a = new Map<string, string>([['(contract)', contextText(after)], ...accountLines(after), ...previewOf(after, appName).formats.map((f): [string, string] => [f.key, formatText(f)])]);
  const keys = [...new Set([...b.keys(), ...a.keys()])];
  return keys.map((key) => {
    const x = b.get(key) ?? null;
    const y = a.get(key) ?? null;
    return { key, before: x, after: y, change: x === null ? 'added' : y === null ? 'removed' : x === y ? 'same' : 'changed' };
  });
}
