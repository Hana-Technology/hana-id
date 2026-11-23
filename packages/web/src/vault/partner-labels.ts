// Partner labels as the vault takes them from `GET /v1/app` (D894, piece 2 of D892) and hands them to the approval
// window (D896, piece 3): the delivered shape, a pure check, and what one request's window may get. The check trusts
// nothing the API says about a document: it hashes the text itself, parses it with the vault's own copy of core's
// parser and text rules, and requires the document's network to be the env's. Anything that fails (a bad hash, a
// schema version it doesn't know, a document its parser refuses, an entry named twice, two entries describing the same
// contract, a malformed entry) is dropped, never shown; the window then shows its plain view, as for an app without
// labels. The vault keeps what passed with the time of the read it came from and sends it only while that read is
// younger than PARTNER_LABELS_FRESH_MS (vault.ts `labelsForWindow`), so a staff switch or block reaches users within
// seconds and a failed read means no labels.
import { type WalletChain, sha256, toHex } from '@hana-id/core';
import { LABEL_SCHEMA, type LabelDocument, labelOnNetwork, parseLabelDocument, withoutSharedContracts } from '@hana-id/core/partner-labels';

/** One document as `GET /v1/app` sends it (apps/api src/labels/deliver.ts DeliveredLabel). */
export interface DeliveredLabel {
  id: string;
  changeId: string;
  version: string;
  sha256: string;
  text: string;
  effectiveSince: number;
  previousEffectiveSince: number | null;
}

/** A document the vault checked: the parsed document, its text (what the window gets) and its age. */
export interface VerifiedLabel {
  id: string;
  changeId: string;
  document: LabelDocument;
  /** The document's text exactly as delivered (and hashed): the approval window parses it again with its own parser. */
  text: string;
  effectiveSince: number;
  previousEffectiveSince: number | null;
}

/** The most documents one app's config may carry (the API's per-org entry limit); more is a malformed answer. */
export const MAX_DELIVERED_LABELS = 16;
/** A document's largest UTF-8 size (core's LABEL_LIMITS.documentBytes). */
const MAX_TEXT_BYTES = 16 * 1024;
/**
 * The most label text one approval window gets (the API's per-app limit, LABEL_STORE_LIMITS.appBytes, and the
 * protocol's APPROVAL_LABELS_MAX_BYTES): more is a malformed answer, and the window gets none.
 */
export const MAX_WINDOW_LABEL_BYTES = 32 * 1024;

/**
 * D896: a label is shown only from a `GET /v1/app` read younger than this, as an auto-sign needs its policy confirmed
 * (vault.ts POLICY_FRESH_MS, D62): the same 10 s. Older, the vault reads again before the window gets it; a read that
 * fails or is late means the plain window.
 */
export const PARTNER_LABELS_FRESH_MS = 10_000;
/** How long the window's request waits for that read at most (a slower one means the plain window for it). */
export const PARTNER_LABELS_WAIT_MS = 3_000;

const ID = /^pl_[A-Za-z0-9]{1,64}$/u;
const CHANGE_ID = /^lc_[A-Za-z0-9]{1,64}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const utf8 = new TextEncoder();

function shapeOf(v: unknown): DeliveredLabel | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || !ID.test(o.id) || typeof o.changeId !== 'string' || !CHANGE_ID.test(o.changeId)) return null;
  if (typeof o.version !== 'string' || typeof o.sha256 !== 'string' || !HEX64.test(o.sha256) || typeof o.text !== 'string') return null;
  if (!isTime(o.effectiveSince) || !(o.previousEffectiveSince === null || isTime(o.previousEffectiveSince))) return null;
  return { id: o.id, changeId: o.changeId, version: o.version, sha256: o.sha256, text: o.text, effectiveSince: o.effectiveSince, previousEffectiveSince: o.previousEffectiveSince };
}

/**
 * The delivered documents the vault can stand behind, in the order sent: each re-hashed, of a schema version this build
 * knows, parsed by its own parser, on the env's network, its entry named once, its contract described by no other.
 * `partnerLabels` absent or not a list is no labels. Pure: no clock, no network.
 */
export function verifyDeliveredLabels(partnerLabels: unknown, env: { network: 'testnet' | 'mainnet' }): VerifiedLabel[] {
  if (!Array.isArray(partnerLabels) || partnerLabels.length > MAX_DELIVERED_LABELS) return [];
  const out: VerifiedLabel[] = [];
  // An entry named twice is a malformed answer: neither copy is used.
  const ids = partnerLabels.map((raw) => shapeOf(raw)?.id);
  for (const raw of partnerLabels) {
    const d = shapeOf(raw);
    if (!d || ids.filter((x) => x === d.id).length > 1) continue;
    if (d.version !== LABEL_SCHEMA) continue;
    const bytes = utf8.encode(d.text);
    if (bytes.length > MAX_TEXT_BYTES || toHex(sha256(bytes)) !== d.sha256) continue;
    const parsed = parseLabelDocument(d.text);
    if (!parsed.ok || !labelOnNetwork(parsed.document, env.network)) continue;
    out.push({ id: d.id, changeId: d.changeId, document: parsed.document, text: d.text, effectiveSince: d.effectiveSince, previousEffectiveSince: d.previousEffectiveSince });
  }
  return withoutSharedContracts(out);
}

/** Which documents can describe a request of `chain`: NEAR's for NEAR, Soroban's and classic payments' for Stellar. */
const forChain = (doc: LabelDocument, chain: WalletChain): boolean => (chain === 'near' ? doc.context.chain === 'near' : chain === 'stellar' ? doc.context.chain !== 'near' : false);

/**
 * The texts one approval window gets for a request on `chain`: the checked documents that can describe it, or none
 * when they are over MAX_WINDOW_LABEL_BYTES together (a malformed answer). Pure; freshness is the caller's.
 */
export function windowLabelTexts(labels: readonly VerifiedLabel[], chain: WalletChain): string[] {
  const texts = labels.filter((l) => forChain(l.document, chain)).map((l) => l.text);
  const total = texts.reduce((n, t) => n + utf8.encode(t).length, 0);
  return total > MAX_WINDOW_LABEL_BYTES ? [] : texts;
}
