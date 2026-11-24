// What a request labels change changes for users (D899), line by line against what they see now: the API's diff (D894
// `diffOf`), as the confirmation page and the list's waiting change show it. Text only (partner words are text nodes).
import { durationWords } from '@hana-id/console-core/duration-words';
import { Badge } from '../ui.tsx';

export interface DiffLine {
  change: 'added' | 'removed' | 'changed' | 'same';
  key: string;
  before: string | null;
  after: string | null;
}

const DIFF_TEXT: Record<DiffLine['change'], string> = { added: 'Added', removed: 'Removed', changed: 'Changed', same: 'Stays the same' };

/** The changed lines (none: the one line that says so). */
export function DiffList({ diff }: { diff: readonly DiffLine[] }) {
  const changed = diff.filter((x) => x.change !== 'same');
  if (changed.length === 0) return <p>The example lines users see stay the same: what changes is elsewhere in the description (its conditions, its lists of values, the program’s code it describes, or the apps).</p>;
  return (
    <ul className="labels-diff">
      {changed.map((x) => (
        <li key={x.key} className={`diff-${x.change}`} data-change={x.change}>
          <span className="diff-badge">
            <Badge tone={x.change === 'removed' ? 'danger' : x.change === 'added' ? 'ok' : 'warn'}>{DIFF_TEXT[x.change]}</Badge>
            {x.key === '(contract)' ? ' What they describe' : ''}
          </span>
          {x.before !== null && x.change !== 'added' && (
            <span className="diff-before">
              <span className="visually-hidden">Now: </span>
              {x.before}
            </span>
          )}
          {x.after !== null && x.change !== 'removed' && (
            <span className="diff-after">
              <span className="visually-hidden">Becomes: </span>
              {x.after}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * When a change goes live, after the email: "{1 day} after the email", in the admin notices' own words (console-core
 * `durationWords`, the same function); the delay unnamed when the API didn't say.
 */
export const afterEmail = (delayMs: number | null | undefined): string => (typeof delayMs === 'number' ? `${durationWords(delayMs)} after the email` : 'after the security delay that follows the email');

/** Every listed account's name and account whole (the example lines show one account only). Text only. */
export function AccountLines({ accounts }: { accounts: readonly string[] }) {
  if (accounts.length === 0) return null;
  return (
    <>
      <p className="muted small">The accounts and the names users can be shown for them:</p>
      <ul className="labels-accounts">
        {accounts.map((a) => (
          <li key={a} className="mono-wrap small">
            {a}
          </li>
        ))}
      </ul>
    </>
  );
}
