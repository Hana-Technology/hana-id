// An app's guarded changes (origin adds, policy sets, raw signing on): where each is (requested, announced, in
// effect), who asked, and the owner's Cancel while it is pending (`POST /api/orgs/:org/changes/:id/cancel`, immediate,
// open in a frozen org too).
import type { GuardedChange } from '@hana-id/console-core';
import { postJson } from '../../api.ts';
import { useNow, useWrite } from '../../lib.tsx';
import { Badge, ChangeTrack, ConfirmButton, WriteNote, proposer } from '../../ui.tsx';
import type { AppCtl } from '../Apps.tsx';

const TITLE: Record<GuardedChange['kind'], string> = { origin_add: 'Add web address', policy_set: 'Set the auto-approve policy', raw_sign_on: 'Turn raw signing on' };

export function changeTitle(c: GuardedChange): string {
  if (c.kind === 'origin_add') return `${TITLE.origin_add} ${c.display ?? c.origin ?? ''}`;
  if (c.kind === 'policy_set') return `${TITLE.policy_set}${c.policyId ? ` (policy ${c.policyId.slice(0, 12)}…)` : ''}`;
  return TITLE.raw_sign_on;
}

/**
 * Still waiting to take effect at `now` (the server's clock, `AppCtl.serverNow`): pending and not announced, or announced
 * with its time still ahead (the API's NOT_YET). A pending change whose time has passed is in force (the API serves it,
 * and refuses its Cancel), even when the page was read before that time.
 */
export const isWaiting = (c: GuardedChange, now: number): boolean => c.status === 'pending' && (c.activeFrom === null || c.activeFrom === undefined || c.activeFrom > now);

/** A platform proposal's wait in words: whole hours ("24 hours"), else minutes (a local test setup's short wait). */
const waitWords = (ms: number): string => (ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)} hours` : `${Math.max(1, Math.round(ms / 60_000))} minutes`);

/** One-line state for tables and summaries. */
export function changeState(c: GuardedChange, now: number): string {
  // D930: a web address your backend asked for always waits 24 hours after its email (outside local test setups), and
  // nothing brings it forward yet (an owner's confirmation is still to come: docs/partner-platform-spec.md A15, P10).
  if (isWaiting(c, now) && c.proposedByKind === 'platform')
    return c.notifiedAt === undefined
      ? 'Waiting for the announcement email: its 24 hours start once it is sent'
      : `Waiting ${waitWords((c.activeFrom ?? 0) - c.notifiedAt)} after its email: starts working ${new Date(c.activeFrom ?? 0).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
  if (isWaiting(c, now)) return c.notifiedAt === undefined ? 'Waiting for the announcement email: the delay starts once it is sent' : `Pending: active from ${new Date(c.activeFrom ?? 0).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
  if (c.status === 'active' || c.status === 'pending') return 'In effect';
  return c.status === 'cancelled' ? 'Cancelled' : 'Ended';
}

/** The changes of `kinds` still waiting, each with its timeline and (for an owner) Cancel. */
export function PendingChanges({ ctl, kinds, title = 'Waiting to take effect' }: { ctl: AppCtl; kinds: GuardedChange['kind'][]; title?: string | null }) {
  useNow(30_000); // re-render every 30 s: the countdowns and the moment a change takes effect
  const w = useWrite();
  // On the server's clock (D701): a change the server would still let you cancel keeps its Cancel, whatever the
  // reader's clock says, and one in force there never shows as waiting.
  const at = ctl.serverNow();
  const list = ctl.app.changes.filter((c) => isWaiting(c, at) && kinds.includes(c.kind));
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
                {c.idn && (
                  <>
                    {' '}
                    <Badge tone="warn">IDN</Badge>
                  </>
                )}
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
            {c.proposedByKind === 'platform' && (
              <p className="pending-by small">
                <Badge tone="info">Asked for by your backend</Badge>
              </p>
            )}
            <p className="pending-by muted small">
              Requested by {(c.proposedByKind === 'member' && ctl.nameOf(c.proposedBy)) || proposer(c, ctl.keyLabels)}
              {c.proposedByKind === 'member' && ctl.nameOf(c.proposedBy) && c.requestCountry ? ` (from ${c.requestCountry})` : ''}. {changeState(c, at)}.
            </p>
            <ChangeTrack change={c} now={at} />
          </li>
        ))}
      </ul>
      <p className="muted small">Each change is announced by email to your organisation’s security contacts, then takes effect after the security delay. Until then any owner can cancel it here, or anyone with the email can use its cancel link.</p>
      {list.some((c) => c.proposedByKind === 'platform') && (
        <p className="muted small">Web addresses your backend asks for always wait 24 hours after their email, and nothing makes them start sooner. If one isn’t yours, cancel it.</p>
      )}
      <WriteNote error={w.error} />
    </div>
  );
}
