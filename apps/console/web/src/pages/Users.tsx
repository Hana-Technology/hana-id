// The org's end users (D310, D346; `GET /api/orgs/:org/users`): the User ID (the identity token's `sub`, `u1_…`, the
// one id partners see, like Privy's DID) and its short form, the Support ID; when the user was first and last seen; the
// kinds of account connected; the wallet addresses; and the email only once the user shared it with one of the org's
// apps (D411: "Not shared" otherwise). A user's detail (`GET /api/orgs/:org/users/:userId`) lists each app's shared
// address. Never an unshared address or a Google account id: the console's answer has no such field (src/users.ts).
// Shown only when the server has the screen on (`/api/me` features).
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ErrorNote, Section, useApi, when } from '../lib.tsx';

interface PartnerUser {
  userId: string;
  supportId: string;
  scopeId: string;
  createdAt: number;
  lastSeenAt: number;
  accounts: { kind: string; status: 'active' | 'pending' }[];
  wallets: { chain: 'stellar' | 'evm'; address: string; firstSeenAt: number; lastUsedAt: number }[];
  /** The address most recently shared with one of the org's apps, or null. */
  email: string | null;
  /** A user's detail only: each app's shared address. */
  emails?: { appId: string; appName: string; email: string; sharedAt: number }[];
}

const KIND: Record<string, string> = { google: 'Google', email: 'Email', apple: 'Apple', other: 'Other' };
const NOT_SHARED = 'Not shared';

const day = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });
const accountsText = (u: PartnerUser): string => u.accounts.map((a) => `${KIND[a.kind] ?? 'Other'}${a.status === 'pending' ? ' (pending)' : ''}`).join(', ') || '—';

function Wallets({ u }: { u: PartnerUser }) {
  return (
    <>
      {u.wallets.map((w) => (
        <div key={`${w.chain}:${w.address}`} className="mono small">
          {w.chain === 'stellar' ? 'Stellar' : 'EVM'} {w.address}
        </div>
      ))}
    </>
  );
}

/** One user's detail: the list's fields and, per app, the address the user shared with it. */
function UserDetail({ org, userId, onClose }: { org: string; userId: string; onClose: () => void }) {
  const r = useApi<{ user: PartnerUser }>(`/api/orgs/${org}/users/${encodeURIComponent(userId)}`);
  return (
    <Section title="User">
      {r.error && <ErrorNote error={r.error} />}
      {!r.data && !r.error && <p className="muted">Loading…</p>}
      {r.data && (
        <dl className="settings">
          <dt>User ID</dt>
          <dd className="mono">{r.data.user.userId}</dd>
          <dt>Support ID</dt>
          <dd className="mono">{r.data.user.supportId}</dd>
          <dt>Accounts</dt>
          <dd>{accountsText(r.data.user)}</dd>
          <dt>Wallets</dt>
          <dd>
            <Wallets u={r.data.user} />
          </dd>
          <dt>Created</dt>
          <dd>{when(r.data.user.createdAt)}</dd>
          <dt>Last seen</dt>
          <dd>{when(r.data.user.lastSeenAt)}</dd>
          <dt>Email</dt>
          <dd>
            {(r.data.user.emails ?? []).length === 0 ? (
              <span className="muted">{NOT_SHARED}</span>
            ) : (
              (r.data.user.emails ?? []).map((e) => (
                <div key={`${e.appId}:${e.email}`}>
                  <span className="mono">{e.email}</span>{' '}
                  <span className="muted small">
                    Shared with {e.appName} on {day(e.sharedAt)}
                  </span>
                </div>
              ))
            )}
          </dd>
        </dl>
      )}
      <button type="button" className="link" onClick={onClose}>
        Close
      </button>
    </Section>
  );
}

export function Users() {
  const { org } = useParams();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [open, setOpen] = useState<string | undefined>();
  const params = new URLSearchParams();
  if (query) params.set('search', query);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  const r = useApi<{ users: PartnerUser[]; next?: string }>(`/api/orgs/${org}/users${qs ? `?${qs}` : ''}`);
  return (
    <>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          setCursor(undefined);
          setQuery(search.trim());
        }}
      >
        <label>
          Find by wallet address, User ID, Support ID or full email address <input value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <button type="submit">Search</button>
      </form>
      <p className="muted small">An email address matches exactly, and only among the addresses users shared with your apps.</p>
      {open && org && <UserDetail key={open} org={org} userId={open} onClose={() => setOpen(undefined)} />}
      {r.error && <ErrorNote error={r.error} />}
      {!r.data && !r.error && <p className="muted">Loading…</p>}
      {r.data && (
        <>
          {r.data.users.length === 0 ? (
            <p className="muted">No users{query ? ' match' : ' yet'}.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>User ID</th>
                  <th>Support ID</th>
                  <th>Email</th>
                  <th>Accounts</th>
                  <th>Wallets</th>
                  <th>Created</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {r.data.users.map((u) => (
                  <tr key={u.userId}>
                    <td className="mono">
                      <button type="button" className="link mono" aria-label={`Open ${u.userId}`} onClick={() => setOpen(u.userId)}>
                        {u.userId}
                      </button>
                    </td>
                    <td className="mono">{u.supportId}</td>
                    <td>{u.email === null ? <span className="muted">{NOT_SHARED}</span> : <span className="mono">{u.email}</span>}</td>
                    <td>{accountsText(u)}</td>
                    <td>
                      <Wallets u={u} />
                    </td>
                    <td>{when(u.createdAt)}</td>
                    <td>{when(u.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {r.data.next && (
            <button type="button" onClick={() => setCursor(r.data!.next)}>
              Next page
            </button>
          )}
        </>
      )}
    </>
  );
}
