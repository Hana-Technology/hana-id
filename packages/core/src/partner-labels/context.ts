// What a label document describes (D896): its contract as one key, whether it is on an env's network, and the rule that
// two documents describing the same contract are both dropped. Shared by the vault's check of what `GET /v1/app`
// delivers and the approval window's own check of what the vault sends it. Pure.
import { LABEL_STELLAR_NETWORKS, type LabelDocument } from './schema.ts';

/**
 * What a document describes, as one key: the chain, the network and the account or contract. The same key as the
 * API's `label_changes.context_key` (apps/api src/labels/store.ts contextKey), under which two live entries of a scope
 * never coexist.
 */
export function labelContextKey(doc: LabelDocument): string {
  const c = doc.context;
  return c.chain === 'near' ? `near:${c.network}:${c.account}` : c.chain === 'soroban' ? `soroban:${c.networkPassphrase}:${c.contract}` : `stellar:${c.networkPassphrase}`;
}

/** The document names `network`: NEAR testnet or mainnet, or the matching Stellar passphrase. */
export function labelOnNetwork(doc: LabelDocument, network: 'testnet' | 'mainnet'): boolean {
  const c = doc.context;
  if (c.chain === 'near') return c.network === network;
  return c.networkPassphrase === (network === 'testnet' ? LABEL_STELLAR_NETWORKS.test : LABEL_STELLAR_NETWORKS.public);
}

/**
 * Drops every document whose contract another one also describes, both of them (D894's requirement for piece 3): the
 * API refuses a second live entry for a contract, so two mean a write that skipped that check, and neither is trusted.
 * The order of the rest is kept.
 */
export function withoutSharedContracts<T extends { readonly document: LabelDocument }>(labels: readonly T[]): T[] {
  const count = new Map<string, number>();
  for (const l of labels) {
    const k = labelContextKey(l.document);
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  return labels.filter((l) => count.get(labelContextKey(l.document)) === 1);
}
