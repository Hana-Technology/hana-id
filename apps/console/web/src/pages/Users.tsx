// The org's end users (D310, D346; `GET /api/orgs/:org/users`): the User ID (the identity token's `sub`, `u1_…`, the
// one id partners see, like Privy's DID) and its short form, the Support ID; when the user was first and last seen; the
// kinds of account connected; the wallet addresses; and the email only once the user shared it with one of the org's
// apps (D411: "Not shared" otherwise), and the name the user set in Hana Home likewise only once shared with one of
// them (D714). A user's detail (`GET /api/orgs/:org/users/:userId`) lists each app's shared address. Names and
// addresses are rendered as text only. Never an unshared address or a Google account id: the console's answer has no
// such field (src/users.ts).
// Shown only when the server has the screen on (`/api/me` features). The list sits in a card like every console table;
// its ids stay whole on one line and its wallet addresses are shortened, each copied whole (the detail shows them full).
// NEAR (D755): the user's implicit account, recorded only once they sign in through an SDK of 0.4.0 or later; a user
// without one shows just Stellar and EVM in the list, and "No NEAR account yet" in the detail.
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useApi, when } from '../lib.tsx';
import { CopyButton, Empty, ErrorNote, Loading, PageHeader, Panel, ShortValue } from '../ui.tsx';

interface PartnerUser {
  userId: string;
  supportId: string;
  scopeId: string;
  createdAt: number;
  lastSeenAt: number;
  accounts: { kind: string; status: 'active' | 'pending' }[];
  wallets: { chain: 'stellar' | 'evm' | 'near'; address: string; firstSeenAt: number; lastUsedAt: number }[];
  /** The address most recently shared with one of the org's apps, or null. */
  email: string | null;
  /** A user's detail only: each app's shared address. */
  emails?: { appId: string; appName: string; email: string; sharedAt: number }[];
  /** The name shared from Hana Home with one of the org's apps (each part optional, at least one set), or null. */
  name: { givenName: string | null; familyName: string | null } | null;
}

const KIND: Record<string, string> = { google: 'Google', email: 'Email', apple: 'Apple', other: 'Other' };
const NOT_SHARED = 'Not shared';

const day = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });
/** A time in the list, as `when` but narrower: the date, then the time on a line of its own. */
function Moment({ ms }: { ms: number }) {
  const d = new Date(ms);
  return (
    <>
      {day(ms)}
      <br />
      <span className="nowrap">{d.toLocaleTimeString(undefined, { timeStyle: 'short' })}</span>
    </>
  );
}
/** A shared name as one line: the first name, then the last, whichever are set. */
const nameText = (n: NonNullable<PartnerUser['name']>): string => [n.givenName, n.familyName].filter((p): p is string => p !== null).join(' ');
/** Which part a one-part name is, in a user's detail (a partner storing it needs to know). */
const namePartHint = (n: NonNullable<PartnerUser['name']>): string | null => (n.familyName === null ? 'first name only' : n.givenName === null ? 'last name only' : null);
const accountsText = (u: PartnerUser): string => u.accounts.map((a) => `${KIND[a.kind] ?? 'Other'}${a.status === 'pending' ? ' (pending)' : ''}`).join(', ') || '—';

const CHAIN: Record<string, string> = { stellar: 'Stellar', evm: 'EVM', near: 'NEAR' };
const chainName = (c: string): string => CHAIN[c] ?? c;
const NO_NEAR = 'No NEAR account yet';

/** The wallets in full, each with its copy button (a user's detail), and a plain line when NEAR isn't recorded yet. */
function Wallets({ u }: { u: PartnerUser }) {
  return (
    <>
      {u.wallets.map((w) => (
        <div key={`${w.chain}:${w.address}`}>
          <span className="muted small">{chainName(w.chain)}</span> <code className="mono small">{w.address}</code> <CopyButton value={w.address} label={`${chainName(w.chain)} address`} />
        </div>
      ))}
      {!u.wallets.some((w) => w.chain === 'near') && (
        <div>
          <span className="muted small">NEAR</span> <span className="muted small">{NO_NEAR}</span>
        </div>
      )}
    </>
  );
}

/** The wallets shortened to one line each (the list), each copied whole. */
function ShortWallets({ u }: { u: PartnerUser }) {
  return (
    <>
      {u.wallets.map((w) => (
        <div key={`${w.chain}:${w.address}`} className="nowrap">
          <span className="muted small">{chainName(w.chain)}</span> <ShortValue value={w.address} label={`${chainName(w.chain)} address`} />
        </div>
      ))}
    </>
  );
}

/** An email address that wraps only after its `@`, never mid-word (one element, so its text reads and matches whole). */
function EmailText({ email }: { email: string }) {
  const at = email.lastIndexOf('@') + 1;
  return (
    <span className="mono small keep-words">
      {email.slice(0, at)}
      {at > 0 && <wbr />}
      {email.slice(at)}
    </span>
  );
}

/** One user's detail: the list's fields and, per app, the address the user shared with it. */
function UserDetail({ org, userId, onClose }: { org: string; userId: string; onClose: () => void }) {
  const r = useApi<{ user: PartnerUser }>(`/api/orgs/${org}/users/${encodeURIComponent(userId)}`);
  return (
    <Panel
      title="User"
      className="section"
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
          <dd>
            <code className="mono small">{r.data.user.userId}</code> <CopyButton value={r.data.user.userId} label="User ID" />
          </dd>
          <dt>Support ID</dt>
          <dd className="mono nowrap">{r.data.user.supportId}</dd>
          <dt>Name</dt>
          <dd>
            {r.data.user.name ? (
              <>
                {nameText(r.data.user.name)}
                {namePartHint(r.data.user.name) && <span className="muted small"> ({namePartHint(r.data.user.name)})</span>}
              </>
            ) : (
              <span className="muted">{NOT_SHARED}</span>
            )}
          </dd>
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
                  <EmailText email={e.email} />{' '}
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
      <PageHeader title="Users" description="The people who have signed in to your apps. Each has a User ID (the identity token’s sub, the id your backend stores) and a short Support ID to quote to Hana. An email address or a name appears only once the user shares it with one of your apps." />
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
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="0x…, G…, a NEAR account, u1_…, HANA-… or an email address" />
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
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">User ID</th>
                    <th scope="col">Support ID</th>
                    <th scope="col">Name</th>
                    <th scope="col">Email</th>
                    <th scope="col">Accounts</th>
                    <th scope="col">Wallets</th>
                    <th scope="col">Created</th>
                    <th scope="col">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {r.data.users.map((u) => (
                    <tr key={u.userId}>
                      <td>
                        <button type="button" className="btn-link mono small nowrap" aria-label={`Open ${u.userId}`} onClick={() => setOpen(u.userId)}>
                          {u.userId}
                        </button>{' '}
                        <CopyButton value={u.userId} label="User ID" />
                      </td>
                      <td className="mono">{u.supportId}</td>
                      <td>{u.name ? nameText(u.name) : <span className="muted">{NOT_SHARED}</span>}</td>
                      <td>{u.email ? <EmailText email={u.email} /> : <span className="muted">{NOT_SHARED}</span>}</td>
                      <td>{accountsText(u)}</td>
                      <td>
                        <ShortWallets u={u} />
                      </td>
                      <td>
                        <Moment ms={u.createdAt} />
                      </td>
                      <td>
                        <Moment ms={u.lastSeenAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {r.data.next && (
            <button type="button" className="btn load-more" onClick={() => setCursor(r.data!.next)}>
              Next page
            </button>
          )}
        </>
      )}
    </>
  );
}
