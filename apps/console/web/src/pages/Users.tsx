// The org's end users (D310, D346; `GET /api/orgs/:org/users`): the User ID (the identity token's `sub`, `u1_…`, the
// one id partners see, like Privy's DID) and its short form, the Support ID; when the user was first and last seen; the
// kinds of account connected; the wallet addresses; and the email only once the user shared it with one of the org's
// apps (D411: "Not shared" otherwise). A user's detail (`GET /api/orgs/:org/users/:userId`) lists each app's shared
// address. Never an unshared address or a Google account id: the console's answer has no such field (src/users.ts).
// Shown only when the server has the screen on (`/api/me` features).
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useApi, when } from '../lib.tsx';
import { CopyButton, Empty, ErrorNote, Loading, PageHeader, Panel } from '../ui.tsx';

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
    <Panel
      title="User"
      actions={
        <button type="button" className="btn btn-quiet btn-small" onClick={onClose}>
          Close
        </button>
      }
    >
      {r.error && <ErrorNote error={r.error} onRetry={r.reload} />}
      {!r.data && !r.error && <Loading />}
      {r.data && (
        <dl className="facts">
          <dt>User ID</dt>
          <dd className="mono small">{r.data.user.userId}</dd>
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
                  <span className="mono small">{e.email}</span>{' '}
                  <span className="muted small">
                    Shared with {e.appName} on {day(e.sharedAt)}
                  </span>
                </div>
              ))
            )}
          </dd>
        </dl>
      )}
    </Panel>
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
      <PageHeader title="Users" description="The people who have signed in to your apps. Each has a User ID (the identity token’s sub, the id your backend stores) and a short Support ID to quote to Hana. An email address appears only once the user shares it with one of your apps." />
      <form
        className="form form-inline filters"
        onSubmit={(e) => {
          e.preventDefault();
          setCursor(undefined);
          setQuery(search.trim());
        }}
      >
        <label className="field field-grow">
          <span className="field-label">Find by wallet address, User ID, Support ID or full email address</span>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="0x…, G…, u1_…, HANA-… or an email address" />
        </label>
        <button type="submit" className="btn">
          Search
        </button>
        {query && (
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              setSearch('');
              setQuery('');
              setCursor(undefined);
            }}
          >
            Clear
          </button>
        )}
      </form>
      <p className="muted small">An email address matches exactly, and only among the addresses users shared with your apps.</p>
      {open && org && <UserDetail key={open} org={org} userId={open} onClose={() => setOpen(undefined)} />}
      {r.error && <ErrorNote error={r.error} onRetry={r.reload} />}
      {!r.data && !r.error && <Loading />}
      {r.data && (
        <>
          {r.data.users.length === 0 ? (
            <Empty title={query ? 'No users match' : 'No users yet'}>
              <p>{query ? 'Check the address or ID, or clear the search.' : 'Users appear here after they first sign in to one of your apps.'}</p>
            </Empty>
          ) : (
            <table className="table">
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
                    <td>
                      <button type="button" className="btn-link mono small" aria-label={`Open ${u.userId}`} onClick={() => setOpen(u.userId)}>
                        {u.userId}
                      </button>{' '}
                      <CopyButton value={u.userId} label="User ID" />
                    </td>
                    <td>
                      <span className="mono">{u.supportId}</span>
                    </td>
                    <td>{u.email ? <span className="mono small">{u.email}</span> : <span className="muted">{NOT_SHARED}</span>}</td>
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
            <button type="button" className="btn" onClick={() => setCursor(r.data!.next)}>
              Next page
            </button>
          )}
        </>
      )}
    </>
  );
}
