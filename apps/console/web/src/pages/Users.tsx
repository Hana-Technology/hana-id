// The org's end users (D310, D346; `GET /api/orgs/:org/users`): the User ID (the identity token's `sub`, `u1_…`, the
// one id partners see, like Privy's DID) and its short form, the Support ID; when the user was first and last seen; the
// kinds of account connected; and the wallet addresses. Never an email address or a Google account id: the console's
// answer has no such field (src/users.ts). Shown only when the server has the screen on (`/api/me` features).
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ErrorNote, useApi, when } from '../lib.tsx';

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
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          setCursor(undefined);
          setQuery(search.trim());
        }}
      >
        <label>
          Find by wallet address, User ID or Support ID <input value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <button type="submit">Search</button>
      </form>
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
                  <th>Accounts</th>
                  <th>Wallets</th>
                  <th>Created</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {r.data.users.map((u) => (
                  <tr key={u.userId}>
                    <td className="mono">{u.userId}</td>
                    <td className="mono">{u.supportId}</td>
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
            <button type="button" onClick={() => setCursor(r.data!.next)}>
              Next page
            </button>
          )}
        </>
      )}
    </>
  );
}
