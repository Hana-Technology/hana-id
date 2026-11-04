// The Hana admin console SPA (batch C8): plain JavaScript, no build step and no dependency, under the admin CSP
// (script-src 'self', style-src 'self'). Every value from the API is put in the page as text (textContent), never as
// HTML. Writes send the admin's CSRF headers; Cloudflare Access adds the staff identity at the edge.
'use strict';

// ---- helpers ----

/** An element with attributes and children (strings become text nodes). */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const time = (ms) => (typeof ms === 'number' ? new Date(ms).toISOString().replace('.000Z', 'Z') : '');
const link = (path, text) => h('a', { href: path, 'data-link': true }, text);

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(method, path, body) {
  const init = { method, headers: { accept: 'application/json' }, credentials: 'same-origin' };
  if (method !== 'GET') {
    init.headers['content-type'] = 'application/json';
    init.headers['x-hana-admin'] = '1';
    init.body = JSON.stringify(body || {});
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error?.code || 'error', data?.error?.message || `HTTP ${res.status}`);
  return data;
}

function errorBox(err) {
  return h('p', { class: 'error' }, err instanceof ApiError ? `${err.code}: ${err.message}` : String(err && err.message ? err.message : err));
}

/** A form whose submit runs `action(values)` and then re-renders the current page; errors show above it. */
function form(fields, label, action, opts = {}) {
  const status = h('div');
  const inputs = {};
  const el = h(
    'form',
    {
      onsubmit: async (ev) => {
        ev.preventDefault();
        status.replaceChildren();
        if (opts.confirm && !window.confirm(opts.confirm)) return;
        const values = {};
        for (const [name, input] of Object.entries(inputs)) values[name] = input.type === 'checkbox' ? input.checked : input.value;
        try {
          const out = await action(values);
          if (opts.after) opts.after(out, status);
          else await render();
        } catch (err) {
          status.append(errorBox(err));
        }
      },
    },
    fields.map((f) => {
      let input;
      if (f.type === 'select') input = h('select', { name: f.name }, f.options.map((o) => h('option', { value: o }, o)));
      else if (f.type === 'textarea') input = h('textarea', { name: f.name, placeholder: f.placeholder || '' });
      else input = h('input', { name: f.name, type: f.type || 'text', placeholder: f.placeholder || '', value: f.value ?? '', required: f.required });
      inputs[f.name] = input;
      return f.label ? h('label', {}, `${f.label} `, input) : input;
    }),
    h('button', { type: 'submit', class: opts.danger ? 'danger' : undefined }, label),
  );
  return h('div', {}, status, el);
}

/** A button that runs `action()` (after a confirm when given) and re-renders. */
function actionButton(label, action, confirmText, danger) {
  const out = h('span');
  const btn = h(
    'button',
    {
      class: danger ? 'danger' : undefined,
      onclick: async () => {
        if (confirmText && !window.confirm(confirmText)) return;
        out.replaceChildren();
        try {
          await action();
          await render();
        } catch (err) {
          out.append(errorBox(err));
        }
      },
    },
    label,
  );
  return h('span', {}, btn, out);
}

function table(headers, rows) {
  return h('table', {}, h('thead', {}, h('tr', {}, headers.map((x) => h('th', {}, x)))), h('tbody', {}, rows.length ? rows : [h('tr', {}, h('td', { colspan: headers.length, class: 'muted' }, 'None'))]));
}

const tr = (...cells) => h('tr', {}, cells.map((c) => h('td', {}, c)));
const lines = (s) => s.split(/[\s,]+/u).map((x) => x.trim()).filter(Boolean);

// ---- navigation ----

// The screens of the spec's admin layout. Later batches fill the disabled ones: reports, statements and rates (C12),
// retention (C13). Security & monitoring, the pending-upgrades page and the playbooks are C14's. The Users screen
// (proposed D275, C8b) is not listed until it is confirmed and built.
const NAV = [
  { path: '/orgs', label: 'Organisations' },
  { path: '/audit', label: 'Audit' },
  { path: '/security', label: 'Feed and notices' },
  { path: '/security/monitoring', label: 'Security & monitoring' },
  { path: '/security/upgrades', label: 'Pending upgrades' },
  { path: '/security/playbooks', label: 'Playbooks' },
  { label: 'Reports (C12)' },
  { label: 'Retention (C13)' },
];

function renderNav() {
  const nav = document.getElementById('nav');
  // The longest nav path the current path is under is the active one (/security/playbooks/x → Playbooks).
  const under = (p) => location.pathname === p || location.pathname.startsWith(`${p}/`) || (p === '/orgs' && location.pathname === '/');
  const active = NAV.filter((n) => n.path && under(n.path)).sort((a, b) => b.path.length - a.path.length)[0];
  nav.replaceChildren(...NAV.map((n) => (n.path ? h('a', { href: n.path, 'data-link': true, class: n === active ? 'active' : undefined }, n.label) : h('a', { class: 'disabled', 'aria-disabled': 'true' }, n.label))));
}

document.addEventListener('click', (ev) => {
  const a = ev.target.closest && ev.target.closest('a[data-link]');
  if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
  ev.preventDefault();
  history.pushState(null, '', a.getAttribute('href'));
  render();
});
window.addEventListener('popstate', () => render());

// ---- screens ----

async function orgsPage(main) {
  const cursor = new URLSearchParams(location.search).get('cursor');
  const data = await api('GET', `/api/orgs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
  main.append(
    h('h1', {}, 'Organisations'),
    table(
      ['Id', 'Name', 'Kind', 'Status', 'Created'],
      data.orgs.map((o) => tr(link(`/orgs/${encodeURIComponent(o.id)}`, o.id), o.name, o.kind, o.status, time(o.createdAt))),
    ),
    data.next ? link(`/orgs?cursor=${encodeURIComponent(data.next)}`, 'Next page') : '',
    h('h2', {}, 'Invite the first owner of a new organisation'),
    h('p', { class: 'muted' }, 'The invite works only once its notices are sent (within 5 minutes). The invitee gets the link by email.'),
    form(
      [
        { name: 'newOrgName', placeholder: 'Organisation name', required: true },
        { name: 'email', type: 'email', placeholder: 'owner@partner.example', required: true },
        { name: 'kind', type: 'select', options: ['partner', 'internal'] },
      ],
      'Invite',
      (v) => api('POST', '/api/invites', { email: v.email, role: 'owner', newOrgName: v.newOrgName, kind: v.kind }),
    ),
  );
}

async function orgPage(main, orgId) {
  const d = await api('GET', `/api/orgs/${encodeURIComponent(orgId)}`);
  const o = d.org;
  main.append(h('h1', {}, `${o.name} `, h('span', { class: 'muted' }, `(${o.id}, ${o.kind}, ${o.status})`)));
  if (d.flags.noSecurityContacts) main.append(h('p', { class: 'warn' }, 'This organisation has no security contacts: it cannot get apps, and notices go to the Hana security alias only.'));
  if (d.flags.ownersNotContacts.length) main.append(h('p', { class: 'warn' }, `Owners who are not security contacts: ${d.flags.ownersNotContacts.join(', ')}`));
  main.append(
    h(
      'div',
      { class: 'row' },
      actionButton(o.status === 'frozen' ? 'Unfreeze' : 'Freeze', () => api('POST', `/api/orgs/${encodeURIComponent(o.id)}/freeze`, { frozen: o.status !== 'frozen' }), o.status === 'frozen' ? null : 'Freeze this organisation? Its members are signed out and every console write but cancels and kill switches is refused.', o.status !== 'frozen'),
      actionButton('Suspend every app (bit 2)', () => api('POST', `/api/orgs/${encodeURIComponent(o.id)}/suspend`, { suspended: true }), 'Suspend every app of this organisation?', true),
      actionButton('Resume every app (bit 2)', () => api('POST', `/api/orgs/${encodeURIComponent(o.id)}/suspend`, { suspended: false })),
    ),
    h('h2', {}, 'Security contacts'),
    h('p', {}, d.securityContacts.length ? d.securityContacts.join(', ') : 'None'),
    form([{ name: 'emails', placeholder: 'a@partner.example, b@partner.example', value: d.securityContacts.join(', '), required: true }], 'Replace contacts', (v) => api('PUT', `/api/orgs/${encodeURIComponent(o.id)}/security-contacts`, { emails: lines(v.emails) }), { confirm: 'Replace the security contacts? The old and the new contacts are emailed.' }),
    h('h2', {}, 'Members'),
    table(
      ['User', 'Email', 'Role', 'Since', 'Status', 'Actions'],
      d.members.map((m) =>
        tr(
          m.userId,
          m.email,
          m.pendingOwnerFrom ? `viewer (owner from ${time(m.pendingOwnerFrom)})` : m.role,
          time(m.roleSince),
          m.disabled ? 'disabled' : 'active',
          h(
            'div',
            { class: 'row' },
            actionButton(m.role === 'owner' ? 'Make viewer' : 'Make owner', () => api('POST', `/api/orgs/${encodeURIComponent(o.id)}/members/${encodeURIComponent(m.userId)}`, { role: m.role === 'owner' ? 'viewer' : 'owner' }), m.role === 'owner' ? null : 'Promote to owner? A new owner waits (owner grant) and every owner and contact is notified.'),
            actionButton('Remove', () => api('POST', `/api/orgs/${encodeURIComponent(o.id)}/members/${encodeURIComponent(m.userId)}`, { role: null }), 'Remove this member from the organisation?', true),
            actionButton(m.disabled ? 'Enable user' : 'Disable user', () => api('POST', `/api/users/${encodeURIComponent(m.userId)}/disable`, { disabled: !m.disabled }), m.disabled ? null : 'Disable this user everywhere? Their sessions end.', !m.disabled),
          ),
        ),
      ),
    ),
    h('h2', {}, 'Invites'),
    table(
      ['Invite', 'Email', 'Role', 'Created', 'Notified', 'Expires', 'State', ''],
      d.invites.map((i) =>
        tr(i.id, i.email, i.role, time(i.createdAt), i.notifiedAt ? time(i.notifiedAt) : 'not yet', time(i.expiresAt), i.acceptedAt ? 'accepted' : i.revokedAt ? 'revoked' : 'open', !i.acceptedAt && !i.revokedAt ? actionButton('Revoke', () => api('POST', `/api/invites/${encodeURIComponent(i.id)}/revoke`), 'Revoke this invite?', true) : ''),
      ),
    ),
    form(
      [
        { name: 'email', type: 'email', placeholder: 'person@partner.example', required: true },
        { name: 'role', type: 'select', options: ['viewer', 'owner'] },
      ],
      'Invite to this organisation',
      (v) => api('POST', '/api/invites', { email: v.email, role: v.role, orgId: o.id }),
    ),
    h('h2', {}, 'Pending owner grants'),
    table(
      ['Grant', 'User or invite', 'Granted by', 'Notified', 'Owner from', ''],
      d.grants.map((g) => tr(g.id, g.userId || g.inviteId || '', `${g.grantedByKind} ${g.grantedBy}`, g.notifiedAt ? time(g.notifiedAt) : 'not yet', g.ownerFrom ? time(g.ownerFrom) : 'after acceptance', actionButton('Cancel', () => api('POST', `/api/owner-grants/${encodeURIComponent(g.id)}/cancel`), 'Cancel this owner grant? The person stays a viewer.', true))),
    ),
    h('h2', {}, 'Apps'),
    table(
      ['App', 'Name', 'Scope', 'Env', 'Suspended', 'Origins', 'Pending'],
      d.apps.map((a) => tr(link(`/orgs/${encodeURIComponent(o.id)}/apps/${encodeURIComponent(a.id)}`, a.id), a.name, a.scopeId, a.environment, a.deleted ? 'deleted' : a.suspendedBy ? `bits ${a.suspendedBy}` : 'no', String(a.activeOrigins), String(a.pendingChanges))),
    ),
    h('h2', {}, 'Create an app'),
    h('p', { class: 'muted' }, "The scope must be registered on chain with this organisation's owners (scope:register --owners-from-org). Its origins are staff proposals: emailed, then in force after the delay."),
    form(
      [
        { name: 'scopeId', placeholder: 'scope id (s…)', required: true },
        { name: 'environment', type: 'select', options: ['test', 'live'] },
        { name: 'name', placeholder: 'App name', required: true },
        { name: 'origins', placeholder: 'https://app.partner.example (comma or space separated)' },
      ],
      'Create app',
      (v) => api('POST', '/api/apps', { orgId: o.id, scopeId: v.scopeId, environment: v.environment, name: v.name, origins: lines(v.origins) }),
      { after: (out, status) => status.append(h('p', { class: 'notice' }, `Created ${out.app.id}. Its publishable key: `, h('code', {}, out.publishableKey))) },
    ),
    h('h2', {}, 'Assign a legacy scope'),
    form([{ name: 'scopeId', placeholder: 'scope id (s…)', required: true }], 'Assign to this organisation', (v) => api('POST', `/api/scopes/${encodeURIComponent(v.scopeId)}/assign`, { orgId: o.id }), { confirm: 'Move every app of this legacy scope into this organisation?' }),
    h('h2', {}, 'App changes'),
  );
  const changes = await api('GET', `/api/orgs/${encodeURIComponent(o.id)}/changes`);
  main.append(changesTable(changes.changes));
}

function changesTable(changes) {
  return table(
    ['Seq', 'At', 'Kind', 'App', 'Actor', 'Detail'],
    changes.map((c) => tr(String(c.seq), time(c.at), c.kind, c.appId || '', `${c.actorKind} ${c.actorId}`, h('code', {}, JSON.stringify(c.detail)))),
  );
}

async function appPage(main, orgId, appId) {
  const { app } = await api('GET', `/api/apps/${encodeURIComponent(appId)}?org=${encodeURIComponent(orgId)}`);
  const base = `/api/apps/${encodeURIComponent(app.id)}`;
  main.append(
    h('h1', {}, `${app.name} `, h('span', { class: 'muted' }, `(${app.id}, ${app.scopeId}, ${app.environment})`)),
    h('p', {}, link(`/orgs/${encodeURIComponent(orgId)}`, `← ${orgId}`)),
    h('p', {}, `Suspended bits: ${app.suspendedBy || 'none'} (1 Hana, 2 organisation, 4 partner)${app.deleted ? ' · deleted' : ''} · origins version ${app.originsVersion} · settings version ${app.settingsVersion}`),
    h(
      'div',
      { class: 'row' },
      actionButton('Suspend (Hana bit 1)', () => api('POST', `${base}/suspend`, { bit: 1 }), 'Suspend this app? Logins stop at once.', true),
      ...[1, 2, 4].filter((b) => app.suspendedBy & b).map((b) => actionButton(`Clear bit ${b}`, () => api('POST', `${base}/resume`, { bit: b }))),
      actionButton('Delete app', () => api('POST', `${base}/delete`), 'Delete this app? Every key is revoked; this cannot be undone.', true),
    ),
    h('h2', {}, 'Origins'),
    table(
      ['Origin', 'Shown as', 'Active from', ''],
      app.origins.map((x) => tr(x.origin, `${x.display}${x.idn ? ' (IDN: check for lookalikes)' : ''}`, x.activeFrom === null ? 'pending' : time(x.activeFrom), actionButton('Remove', () => api('POST', `${base}/origins/remove`, { orgId, remove: [x.origin], expectedVersion: app.originsVersion }), `Remove ${x.origin}? It stops working at once.`, true))),
    ),
    form([{ name: 'add', placeholder: 'https://new.partner.example', required: true }], 'Propose origins', (v) => api('POST', `${base}/origins`, { orgId, add: lines(v.add), expectedVersion: app.originsVersion }), { confirm: 'Propose these origins? The security contacts are emailed and they take effect after the delay.' }),
    h('h2', {}, 'Guarded changes'),
    table(
      ['Change', 'Kind', 'What', 'Status', 'Proposed', 'Notified', 'Active from', ''],
      app.changes.map((c) =>
        tr(
          c.id,
          c.kind,
          c.origin || c.policyId || '',
          c.status,
          `${time(c.proposedAt)} by ${c.proposedByKind} ${c.proposedBy}`,
          c.notifiedAt ? time(c.notifiedAt) : 'not yet',
          c.activeFrom ? time(c.activeFrom) : '',
          c.status === 'pending'
            ? h(
                'div',
                {},
                actionButton('Cancel', () => api('POST', `/api/changes/${encodeURIComponent(c.id)}/cancel`, { orgId }), 'Cancel this change?', true),
                c.proposedByKind === 'member' && c.notifiedAt
                  ? form([{ name: 'reason', placeholder: 'Which contact confirmed it, and how (20+ characters)', required: true }], 'Expedite', (v) => api('POST', `/api/changes/${encodeURIComponent(c.id)}/expedite`, { reason: v.reason }), { confirm: 'Put this change in force now?' })
                  : '',
              )
            : '',
        ),
      ),
    ),
    h('h2', {}, 'Settings'),
    h('pre', {}, JSON.stringify(app.settings, null, 2)),
    h(
      'div',
      { class: 'row' },
      app.settings.policy ? actionButton('Remove the policy', () => api('POST', `${base}/off`, { orgId, what: 'policy', expectedVersion: app.settingsVersion }), 'Remove the auto-approve policy? Auto-signing stops within 10 s.', true) : '',
      app.settings.rawSign !== 'off' ? actionButton('Turn raw signing off', () => api('POST', `${base}/off`, { orgId, what: 'raw_sign', expectedVersion: app.settingsVersion }), 'Turn raw signing off?', true) : '',
      app.environment === 'live' && app.settings.rawSign === 'off' ? actionButton('Propose raw signing on', () => api('POST', `${base}/changes`, { orgId, kind: 'raw_sign_on', expectedVersion: app.settingsVersion }), 'Propose raw signing (with approval)? The contacts are emailed; it takes effect after the delay.') : '',
    ),
    h('h3', {}, 'Propose an auto-approve policy'),
    form(
      [{ name: 'policy', type: 'textarea', placeholder: '{"v": 1, "label": "…", "maxConsentMs": …, "limits": {"perDayCount": …}, "stellar": {…}}' }],
      'Propose policy',
      (v) => {
        let policy;
        try {
          policy = JSON.parse(v.policy);
        } catch {
          throw new Error('The policy is not valid JSON');
        }
        return api('POST', `${base}/changes`, { orgId, kind: 'policy_set', policy, expectedVersion: app.settingsVersion });
      },
      { confirm: 'Propose this policy? The contacts are emailed; it takes effect after the delay and each user consents to it.' },
    ),
    h('h2', {}, 'Keys'),
    table(
      ['Key', 'Created', 'Revoked', ''],
      app.keys.map((k) => tr(h('code', {}, k.key), `${time(k.createdAt)} by ${k.createdBy}`, k.revokedAt ? time(k.revokedAt) : '', k.revokedAt && k.revokedAt <= Date.now() ? '' : actionButton('Revoke', () => api('POST', `${base}/keys/${encodeURIComponent(k.id)}/revoke`, { orgId }), 'Revoke this key now? Every page using it stops working.', true))),
    ),
  );
}

async function auditPage(main) {
  const params = new URLSearchParams(location.search);
  const keys = ['orgId', 'appId', 'actorKind', 'actorId', 'action'];
  const filterForm = h(
    'form',
    {
      onsubmit: (ev) => {
        ev.preventDefault();
        const q = new URLSearchParams();
        for (const k of keys) {
          const v = filterForm.elements[k].value.trim();
          if (v) q.set(k, v);
        }
        for (const k of ['from', 'to']) {
          const v = filterForm.elements[k].value;
          if (v) q.set(k, String(Date.parse(`${v}T00:00:00Z`)));
        }
        history.pushState(null, '', `/audit?${q}`);
        render();
      },
    },
    keys.map((k) => h('input', { name: k, placeholder: k, value: params.get(k) || '' })),
    h('label', {}, 'from ', h('input', { name: 'from', type: 'date', value: params.get('from') ? new Date(Number(params.get('from'))).toISOString().slice(0, 10) : '' })),
    h('label', {}, 'to ', h('input', { name: 'to', type: 'date', value: params.get('to') ? new Date(Number(params.get('to'))).toISOString().slice(0, 10) : '' })),
    h('button', { type: 'submit' }, 'Filter'),
  );
  const csv = new URLSearchParams(params);
  csv.delete('cursor');
  main.append(h('h1', {}, 'Audit'), filterForm, h('p', {}, h('a', { href: `/api/audit.csv?${csv}`, download: true }, 'Download CSV'), h('span', { class: 'muted' }, ' (console audit rows; with an organisation filter, its app changes too)')));
  const data = await api('GET', `/api/audit?${params}`);
  main.append(
    h('h2', {}, 'Console audit'),
    table(
      ['Seq', 'At', 'Action', 'Org', 'App', 'Actor', 'Target', 'Outcome', 'Request', 'Details'],
      data.rows.map((r) => tr(String(r.seq), time(r.at), r.action, r.orgId || '', r.appId || '', `${r.actorKind} ${r.actorEmail || r.actorId}`, r.target || '', r.outcome, r.requestId, h('code', {}, JSON.stringify(r.details)))),
    ),
  );
  if (data.next) {
    const next = new URLSearchParams(params);
    next.set('cursor', data.next);
    main.append(link(`/audit?${next}`, 'Older rows'));
  }
  main.append(h('h2', {}, 'App changes'), data.changes ? changesTable(data.changes) : h('p', { class: 'muted' }, 'Filter by an organisation to see its app changes.'));
}

async function securityPage(main) {
  const d = await api('GET', '/api/security');
  main.append(h('h1', {}, 'Feed and notices'));
  if (d.opsError) main.append(h('p', { class: 'warn' }, d.opsError));
  main.append(
    h('h2', {}, 'Blocking notices not yet sent'),
    d.notices.changes === null ? h('p', { class: 'error' }, 'The API did not answer') : table(['Change', 'Kind', 'App', 'Org', 'Proposed', 'Contacts'], d.notices.changes.map((n) => tr(n.changeId, n.kind, n.appId, n.orgId, time(n.proposedAt), String(n.contacts)))),
    d.notices.members === null ? h('p', { class: 'error' }, 'The console did not answer') : table(['Kind', 'Id', 'Org', 'Created'], d.notices.members.map((n) => tr(n.kind, n.id || '', n.orgId || '(new organisation)', time(n.createdAt)))),
    h('h2', {}, 'Feed'),
    d.feed ? table(['Source', 'Cursor', 'Moved', 'Lag'], Object.entries(d.feed).map(([k, v]) => tr(k, String(v.cursor), v.updatedAt ? time(v.updatedAt) : 'never', v.lagMs === null ? 'unknown' : v.lagMs === 0 ? 'caught up' : `${Math.round(v.lagMs / 60000)} min`))) : h('p', { class: 'muted' }, 'Unavailable'),
    h('h2', {}, 'Watcher'),
    h('p', {}, d.watcher ? `Next scope after: ${d.watcher.cursor || '(start)'}; moved ${d.watcher.updatedAt ? time(d.watcher.updatedAt) : 'never'}` : 'Unavailable'),
    h('h2', {}, 'Last cron run'),
    h('pre', {}, d.lastRun ? JSON.stringify(d.lastRun, null, 2) : 'None recorded'),
    h('h2', {}, 'Security events not yet emailed'),
    d.unnotifiedEvents === null ? h('p', { class: 'error' }, 'The API did not answer') : table(['Id', 'Detected', 'Kind', 'Org', 'App', 'Scope', 'Detail'], d.unnotifiedEvents.map((e) => tr(e.id, time(e.detectedAt), e.kind, e.orgId || '', e.appId || '', e.scopeId || '', h('code', {}, JSON.stringify(e.detail))))),
  );
}

// ---- Security & monitoring, pending upgrades, playbooks (C14) ----
//
// Every value below comes from the admin Worker, which reduced the watchdog's answers to bounded plain data; it is
// written as text like everything else. Links are only those the Worker built (playbook pages, the repo's docs,
// explorer links of validated transaction hashes), and an external one is set only when it is https.

/** "in 2 h 5 min" / "due 3 min ago" from a time in ms (the reader's clock, as the API's countdowns intend). */
function countdown(atMs) {
  if (typeof atMs !== 'number') return '';
  const d = atMs - Date.now();
  const abs = Math.abs(d);
  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  const mins = Math.round((abs % 3_600_000) / 60_000);
  const span = days ? `${days} d ${hours} h` : hours ? `${hours} h ${mins} min` : `${mins} min`;
  return d > 0 ? `in ${span} (${time(atMs)})` : `due ${span} ago (${time(atMs)})`;
}

const badge = (text, kind) => h('span', { class: `badge ${kind || ''}` }, text);
const sev = (s) => badge(s, s);
const external = (href, text) => (typeof href === 'string' && href.startsWith('https://') ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text) : text);
const playbookLink = (p) => (p ? link(`/security/playbooks/${encodeURIComponent(p.id)}`, p.title) : h('span', { class: 'error' }, 'no playbook'));
const plainJson = (v) => h('pre', {}, v === null || v === undefined ? 'None' : JSON.stringify(v, null, 2));

/** Text with `backtick` spans shown as code (each span is text in a <code>, never markup). */
function richText(s) {
  return String(s)
    .split('`')
    .map((part, i) => (i % 2 ? h('code', {}, part) : part));
}

/** A command in a copyable block, verbatim (placeholders such as <env> stay as they are). */
function commandBlock(cmd) {
  const status = h('span', { class: 'muted' });
  return h(
    'div',
    { class: 'command' },
    h('pre', {}, h('code', {}, cmd)),
    h(
      'button',
      {
        type: 'button',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(cmd);
            status.textContent = ' copied';
          } catch {
            status.textContent = ' copy failed: select the text instead';
          }
        },
      },
      'Copy',
    ),
    status,
  );
}

function sourceError(what, part) {
  return h('p', { class: 'error' }, `${what} unavailable: ${part.code}`);
}

function alertsTable(alerts, opts = {}) {
  return table(
    ['Alert', 'Severity', 'Kind', 'Title', 'Raised', 'State', 'Re-sends', 'Acknowledged', 'Playbook', ''],
    alerts.map((a) =>
      tr(
        `#${a.id}`,
        sev(a.severity),
        a.kind,
        a.title,
        time(a.createdAt),
        a.open ? 'open (condition holds)' : `resolved ${time(a.resolvedAt)}`,
        a.resendsUntilAck ? `${a.sendCount ?? 0} sent, last ${time(a.lastSentAt)}` : 'none (not critical)',
        a.ackedAt ? `${time(a.ackedAt)} by ${a.ackedBy || '?'} via ${a.ackedVia || '?'}` : 'no',
        playbookLink(a.playbook),
        h(
          'div',
          {},
          a.canAck
            ? actionButton(
                'Acknowledge',
                () => api('POST', `/api/monitoring/alerts/${encodeURIComponent(a.id)}/ack`),
                `Acknowledge alert #${a.id} (${a.kind})? This only stops its 15-minute re-sends. It does not clear the condition, and the watchdog keeps checking. Your Access identity is recorded.`,
              )
            : '',
          opts.details ? h('details', {}, h('summary', {}, 'Details and deliveries'), plainJson(a.details), h('p', { class: 'muted' }, `Deliveries: the last ${a.deliveries.length} of ${a.deliveriesTotal}`), plainJson(a.deliveries)) : '',
        ),
      ),
    ),
  );
}

function actionsTable(actions) {
  return table(
    ['Action', 'At', 'Method', 'Reason', 'Result', 'Transaction', 'Args'],
    actions.map((x) => tr(`#${x.id}`, time(x.at), x.method, x.reason || '', x.ok ? 'ok' : `failed${x.error ? `: ${x.error}` : ''}`, x.txHash ? external(x.txUrl, x.txHash) : '', h('code', {}, JSON.stringify(x.args)))),
  );
}

async function monitoringPage(main) {
  const params = new URLSearchParams(location.search);
  const alertsQuery = new URLSearchParams();
  for (const k of ['cursor', 'severity']) if (params.get(k)) alertsQuery.set(k, params.get(k));
  const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
  const [d, alertPage, actions] = await Promise.all([api('GET', '/api/monitoring'), settle(api('GET', `/api/monitoring/alerts?${alertsQuery}`)), settle(api('GET', `/api/monitoring/actions${params.get('actionsCursor') ? `?cursor=${encodeURIComponent(params.get('actionsCursor'))}` : ''}`))]);
  const w = d.watchdog;
  const g = d.governance;
  main.append(
    h('h1', {}, 'Security & monitoring'),
    h('p', { class: 'muted' }, `A view of the watchdog and the contract (${d.env}). The watchdog sends its own alerts; nothing here alerts or acts on chain. Read at ${time(d.now)}.`),
  );
  if (w.ok && w.silent) main.append(h('p', { class: 'banner critical' }, w.sinceLastRunMs === null ? 'The watchdog has never finished a run.' : `The watchdog has been silent for ${Math.round(w.sinceLastRunMs / 60000)} min: more than two ${Math.round(w.runIntervalMs / 60000)}-minute intervals. `, link('/security/playbooks/watchdog-down', 'Playbook: watchdog down')));

  main.append(
    h('h2', {}, 'Findings'),
    d.findings.length ? h('ul', { class: 'findings' }, d.findings.map((f) => h('li', {}, sev(f.severity), ` ${f.source}: `, f.text, f.playbook ? [' ', playbookLink(f.playbook)] : ''))) : h('p', {}, 'None'),
  );

  // The watchdog.
  main.append(h('h2', {}, 'Watchdog'));
  if (!w.ok) main.append(sourceError('The watchdog status', w));
  else {
    const hb = w.heartbeat || {};
    main.append(
      table(
        ['Env', 'Account', 'Network', 'Last run', 'Outcome', 'Heartbeat', 'Channels'],
        [
          tr(
            w.env || '',
            w.watchdogAccount || '',
            w.network || '',
            w.lastRun ? `#${w.lastRun.id} finished ${time(w.lastRun.finishedAt)}` : 'never',
            w.lastRun ? w.lastRun.outcome || '' : '',
            hb.configured === false ? 'not configured' : `${hb.ok ? 'ok' : 'failing'}, last ok ${time(hb.last_ok_at)}`,
            Object.entries(w.channels || {})
              .map(([k, v]) => `${k}: ${v && v.configured ? 'on' : 'off'}`)
              .join(', '),
          ),
        ],
      ),
      h('h3', {}, 'Checks of the last run'),
      table(['Check', 'What', 'Outcome', 'Detail', 'Shown in'], w.checks.map((c) => tr(c.known ? c.id : h('span', { class: 'error' }, `${c.id} (no portal rendering)`), c.title, c.outcome || 'not reported', c.detail || '', c.shownIn || ''))),
      h('h3', {}, 'Open alerts'),
      alertsTable(w.openAlerts),
    );
  }

  // Governance.
  main.append(h('h2', {}, 'Contract governance'));
  if (!g.ok) main.append(sourceError('The governance state', g));
  else {
    main.append(
      h('p', {}, `Read ${time(g.readAtMs)} · state version ${g.stateVersion} · `, g.pause.paused ? h('strong', { class: 'error' }, 'PAUSED') : 'not paused', g.pause.unpausedAtMs ? ` · last unpause ${time(g.pause.unpausedAtMs)}` : '', g.pause.lastWatchdogPause ? ` · the watchdog last paused at ${time(g.pause.lastWatchdogPause.at)} (${g.pause.lastWatchdogPause.reason || ''})` : ''),
      h('h3', {}, 'Pending issuer-key changes'),
      table(
        ['Change', 'Provider', 'Kid', 'Op', 'Proposer', 'Executable', "Google's JWKS (the API's fetch)", "Watchdog's sighting"],
        (g.keyChanges || []).map((c) => tr(String(c.id), c.provider, c.kid, c.op, c.by, countdown(c.executableAtMs), c.jwks, c.watchdogSeen ? `seen since ${time(c.watchdogSeen.firstSeenAt)}` : 'never seen')),
      ),
      h('h3', {}, 'Pending upgrades and owner actions'),
      table(
        ['What', 'Detail', 'When'],
        [
          g.pendingUpgrade ? tr('Upgrade', g.pendingUpgrade.codeHash, countdown(g.pendingUpgrade.executableAtMs)) : null,
          g.pendingOwner ? tr('Owner transfer', g.pendingOwner.owner, countdown(g.pendingOwner.acceptableAtMs)) : null,
          g.pendingWithdrawal ? tr('Withdrawal', `${g.pendingWithdrawal.amountYocto} yoctoNEAR to ${g.pendingWithdrawal.receiver}`, countdown(g.pendingWithdrawal.executableAtMs)) : null,
          ...['pendingIssuerKeyDelay', 'pendingGovernanceDelay', 'pendingChangeDelay'].filter((k) => g.delays && g.delays[k]).map((k) => tr('Delay decrease', `${k}: ${g.delays[k].valueMs} ms`, countdown(g.delays[k].effectiveAtMs))),
          ...(g.pendingConsoleAudiences || []).map((a) => tr('Console audience', `${a.provider} ${a.aud}`, countdown(a.effectiveAtMs))),
        ].filter(Boolean),
      ),
      h('p', {}, link('/security/upgrades', 'The pending-upgrades page'), ' (what partners see too).'),
      h('h3', {}, 'Updater keys against the signer’s access keys'),
      table(['Updater key', 'On the signer account', 'Permission'], (g.updaterKeyCheck || []).map((k) => tr(h('code', {}, k.publicKey), k.onAccount === null ? 'unknown' : k.onAccount ? 'yes' : h('span', { class: 'error' }, 'no'), k.permissionOk === null ? '' : k.permissionOk ? 'ok' : h('span', { class: 'error' }, 'wrong')))),
      table(['Other signer key', 'Kind', 'Receiver', 'Methods'], (g.otherSignerKeys || []).map((k) => tr(h('code', {}, k.publicKey), k.kind, k.receiverId || '', (k.methodNames || []).join(', ')))),
      h('h3', {}, 'Watchdogs on chain'),
      table(['Account', 'May confirm from', 'Can confirm'], (g.watchdogs || []).map((x) => tr(x.accountId, time(x.confirmFromMs), x.canConfirm ? 'yes' : 'not yet'))),
      h('h3', {}, "The API's JWKS cron"),
      plainJson(g.updater),
    );
  }

  // History.
  main.append(h('h2', {}, 'Alert history'));
  const sevForm = h(
    'form',
    {
      onsubmit: (ev) => {
        ev.preventDefault();
        const q = new URLSearchParams();
        if (sevForm.elements.severity.value) q.set('severity', sevForm.elements.severity.value);
        window.history.pushState(null, '', `/security/monitoring?${q}`);
        render();
      },
    },
    h('select', { name: 'severity' }, ['', 'critical', 'warning', 'info'].map((s) => h('option', { value: s, selected: params.get('severity') === s || undefined }, s || 'all severities'))),
    h('button', { type: 'submit' }, 'Filter'),
  );
  main.append(sevForm);
  if (!alertPage.ok) main.append(errorBox(alertPage.e));
  else {
    main.append(alertsTable(alertPage.v.alerts, { details: true }));
    if (alertPage.v.nextCursor) {
      const next = new URLSearchParams(params);
      next.set('cursor', String(alertPage.v.nextCursor));
      main.append(link(`/security/monitoring?${next}`, 'Older alerts'));
    }
  }
  main.append(h('h2', {}, "The watchdog's actions"));
  if (!actions.ok) main.append(errorBox(actions.e));
  else {
    main.append(actionsTable(actions.v.actions));
    if (actions.v.nextCursor) {
      const next = new URLSearchParams(params);
      next.set('actionsCursor', String(actions.v.nextCursor));
      main.append(link(`/security/monitoring?${next}`, 'Older actions'));
    }
  }

  if (w.ok) {
    main.append(
      h('h2', {}, 'Seen kids'),
      table(['Provider', 'Kid', 'Source', 'First seen', 'Last seen'], w.seenKids.map((k) => tr(k.provider || '', k.kid || '', k.source || '', time(k.firstSeenAt), time(k.lastSeenAt)))),
      h('h2', {}, 'Relayer funds'),
      plainJson(w.relayerFunds),
      h('h2', {}, 'Email issuer pins and the chain'),
      plainJson(w.email),
      h('h2', {}, 'Identity token keys'),
      plainJson(w.identity),
      h('h2', {}, 'Link stats'),
      plainJson(w.linkStats),
      h('h2', {}, 'Alert kinds and their playbooks'),
      table(['Kind', 'Severity', 'Check', 'Description', 'Playbook'], w.alertKinds.map((k) => tr(k.kind, sev(k.severity), k.check || '', k.description || '', playbookLink(k.playbook)))),
    );
  }
  main.append(
    h('h2', {}, 'Security events'),
    d.events.ok ? table(['Id', 'Detected', 'Kind', 'Org', 'App', 'Scope', 'Emailed', 'Detail'], d.events.events.map((e) => tr(e.id, time(e.detectedAt), e.kind, e.orgId || '', e.appId || '', e.scopeId || '', e.notifiedAt ? time(e.notifiedAt) : 'not yet', h('code', {}, JSON.stringify(e.detail))))) : sourceError('The security events', d.events),
  );
}

async function upgradesPage(main) {
  const { pendingUpgrades: p } = await api('GET', '/api/governance/pending-upgrades');
  main.append(
    h('h1', {}, 'Pending upgrades'),
    h('p', { class: 'muted' }, `What the contract owner has queued for ${p.signer} (${p.env}), read ${time(p.readAtMs)}. Partners see the same page. Each waits the governance delay (${Math.round(p.governanceDelayMs / 60000)} min) so partners and users can react, for example by exporting keys.`),
  );
  if (p.paused) main.append(h('p', { class: 'banner critical' }, 'The contract is paused.'));
  if (!p.anyPending) main.append(h('p', {}, 'Nothing is pending.'));
  if (p.upgrade) {
    const u = p.upgrade;
    main.append(h('h2', {}, 'Contract upgrade'), table(['Code hash', 'Proposed', 'Executable'], [tr(h('code', {}, u.codeHash), time(u.proposedAtMs), countdown(u.executableAtMs))]));
    if (u.release) {
      main.append(
        h('p', {}, `Release ${u.release.version}, source commit `, h('code', {}, u.release.commit), '. Rebuild it and compare the hash:'),
        commandBlock(u.release.buildCommand),
        u.release.diffCommand ? [h('p', {}, 'The diff to the last release:'), commandBlock(u.release.diffCommand)] : h('p', { class: 'muted' }, 'The first published release: no earlier release to diff against.'),
      );
    } else main.append(h('p', { class: 'warn' }, 'This code hash is not a published release: no source commit or reproducible-build command is on record for it. Treat it as unexplained until it is published.'));
  }
  if (p.ownerTransfer) main.append(h('h2', {}, 'Owner transfer'), table(['New owner', 'Acceptable'], [tr(p.ownerTransfer.owner, countdown(p.ownerTransfer.acceptableAtMs))]));
  if (p.withdrawal) main.append(h('h2', {}, 'Withdrawal'), table(['Receiver', 'Amount (yoctoNEAR)', 'Executable'], [tr(p.withdrawal.receiver, p.withdrawal.amountYocto, countdown(p.withdrawal.executableAtMs))]));
  if (p.delayDecreases.length) main.append(h('h2', {}, 'Delay decreases'), table(['Delay', 'Now (ms)', 'Becomes (ms)', 'Effective'], p.delayDecreases.map((x) => tr(x.delay, String(x.currentMs), String(x.valueMs), countdown(x.effectiveAtMs)))));
  if (p.consoleAudienceAdditions.length) main.append(h('h2', {}, 'Console audience additions'), table(['Provider', 'Audience', 'Effective'], p.consoleAudienceAdditions.map((x) => tr(x.provider, x.aud, countdown(x.effectiveAtMs)))));
}

async function playbooksPage(main) {
  const params = new URLSearchParams(location.search);
  const d = await api('GET', `/api/playbooks?${params}`);
  const filter = h(
    'form',
    {
      onsubmit: (ev) => {
        ev.preventDefault();
        const q = new URLSearchParams();
        for (const k of ['q', 'kind', 'severity']) if (filter.elements[k].value.trim()) q.set(k, filter.elements[k].value.trim());
        history.pushState(null, '', `/security/playbooks?${q}`);
        render();
      },
    },
    h('input', { name: 'q', placeholder: 'Search title, summary, signals, impact', value: params.get('q') || '' }),
    h('select', { name: 'kind' }, ['', 'alert', 'incident'].map((s) => h('option', { value: s, selected: params.get('kind') === s || undefined }, s || 'alerts and incidents'))),
    h('select', { name: 'severity' }, ['', 'critical', 'warning', 'info'].map((s) => h('option', { value: s, selected: params.get('severity') === s || undefined }, s || 'all severities'))),
    h('button', { type: 'submit' }, 'Search'),
  );
  main.append(
    h('h1', {}, 'Recovery playbooks'),
    h('p', { class: 'muted' }, `From @hana-id/playbooks (last verified ${d.lastVerified}). Read-only: owner calls stay in scripts/ and the council's own signing.`),
    filter,
    table(
      ['Playbook', 'Kind', 'Severity', 'Status', 'Summary', 'Alert kinds'],
      d.playbooks.map((p) => tr(link(`/security/playbooks/${encodeURIComponent(p.id)}`, p.title), p.kind, sev(p.severity), p.status === 'planned' ? badge('planned: not built yet', 'warning') : 'live', p.summary, p.alertKinds.join(', '))),
    ),
  );
}

async function playbookPage(main, id) {
  const { notes, playbook: p } = await api('GET', `/api/playbooks/${encodeURIComponent(id)}`);
  const list = (items) => (items.length ? h('ul', {}, items.map((x) => h('li', {}, richText(x)))) : h('p', { class: 'muted' }, 'None'));
  main.append(
    h('p', {}, link('/security/playbooks', '← Playbooks')),
    h('h1', {}, p.title),
    h('p', {}, sev(p.severity), ' ', badge(p.kind), ' ', p.status === 'planned' ? badge('planned: not built yet', 'warning') : '', p.alertKinds.length ? ` Alert kinds: ${p.alertKinds.join(', ')}` : ''),
    h('p', {}, richText(p.summary)),
    h('div', { class: 'notice' }, h('strong', {}, 'Before you start'), h('ul', {}, notes.map((n) => h('li', {}, richText(n))))),
    h('h2', {}, 'Signals'),
    list(p.signals),
    h('h2', {}, 'Impact'),
    list(p.impact),
    h('h2', {}, 'Steps'),
    h(
      'ol',
      { class: 'steps' },
      p.steps.map((s) => h('li', {}, h('p', {}, badge(s.who, 'who'), ' ', h('strong', {}, s.title)), h('p', {}, richText(s.detail)), s.commands.map(commandBlock))),
    ),
    h('h2', {}, 'Verify'),
    list(p.verify),
    h('h2', {}, 'Follow-ups'),
    list(p.followUps),
    h('h2', {}, 'References'),
    h('ul', {}, p.refs.map((r) => h('li', {}, external(r.href, r.ref)))),
    h('h2', {}, 'Related playbooks'),
    p.related.length ? h('ul', {}, p.related.map((r) => h('li', {}, link(`/security/playbooks/${encodeURIComponent(r.id)}`, r.title)))) : h('p', { class: 'muted' }, 'None'),
  );
}

// ---- router ----

let me = null;

async function render() {
  renderNav();
  const main = document.getElementById('app');
  main.replaceChildren();
  const path = location.pathname;
  try {
    if (!me) {
      me = await api('GET', '/api/me');
      document.getElementById('who').textContent = `${me.email} · ${me.env}`;
    }
    let m;
    if (path === '/' || path === '/orgs') await orgsPage(main);
    else if ((m = /^\/orgs\/([^/]+)\/apps\/([^/]+)$/u.exec(path))) await appPage(main, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    else if ((m = /^\/orgs\/([^/]+)$/u.exec(path))) await orgPage(main, decodeURIComponent(m[1]));
    else if (path === '/audit') await auditPage(main);
    else if (path === '/security') await securityPage(main);
    else if (path === '/security/monitoring') await monitoringPage(main);
    else if (path === '/security/upgrades') await upgradesPage(main);
    else if (path === '/security/playbooks') await playbooksPage(main);
    else if ((m = /^\/security\/playbooks\/([a-z0-9-]{1,64})$/u.exec(path))) await playbookPage(main, m[1]);
    else main.append(h('h1', {}, 'Not found'), link('/orgs', 'Organisations'));
  } catch (err) {
    main.append(errorBox(err));
  }
}

render();
