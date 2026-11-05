// The Hana admin console SPA (batch C8; reports, statements and rates in C12; retention in C13; Users in C8b; the Support ID lookup in C15): plain JavaScript, no build step and no dependency, under the admin CSP
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

/** An integer decimal string of 10^-decimals units, exactly (string arithmetic, never a float); '' when absent. */
function units(v, decimals) {
  if (v === undefined || v === null || v === '') return '';
  const s = String(v);
  if (!/^\d+$/u.test(s)) return s;
  const padded = s.padStart(decimals + 1, '0');
  const int = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/u, '');
  const frac = padded.slice(padded.length - decimals).replace(/0+$/u, '');
  return frac ? `${int}.${frac}` : int;
}
const near = (yocto) => units(yocto, 24);
const usd = (micros) => (micros === undefined || micros === null ? '—' : units(micros, 6));
const enc = encodeURIComponent;
const thisMonth = () => new Date().toISOString().slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10);

/** A filter form that writes its fields into the page's query string (GET), then re-renders. */
function queryForm(path, fields, label) {
  const params = new URLSearchParams(location.search);
  const el = h(
    'form',
    {
      onsubmit: (ev) => {
        ev.preventDefault();
        const q = new URLSearchParams();
        for (const f of fields) {
          const v = String(el.elements[f.name].value || '').trim();
          if (v) q.set(f.name, v);
        }
        history.pushState(null, '', `${path}?${q}`);
        render();
      },
    },
    fields.map((f) => {
      const value = params.get(f.name) ?? f.value ?? '';
      const input =
        f.type === 'select'
          ? h('select', { name: f.name }, f.options.map((o) => h('option', { value: o.value ?? o, selected: (o.value ?? o) === value }, o.label ?? o)))
          : h('input', { name: f.name, type: f.type || 'text', placeholder: f.placeholder || '', value });
      return h('label', {}, `${f.label || f.name} `, input);
    }),
    h('button', { type: 'submit' }, label),
  );
  return el;
}

/** The organisations as select options (the first page). */
async function orgOptions() {
  const d = await api('GET', '/api/orgs');
  return d.orgs.map((o) => ({ value: o.id, label: `${o.name} (${o.id})` }));
}

// ---- navigation ----

// The screens of the spec's admin layout. Reports, statements and rates are C12's; Security & monitoring, the
// pending-upgrades page and the playbooks are C14's; retention is C13's; Users is C8b's (D275); the Support ID lookup is
// C15's (D394–D396, D399).
const NAV = [
  { path: '/orgs', label: 'Organisations' },
  { path: '/users', label: 'Users' },
  { path: '/support', label: 'Support ID lookup' },
  { path: '/audit', label: 'Audit' },
  { path: '/security', label: 'Feed and notices' },
  { path: '/security/monitoring', label: 'Security & monitoring' },
  { path: '/security/upgrades', label: 'Pending upgrades' },
  { path: '/security/playbooks', label: 'Playbooks' },
  { path: '/reports', label: 'Reports' },
  { path: '/statements', label: 'Statements' },
  { path: '/rates', label: 'Rates' },
  { path: '/retention', label: 'Retention' },
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
  const dirForm = h(
    'form',
    {
      onsubmit: (ev) => {
        ev.preventDefault();
        const q = new URLSearchParams(params);
        q.delete('dirBefore');
        for (const k of ['dirStaff', 'dirAction']) {
          const v = dirForm.elements[k].value.trim();
          if (v) q.set(k, v);
          else q.delete(k);
        }
        history.pushState(null, '', `/audit?${q}`);
        render();
      },
    },
    h('input', { name: 'dirStaff', placeholder: 'staff email', value: params.get('dirStaff') || '' }),
    h('select', { name: 'dirAction' }, ['', 'user_search', 'user_view', 'support_lookup', 'client_proof', 'unlock', 'unsuppress', 'revoke_tickets'].map((a) => h('option', { value: a, selected: params.get('dirAction') === a }, a || 'any action'))),
    h('button', { type: 'submit' }, 'Filter issuer rows'),
  );
  directoryAuditBlock(main, params, data.directory);
  main.append(dirForm);
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
  ledgerSecurity(main, d.ledger);
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

/** The usage ledger's part of the security screen (C12): nonce checks, rejection and settlement alerts, partitions. */
function ledgerSecurity(main, l) {
  main.append(h('h2', {}, 'Usage ledger'));
  if (!l || l.error) {
    main.append(h('p', { class: 'warn' }, l && l.error ? l.error : 'Unavailable'));
    return;
  }
  if (!l.relayerAccountSet) main.append(h('p', { class: 'warn' }, 'RELAYER_ACCOUNT is not set: settlement and the nonce check do not run.'));
  main.append(
    l.partitionsLow ? h('p', { class: 'warn' }, `Only ${l.partitionsAhead} future monthly partition(s) of usage.events: an event outside every partition is lost. Check the API's and the admin's partition keepers.`) : h('p', {}, `Future monthly partitions: ${l.partitionsAhead}`),
    h('h3', {}, 'Settlement backlog'),
    h('p', {}, `${l.settlementBacklog.pending} relayed event(s) without a settlement${l.settlementBacklog.oldestAt ? `, the oldest from ${time(l.settlementBacklog.oldestAt)}` : ''}`),
    h('h3', {}, 'Nonce cross-check (latest per relayer key)'),
    table(
      ['Relayer key', 'Checked', 'Nonce on chain', 'Result', 'Ledger rows since last', 'Alerted'],
      l.nonceChecks.map((n) => tr(h('code', {}, n.relayerPk), time(n.checkedAt), n.chainNonce, n.explained ? 'explained' : h('strong', { class: 'error' }, 'UNEXPLAINED'), String(n.ledgerRelayedSinceLast), n.alertedAt ? time(n.alertedAt) : n.explained ? '' : 'not yet')),
    ),
    h('h3', {}, 'Rejection-rate alerts (D91)'),
    table(
      ['Org', 'Day', 'Relayed', 'Rejected after relay', 'Alerted'],
      l.rejectionAlerts.map((a) => tr(a.orgId, a.day, String(a.relayed), `${a.rejected} (${((a.rejected * 100) / Math.max(1, a.relayed)).toFixed(1)}%)`, a.alertedAt ? time(a.alertedAt) : 'not yet')),
    ),
    h('h3', {}, 'Settlement refusals (not billed)'),
    h('p', { class: 'muted' }, 'A relayed event is billed only when its transaction is its own: no other event carries it, and it is signed by the event’s pool key at its nonce.'),
    table(
      ['Detected', 'Reason', 'Org', 'Request', 'Event time', 'Transaction', 'Detail', 'Alerted'],
      l.settlementAlerts.map((a) => tr(time(a.detectedAt), a.reason, a.orgId, a.requestId, time(a.at), h('code', {}, a.nearTx), h('code', {}, JSON.stringify(a.detail)), a.alertedAt ? time(a.alertedAt) : 'not yet')),
    ),
  );
}

// ---- reports, statements, rates (C12) ----

async function reportsPage(main) {
  const params = new URLSearchParams(location.search);
  const first = `${thisMonth()}-01`;
  main.append(
    h('h1', {}, 'Usage reports'),
    queryForm(
      '/reports',
      [
        { name: 'org', label: 'Organisation', type: 'select', options: [{ value: '', label: '(choose)' }, ...(await orgOptions())] },
        { name: 'from', label: 'From', type: 'date', value: first },
        { name: 'to', label: 'To', type: 'date', value: today() },
        { name: 'by', label: 'By', type: 'select', options: ['day', 'month'] },
        { name: 'apps', label: 'Apps', placeholder: 'app ids, comma separated (optional)' },
      ],
      'Show',
    ),
    h('p', { class: 'muted' }, 'At most 400 days and 100 apps. Gas is settled gas at FINAL; unsettled events are never billed. Late events (received after the month’s statement) are flagged.'),
  );
  const org = params.get('org');
  if (!org) return;
  const q = new URLSearchParams({ org, from: params.get('from') || first, to: params.get('to') || today(), by: params.get('by') || 'day' });
  if (params.get('apps')) q.set('apps', lines(params.get('apps')).join(','));
  const d = await api('GET', `/api/reports?${q}`);
  main.append(
    table(
      ['Period', 'App or scope', 'Logins', 'Derives', 'Owner actions', 'Link actions', 'Identity tokens', 'Active users', 'New users', 'Tgas', 'Rejected Tgas', 'Error Tgas', 'NEAR', 'USD', 'Login p50 ms', 'Login p95 ms', 'Failures', 'Unsettled', 'After statement'],
      d.rows.map((r) =>
        tr(
          r.period,
          r.appId ? r.appId : `owner actions, ${r.scopeId}`,
          String(r.logins),
          String(r.derives),
          String(r.ownerActions),
          String(r.linkActions ?? 0),
          String(r.identityTokens ?? 0),
          String(r.activeUsers ?? ''),
          String(r.newUsers),
          r.tgas,
          r.relayedRejectedTgas,
          r.errorTgas,
          near(r.burntYocto),
          usd(r.usdMicros),
          r.p50.login === undefined ? '' : String(r.p50.login),
          r.p95.login === undefined ? '' : String(r.p95.login),
          Object.entries(r.failuresByCode).map(([k, v]) => `${k}=${v}`).join('; '),
          r.unsettled ? h('strong', {}, String(r.unsettled)) : '0',
          r.afterStatement ? h('strong', { class: 'warn' }, `${r.afterStatement} late`) : '0',
        ),
      ),
    ),
  );
}

/** The on-screen statement (D92): the same labels and values as its PDF. */
function statementBlock(st, view) {
  return h(
    'div',
    {},
    h('h2', {}, view.title),
    h('p', { class: 'notice' }, 'Statement hash (SHA-256 of the CSV): ', h('code', {}, st.csvSha256)),
    table(['', ''], view.header.map(([k, v]) => tr(k, v))),
    table(['App or scope', ...view.tableColumns], view.table.map((r) => tr(r.label, ...r.cells))),
    table(['', ''], view.summary.map(([k, v]) => tr(k.startsWith('Billed') ? h('strong', {}, k) : k, k.startsWith('Billed') ? h('strong', {}, v) : v))),
    view.notes.map((n) => h('p', { class: 'muted' }, n)),
    h('p', {}, `Issued ${time(st.issuedAt)} by ${st.issuedBy}${st.pdfSha256 ? ` · PDF SHA-256 ${st.pdfSha256}` : ''}`),
  );
}

async function statementsPage(main) {
  const params = new URLSearchParams(location.search);
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  main.append(
    h('h1', {}, 'Monthly statements'),
    queryForm(
      '/statements',
      [
        { name: 'org', label: 'Organisation', type: 'select', options: [{ value: '', label: '(choose)' }, ...(await orgOptions())] },
        { name: 'month', label: 'Month', type: 'month', value: prev },
      ],
      'Show',
    ),
  );
  const org = params.get('org');
  if (!org) return;
  const month = params.get('month') || prev;
  const base = `/api/statements/${enc(org)}/${enc(month)}`;
  const d = await api('GET', base);
  if (d.statement) {
    main.append(
      statementBlock(d.statement, d.view),
      h('p', { class: 'row' }, h('a', { href: `${base}.csv`, download: true }, 'Download CSV'), h('a', { href: `${base}.pdf`, download: true }, 'Download PDF')),
    );
  } else {
    const b = d.blockers;
    main.append(
      h('h2', {}, `${month}: not issued`),
      h('p', {}, `Can be issued from ${time(d.issuableFrom)}.`),
      b.pending ? h('p', { class: 'warn' }, `${b.pending} relayed event(s) of the month are not settled yet (settlement runs every 15 minutes).`) : h('p', {}, 'Every relayed event of the month has a settlement.'),
      b.missingRateDays.length ? h('p', { class: 'warn' }, `Days without a NEAR/USD rate: ${b.missingRateDays.join(', ')} (set them on the Rates screen).`) : h('p', {}, 'Every day of the month has a rate.'),
      actionButton('Issue statement', () => api('POST', `${base}/issue`, {}), `Issue the ${month} statement for ${org}? It is frozen once issued: no change, no second statement.`),
    );
  }
  const exportOut = h('div');
  main.append(
    h('h2', {}, 'Ledger export'),
    h('p', { class: 'muted' }, d.statement ? 'As of the statement’s time, so its final gas sums to the statement’s Tgas and NEAR.' : 'As of now.'),
    h(
      'button',
      {
        onclick: async () => {
          exportOut.replaceChildren(h('p', { class: 'muted' }, 'Exporting…'));
          try {
            const out = await api('POST', `/api/exports/${enc(org)}/${enc(month)}`, d.statement ? { asOf: d.statement.asOf } : {});
            exportOut.replaceChildren(
              h('p', { class: 'notice' }, `${out.rows} rows as of ${time(out.asOf)}; final gas ${units(out.finalGas, 12)} Tgas, ${near(out.finalTokens)} NEAR; SHA-256 `, h('code', {}, out.sha256)),
              h('p', {}, h('a', { href: `/api/exports/${enc(org)}/${enc(month)}/${enc(out.file)}`, download: true }, 'Download the export'), h('span', { class: 'muted' }, ' (kept 30 days)')),
            );
          } catch (err) {
            exportOut.replaceChildren(errorBox(err));
          }
        },
      },
      'Export ledger CSV',
    ),
    exportOut,
    h('h2', {}, 'Statements of this organisation'),
  );
  const list = await api('GET', `/api/statements?org=${enc(org)}`);
  main.append(
    table(
      ['Month', 'As of', 'CSV SHA-256', 'Issued', 'By'],
      list.statements.map((s) => tr(link(`/statements?org=${enc(org)}&month=${enc(s.month)}`, s.month), time(s.asOf), h('code', {}, s.csvSha256), time(s.issuedAt), s.issuedBy)),
    ),
  );
}

async function ratesPage(main) {
  const params = new URLSearchParams(location.search);
  const month = params.get('month') || thisMonth();
  main.append(h('h1', {}, 'NEAR/USD rates'), queryForm('/rates', [{ name: 'month', label: 'Month', type: 'month', value: month }], 'Show'));
  const d = await api('GET', `/api/rates?month=${enc(month)}`);
  main.append(
    h('p', { class: 'muted' }, 'Fetched daily from CoinGecko (the price at 00:00 UTC of the day). A month with a statement is frozen. Testnet usage is valued at the mainnet price.'),
    d.missing.length ? h('p', { class: 'warn' }, `Days without a rate: ${d.missing.join(', ')}`) : h('p', {}, 'Every past day of the month has a rate.'),
    table(['Day', 'USD per NEAR', 'Source', 'Entered by', 'Set at'], d.rates.map((r) => tr(r.day, usd(r.usdMicros), r.source, r.enteredBy || '(fetched)', time(r.fetchedAt)))),
    h('h2', {}, 'Override a rate'),
    h('p', { class: 'muted' }, 'Audited: the old and new rate, who and why are kept with it. Refused once the month has a statement.'),
    form(
      [
        { name: 'day', type: 'date', required: true },
        { name: 'usd', placeholder: 'USD per NEAR, e.g. 2.345678', required: true },
        { name: 'reason', placeholder: 'Why (10 to 500 characters)', required: true },
      ],
      'Set rate',
      (v) => api('PUT', `/api/rates/${enc(v.day)}`, { usd: v.usd.trim(), reason: v.reason.trim() }),
      { confirm: 'Set this rate by hand? It replaces the fetched one for that day.' },
    ),
    h('h2', {}, 'Override history'),
    table(['At', 'Day', 'USD', 'Was', 'By', 'Reason'], d.overrides.map((o) => tr(time(o.at), o.day, usd(o.usdMicros), o.previousUsdMicros ? `${usd(o.previousUsdMicros)} (${o.previousSource})` : '(none)', o.enteredBy, o.reason))),
  );
}


// The monthly retention job (C13, D90): its runs with the rows per table, a warning until a run succeeds, the next
// run, what waits for a person, the manual issuer step and the recent erasures.
const RETENTION_LABELS = {
  uidsStripped: 'uids removed (events past 24 months)',
  appUsersExpired: 'app_users last seen 24 months ago',
  partitionsDropped: 'monthly partitions dropped (past 7 years)',
  settlementsDeleted: 'settlements (past 7 years)',
  identityTokensDeleted: 'identity token days (past 7 years)',
  emailCountsDeleted: 'email count days (past 7 years)',
  settlementAlertsDeleted: 'settlement alerts (past 7 years)',
  settlementTriesDeleted: 'settlement tries (past 7 years)',
  nonceChecksDeleted: 'nonce checks (400 days)',
  rejectionAlertsDeleted: 'rejection alerts (400 days)',
  scopeWatchDeleted: 'watcher rows (400 days)',
  retentionRunsDeleted: 'retention runs (60 months)',
  erasuresDeleted: 'erasure records (60 months)',
  deletedAppsPurged: 'deleted apps purged',
  appUsersPurged: 'app_users of deleted apps',
  directoryScopes: 'scopes left without apps',
  directoryUsers: 'wallet directory users',
  directoryWallets: 'wallet directory wallets',
  directoryIdentities: 'wallet directory identities',
  appChangesDeleted: 'app_changes (60 months)',
  guardedChangesDeleted: 'guarded_changes (60 months)',
  auditLogDeleted: 'console audit_log (60 months)',
  ownerGrantsDeleted: 'owner grants (60 months)',
};

function retentionRows(rows) {
  const items = Object.entries(rows || {})
    .filter(([k, v]) => k !== 'due' && k !== 'calls' && typeof v === 'number' && v > 0)
    .map(([k, v]) => h('li', {}, `${RETENTION_LABELS[k] || k}: ${v}`));
  return items.length ? h('ul', {}, items) : h('span', { class: 'muted' }, 'nothing due');
}

const RETENTION_STATE = {
  due: 'due now (the next 15-minute run starts it)',
  continuing: 'continuing (the last run ran out of its calls)',
  done: 'done for this month',
  not_yet: 'not due yet',
  running: 'a run is in progress',
  retry_later: 'the last run failed; it is retried an hour after the failure',
};

async function retentionPage(main) {
  const d = await api('GET', '/api/retention');
  main.append(
    h('h1', {}, 'Retention'),
    h('p', { class: 'muted' }, 'D90: raw usage 24 months (then the uid is removed and the rows kept), settlement records 7 years (whole months), audit logs 5 years, the admin’s own state 400 days. The job runs on the 1st at 01:00 UTC until one run of the month completes.'),
  );
  if (d.warning) main.append(h('p', { class: 'warn' }, d.warning));
  main.append(
    table(['Month', 'State', 'Due at', 'Next run'], [tr(d.month, RETENTION_STATE[d.state] || d.state, time(d.dueAt), time(d.nextRunAt))]),
    h('h2', {}, 'Waiting for a person'),
    d.due && (d.due.statements || d.due.rates || d.due.rateOverrides)
      ? h('p', { class: 'warn' }, `Past 7 years: ${d.due.statements} statement(s)${d.due.oldestStatement ? ` (oldest ${d.due.oldestStatement})` : ''}, ${d.due.rates} rate(s), ${d.due.rateOverrides} rate override(s). Statements, rates and their files are deleted by hand after review (docs/operations.md "Retention").`)
      : h('p', {}, 'Nothing past 7 years waits for review.'),
    h('p', { class: 'muted' }, 'Not done by this job: the email issuer’s user directory (rows of apps deleted 30 days ago) and its staff audit (60 months). This Worker’s binding to the issuer only reads (DirectoryRpc, C8b): run `admin <env> retention:issuer --remote` after each month’s run (docs/operations.md "Retention").'),
    h('h2', {}, 'Runs'),
    table(
      ['Run', 'Month', 'Started', 'Finished', 'Status', 'Calls', 'Rows', 'Error'],
      d.runs.map((r) => tr(String(r.id), r.month, time(r.startedAt), time(r.finishedAt), r.status, String((r.rows && r.rows.calls) || 0), retentionRows(r.rows), r.error || '')),
    ),
    h('h2', {}, 'Erasures'),
    h('p', { class: 'muted' }, 'Each `uid-erase` run: who ran it, under which ticket, in which scope, and how many rows each store lost. Never whom.'),
    table(
      ['At', 'Ticket', 'Operator', 'Scope', 'Rows'],
      d.erasures.map((e) => tr(time(e.at), e.ticket, e.operator, e.scopeId, h('code', {}, JSON.stringify(e.rows)))),
    ),
  );
}

// ---- users (C8b, D275): the issuer's directory, the wallet directory, the chain ----

// The search and the last support reference live in memory only: never in the URL, history or storage (no address,
// sub or code in a URL; the server's routes are POST). An opened user is too (D410): its page is the fixed path
// USER_OPEN_PATH, and the history entry holds only an opaque number into `opened` (this page's memory), so back and
// forward move between the users opened in this tab, and a reload or a copied link opens nobody.
const usersState = { form: {}, result: null, kind: null, ticket: '', opened: new Map(), seq: 0 };
const USER_OPEN_PATH = '/users/open';
/** Users kept for back and forward in this tab (the oldest forgotten past it). */
const OPENED_MAX = 50;
/** Labels shared with the partner console's Users screen (apps/console/web/src/pages/Users.tsx). */
const KIND = { google: 'Google', email: 'Email', apple: 'Apple' };
const kindLabel = (k) => KIND[k] || k;
const chainLabel = (c) => (c === 'stellar' ? 'Stellar' : c === 'evm' ? 'EVM' : c);
/** Opens one identity's page from memory: the fixed path, the identity never in the URL or history state. */
function openUser(provider, sub) {
  usersState.seq += 1;
  usersState.opened.set(usersState.seq, { provider, sub });
  for (const k of usersState.opened.keys()) if (usersState.opened.size > OPENED_MAX) usersState.opened.delete(k);
  go(USER_OPEN_PATH, { user: usersState.seq });
}
/** A link to one identity's page: its href is the fixed path; a click opens it from memory (`openUser`). */
const userLink = (provider, sub, text) =>
  h(
    'a',
    {
      href: USER_OPEN_PATH,
      onclick: (ev) => {
        ev.preventDefault();
        openUser(provider, sub);
      },
    },
    text,
  );
/** A Support ID as the search box takes it (`HANA-XXXX-XXXX`, any case): it goes to the Support ID lookup (D399). */
const supportIdQuery = (q) => /^hana[\s-]?[0-9a-z]{4}-?[0-9a-z]{4}$/iu.test(q.trim());
/** A full address (console-core isFullAddress): an exact search, which names one identity and so needs the ticket (D410). */
const fullAddress = (q) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(q.trim());
/** What the search box names that the wallet directory answers (AdminRpc.findUsers) instead of the issuer's directory. */
function walletQuery(q) {
  const s = q.trim();
  return /^G[A-Z2-7]{55}$/u.test(s) || /^0x[0-9a-fA-F]{40}$/u.test(s) || /^u1_[A-Za-z0-9_-]{22}$/u.test(s) || /^hu_[0-9a-z]{26}$/iu.test(s) || supportIdQuery(s);
}

const unverifiedBadge = () => h('span', { class: 'badge warning' }, 'UNVERIFIED claim');

function directoryRows(users, warning) {
  const claims = users.filter((u) => u.unverifiedClaim).length;
  return [
    claims ? h('p', { class: 'warn' }, `${warning} (${claims} row${claims === 1 ? '' : 's'} below, listed last).`) : '',
    table(
      ['Address', 'Account', 'Verified', 'Hosted', 'Apps', 'Last seen', ''],
      users.map((u) =>
        tr(
          u.unverifiedClaim ? h('span', {}, u.email, ' ', unverifiedBadge()) : u.email,
          kindLabel(u.provider),
          u.emailVerified ? 'yes' : 'no',
          u.hosted === null ? '' : u.hosted ? 'Google-hosted' : 'no',
          String(u.appCount),
          time(u.lastSeenMs),
          userLink(u.provider, u.sub, 'Open'),
        ),
      ),
    ),
  ];
}

function walletUserBlock(u) {
  return h(
    'div',
    {},
    table(['User ID', 'Support ID', 'Internal id', 'Scope', 'Org', 'Created', 'Last seen'], [tr(h('code', {}, u.userId), h('code', {}, u.supportId), h('code', {}, u.internalId), u.scopeId, u.orgId || '', time(u.createdAt), time(u.lastSeenAt))]),
    // The Support ID and its activity: the lookup by User ID, the ticket carried over (in memory); staff press "Look up".
    h('p', {}, h('button', { type: 'button', onclick: () => openLookup(u.userId, usersState.ticket, false) }, 'Support ID lookup: activity, shares, emails')),
    table(
      ['Account', 'Sub', 'Role', 'Status', 'Effective', 'Observed'],
      u.identities.map((i) => tr(kindLabel(i.provider), i.sub ? userLink(i.provider, i.sub, i.sub) : h('span', { class: 'muted' }, 'seen on chain only'), i.role, i.status, i.effectiveAt ? time(i.effectiveAt) : '', time(i.observedAt))),
    ),
    table(
      ['Wallet', 'Address', 'Key index', 'First seen', 'Last used'],
      u.wallets.map((w) => tr(chainLabel(w.chain), h('span', {}, h('code', {}, w.address), w.sharedWith ? h('span', { class: 'badge warning' }, ` also listed by ${w.sharedWith} other user(s): not proof of ownership`) : ''), String(w.keyIndex), time(w.firstSeenAt), time(w.lastUsedAt))),
    ),
  );
}

async function usersPage(main) {
  const f = usersState.form;
  const results = h('div');
  const showResults = () => {
    const r = usersState.result;
    if (!r) return results.replaceChildren();
    if (usersState.kind === 'wallet') {
      results.replaceChildren(h('h2', {}, 'Wallet directory'), r.users.length ? h('div', {}, r.users.map(walletUserBlock)) : h('p', { class: 'muted' }, 'No user has this id or wallet (a Support ID resolves only for users who logged in since the wallet directory’s deploy).'));
      return undefined;
    }
    results.replaceChildren(h('h2', {}, 'Directory'), ...directoryRows(r.users, r.unverifiedWarning), r.next ? h('button', { type: 'button', onclick: () => runSearch(r.next) }, 'Next page') : '');
    return undefined;
  };
  const runSearch = async (cursor) => {
    results.replaceChildren(h('p', { class: 'muted' }, 'Searching…'));
    try {
      const q = (f.q || '').trim();
      // A Support ID goes to the lookup (activity, shares, emails; D399), run at once when a support reference is given.
      // The wallet directory alone stays a click away there ("Wallet directory only", `/api/users/find`).
      if (q && supportIdQuery(q)) {
        openLookup(q, (f.ticket || '').trim(), true);
        return;
      }
      const ticket = (f.ticket || '').trim();
      // The reference typed here is the one an opened user or the lookup is offered next (memory only).
      if (ticket) usersState.ticket = ticket;
      // A search that names one user (an id, a wallet, a sub or a full address) needs the support reference (D410).
      if (!ticket && ((q && (walletQuery(q) || fullAddress(q))) || (f.sub || '').trim())) {
        results.replaceChildren(h('p', { class: 'error' }, 'A support reference is required to search by User ID, internal id, wallet, sub or a full address: it is recorded in the audit. Browsing (a part of an address, the account kind, an app, unverified claims) needs none.'));
        return;
      }
      if (q && walletQuery(q)) {
        usersState.kind = 'wallet';
        usersState.result = await api('POST', '/api/users/find', { query: q, ticket });
      } else {
        usersState.kind = 'directory';
        const body = { limit: 50 };
        if (q) body.q = q;
        for (const k of ['provider', 'appId', 'sub', 'ticket']) if (f[k] && f[k].trim()) body[k] = f[k].trim();
        if (f.unverifiedOnly) body.unverifiedOnly = true;
        if (cursor) body.cursor = cursor;
        usersState.result = await api('POST', '/api/users/search', body);
      }
      showResults();
    } catch (err) {
      results.replaceChildren(errorBox(err));
    }
  };
  const input = (name, placeholder) => h('input', { name, placeholder, value: f[name] || '' });
  const el = h(
    'form',
    {
      onsubmit: async (ev) => {
        ev.preventDefault();
        for (const k of ['q', 'provider', 'appId', 'sub', 'ticket']) f[k] = el.elements[k].value;
        f.unverifiedOnly = el.elements.unverifiedOnly.checked;
        await runSearch(null);
      },
    },
    input('q', 'Address (or ≥ 3 characters of one), User ID, Support ID, internal id or wallet'),
    h('select', { name: 'provider' }, ['', 'email', 'google'].map((p) => h('option', { value: p, selected: f.provider === p }, p ? kindLabel(p) : 'Any account'))),
    input('appId', 'App id'),
    input('sub', 'Sub (exact)'),
    h('label', {}, h('input', { name: 'unverifiedOnly', type: 'checkbox', checked: !!f.unverifiedOnly }), ' Unverified claims only'),
    input('ticket', 'Support reference (for an id, wallet, sub or full address)'),
    h('button', { type: 'submit' }, 'Search'),
  );
  main.append(
    h('h1', {}, 'Users'),
    h('p', { class: 'muted' }, 'Hana staff only: partners never see addresses. Every search and every opened user is audited by the email issuer under your Access identity, and each staff member can read at most 500 identities an hour and 2 000 a day (past that the reads stop and Hana security is emailed). There is no export: bulk reads stay with `admin <env> user:list --json`.'),
    h('p', { class: 'muted' }, 'A Support ID (HANA-XXXX-XXXX) opens the Support ID lookup; a User ID, internal id or wallet lists the wallet directory’s users. Both, and a search by sub or by a full address, need a support reference (recorded in the audit); browsing by a part of an address, the account kind, an app or unverified claims doesn’t.'),
    el,
    results,
  );
  showResults();
}

function standingBlock(s) {
  if (!s.ok) return h('div', {}, h('h3', {}, s.scopeId), h('p', { class: 'error' }, s.reason === 'not_read' ? 'Not read (this page’s call budget)' : 'chain unavailable'));
  const rows = [
    ['Status', s.status === 'pending' ? `pending: takes effect ${time(s.effectiveAtMs)}` : s.status],
    ['Path', h('code', {}, s.path)],
    ['Opened (has a wallet)', s.opened ? 'yes' : 'no'],
    ['Identity key', h('code', {}, s.identityKey)],
    ['Read at block', s.blockHeight === null ? 'unknown' : String(s.blockHeight)],
  ];
  if (s.root) rows.splice(2, 0, ['Account root', userLink(s.root.provider, s.root.sub, `${kindLabel(s.root.provider)} ${s.root.sub}`)]);
  const parts = [h('h3', {}, s.scopeId), table(['', ''], rows.map(([k, v]) => tr(k, v)))];
  if (s.account) {
    parts.push(
      h('p', {}, 'Account root: ', userLink(s.account.root.provider, s.account.root.sub, `${kindLabel(s.account.root.provider)} ${s.account.root.sub}`), ` (epoch ${s.account.epoch})`),
      table(['Member', 'Sub', 'Key', 'Active', 'Effective'], s.account.members.map((m) => tr(kindLabel(m.provider), m.sub ? userLink(m.provider, m.sub, m.sub) : h('span', { class: 'muted' }, 'unknown to the wallet directory'), h('code', {}, m.key), m.active ? 'yes' : 'no', m.effectiveAtMs ? time(m.effectiveAtMs) : ''))),
    );
  } else if (s.accountUnread) parts.push(h('p', { class: 'warn' }, `In an account; its members: ${s.accountUnread === 'not_read' ? 'not read (this page’s call budget)' : 'chain unavailable'}`));
  return h('div', {}, parts);
}

function userDetail(main, d) {
  const u = d.user;
  if (d.warning) main.append(h('p', { class: 'warn' }, d.warning));
  main.append(h('h2', {}, 'Directory'));
  if (!u) main.append(h('p', { class: 'muted' }, 'No directory row: the issuer hasn’t seen this identity log in since the directory’s deploy (D269), its app is on no issuer env, or a best-effort write was lost.'));
  else {
    main.append(
      table(
        ['', ''],
        [
          ['Address', u.unverifiedClaim ? h('span', {}, u.email, ' ', unverifiedBadge()) : u.email],
          ['Account', kindLabel(u.provider)],
          ['Sub', h('code', {}, u.sub)],
          ['Verified', u.provider === 'email' ? 'yes (a sign-in code)' : u.emailVerified ? 'yes (Google)' : 'NO: Google hasn’t verified this address; the account only claims it'],
          ['Hosted', u.hosted === null ? '' : u.hosted ? 'Google-hosted' : 'not Google-hosted'],
          ['First seen', time(u.firstSeenMs)],
          ['Last seen', time(u.lastSeenMs)],
        ].map(([k, v]) => tr(k, v)),
      ),
      h('p', { class: 'muted' }, 'Seen times are when the issuer saw the identity log in; writes are best effort, so a lost one leaves a gap.'),
    );
  }
  main.append(
    h('h2', {}, 'Apps'),
    d.appNamesError ? h('p', { class: 'warn' }, `App names unavailable: ${d.appNamesError}`) : '',
    table(['App', 'Id', 'Org', 'Environment', 'Scope', 'First seen', 'Last seen'], d.apps.map((a) => tr(a.name ? `${a.name}${a.deletedAt ? ' (deleted)' : ''}` : h('span', { class: 'muted' }, 'unknown'), h('code', {}, a.appId), a.orgId || '', a.environment || '', a.scopeId, time(a.firstSeenMs), time(a.lastSeenMs)))),
    d.appsTruncated ? h('p', { class: 'muted' }, 'Only the 200 most recent apps are listed.') : '',
    h('h2', {}, 'Wallets and ids'),
  );
  if (d.walletUsers === null) main.append(h('p', { class: 'error' }, `Wallet directory unavailable: ${d.walletError || 'error'}`));
  else if (d.walletUsers.length === 0) main.append(h('p', { class: 'muted' }, 'No wallet-directory user holds this identity yet (a user appears at their next login).'));
  else main.append(...d.walletUsers.map(walletUserBlock));
  main.append(h('h2', {}, 'On chain, per scope (read live)'), d.chain.length ? h('div', {}, d.chain.map(standingBlock)) : h('p', { class: 'muted' }, 'No scope to read.'));
}

async function userPage(main) {
  const st = history.state;
  const who = st && typeof st.user === 'number' ? usersState.opened.get(st.user) : undefined;
  if (!who) {
    // A reload, a copied link or a user forgotten past OPENED_MAX: the identity was never in the URL, so open it again.
    main.append(h('h1', {}, 'No user open'), h('p', { class: 'muted' }, 'An opened user lives in this tab’s memory only, never in the URL: search Users and open them again.'), link('/users', 'Users'));
    return;
  }
  const { provider, sub } = who;
  main.append(h('h1', {}, `${kindLabel(provider)} ${sub}`), link('/users', 'Back to the search'));
  const out = h('div');
  const el = h(
    'form',
    {
      onsubmit: async (ev) => {
        ev.preventDefault();
        const ticket = el.elements.ticket.value.trim();
        usersState.ticket = ticket;
        out.replaceChildren(h('p', { class: 'muted' }, 'Reading…'));
        try {
          const d = await api('POST', '/api/users/get', { provider, sub, ticket });
          out.replaceChildren();
          userDetail(out, d);
        } catch (err) {
          out.replaceChildren(errorBox(err));
        }
      },
    },
    h('label', {}, 'Support reference (required to open a user; recorded in the issuer’s audit) ', h('input', { name: 'ticket', required: true, maxlength: 64, pattern: '[A-Za-z0-9._#:\\-]{1,64}', value: usersState.ticket })),
    h('button', { type: 'submit' }, 'Open'),
  );
  main.append(el, out);
}

function directoryAuditBlock(main, params, dir) {
  main.append(h('h2', {}, 'Issuer directory reads and staff actions'));
  if (dir === null || dir === undefined) {
    main.append(h('p', { class: 'muted' }, 'No email issuer in this environment.'));
    return;
  }
  if (dir.error) {
    main.append(h('p', { class: 'error' }, `Unavailable: ${dir.error}`));
    return;
  }
  main.append(table(['Id', 'At', 'Staff', 'Action', 'Ticket', 'Scope', 'Subject', 'Detail'], dir.rows.map((r) => tr(String(r.id), time(r.atMs), r.staff, r.action, r.ticket || '', r.scopeId || '', r.subject || '', h('code', {}, r.detail === null ? '' : JSON.stringify(r.detail))))));
  if (dir.next) {
    const next = new URLSearchParams(params);
    next.set('dirBefore', String(dir.next));
    main.append(link(`/audit?${next}`, 'Older issuer rows'));
  }
}

// ---- Support ID lookup (C15; D394–D396, D399) ----

// The query, the ticket, the request IDs and the last answer live in memory only: never in the URL, history state or
// storage (POST /api/support/lookup; no code, id or address in a URL). Reached from the nav, from the Users search (a
// Support ID) and from a wallet-directory user's block (by User ID). Nothing is read until staff press "Look up" (or
// search Users for a Support ID with a support reference): every lookup is audited first in the console's audit
// (`support.lookup`), and each address it shows is read from the issuer's directory, audited there (`support_lookup`).
const supportState = { form: { query: '', ticket: '', requestIds: '', days: '30' }, result: null, askedIds: 0, wallet: null, run: false };
/** The support reference's rule (console-core SUPPORT_TICKET_RE), the same for the console's and the issuer's audits. */
const SUPPORT_TICKET_PATTERN = '[A-Za-z0-9._#:\\-]{1,64}';

/** Opens the lookup screen for `query` (the ticket carried over when known); runs it when `run` and there is a ticket. */
function openLookup(query, ticket, run) {
  supportState.form = { query: query || '', ticket: ticket || '', requestIds: '', days: '30' };
  supportState.result = null;
  supportState.wallet = null;
  supportState.run = !!(run && ticket);
  go('/support');
}

/** Why an identity's address isn't shown (apps/admin/src/support.ts SupportEmailMissing). */
const EMAIL_MISSING = {
  not_found: 'not in the directory (no login seen since its deploy, or an app on no issuer env)',
  not_read: 'not read (this lookup’s limit of identities)',
  no_directory: 'no directory for this account kind',
  directory_unavailable: 'directory unavailable',
  directory_refused: 'the directory refused your staff identity (config drift: see the log)',
  rate_limited: 'not read: your directory row budget is used up',
  failed: 'the directory read failed',
};
const emailKey = (provider, sub) => `${provider}\n${sub}`;

/** The identity's address cell: `key` its directoryKey (null without a sub), `e` the email join's row for it. */
function emailCell(key, e) {
  if (!key) return h('span', { class: 'muted' }, 'no sub: seen on chain only');
  if (!e) return h('span', { class: 'muted' }, 'not read');
  if (!e.found) return h('span', { class: 'muted' }, EMAIL_MISSING[e.reason] || e.reason);
  return e.unverifiedClaim ? h('span', {}, e.email, ' ', unverifiedBadge()) : e.email;
}

const outcomeBadge = (o) => (o === 'ok' ? badge('ok', 'info') : o === 'rejected' ? badge('rejected', 'warning') : badge(o, 'critical'));

function supportMatchBlock(m, k, n, activity, ledger, emails, days) {
  const u = m.user;
  const appName = new Map(m.apps.map((a) => [a.appId, a.name]));
  const appLabel = (id) => (id ? `${appName.get(id) || 'unknown app'} (${id})` : '');
  const parts = [
    h('h2', {}, n > 1 ? `Match ${k + 1} of ${n}: ` : '', h('code', {}, u.supportId), ' · ', h('code', {}, u.userId)),
    table(['User ID', 'Support ID', 'Internal id', 'Scope', 'Org', 'Created', 'Last seen'], [tr(h('code', {}, u.userId), h('code', {}, u.supportId), h('code', {}, u.internalId), u.scopeId, u.orgId || '', time(u.createdAt), time(u.lastSeenAt))]),
    h('h3', {}, 'Identities'),
    table(
      ['Account', 'Email (the issuer’s directory)', 'Sub', 'Role', 'Status', 'Effective', 'Observed'],
      u.identities.map((i) =>
        tr(
          kindLabel(i.provider),
          emailCell(i.directoryKey, i.directoryKey ? emails.get(emailKey(i.directoryKey.provider, i.directoryKey.sub)) : undefined),
          i.sub ? userLink(i.provider, i.sub, i.sub) : h('span', { class: 'muted' }, 'seen on chain only'),
          i.role,
          i.status,
          i.effectiveAt ? time(i.effectiveAt) : '',
          time(i.observedAt),
        ),
      ),
    ),
    h('h3', {}, 'Wallets'),
    table(
      ['Wallet', 'Address', 'Key index', 'First seen', 'Last used'],
      u.wallets.map((w) => tr(chainLabel(w.chain), h('span', {}, h('code', {}, w.address), w.sharedWith ? h('span', { class: 'badge warning' }, ` also listed by ${w.sharedWith} other user(s): not proof of ownership`) : ''), String(w.keyIndex), time(w.firstSeenAt), time(w.lastUsedAt))),
    ),
    h('h3', {}, 'Apps of the scope'),
    table(['App', 'Id', 'Org', 'Environment', 'Persistence', 'Deleted'], m.apps.map((a) => tr(a.name, h('code', {}, a.appId), a.orgId, a.environment || 'unknown', a.persistence, a.deletedAt ? time(a.deletedAt) : ''))),
    h('h3', {}, 'Vault shares that haven’t expired'),
    h('p', { class: 'muted' }, 'A share keeps the wallet across reloads (persistence "session"). Live: not revoked, and before its idle and absolute limits.'),
    table(['App', 'Key index', 'Created', 'Idle until', 'Expires', 'Revoked', 'Live'], m.shares.map((x) => tr(appLabel(x.appId), String(x.keyIndex), time(x.createdAt), time(x.idleUntil), time(x.absExpiresAt), x.revokedAt ? time(x.revokedAt) : '', x.live ? badge('live', 'info') : 'no'))),
    h('h3', {}, `App changes (last ${days} days, at most 50)`),
    changesTable(m.changes),
    h('h3', {}, `Ledger events (ok logins, sessions and derives; last ${days} days, at most 400)`),
  ];
  if (!ledger.available || activity === null) parts.push(h('p', { class: 'warn' }, `Not shown: ${ledger.available ? 'ledger unavailable' : ledger.reason}`));
  else {
    parts.push(
      table(
        ['At', 'Request ID', 'App', 'Endpoint', 'Status', 'Latency ms', 'Relayed', 'NEAR tx'],
        activity.map((a) => tr(time(a.at), h('code', {}, a.requestId), appLabel(a.appId), a.endpoint, String(a.status), String(a.latencyMs), a.relayed ? 'yes' : 'no', a.nearTx ? h('code', {}, a.nearTx) : '')),
      ),
      h('p', { class: 'muted' }, 'Failures carry no user id in the ledger, by design: look them up by the request IDs the partner gives.'),
    );
  }
  return h('div', {}, parts);
}

function supportResult(out, v, askedIds) {
  const emails = new Map((v.emails || []).map((e) => [emailKey(e.provider, e.sub), e]));
  const by = v.query.kind === 'supportId' ? 'Support ID' : v.query.kind === 'userId' ? 'User ID' : 'internal id';
  out.append(h('p', { class: 'muted' }, `Looked up by ${by}, since ${time(v.since)} (${v.days} days). Recorded in the audit under your Access identity.`));
  if (!v.ledger.available) out.append(h('p', { class: 'warn' }, `Ledger unavailable: ${v.ledger.reason}. Ledger events and request-ID events are not shown; the directory part below is complete.`));
  if (v.emailsNote) out.append(h('p', { class: 'warn' }, v.emailsNote));
  if (v.unverifiedWarning) out.append(h('p', { class: 'warn' }, v.unverifiedWarning));
  if (v.truncated) out.append(h('p', { class: 'warn' }, `Truncated: more users share this Support ID than are listed; only the ${v.matches.length} most recently seen are shown. Ask the partner for the User ID.`));
  if (v.matches.length === 0) out.append(h('p', { class: 'muted' }, 'No user has this id (a Support ID resolves only for users who logged in since the wallet directory’s deploy, and an erased user is gone).'));
  else if (v.matches.length > 1 || v.truncated) {
    out.append(
      h('h2', {}, 'Matches'),
      h('p', { class: 'notice' }, `${v.matches.length}${v.truncated ? '+' : ''} users share this Support ID (40 bits collide rarely). Tell them apart by the app and the time the partner names.`),
      table(['#', 'User ID', 'Scope', 'Org', 'Apps', 'Last seen'], v.matches.map((m, k) => tr(String(k + 1), h('code', {}, m.user.userId), m.user.scopeId, m.user.orgId || '', m.apps.map((a) => a.name).join(', '), time(m.user.lastSeenAt)))),
    );
  }
  v.matches.forEach((m, k) => out.append(supportMatchBlock(m, k, v.matches.length, v.activity[k], v.ledger, emails, v.days)));
  if (!askedIds) return;
  out.append(h('h2', {}, 'Request IDs'));
  if (v.requests === null) {
    out.append(h('p', { class: 'warn' }, `Not shown: ${v.ledger.available ? 'ledger unavailable' : v.ledger.reason}`));
    return;
  }
  out.append(
    table(
      ['At', 'Request ID', 'Outcome', 'Code', 'Status', 'Endpoint', 'Org', 'App', 'Scope', 'Latency ms', 'Relayed', 'NEAR tx', 'This user'],
      v.requests.map((r) =>
        tr(
          time(r.at),
          h('code', {}, r.requestId),
          outcomeBadge(r.outcome),
          r.code ? h('code', {}, r.code) : '',
          String(r.status),
          r.endpoint,
          r.orgId,
          r.appId || '',
          r.scopeId,
          String(r.latencyMs),
          r.relayed ? 'yes' : 'no',
          r.nearTx ? h('code', {}, r.nearTx) : '',
          r.byMatch ? 'yes' : h('span', { class: 'muted' }, 'no user id on the event'),
        ),
      ),
    ),
  );
  if (v.requestsNotFound.length) out.append(h('p', { class: 'warn' }, 'No ledger event for: ', v.requestsNotFound.flatMap((id, k) => [k ? ', ' : '', h('code', {}, id)]), ' (an unknown id, a rejection before the gate recorded it, or usage capture off then).'));
}

async function supportPage(main) {
  const f = supportState.form;
  const out = h('div');
  const show = () => {
    out.replaceChildren();
    if (supportState.wallet) out.append(h('h2', {}, 'Wallet directory only'), supportState.wallet.users.length ? h('div', {}, supportState.wallet.users.map(walletUserBlock)) : h('p', { class: 'muted' }, 'No user has this id or wallet.'));
    else if (supportState.result) supportResult(out, supportState.result, supportState.askedIds);
  };
  let el;
  const read = () => {
    for (const k of ['query', 'ticket', 'requestIds', 'days']) f[k] = el.elements[k].value;
  };
  const run = async () => {
    supportState.wallet = null;
    supportState.result = null;
    out.replaceChildren(h('p', { class: 'muted' }, 'Looking up…'));
    try {
      const body = { query: f.query.trim(), ticket: f.ticket.trim() };
      const ids = lines(f.requestIds);
      if (ids.length) body.requestIds = ids;
      if (String(f.days).trim() && Number(f.days) !== 30) body.days = Number(f.days);
      supportState.askedIds = ids.length;
      supportState.result = await api('POST', '/api/support/lookup', body);
      show();
    } catch (err) {
      out.replaceChildren(errorBox(err));
    }
  };
  const walletOnly = async () => {
    read();
    supportState.result = null;
    out.replaceChildren(h('p', { class: 'muted' }, 'Searching…'));
    try {
      supportState.wallet = await api('POST', '/api/users/find', { query: f.query.trim(), ticket: f.ticket.trim() });
      show();
    } catch (err) {
      out.replaceChildren(errorBox(err));
    }
  };
  el = h(
    'form',
    {
      onsubmit: async (ev) => {
        ev.preventDefault();
        read();
        await run();
      },
    },
    h('label', {}, 'Support ID, User ID or internal id ', h('input', { name: 'query', required: true, maxlength: 64, placeholder: 'HANA-XXXX-XXXX, u1_… or hu_…', value: f.query })),
    h('label', {}, 'Support reference (required; recorded in the console’s and the issuer’s audits) ', h('input', { name: 'ticket', required: true, maxlength: 64, pattern: SUPPORT_TICKET_PATTERN, value: f.ticket })),
    h('label', {}, 'Days ', h('input', { name: 'days', type: 'number', min: 1, max: 731, value: f.days })),
    h('label', {}, 'Request IDs from the escalation (up to 20) ', h('textarea', { name: 'requestIds', placeholder: 'req_… one per line' }, f.requestIds)),
    h('button', { type: 'submit' }, 'Look up'),
    h('button', { type: 'button', onclick: walletOnly }, 'Wallet directory only (no activity; the ticket still recorded)'),
  );
  main.append(
    h('h1', {}, 'Support ID lookup'),
    h(
      'p',
      { class: 'muted' },
      'Hana staff only. What happened to one user: their ids, identities with the directory’s addresses, wallets, the vault shares that haven’t expired, the scope’s app changes, their ledger events, and the events of the request IDs a partner escalates (errors included). Every lookup is audited before anything is read; each address is read from the issuer’s directory under your Access identity and row budget. A wallet address or a sub: search Users first. There is no export: the operator’s path is the CLI’s `admin <env> support:lookup`.',
    ),
    el,
    out,
  );
  show();
  if (supportState.run) {
    supportState.run = false;
    await run();
  }
}

// ---- router ----

let me = null;

/** Moves to `path` (no data in it) and renders it; `state` is at most an opaque number (openUser), never data. */
function go(path, state = null) {
  history.pushState(state, '', path);
  render();
}

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
    else if (path === '/reports') await reportsPage(main);
    else if (path === '/statements') await statementsPage(main);
    else if (path === '/rates') await ratesPage(main);
    else if (path === '/retention') await retentionPage(main);
    else if (path === '/users') await usersPage(main);
    else if (path === '/support') await supportPage(main);
    else if (path === USER_OPEN_PATH) await userPage(main);
    else if (/^\/users\/(email|google)\//u.test(path)) {
      // The old detail path held the sub (before D410): this entry is rewritten to the search, and nothing is read.
      history.replaceState(null, '', '/users');
      renderNav();
      await usersPage(main);
    }
    else main.append(h('h1', {}, 'Not found'), link('/orgs', 'Organisations'));
  } catch (err) {
    main.append(errorBox(err));
  }
}

render();
