// The org's end users (D310, D346; `GET /api/orgs/:org/users`): the User ID (the identity token's `sub`, `u1_…`, the
// one id partners see, like Privy's DID) and its short form, the Support ID; when the user was first and last seen; the
// kinds of account connected; and the wallet addresses. Never an email address or a Google account id: the console's
// answer has no such field (src/users.ts). Shown only when the server has the screen on (`/api/me` features).
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useApi, when } from '../lib.tsx';
import { CopyButton, Empty, ErrorNote, Loading, PageHeader } from '../ui.tsx';

interface PartnerUser {
  userId: string;
  supportId: string;
  scopeId: string;
  createdAt: number;
  lastSeenAt: number;
  accounts: { kind: string; status: 'active' | 'pending' }[];
  wallets: { chain: 'stellar' | 'evm'; address: string; firstSeenAt: number; lastUsedAt: number }[];
}

const KIND: Record<string, string> = { google: 'Google', email: 'Email', apple: 'Apple', other: 'Other' };

export function Users() {
  const { org } = useParams();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const params = new URLSearchParams();
  if (query) params.set('search', query);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  const r = useApi<{ users: PartnerUser[]; next?: string }>(`/api/orgs/${org}/users${qs ? `?${qs}` : ''}`);
  return (
    <>
      <PageHeader title="Users" description="The people who have signed in to your apps. Each has a User ID (the identity token’s sub, the id your backend stores) and a short Support ID to quote to Hana. Email addresses are never shown." />
      <form
        className="form form-inline filters"
        onSubmit={(e) => {
          e.preventDefault();
          setCursor(undefined);
          setQuery(search.trim());
        }}
      >
        <label className="field field-grow">
          <span className="field-label">Find by wallet address, User ID or Support ID</span>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="0x…, G…, u1_… or HANA-…" />
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
                      <span className="mono small">{u.userId}</span> <CopyButton value={u.userId} label="User ID" />
                    </td>
                    <td>
                      <span className="mono">{u.supportId}</span>
                    </td>
                    <td>{u.accounts.map((a) => `${KIND[a.kind] ?? 'Other'}${a.status === 'pending' ? ' (pending)' : ''}`).join(', ') || '—'}</td>
                    <td>
                      {u.wallets.map((w) => (
                        <div key={`${w.chain}:${w.address}`} className="mono small">
                          {w.chain === 'stellar' ? 'Stellar' : 'EVM'} {w.address}
                        </div>
                      ))}
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
