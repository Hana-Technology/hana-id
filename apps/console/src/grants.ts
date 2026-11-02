// Owner grants (docs/batch-c-spec.md "Invites and owner grants", D89): a new owner of an org that has one is a viewer
// until `owner_from`, then an owner by predicate (sql.ts ownerNow), and the hourly cron records it. Any owner, Hana
// staff or the grant notice's emailed link can cancel until `owner_from`; cancelling leaves the person a viewer.
import { sha256 } from '@hana-id/console-core';
import { type Writer, auditInsert, entry, replayOf } from './audit.ts';
import { refuse } from './errors.ts';
import { applied, frag, gate, gated, lit, runBatch } from './sql.ts';

/** A grant can still be cancelled: not cancelled, not applied, and its `owner_from` (if set) still ahead. */
const cancellable = (g: string, now: number) => `${g}.cancelled_at IS NULL AND ${g}.applied_at IS NULL AND (${g}.owner_from IS NULL OR ${g}.owner_from > ${lit(now)})`;

/**
 * Cancels a grant (staff, or an owner of its org with `orgId`, batch C10). Refusals: `not_found` (unknown, or another
 * org's), `not_pending` (cancelled, applied, or its `owner_from` passed).
 */
export async function cancelOwnerGrant(db: D1Database, w: Writer, grantId: string, orgId?: string): Promise<void> {
  const row = await db.prepare('SELECT org_id FROM owner_grants WHERE id = ?').bind(grantId).first<{ org_id: string }>();
  if (!row || (orgId !== undefined && row.org_id !== orgId)) return refuse('not_found', 'No such owner grant');
  const action = 'owner_grant.cancelled';
  const g = gate(w.requestId, action);
  const results = await runBatch(
    db,
    [
      auditInsert(db, entry(w, action, { orgId: row.org_id, target: grantId, details: { via: w.actor.kind } }), frag(`EXISTS (SELECT 1 FROM owner_grants g WHERE g.id = ? AND ${cancellable('g', w.now)})`, grantId)),
      gated(db, 'UPDATE owner_grants SET cancelled_at = ?, cancelled_by = ? WHERE id = ?', [w.now, `${w.actor.kind}:${w.actor.id}`, grantId], g),
    ],
    replayOf(w, action, grantId),
  );
  if (!applied(results)) refuse('not_pending', 'The grant was already cancelled or applied, or its wait is over');
}

/**
 * The emailed link's POST confirm (`POST /api/owner-grants/cancel`): the token's sha256 must equal the grant's
 * `cancel_token_hash` (set by the notice's ack). A wrong token, an unknown grant or one not announced yet is
 * `forbidden` (nothing tells a guesser which); the right token on a grant that can't be cancelled any more (already
 * cancelled: the link is single use; applied; `owner_from` passed) is `not_pending`.
 */
export async function cancelOwnerGrantByLink(db: D1Database, w: Writer, grantId: string, token: Uint8Array): Promise<void> {
  const presented = await sha256(token);
  const row = await db.prepare('SELECT org_id FROM owner_grants WHERE id = ? AND cancel_token_hash = ?').bind(grantId, presented).first<{ org_id: string }>();
  if (!row) return refuse('forbidden', 'This link is not valid');
  const action = 'owner_grant.cancelled';
  const g = gate(w.requestId, action);
  const results = await runBatch(
    db,
    [
      auditInsert(
        db,
        entry(w, action, { orgId: row.org_id, target: grantId, details: { via: 'link' } }),
        frag(`EXISTS (SELECT 1 FROM owner_grants g WHERE g.id = ? AND g.cancel_token_hash = ? AND ${cancellable('g', w.now)})`, grantId, presented),
      ),
      gated(db, 'UPDATE owner_grants SET cancelled_at = ?, cancelled_by = ? WHERE id = ?', [w.now, `link:${grantId}`, grantId], g),
    ],
    replayOf(w, action, grantId),
  );
  if (!applied(results)) refuse('not_pending', 'The grant was already cancelled or applied, or its wait is over');
}
