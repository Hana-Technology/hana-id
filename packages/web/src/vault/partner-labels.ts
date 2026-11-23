// Partner labels as the vault would take them from `GET /v1/app` (D894, piece 2 of D892): the delivered shape and a
// pure check. NOTHING CALLS THIS YET: the approval window renders no partner label until piece 3, which will also hold
// a label to a fresh read (the policies' POLICY_FRESH_MS rule, D62) so a staff switch or block takes effect within
// seconds. The check trusts nothing the API says about a document: it hashes the text itself, parses it with the
// vault's own copy of core's parser and text rules, and requires the document's network to be the env's. Anything that
// fails (a bad hash, a schema version it doesn't know, a document its parser refuses, a duplicate, a malformed entry) is
// dropped, never shown; the window then shows its plain view, as for an app without labels.
import { sha256, toHex } from '@hana-id/core';
import { LABEL_SCHEMA, LABEL_STELLAR_NETWORKS, type LabelDocument, parseLabelDocument } from '@hana-id/core/partner-labels';

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

/** A document the vault checked: the parsed document and what the window may say about its age. */
export interface VerifiedLabel {
  id: string;
  changeId: string;
  document: LabelDocument;
  effectiveSince: number;
  previousEffectiveSince: number | null;
}

/** The most documents one app's config may carry (the API's per-org entry limit); more is a malformed answer. */
export const MAX_DELIVERED_LABELS = 16;
/** A document's largest UTF-8 size (core's LABEL_LIMITS.documentBytes). */
const MAX_TEXT_BYTES = 16 * 1024;

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

/** The document names the env's network: NEAR testnet or mainnet, or the matching Stellar passphrase. */
function onNetwork(doc: LabelDocument, network: 'testnet' | 'mainnet'): boolean {
  const c = doc.context;
  if (c.chain === 'near') return c.network === network;
  return c.networkPassphrase === (network === 'testnet' ? LABEL_STELLAR_NETWORKS.test : LABEL_STELLAR_NETWORKS.public);
}

/**
 * The delivered documents the vault can stand behind, in the order sent: each re-hashed, of a schema version this build
 * knows, parsed by its own parser, on the env's network, its entry named once. `partnerLabels` absent or not a list is
 * no labels. Pure: no clock, no network.
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
    if (!parsed.ok || !onNetwork(parsed.document, env.network)) continue;
    out.push({ id: d.id, changeId: d.changeId, document: parsed.document, effectiveSince: d.effectiveSince, previousEffectiveSince: d.previousEffectiveSince });
  }
  return out;
}
