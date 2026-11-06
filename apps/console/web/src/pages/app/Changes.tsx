// An app's guarded changes (origin adds, policy sets, raw signing on): where each is (requested, announced, in
// effect), who asked, and the owner's Cancel while it is pending (`POST /api/orgs/:org/changes/:id/cancel`, immediate,
// open in a frozen org too).
import type { GuardedChange } from '@hana-id/console-core';
import { postJson } from '../../api.ts';
import { useNow, useWrite } from '../../lib.tsx';
import { ChangeTrack, ConfirmButton, WriteNote, proposer } from '../../ui.tsx';
import type { AppCtl } from '../Apps.tsx';

const TITLE: Record<GuardedChange['kind'], string> = { origin_add: 'Add origin', policy_set: 'Set the auto-approve policy', raw_sign_on: 'Turn raw signing on' };

export function changeTitle(c: GuardedChange): string {
  if (c.kind === 'origin_add') return `${TITLE.origin_add} ${c.display ?? c.origin ?? ''}`;
  if (c.kind === 'policy_set') return `${TITLE.policy_set}${c.policyId ? ` (policy ${c.policyId.slice(0, 12)}…)` : ''}`;
  return TITLE.raw_sign_on;
}

/** One-line state for tables and summaries. */
export function changeState(c: GuardedChange, now: number): string {
  if (c.status === 'pending') return c.notifiedAt === undefined ? 'Waiting for the announcement email: the delay starts once it is sent' : `Pending: active from ${new Date(c.activeFrom ?? 0).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
  if (c.status === 'active') return 'In effect';
  return c.status === 'cancelled' ? 'Cancelled' : 'Ended';
}

/** The pending changes of `kinds`, each with its timeline and (for an owner) Cancel. */
export function PendingChanges({ ctl, kinds, title = 'Waiting to take effect' }: { ctl: AppCtl; kinds: GuardedChange['kind'][]; title?: string | null }) {
  const now = useNow(30_000);
  const w = useWrite();
  const list = ctl.app.changes.filter((c) => c.status === 'pending' && kinds.includes(c.kind));
  if (list.length === 0) return null;
  return (
    <div className="pending">
      {title && <h3>{title}</h3>}
      <ul className="pending-list">
        {list.map((c) => (
          <li key={c.id} className="pending-item">
            <div className="pending-head">
              <span className="pending-what">
                {changeTitle(c)}
                {c.idn && <span className="badge badge-warn">IDN</span>}
              </span>
              {ctl.owner && (
                <ConfirmButton
                  label="Cancel"
                  confirm="Cancel this change"
                  detail="It never takes effect. You can request it again later."
                  busy={w.busy}
                  onConfirm={() =>
                    void w.run(async () => {
                      await postJson(`/api/orgs/${ctl.org}/changes/${c.id}/cancel`, {});
                      ctl.reload();
                      return 'Cancelled. It won’t take effect.';
                    })
                  }
                />
              )}
            </div>
            <p className="pending-by muted small">
              Requested by {(c.proposedByKind === 'member' && ctl.nameOf(c.proposedBy)) || proposer(c)}
              {c.proposedByKind === 'member' && ctl.nameOf(c.proposedBy) && c.requestCountry ? ` (from ${c.requestCountry})` : ''}. {changeState(c, now)}.
            </p>
            <ChangeTrack change={c} now={now} />
          </li>
        ))}
      </ul>
      <p className="muted small">Each change is announced by email to your organisation’s security contacts, then takes effect after the security delay. Until then any owner can cancel it here, or anyone with the email can use its cancel link.</p>
      <WriteNote error={w.error} done={w.done} />
    </div>
  );
}
