// An org's scopes on chain (docs/batch-c-spec.md "Console BFF routes" `GET /api/orgs/:org/scopes/:scope`, "Apps,
// scopes and client mode" → "Owner drift", "On-chain owner actions" step 3): the decoded on-chain view (owners,
// clients, shared login, pending changes with their unlock times), owner drift between the org's owners in CONSOLE_DB
// and the scope's on-chain owners, and the client-proof helper download.
//
// What a partner sees (D296): on-chain owners that are members of the org by their user id and address (the org's own
// staff), `Near` owners by account id (public on chain), and any other `Oidc` owner only as "a Google account that
// isn't a member of this organisation" — never a Google `sub`.
import { clientProofNonce, scopeIdInput } from '@hana-id/console-core';
import type { Actor } from '@hana-id/console-core';
import type { Env } from './env.ts';
import { errorResponse, json } from './http.ts';
import { NearUnavailable, type ScopeView, viewScope } from './near.ts';
import { ownerNow } from './sql.ts';

interface RpcCtx {
  actor: Actor;
  requestId: string;
  clientIp: string;
}

/** Whether `scopeId` is the scope of one of the org's apps (ConsoleRpc.listApps: the hot DB is authoritative). */
export async function scopeOfOrg(env: Env, ctx: RpcCtx, orgId: string, scopeId: string): Promise<boolean> {
  if (!scopeIdInput.safeParse(scopeId).success) return false;
  const r = await env.API.listApps({ ...ctx, orgId });
  return r.ok && r.apps.some((a) => a.scopeId === scopeId);
}

export interface OwnerSet {
  /** The Google subs of the org's usable owners now (not disabled, role or matured grant), for a SetOwners. */
  subs: string[];
  /** Every member's sub → who (to decode on-chain owners; never sent to the SPA). */
  members: Map<string, { userId: string; email: string; owner: boolean }>;
}

export async function orgOwnerSet(env: Env, orgId: string, now: number): Promise<OwnerSet> {
  const { results } = await env.CONSOLE_DB.prepare(
    `SELECT u.id, u.sub, u.email, u.provider, (u.disabled_at IS NULL AND ${ownerNow('m', now)}) AS owner FROM members m JOIN console_users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.added_at, u.id`,
  )
    .bind(orgId)
    .all<{ id: string; sub: string; email: string; provider: string; owner: number }>();
  const members = new Map<string, { userId: string; email: string; owner: boolean }>();
  const subs: string[] = [];
  for (const r of results) {
    if (r.provider !== 'google') continue;
    members.set(r.sub, { userId: r.id, email: r.email, owner: !!r.owner });
    if (r.owner) subs.push(r.sub);
  }
  return { subs, members };
}

export type DecodedOwner = { kind: 'near'; accountId: string } | { kind: 'member'; userId: string; email: string; orgOwner: boolean } | { kind: 'other_google' } | { kind: 'other'; provider: string };

export function decodeOwner(o: unknown, owners: OwnerSet): DecodedOwner {
  const x = o as { Near?: { account_id?: unknown }; Oidc?: { provider?: unknown; sub?: unknown } };
  if (x?.Near && typeof x.Near.account_id === 'string') return { kind: 'near', accountId: x.Near.account_id };
  if (x?.Oidc && typeof x.Oidc.sub === 'string') {
    if (x.Oidc.provider !== 'google') return { kind: 'other', provider: String(x.Oidc.provider).slice(0, 32) };
    const m = owners.members.get(x.Oidc.sub);
    return m ? { kind: 'member', userId: m.userId, email: m.email, orgOwner: m.owner } : { kind: 'other_google' };
  }
  return { kind: 'other', provider: 'unknown' };
}

/** A contract `Change` as the screen shows it (no `sub`). */
export function decodeChange(change: unknown, owners: OwnerSet): Record<string, unknown> {
  const c = change as { AddClient?: { provider?: unknown; aud?: unknown }; SetOwners?: { owners?: unknown }; SetAllowShared?: { allow?: unknown } };
  if (c?.AddClient) return { kind: 'AddClient', provider: String(c.AddClient.provider), aud: String(c.AddClient.aud) };
  if (c?.SetOwners && Array.isArray(c.SetOwners.owners)) return { kind: 'SetOwners', owners: c.SetOwners.owners.map((o) => decodeOwner(o, owners)) };
  if (c?.SetAllowShared) return { kind: 'SetAllowShared', allow: c.SetAllowShared.allow === true };
  return { kind: 'unknown' };
}

export interface ScopeAnswer {
  scope: {
    id: string;
    actionNonce: number;
    allowShared: boolean;
    clients: { provider: string; aud: string }[];
    owners: DecodedOwner[];
    pending: { id: number; change: Record<string, unknown>; unlockAt: number; executable: boolean }[];
  };
  /** Owner drift: the org's owners not on chain, members on chain who aren't org owners, and on-chain strangers. */
  drift: { hasDrift: boolean; missingOnChain: { userId: string; email: string }[]; notOrgOwners: { userId: string; email: string }[]; unknownOnChain: number };
  /** Whether the signed-in member is an on-chain owner (owner actions need it). */
  youAreOnChainOwner: boolean;
}

export function scopeAnswer(s: ScopeView, owners: OwnerSet, mySub: string, now: number): ScopeAnswer {
  const decoded = s.owners.map((o) => decodeOwner(o, owners));
  const onChainSubs = new Set(s.owners.flatMap((o) => ('Oidc' in o && o.Oidc.provider === 'google' ? [o.Oidc.sub] : [])));
  const missingOnChain = owners.subs.filter((sub) => !onChainSubs.has(sub)).map((sub) => ({ userId: owners.members.get(sub)!.userId, email: owners.members.get(sub)!.email }));
  const notOrgOwners = decoded.flatMap((d) => (d.kind === 'member' && !d.orgOwner ? [{ userId: d.userId, email: d.email }] : []));
  const unknownOnChain = decoded.filter((d) => d.kind === 'other_google' || d.kind === 'other').length;
  return {
    scope: {
      id: s.id,
      actionNonce: s.action_nonce,
      allowShared: s.allow_shared,
      clients: s.clients.map(([provider, aud]) => ({ provider, aud })),
      owners: decoded,
      pending: s.pending.map((p) => ({ id: p.id, change: decodeChange(p.change, owners), unlockAt: p.unlock_at_ms, executable: p.unlock_at_ms <= now })),
    },
    drift: { hasDrift: missingOnChain.length + notOrgOwners.length + unknownOnChain > 0, missingOnChain, notOrgOwners, unknownOnChain },
    youAreOnChainOwner: onChainSubs.has(mySub),
  };
}

/** `GET /api/orgs/:org/scopes/:scope` (viewer). */
export async function scopeRoute(env: Env, ctx: RpcCtx, orgId: string, scopeId: string, mySub: string): Promise<Response> {
  if (!(await scopeOfOrg(env, ctx, orgId, scopeId))) return errorResponse('not_found');
  let s: ScopeView | null;
  try {
    s = await viewScope(env, scopeId);
  } catch (err) {
    if (err instanceof NearUnavailable) return errorResponse('near_unavailable', 'NEAR RPC is unavailable: try again');
    throw err;
  }
  if (!s) return errorResponse('not_found', 'The scope is not registered on chain');
  const now = Date.now();
  return json(200, scopeAnswer(s, await orgOwnerSet(env, orgId, now), mySub, now));
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);
const GOOGLE_CLIENT_RE = /^[0-9]{1,32}-[0-9a-z]{1,64}\.apps\.googleusercontent\.com$/u;

/**
 * The client-proof helper (spec "On-chain owner actions" step 3): a self-contained static HTML page, downloaded
 * (`Content-Disposition: attachment`), never served for display by the console. The partner opens it on one of the
 * client's own origins, where it signs in with that client and shows the ID token to paste back.
 *
 * It uses Google's implicit flow (`response_type=id_token`, `scope=openid`, `prompt=select_account`) with the page's own
 * address as the redirect URI, not Google Identity Services: GIS tokens always carry `email` and a name, which the
 * claim allow-list refuses on chain (D274), so the page's address must be a registered redirect URI of the client
 * while it is used (D351). The nonce is the scope's client-proof nonce at its current `action_nonce`, so the proof is
 * good only until the scope's next owner action.
 */
export function helperHtml(i: { clientId: string; scopeId: string; nonce: string; actionNonce: number; signer: string }): string {
  const cfg = escapeHtml(JSON.stringify({ clientId: i.clientId, nonce: i.nonce }));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Hana ID client proof for ${escapeHtml(i.clientId)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem}code,textarea{font-family:ui-monospace,monospace}textarea{width:100%;height:9rem}.warn{background:#fff4e5;border-left:4px solid #e69500;padding:.6rem .9rem}.bad{color:#b00020}</style>
</head>
<body>
<h1>Client proof</h1>
<p>This page proves to Hana ID that the Google client <code>${escapeHtml(i.clientId)}</code> belongs to you, so it can be added to scope <code>${escapeHtml(i.scopeId)}</code> on <code>${escapeHtml(i.signer)}</code> (action nonce ${i.actionNonce}).</p>
<ol>
<li>Host this file on one of the client's own origins and add this page's exact address to the client's <strong>Authorized redirect URIs</strong> in Google Cloud (remove it again afterwards).</li>
<li>Open it there and press <strong>Sign in with Google</strong>.</li>
<li>Copy the token shown and paste it into the console.</li>
</ol>
<p class="warn">The token becomes <strong>public on the NEAR blockchain</strong>, with the Google account id of whoever signs in here for this client. It is asked for <code>openid</code> only, so it carries no email address or name; Hana refuses one that does. Sign in with an account you are content to have recorded publicly (for example a team account).</p>
<p class="warn">This proof works only until the scope's next owner action. If the console says the proof is out of date, download a new helper.</p>
<p><button id="go" type="button">Sign in with Google</button></p>
<div id="out" hidden><h2>Your client proof</h2><textarea id="token" readonly></textarea><p id="claims"></p></div>
<p id="err" class="bad" hidden></p>
<script id="cfg" type="application/json">${cfg}</script>
<script>
(function () {
  var cfg = JSON.parse(document.getElementById('cfg').textContent);
  var here = location.origin + location.pathname;
  var allowed = ['iss','azp','aud','sub','iat','exp','nonce','nbf','jti','auth_time','at_hash'];
  document.getElementById('go').addEventListener('click', function () {
    var u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.searchParams.set('client_id', cfg.clientId);
    u.searchParams.set('redirect_uri', here);
    u.searchParams.set('response_type', 'id_token');
    u.searchParams.set('scope', 'openid');
    u.searchParams.set('nonce', cfg.nonce);
    u.searchParams.set('prompt', 'select_account');
    location.assign(u.toString());
  });
  var frag = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', here);
  var err = frag.get('error');
  if (err) { var e = document.getElementById('err'); e.hidden = false; e.textContent = 'Google answered: ' + err; return; }
  var t = frag.get('id_token');
  if (!t) return;
  try {
    var p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    var extra = Object.keys(p).filter(function (k) { return allowed.indexOf(k) < 0; });
    if (p.aud !== cfg.clientId || p.nonce !== cfg.nonce) throw new Error('This token is for another client or another proof.');
    if (extra.length) throw new Error('This token carries ' + extra.join(', ') + ': Hana will refuse it. The client must not ask for more than openid.');
    document.getElementById('token').value = t;
    document.getElementById('claims').textContent = 'Claims: ' + Object.keys(p).sort().join(', ');
    document.getElementById('out').hidden = false;
  } catch (x) { var e2 = document.getElementById('err'); e2.hidden = false; e2.textContent = x.message; }
})();
</script>
</body>
</html>
`;
}

/** `GET /api/orgs/:org/scopes/:scope/client-proof-helper?clientId=` (owner): the helper as a download. */
export async function helperRoute(env: Env, ctx: RpcCtx, orgId: string, scopeId: string, url: URL): Promise<Response> {
  const ids = url.searchParams.getAll('clientId');
  if (ids.length !== 1 || !GOOGLE_CLIENT_RE.test(ids[0]!)) return errorResponse('bad_request', 'Expected ?clientId=<a Google web client id>');
  if (!(await scopeOfOrg(env, ctx, orgId, scopeId))) return errorResponse('not_found');
  let s: ScopeView | null;
  try {
    s = await viewScope(env, scopeId);
  } catch (err) {
    if (err instanceof NearUnavailable) return errorResponse('near_unavailable', 'NEAR RPC is unavailable: try again');
    throw err;
  }
  if (!s) return errorResponse('not_found', 'The scope is not registered on chain');
  const nonce = await clientProofNonce({ signer: env.SIGNER_ACCOUNT, scopeId, actionNonce: s.action_nonce });
  const html = helperHtml({ clientId: ids[0]!, scopeId, nonce, actionNonce: s.action_nonce, signer: env.SIGNER_ACCOUNT });
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-disposition': `attachment; filename="hana-client-proof-${scopeId}-${s.action_nonce}.html"`,
      'x-content-type-options': 'nosniff',
    },
  });
}
