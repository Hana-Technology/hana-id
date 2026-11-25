// The org's end users (D310, D346; `GET /api/orgs/:org/users`): the User ID (the identity token's `sub`, `u1_…`, the
// one id partners see, like Privy's DID) and its short form, the Support ID; when the user was first and last seen; the
// kinds of account connected; the wallet addresses; and the email only once the user shared it with one of the org's
// apps (D411: "Not shared" otherwise), and the name the user set in Passport Home likewise only once shared with one of
// them (D714). A user's detail (`GET /api/orgs/:org/users/:userId`) lists each app's shared address. Names and
// addresses are rendered as text only. Never an unshared address or a Google account id: the console's answer has no
// such field (src/users.ts).
// Shown only when the server has the screen on (`/api/me` features). The list sits in a card like every console table;
// its ids stay whole on one line and its wallet addresses are shortened, each copied whole (the detail shows them full).
// NEAR (D755): the user's implicit account, recorded only once they sign in through an SDK of 0.4.0 or later; a user
// without one shows just Stellar and EVM in the list, and "No NEAR account yet" in the detail.
//
// D925 (piece P7): on a wallet several of the org's apps share (a scope Journear marked), the User ID and Support ID
// here are the person's ones for the whole wallet ("all your apps"); apps made after the mark give the person IDs of
// their own. Owners can open "This person on your apps" in a person's detail, and find a person by any app's ID; both
// ask the server, which records each look-up in the org's Audit first. Viewers see neither (the server refuses them).
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, postJson } from '../api.ts';
import { useApi, useOrg, when } from '../lib.tsx';
import { Callout, CopyButton, Empty, ErrorNote, Field, Loading, PageHeader, Panel, ShortValue } from '../ui.tsx';

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
  /** The name shared from Passport Home with one of the org's apps (each part optional, at least one set), or null. */
  name: { givenName: string | null; familyName: string | null } | null;
  /** A wallet several of the org's apps share (D925): these are the person's IDs for all of them. */
  sharedScope?: boolean;
}

/** One person across the org's apps (`POST /api/orgs/:org/users/link`, owners only). */
interface UserLink {
  userId: string;
  supportId: string;
  scopeId: string;
  match: { kind: 'userId' | 'supportId'; of: 'scope' | 'app'; appId: string | null };
  apps: { appId: string; appName: string; userId: string; supportId: string; firstSeenAt: number; lastSeenAt: number }[];
  truncated: boolean;
}

/** The words of the linking view (D925), in one place for the tests and the plain-words check. */
export const LINK_TEXT = {
  panelTitle: 'This person on your apps',
  panelIntro: 'Each app made after this wallet was shared gives this person a User ID and Support ID of its own.',
  show: 'Show their ID on each app',
  /** N7, said where the IDs are shown. */
  rule: 'Never give one partner another partner’s ID for the same person. Each partner should only see its own.',
  recorded: 'Only owners can see this. Each look-up is recorded in your Audit.',
  viewer: 'Only owners can see this person’s ID on each of your apps.',
  findTitle: 'Find a person by an app’s ID',
  findIntro: 'Type the User ID or Support ID that one of your apps has for a person. You see the same person on all your apps.',
  findLabel: 'User ID or Support ID from one of your apps',
  find: 'Find',
  open: 'Open this person',
  allApps: 'all your apps',
  truncated: 'Only the 100 apps they used most recently are listed.',
} as const;

/** "(all your apps)" under a label, on a line of its own, so the label stays narrow and the ID beside it whole. */
function AllApps() {
  return (
    <>
      {' '}
      <span className="dt-sub">({LINK_TEXT.allApps})</span>
    </>
  );
}

/** What the code that matched is, in plain words. */
function matchText(l: UserLink): string {
  const what = l.match.kind === 'userId' ? 'User ID' : 'Support ID';
  if (l.match.of === 'scope') return `This is the person’s ${what} for ${LINK_TEXT.allApps}.`;
  const app = l.apps.find((a) => a.appId === l.match.appId);
  return `This is the ${what} ${app ? app.appName : 'one of your apps'} has for this person.`;
}

/** The person's IDs on each app, with the sharing rule beside them. */
function LinkTable({ link }: { link: UserLink }) {
  return (
    <>
      <Callout tone="warn" role="note" className="link-rule">
        <p>{LINK_TEXT.rule}</p>
      </Callout>
      {link.apps.length === 0 ? (
        <p className="muted">No app of yours has a sign-in from this person yet.</p>
      ) : (
        <div className="jp-table-wrap">
          <table className="jp-table">
            <thead>
              <tr>
                <th scope="col">App</th>
                <th scope="col">User ID</th>
                <th scope="col">Support ID</th>
                <th scope="col">First sign-in</th>
                <th scope="col">Last sign-in</th>
              </tr>
            </thead>
            <tbody>
              {link.apps.map((a) => (
                <tr key={a.appId}>
                  <td>{a.appName}</td>
                  <td>
                    <span className="nowrap">
                      <code className="mono small">{a.userId}</code> <CopyButton value={a.userId} label={`${a.appName} User ID`} />
                    </span>
                  </td>
                  <td className="mono nowrap">{a.supportId}</td>
                  <td>
                    <Moment ms={a.firstSeenAt} />
                  </td>
                  <td>
                    <Moment ms={a.lastSeenAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {link.truncated && <p className="muted small">{LINK_TEXT.truncated}</p>}
      <p className="muted small">{LINK_TEXT.recorded}</p>
    </>
  );
}

/** Asks the server for one person across the org's apps; each call is one recorded look-up. */
function useLink(org: string): { busy: boolean; error: ApiError | undefined; link: UserLink | undefined; run: (query: string, purpose: 'panel' | 'search') => Promise<void>; reset: () => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | undefined>();
  const [link, setLink] = useState<UserLink | undefined>();
  return {
    busy,
    error,
    link,
    reset: () => {
      setError(undefined);
      setLink(undefined);
    },
    run: async (query, purpose) => {
      setBusy(true);
      setError(undefined);
      setLink(undefined);
      try {
        setLink((await postJson<{ link: UserLink }>(`/api/orgs/${org}/users/link`, { query, purpose })).link);
      } catch (err) {
        setError(err instanceof ApiError ? err : new ApiError(0, 'network', 'The console couldn’t be reached'));
      } finally {
        setBusy(false);
      }
    },
  };
}

/** "This person on your apps", in a person's detail: owners press to see it (one recorded look-up); viewers are told why not. */
function PersonApps({ org, userId, owner }: { org: string; userId: string; owner: boolean }) {
  const l = useLink(org);
  return (
    <section className="person-apps" aria-labelledby="person-apps-title">
      <h3 id="person-apps-title">{LINK_TEXT.panelTitle}</h3>
      <p className="muted">{LINK_TEXT.panelIntro}</p>
      {!owner ? (
        <p className="muted">{LINK_TEXT.viewer}</p>
      ) : (
        <>
          {!l.link && (
            <button type="button" className="jp-btn jp-btn-secondary jp-btn-sm" disabled={l.busy} onClick={() => void l.run(userId, 'panel')}>
              {l.busy ? 'Loading…' : LINK_TEXT.show}
            </button>
          )}
          {l.error && <ErrorNote error={l.error} onRetry={() => void l.run(userId, 'panel')} />}
          {l.link && <LinkTable link={l.link} />}
        </>
      )}
    </section>
  );
}

/** Owners: find a person by any of the org's apps' User IDs or Support IDs (one recorded look-up per search). */
function FindAcrossApps({ org, onOpen }: { org: string; onOpen: (userId: string) => void }) {
  const [query, setQuery] = useState('');
  const l = useLink(org);
  return (
    <Panel title={LINK_TEXT.findTitle} description={LINK_TEXT.findIntro} className="section find-across">
      <form
        className="form form-inline"
        onSubmit={(e) => {
          e.preventDefault();
          const q = query.trim();
          if (q) void l.run(q, 'search');
        }}
      >
        <Field className="field-grow" label={LINK_TEXT.findLabel}>
          {(c) => <input {...c} className="jp-input" type="search" autoComplete="off" spellCheck={false} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="u1_… or HANA-…" />}
        </Field>
        <button type="submit" className="jp-btn jp-btn-secondary" disabled={l.busy || !query.trim()}>
          {LINK_TEXT.find}
        </button>
      </form>
      {l.error && <ErrorNote error={l.error} />}
      {l.link && (
        <div className="find-result" role="status">
          <p>
            <strong>{matchText(l.link)}</strong>
          </p>
          <dl className="facts">
            <dt>
              User ID <AllApps />
            </dt>
            <dd>
              <code className="mono small">{l.link.userId}</code>
            </dd>
            <dt>
              Support ID <AllApps />
            </dt>
            <dd className="mono nowrap">{l.link.supportId}</dd>
          </dl>
          <LinkTable link={l.link} />
          <button type="button" className="jp-btn jp-btn-ghost jp-btn-sm" onClick={() => onOpen(l.link!.userId)}>
            {LINK_TEXT.open}
          </button>
        </div>
      )}
    </Panel>
  );
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
function UserDetail({ org, userId, owner, onClose }: { org: string; userId: string; owner: boolean; onClose: () => void }) {
  const r = useApi<{ user: PartnerUser }>(`/api/orgs/${org}/users/${encodeURIComponent(userId)}`);
  const all = r.data?.user.sharedScope ? <AllApps /> : null;
  return (
    <Panel
      title="User"
      className="section"
      actions={
        <button type="button" className="jp-btn jp-btn-ghost jp-btn-sm" onClick={onClose}>
          Close
        </button>
      }
    >
      {r.error && <ErrorNote error={r.error} onRetry={r.reload} />}
      {!r.data && !r.error && <Loading />}
      {r.data && (
        <dl className="facts">
          <dt>User ID{all}</dt>
          <dd>
            <code className="mono small">{r.data.user.userId}</code> <CopyButton value={r.data.user.userId} label="User ID" />
          </dd>
          <dt>Support ID{all}</dt>
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
      {r.data?.user.sharedScope && <PersonApps key={userId} org={org} userId={userId} owner={owner} />}
    </Panel>
  );
}

export function Users() {
  const { org } = useParams();
  const owner = useOrg()?.role === 'owner';
  // Owners of an org with a shared wallet get the cross-app search (D925); the apps list says whether there is one.
  const apps = useApi<{ apps: { sharedScope?: boolean }[] }>(owner ? `/api/orgs/${org}/apps` : null);
  const shared = (apps.data?.apps ?? []).some((a) => a.sharedScope === true);
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
      <PageHeader title="Users" description="The people who have signed in to your apps. Each has a User ID (the identity token’s sub, the id your backend stores) and a short Support ID to quote to Journear. An email address or a name appears only once the user shares it with one of your apps." />
      <form
        className="form form-inline filters"
        onSubmit={(e) => {
          e.preventDefault();
          setCursor(undefined);
          setQuery(search.trim());
        }}
      >
        <Field className="field-grow" label="Find by wallet address, User ID, Support ID or full email address">
          {(c) => <input {...c} className="jp-input" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="0x…, G…, a NEAR account, u1_…, HANA-… or an email address" />}
        </Field>
        <button type="submit" className="jp-btn jp-btn-secondary">
          Search
        </button>
        {query && (
          <button
            type="button"
            className="jp-btn jp-btn-ghost"
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
      {owner && shared && org && <FindAcrossApps org={org} onOpen={(id) => setOpen(id)} />}
      {open && org && <UserDetail key={open} org={org} userId={open} owner={owner} onClose={() => setOpen(undefined)} />}
      {r.error && <ErrorNote error={r.error} onRetry={r.reload} />}
      {!r.data && !r.error && <Loading />}
      {r.data && (
        <>
          {r.data.users.length === 0 ? (
            <Empty title={query ? 'No users match' : 'No users yet'}>
              <p>{query ? 'Check the address or ID, or clear the search.' : 'Users appear here after they first sign in to one of your apps.'}</p>
            </Empty>
          ) : (
            <div className="jp-table-wrap tall">
              <table className="jp-table">
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
                        <button type="button" className="link-btn mono small nowrap" aria-label={`Open ${u.userId}`} onClick={() => setOpen(u.userId)}>
                          {u.userId}
                        </button>{' '}
                        <CopyButton value={u.userId} label="User ID" />
                        {u.sharedScope && <div className="muted small">{LINK_TEXT.allApps}</div>}
                      </td>
                      <td>
                        <span className="mono nowrap">{u.supportId}</span>
                        {u.sharedScope && <div className="muted small">{LINK_TEXT.allApps}</div>}
                      </td>
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
            <button type="button" className="jp-btn jp-btn-secondary load-more" onClick={() => setCursor(r.data!.next)}>
              Next page
            </button>
          )}
        </>
      )}
    </>
  );
}
