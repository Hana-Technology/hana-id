// Fake data for the admin SPA's local preview (test-spa/preview.ts): every screen filled with believable rows, shaped
// as the admin Worker answers them (docs/api.md "Admin Worker"). Nothing here is real: every address is on a reserved
// `.example` domain, every key, hash and id is made up. Times are relative to the moment the preview starts.

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => NOW - ms;

export const me = {
  email: 'tze@hana.example',
  sub: 'access-sub-1',
  env: 'sandbox-dev',
  consoleOrigin: 'https://console.sandbox-dev.hana.example',
  // The "Register a scope" panel's manifest values (GET /api/me `scopeRegistration`): a council owner, a dev env.
  scopeRegistration: {
    ownerKind: 'sputnik',
    owner: 'hana-id-council-dev1.sputnikv2.testnet',
    councilMembers: ['hana-id-council-a-dev1.testnet', 'hana-id-council-b-dev1.testnet', 'hana-id-council-c-dev1.testnet'],
    devCouncilKeys: true,
    sharedClientIds: ['875896396522-previewsharedclient00000000000.apps.googleusercontent.com'],
  },
};

export const orgs = [
  { id: 'org_legacy', name: 'Legacy apps', kind: 'internal', status: 'active', createdAt: ago(240 * DAY) },
  { id: 'org_01jc8lumenpay', name: 'Lumen Pay', kind: 'partner', status: 'active', createdAt: ago(21 * DAY) },
  { id: 'org_01jd2kestrel', name: 'Kestrel Wallet', kind: 'partner', status: 'active', createdAt: ago(9 * DAY) },
  { id: 'org_01jd9saltmarsh', name: 'Saltmarsh Games', kind: 'partner', status: 'frozen', createdAt: ago(5 * DAY) },
  { id: 'org_01jb0hanaint', name: 'Hana internal', kind: 'internal', status: 'active', createdAt: ago(60 * DAY) },
  // Onboarding (the "Register a scope" panel's states): invited, not accepted yet; and owners in, no scope yet.
  { id: 'org_01jdorbit', name: 'Orbit Labs', kind: 'partner', status: 'active', createdAt: ago(2 * HOUR) },
  { id: 'org_01jdcorvid', name: 'Corvid Pay', kind: 'partner', status: 'active', createdAt: ago(DAY) },
];

/**
 * GET /api/invites/new-orgs (D696): invites to organisations not created yet, one of each state the "Pending invites"
 * panel says (open first, then the newest), as the console's `newOrgInvites` answers them.
 */
const newOrgInvite = (id: string, newOrgName: string, newOrgKind: 'partner' | 'internal', email: string, created: number, extra: Record<string, unknown> = {}) => ({
  id,
  email,
  newOrgName,
  newOrgKind,
  role: 'owner',
  createdByKind: 'hana',
  createdBy: 'access-sub-1',
  createdAt: ago(created),
  expiresAt: ago(created) + 7 * DAY,
  ...extra,
});
export const newOrgInvites = {
  invites: [
    newOrgInvite('inv_01jdtidepool', 'Tidepool Finance', 'partner', 'mira.okafor@tidepool.example', 3 * MIN),
    newOrgInvite('inv_01jdhanaqa', 'Hana QA', 'internal', 'qa-lead@hana.example', 3 * HOUR, { notifiedAt: ago(3 * HOUR - 4 * MIN) }),
    newOrgInvite('inv_01jdcorvid', 'Corvid Pay', 'partner', 'kai.berg@corvidpay.example', 2 * DAY, { notifiedAt: ago(2 * DAY - 5 * MIN), acceptedAt: ago(DAY), acceptedUserId: 'usr_01jdcorvkai' }),
    newOrgInvite('inv_01jdheron', 'Heron Labs', 'partner', 'sam.lee@heron.example', 6 * DAY, { notifiedAt: ago(6 * DAY - 3 * MIN), revokedAt: ago(5 * DAY) }),
    newOrgInvite('inv_01jcquill', 'Quill Wallet', 'partner', 'ana.silva@quill.example', 12 * DAY, { notifiedAt: ago(12 * DAY - 4 * MIN) }),
  ],
  truncated: false,
};

const member = (userId: string, email: string, role: 'owner' | 'viewer', since: number, extra: Record<string, unknown> = {}) => ({ userId, sub: `g-${userId}`, email, role, roleSince: ago(since), disabled: false, ...extra });

export const orgDetail: Record<string, unknown> = {
  org_legacy: {
    org: orgs[0],
    members: [],
    invites: [],
    grants: [],
    securityContacts: ['security@hana.example'],
    apps: [
      { id: 'app_01h7wend', name: 'Wend widget demo', scopeId: 's8f2c1a9e4b7d3', environment: 'test', deleted: false, suspendedBy: 0, activeOrigins: 2, pendingChanges: 0 },
      { id: 'app_01h7wendlive', name: 'Wend widget', scopeId: 's8f2c1a9e4b7d4', environment: 'live', deleted: false, suspendedBy: 0, activeOrigins: 1, pendingChanges: 0 },
      { id: 'app_01h9tidepool', name: 'Tidepool checkout', scopeId: 's3b9e07c55a1f2', environment: 'test', deleted: false, suspendedBy: 2, activeOrigins: 1, pendingChanges: 0 },
      { id: 'app_01h9tideold', name: 'Tidepool (old)', scopeId: 's3b9e07c55a1f2', environment: 'test', deleted: true, suspendedBy: 0, activeOrigins: 0, pendingChanges: 0 },
    ],
    flags: { noSecurityContacts: false, ownersNotContacts: [] },
  },
  org_01jc8lumenpay: {
    org: orgs[1],
    members: [
      member('usr_01jc8aisyah', 'aisyah.rahman@lumenpay.example', 'owner', 20 * DAY),
      member('usr_01jc9daniel', 'daniel.okafor@lumenpay.example', 'viewer', 12 * DAY, { pendingOwnerFrom: NOW + 2 * DAY }),
      member('usr_01jcamei', 'mei.tanaka@lumenpay.example', 'viewer', 6 * DAY, { disabled: true }),
    ],
    invites: [
      { id: 'inv_01jdq3priya', email: 'priya.nair@lumenpay.example', role: 'viewer', createdAt: ago(2 * HOUR), notifiedAt: ago(2 * HOUR - 4 * MIN), expiresAt: NOW + 7 * DAY, acceptedAt: null, revokedAt: null },
      { id: 'inv_01jdk9tom', email: 'tom.becker@lumenpay.example', role: 'owner', createdAt: ago(3 * MIN), notifiedAt: null, expiresAt: NOW + 7 * DAY, acceptedAt: null, revokedAt: null },
      { id: 'inv_01jc8aisyah', email: 'aisyah.rahman@lumenpay.example', role: 'owner', createdAt: ago(21 * DAY), notifiedAt: ago(21 * DAY), expiresAt: ago(14 * DAY), acceptedAt: ago(20 * DAY), revokedAt: null },
    ],
    grants: [
      { id: 'grt_01jdc2daniel', userId: 'usr_01jc9daniel', inviteId: null, grantedByKind: 'member', grantedBy: 'aisyah.rahman@lumenpay.example', notifiedAt: ago(DAY), ownerFrom: NOW + 2 * DAY },
      { id: 'grt_01jdk9tom', userId: null, inviteId: 'inv_01jdk9tom', grantedByKind: 'hana', grantedBy: 'tze@hana.example', notifiedAt: null, ownerFrom: null },
    ],
    securityContacts: ['aisyah.rahman@lumenpay.example', 'secops@lumenpay.example'],
    apps: [
      { id: 'app_01jcblumen', name: 'Lumen Pay checkout', scopeId: 's5d1e8a0c2f6b9', environment: 'live', deleted: false, suspendedBy: 0, activeOrigins: 3, pendingChanges: 1 },
      { id: 'app_01jcblumentest', name: 'Lumen Pay checkout (test)', scopeId: 's5d1e8a0c2f6ba', environment: 'test', deleted: false, suspendedBy: 4, activeOrigins: 2, pendingChanges: 0 },
    ],
    flags: { noSecurityContacts: false, ownersNotContacts: [] },
  },
  org_01jd2kestrel: {
    org: orgs[2],
    members: [member('usr_01jd2joao', 'joao.silva@kestrel.example', 'owner', 8 * DAY)],
    invites: [],
    grants: [],
    securityContacts: [],
    apps: [],
    flags: { noSecurityContacts: true, ownersNotContacts: ['joao.silva@kestrel.example'] },
  },
  org_01jd9saltmarsh: {
    org: orgs[3],
    members: [member('usr_01jd9ines', 'ines.moreau@saltmarsh.example', 'owner', 5 * DAY)],
    invites: [],
    grants: [],
    securityContacts: ['ines.moreau@saltmarsh.example'],
    apps: [{ id: 'app_01jd9tiles', name: 'Saltmarsh Tiles', scopeId: 's0a7c3e9d1b5f8', environment: 'test', deleted: false, suspendedBy: 1, activeOrigins: 1, pendingChanges: 0 }],
    flags: { noSecurityContacts: false, ownersNotContacts: [] },
  },
  org_01jb0hanaint: {
    org: orgs[4],
    members: [member('usr_01jb0tze', 'tze@hana.example', 'owner', 60 * DAY), member('usr_01jb0nadia', 'nadia@hana.example', 'owner', 58 * DAY)],
    invites: [],
    grants: [],
    securityContacts: ['security@hana.example'],
    apps: [{ id: 'app_01jb0demo', name: 'Hana demo', scopeId: 's9e4a1c7b3d2f0', environment: 'test', deleted: false, suspendedBy: 0, activeOrigins: 2, pendingChanges: 0 }],
    flags: { noSecurityContacts: false, ownersNotContacts: [] },
  },
};

orgDetail.org_01jdorbit = {
  org: orgs[5],
  members: [],
  invites: [{ id: 'inv_01jdorbitlena', email: 'lena.fischer@orbitlabs.example', role: 'owner', createdAt: ago(2 * HOUR), notifiedAt: ago(2 * HOUR - 4 * MIN), expiresAt: NOW + 7 * DAY, acceptedAt: null, revokedAt: null }],
  grants: [{ id: 'grt_01jdorbitlena', userId: null, inviteId: 'inv_01jdorbitlena', grantedByKind: 'hana', grantedBy: 'tze@hana.example', notifiedAt: null, ownerFrom: null }],
  securityContacts: [],
  apps: [],
  flags: { noSecurityContacts: true, ownersNotContacts: [] },
};
orgDetail.org_01jdcorvid = {
  org: orgs[6],
  members: [
    member('usr_01jdcorvsam', 'sam.ito@corvidpay.example', 'owner', DAY, { sub: '110248495921238986420' }),
    member('usr_01jdcorvrui', 'rui.costa@corvidpay.example', 'owner', 20 * HOUR, { sub: '104857739201938475610' }),
    member('usr_01jdcorvada', 'ada.obi@corvidpay.example', 'viewer', 3 * HOUR, { sub: '117730021948573629104', pendingOwnerFrom: NOW + 21 * HOUR }),
  ],
  invites: [{ id: 'inv_01jdcorvkai', email: 'kai.berg@corvidpay.example', role: 'owner', createdAt: ago(HOUR), notifiedAt: ago(HOUR - 4 * MIN), expiresAt: NOW + 7 * DAY, acceptedAt: null, revokedAt: null }],
  grants: [],
  securityContacts: ['sam.ito@corvidpay.example', 'rui.costa@corvidpay.example'],
  apps: [],
  flags: { noSecurityContacts: false, ownersNotContacts: [] },
};

export const orgChanges = (orgId: string) => ({
  changes:
    orgId === 'org_01jc8lumenpay'
      ? [
          { seq: 412, at: ago(40 * MIN), kind: 'change.proposed', appId: 'app_01jcblumen', actorKind: 'member', actorId: 'usr_01jc8aisyah', detail: { kind: 'origin_add', origin: 'https://pay.lumenpay.example' } },
          { seq: 398, at: ago(DAY), kind: 'key.created', appId: 'app_01jcblumen', actorKind: 'member', actorId: 'usr_01jc8aisyah', detail: { keyId: 'key_01jdb7' } },
          { seq: 377, at: ago(4 * DAY), kind: 'app.suspended', appId: 'app_01jcblumentest', actorKind: 'member', actorId: 'usr_01jc8aisyah', detail: { bit: 4 } },
          { seq: 301, at: ago(19 * DAY), kind: 'app.created', appId: 'app_01jcblumen', actorKind: 'hana', actorId: 'tze@hana.example', detail: { environment: 'live' } },
        ]
      : orgId === 'org_legacy'
        ? [{ seq: 12, at: ago(200 * DAY), kind: 'app.created', appId: 'app_01h7wend', actorKind: 'system', actorId: 'migration', detail: { from: 'hot_db' } }]
        : [],
});

export const appDetail = (orgId: string, appId: string) => {
  const live = appId === 'app_01jcblumen';
  return {
    app: {
      id: appId,
      orgId,
      name: live ? 'Lumen Pay checkout' : 'Wend widget demo',
      scopeId: live ? 's5d1e8a0c2f6b9' : 's8f2c1a9e4b7d3',
      environment: live ? 'live' : 'test',
      suspendedBy: 0,
      deleted: false,
      originsVersion: 7,
      settingsVersion: 3,
      origins: [
        { origin: 'https://checkout.lumenpay.example', display: 'https://checkout.lumenpay.example', idn: false, activeFrom: ago(18 * DAY) },
        { origin: 'https://app.lumenpay.example', display: 'https://app.lumenpay.example', idn: false, activeFrom: ago(10 * DAY) },
        { origin: 'https://xn--lumnpay-b1a.example', display: 'https://lumėnpay.example', idn: true, activeFrom: ago(2 * DAY) },
        { origin: 'https://pay.lumenpay.example', display: 'https://pay.lumenpay.example', idn: false, activeFrom: null },
      ],
      changes: [
        { id: 'chg_01jdq1pay', kind: 'origin_add', origin: 'https://pay.lumenpay.example', status: 'pending', proposedAt: ago(40 * MIN), proposedByKind: 'member', proposedBy: 'aisyah.rahman@lumenpay.example', notifiedAt: ago(36 * MIN), activeFrom: NOW + 47 * HOUR },
        { id: 'chg_01jd7raw', kind: 'raw_sign_on', status: 'cancelled', proposedAt: ago(6 * DAY), proposedByKind: 'member', proposedBy: 'aisyah.rahman@lumenpay.example', notifiedAt: ago(6 * DAY), activeFrom: null },
        { id: 'chg_01jcz2app', kind: 'origin_add', origin: 'https://app.lumenpay.example', status: 'active', proposedAt: ago(12 * DAY), proposedByKind: 'hana', proposedBy: 'tze@hana.example', notifiedAt: ago(12 * DAY), activeFrom: ago(10 * DAY) },
      ],
      settings: {
        rawSign: 'off',
        persistence: 'session',
        policy: { v: 1, label: 'Small payments', maxConsentMs: 2_592_000_000, limits: { perDayCount: 20 }, stellar: { maxAmount: '50' } },
      },
      keys: [
        { id: 'key_01jdb7', key: 'pk_live_previewfakekey000001', createdAt: ago(DAY), createdBy: 'aisyah.rahman@lumenpay.example', revokedAt: null },
        { id: 'key_01jcb1', key: 'pk_live_previewfakekey000002', createdAt: ago(19 * DAY), createdBy: 'tze@hana.example', revokedAt: NOW + 6 * DAY },
        { id: 'key_01jcb0', key: 'pk_live_previewfakekey000003', createdAt: ago(20 * DAY), createdBy: 'tze@hana.example', revokedAt: ago(19 * DAY) },
      ],
    },
  };
};

export const audit = (orgFilter: string | null) => ({
  rows: [
    { seq: 9013, at: ago(12 * MIN), action: 'support.lookup', orgId: null, appId: null, actorKind: 'hana', actorEmail: 'tze@hana.example', actorId: 'access-sub-1', target: null, outcome: 'ok', requestId: 'req_7f3a91c2', details: { ticket: 'ZD-4127', requestIds: 2 } },
    { seq: 9011, at: ago(2 * HOUR), action: 'invite.issue', orgId: 'org_01jc8lumenpay', appId: null, actorKind: 'member', actorEmail: 'aisyah.rahman@lumenpay.example', actorId: 'usr_01jc8aisyah', target: 'inv_01jdq3priya', outcome: 'ok', requestId: 'req_2b81d0e4', details: { role: 'viewer' } },
    { seq: 9004, at: ago(5 * HOUR), action: 'member.role', orgId: 'org_01jc8lumenpay', appId: null, actorKind: 'member', actorEmail: 'aisyah.rahman@lumenpay.example', actorId: 'usr_01jc8aisyah', target: 'usr_01jc9daniel', outcome: 'ok', requestId: 'req_c09e7713', details: { role: 'owner', grant: 'grt_01jdc2daniel' } },
    { seq: 8990, at: ago(DAY), action: 'org.freeze', orgId: 'org_01jd9saltmarsh', appId: null, actorKind: 'hana', actorEmail: 'nadia@hana.example', actorId: 'access-sub-2', target: null, outcome: 'ok', requestId: 'req_0d4be5a6', details: { frozen: true } },
    { seq: 8987, at: ago(DAY + 3 * MIN), action: 'session.step_up', orgId: 'org_01jd9saltmarsh', appId: null, actorKind: 'member', actorEmail: 'ines.moreau@saltmarsh.example', actorId: 'usr_01jd9ines', target: null, outcome: 'failed', requestId: 'req_51aa3c09', details: { code: 'step_up_expired' } },
  ],
  next: 'cur_8987',
  changes: orgFilter ? orgChanges(orgFilter).changes : undefined,
  directory: {
    rows: [
      { id: 3311, atMs: ago(12 * MIN), staff: 'tze@hana.example', action: 'support_lookup', ticket: 'ZD-4127', scopeId: 's5d1e8a0c2f6b9', subject: 'google 1158…', detail: { rows: 2 } },
      { id: 3309, atMs: ago(3 * HOUR), staff: 'nadia@hana.example', action: 'user_search', ticket: null, scopeId: null, subject: null, detail: { term: 'hmac:9c1e…', rows: 4 } },
      { id: 3302, atMs: ago(26 * HOUR), staff: 'tze@hana.example', action: 'user_view', ticket: 'ZD-4101', scopeId: null, subject: 'email e1.k3…', detail: null },
    ],
  },
});

export const security = {
  notices: {
    changes: [{ changeId: 'chg_01jdq1pay', kind: 'origin_add', appId: 'app_01jcblumen', orgId: 'org_01jc8lumenpay', proposedAt: ago(4 * MIN), contacts: 2 }],
    members: [{ kind: 'invite', id: 'inv_01jdk9tom', orgId: 'org_01jc8lumenpay', createdAt: ago(3 * MIN) }],
  },
  feed: {
    app_changes: { cursor: 412, updatedAt: ago(4 * MIN), lagMs: 0 },
    security_events: { cursor: 88, updatedAt: ago(4 * MIN), lagMs: 0 },
    console_audit: { cursor: 9013, updatedAt: ago(9 * MIN), lagMs: 6 * MIN },
  },
  watcher: { cursor: 's5d1e8a0c2f6b9', updatedAt: ago(4 * MIN) },
  lastRun: { at: ago(4 * MIN), ms: 2140, calls: 17, notices: { sent: 1, failed: 0 }, feed: { sent: 3 }, watcher: { scopes: 12, alerts: 0 } },
  unnotifiedEvents: [{ id: 'sev_01jdq4', detectedAt: ago(6 * MIN), kind: 'drift', orgId: 'org_01jc8lumenpay', appId: 'app_01jcblumen', scopeId: 's5d1e8a0c2f6b9', detail: { origin: 'https://xn--lumnpay-b1a.example' } }],
  ledger: {
    relayerAccountSet: true,
    partitionsLow: false,
    partitionsAhead: 3,
    settlementBacklog: { pending: 4, oldestAt: ago(22 * MIN) },
    nonceChecks: [
      { relayerPk: 'ed25519:8sY1nVq4Zt2b…Kq7', checkedAt: ago(5 * HOUR), chainNonce: '184467440737', explained: true, ledgerRelayedSinceLast: 211, alertedAt: null },
      { relayerPk: 'ed25519:3Fh8wLr6Pm0c…Xd2', checkedAt: ago(5 * HOUR), chainNonce: '184467440512', explained: true, ledgerRelayedSinceLast: 198, alertedAt: null },
    ],
    rejectionAlerts: [{ orgId: 'org_01jc8lumenpay', day: new Date(ago(DAY)).toISOString().slice(0, 10), relayed: 1437, rejected: 61, alertedAt: ago(20 * HOUR) }],
    settlementAlerts: [],
  },
};

const alert = (id: number, severity: string, kind: string, title: string, created: number, extra: Record<string, unknown> = {}) => ({
  id,
  severity,
  kind,
  title,
  createdAt: ago(created),
  open: true,
  resolvedAt: null,
  resendsUntilAck: severity === 'critical',
  sendCount: severity === 'critical' ? 14 : 1,
  lastSentAt: ago(7 * MIN),
  ackedAt: null,
  ackedBy: null,
  ackedVia: null,
  playbook: { id: 'updater-key-changed', title: 'Updater key changed' },
  canAck: severity === 'critical',
  details: { kid: 'f3a1…', account: 'hana-signer' },
  deliveries: [{ channel: 'email', at: ago(7 * MIN), ok: true }],
  deliveriesTotal: 14,
  deliveriesLatest: [{ channel: 'email', at: ago(7 * MIN), ok: true }],
  ...extra,
});

export const alerts = {
  alerts: [
    alert(11, 'critical', 'updater_key_changed', 'An updater key on the signer changed', 3 * DAY + 4 * HOUR),
    alert(9, 'warning', 'relayer_funds_low', 'Relayer pool below 40 NEAR', 2 * DAY, { open: false, resolvedAt: ago(DAY), playbook: { id: 'relayer-funds-low', title: 'Relayer funds low' }, canAck: false }),
    alert(7, 'info', 'kid_seen', 'Google published a new signing key', 6 * DAY, { open: false, resolvedAt: ago(5 * DAY), playbook: null, canAck: false }),
  ],
  nextCursor: null,
};

export const monitoring = {
  env: 'sandbox-dev',
  now: NOW,
  findings: [
    { severity: 'critical', source: 'watchdog', text: 'Alert #11 is open and not acknowledged: an updater key on the signer changed.', playbook: { id: 'updater-key-changed', title: 'Updater key changed' } },
    { severity: 'warning', source: 'governance', text: 'A contract upgrade is queued: it can be executed in 2 days.', playbook: { id: 'contract-upgrade', title: 'Contract upgrade queued' } },
  ],
  watchdog: {
    ok: true,
    silent: false,
    sinceLastRunMs: 3 * MIN,
    runIntervalMs: 5 * MIN,
    env: 'sandbox-dev',
    watchdogAccount: 'hana-watchdog.sandbox-dev.testnet',
    network: 'testnet',
    lastRun: { id: 48211, finishedAt: ago(3 * MIN), outcome: 'ok' },
    heartbeat: { configured: true, ok: true, last_ok_at: ago(3 * MIN) },
    channels: { email: { configured: true }, telegram: { configured: false } },
    checks: [
      { id: 'updater_keys', known: true, title: 'Updater keys match the signer', outcome: 'alert', detail: '1 key differs (#11)', shownIn: 'Contract governance' },
      { id: 'pause_state', known: true, title: 'Contract not paused', outcome: 'ok', detail: '', shownIn: 'Contract governance' },
      { id: 'relayer_funds', known: true, title: 'Relayer pool funded', outcome: 'ok', detail: '212.4 NEAR across 2 keys', shownIn: 'Relayer funds' },
      { id: 'jwks_sync', known: true, title: "Google's keys match the contract", outcome: 'ok', detail: '', shownIn: 'Seen kids' },
    ],
    openAlerts: [alert(11, 'critical', 'updater_key_changed', 'An updater key on the signer changed', 3 * DAY + 4 * HOUR)],
    seenKids: [
      { provider: 'google', kid: 'a8b3c1f09d…', source: 'jwks', firstSeenAt: ago(30 * DAY), lastSeenAt: ago(3 * MIN) },
      { provider: 'google', kid: '5e2d7a4c11…', source: 'contract', firstSeenAt: ago(6 * DAY), lastSeenAt: ago(3 * MIN) },
    ],
    relayerFunds: { totalNear: '212.4', keys: 2, lowWaterNear: '40' },
    email: { pinsMatch: true, issuerKids: 1 },
    identity: { keys: 1, match: true },
    linkStats: { last24h: { started: 31, completed: 29 } },
    alertKinds: [
      { kind: 'updater_key_changed', severity: 'critical', check: 'updater_keys', description: 'An access key on the signer account that the updater uses was added, removed or changed.', playbook: { id: 'updater-key-changed', title: 'Updater key changed' } },
      { kind: 'relayer_funds_low', severity: 'warning', check: 'relayer_funds', description: 'The relayer pool is below its low-water mark.', playbook: { id: 'relayer-funds-low', title: 'Relayer funds low' } },
      { kind: 'kid_seen', severity: 'info', check: 'jwks_sync', description: 'A new Google signing key appeared.', playbook: null },
    ],
  },
  governance: {
    ok: true,
    readAtMs: ago(MIN),
    stateVersion: 37,
    pause: { paused: false, unpausedAtMs: ago(40 * DAY), lastWatchdogPause: null },
    keyChanges: [{ id: 4, provider: 'google', kid: '5e2d7a4c11…', op: 'add', by: 'hana-updater.sandbox-dev.testnet', executableAtMs: NOW + 20 * HOUR, jwks: 'published', watchdogSeen: { firstSeenAt: ago(6 * DAY) } }],
    pendingUpgrade: { codeHash: '9QhF3x…kL2p', executableAtMs: NOW + 2 * DAY + 3 * HOUR },
    pendingOwner: null,
    pendingWithdrawal: null,
    delays: {},
    pendingConsoleAudiences: [],
    updaterKeyCheck: [
      { publicKey: 'ed25519:Gq7P…3mVa', onAccount: true, permissionOk: true },
      { publicKey: 'ed25519:Bx2L…9wQe', onAccount: false, permissionOk: null },
    ],
    otherSignerKeys: [{ publicKey: 'ed25519:Zt5N…1cRk', kind: 'full_access', receiverId: null, methodNames: [] }],
    watchdogs: [{ accountId: 'hana-watchdog.sandbox-dev.testnet', confirmFromMs: ago(30 * DAY), canConfirm: true }],
    updater: { lastRunAt: ago(9 * MIN), proposed: 0, executed: 1 },
  },
  events: {
    ok: true,
    events: [{ id: 'sev_01jdq4', detectedAt: ago(6 * MIN), kind: 'drift', orgId: 'org_01jc8lumenpay', appId: 'app_01jcblumen', scopeId: 's5d1e8a0c2f6b9', notifiedAt: null, detail: { origin: 'https://xn--lumnpay-b1a.example' } }],
  },
};

export const actions = {
  actions: [{ id: 3, at: ago(40 * DAY), method: 'confirm_issuer_key', reason: 'kid seen in JWKS for 24 h', ok: true, error: null, txHash: '7yQm3K…aP9d', txUrl: 'https://testnet.nearblocks.io/txns/7yQm3K', args: { provider: 'google', kid: 'a8b3c1f09d…' } }],
  nextCursor: null,
};

export const pendingUpgrades = {
  pendingUpgrades: {
    signer: 'hana-signer.sandbox-dev.testnet',
    env: 'sandbox-dev',
    readAtMs: ago(MIN),
    governanceDelayMs: 3 * DAY,
    paused: false,
    anyPending: true,
    upgrade: {
      codeHash: '9QhF3xVb2mT8yW1nR5kD7aZ4cE6pL0sJ3uH9gQ2kL2p',
      proposedAtMs: ago(DAY - 3 * HOUR),
      executableAtMs: NOW + 2 * DAY + 3 * HOUR,
      release: { version: '0.9.2', commit: '4c278803b1f2', buildCommand: 'cargo near build reproducible-wasm --manifest-path contracts/hana-signer/Cargo.toml', diffCommand: 'git diff v0.9.1..4c278803b1f2 -- contracts/hana-signer' },
    },
    ownerTransfer: null,
    withdrawal: null,
    delayDecreases: [],
    consoleAudienceAdditions: [],
  },
};

const month = new Date(NOW).toISOString().slice(0, 7);
const prevMonth = new Date(Date.UTC(new Date(NOW).getUTCFullYear(), new Date(NOW).getUTCMonth() - 1, 1)).toISOString().slice(0, 7);

export const reports = {
  rows: [
    { period: `${month}-03`, appId: 'app_01jcblumen', scopeId: 's5d1e8a0c2f6b9', logins: 1284, derives: 3170, ownerActions: 0, linkActions: 12, identityTokens: 402, activeUsers: 611, newUsers: 87, tgas: '18432.7', relayedRejectedTgas: '211.4', errorTgas: '3.1', burntYocto: '1843270000000000000000', usdMicros: '4718', p50: { login: 812 }, p95: { login: 2290 }, failuresByCode: { mpc_timeout: 3, google_token_invalid: 11 }, unsettled: 0, afterStatement: 0 },
    { period: `${month}-04`, appId: 'app_01jcblumen', scopeId: 's5d1e8a0c2f6b9', logins: 1391, derives: 3402, ownerActions: 0, linkActions: 9, identityTokens: 455, activeUsers: 640, newUsers: 64, tgas: '19877.0', relayedRejectedTgas: '98.2', errorTgas: '0', burntYocto: '1987700000000000000000', usdMicros: '5089', p50: { login: 790 }, p95: { login: 2104 }, failuresByCode: { google_token_invalid: 7 }, unsettled: 4, afterStatement: 0 },
    { period: `${month}-04`, appId: null, scopeId: 's5d1e8a0c2f6b9', logins: 0, derives: 0, ownerActions: 2, linkActions: 0, identityTokens: 0, activeUsers: null, newUsers: 0, tgas: '14.2', relayedRejectedTgas: '0', errorTgas: '0', burntYocto: '1420000000000000000', usdMicros: '4', p50: {}, p95: {}, failuresByCode: {}, unsettled: 0, afterStatement: 0 },
  ],
};

export const statement = (org: string, m: string) =>
  m === prevMonth && org === 'org_01jc8lumenpay'
    ? {
        statement: { csvSha256: 'b41f0c9e2a7d3e18f5c6a0b9d2e47f1c8a3b6d5e9f0a1c2b3d4e5f60718293a4', issuedAt: ago(3 * DAY), issuedBy: 'tze@hana.example', pdfSha256: '0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d', asOf: ago(3 * DAY) },
        view: {
          title: `Lumen Pay: usage statement for ${m}`,
          header: [
            ['Organisation', 'Lumen Pay (org_01jc8lumenpay)'],
            ['Period', `${m}-01 to the month's end (UTC)`],
            ['Network', 'testnet'],
          ],
          tableColumns: ['Logins', 'Derives', 'Tgas', 'NEAR', 'USD'],
          table: [
            { label: 'Lumen Pay checkout (app_01jcblumen)', cells: ['38 412', '94 106', '551 203.9', '55.1204', '141.11'] },
            { label: 'Owner actions (s5d1e8a0c2f6b9)', cells: ['0', '0', '61.0', '0.0061', '0.02'] },
          ],
          summary: [
            ['Total gas', '551 264.9 Tgas'],
            ['Billed NEAR', '55.1265'],
            ['Billed USD', '141.13'],
          ],
          notes: ['Testnet usage is valued at the mainnet NEAR/USD rate of each day.'],
        },
      }
    : { statement: null, view: null, issuableFrom: Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 3), blockers: { pending: m === month ? 4 : 0, missingRateDays: m === month ? [] : [`${m}-14`] } };

export const statements = (org: string) => ({ statements: org === 'org_01jc8lumenpay' ? [{ month: prevMonth, asOf: ago(3 * DAY), csvSha256: 'b41f0c9e2a7d3e18f5c6a0b9d2e47f1c8a3b6d5e9f0a1c2b3d4e5f60718293a4', issuedAt: ago(3 * DAY), issuedBy: 'tze@hana.example' }] : [] });

export const rates = (m: string) => {
  const days = Array.from({ length: 6 }, (_, k) => `${m}-${String(k + 1).padStart(2, '0')}`);
  return {
    missing: m === month ? [] : [`${m}-14`],
    rates: days.map((day, k) => ({ day, usdMicros: String(2_561_200 + k * 13_417), source: k === 2 ? 'override' : 'coingecko', enteredBy: k === 2 ? 'nadia@hana.example' : null, fetchedAt: Date.parse(`${day}T00:07:00Z`) })),
    overrides: [{ at: ago(2 * DAY), day: days[2], usdMicros: '2588034', previousUsdMicros: '2588100', previousSource: 'coingecko', enteredBy: 'nadia@hana.example', reason: 'CoinGecko price was stale for this day (cached from the previous day)' }],
  };
};

export const retention = {
  warning: null,
  month,
  state: 'done',
  dueAt: Date.parse(`${month}-01T01:00:00Z`),
  nextRunAt: Date.UTC(new Date(NOW).getUTCFullYear(), new Date(NOW).getUTCMonth() + 1, 1, 1),
  due: { statements: 0, rates: 0, rateOverrides: 0, oldestStatement: null },
  runs: [
    { id: 6, month, startedAt: Date.parse(`${month}-01T01:00:12Z`), finishedAt: Date.parse(`${month}-01T01:00:41Z`), status: 'ok', rows: { calls: 23, uidsStripped: 1840, nonceChecksDeleted: 12, scopeWatchDeleted: 340, userEventsExpired: 3 }, error: null },
    { id: 5, month: prevMonth, startedAt: Date.parse(`${prevMonth}-01T01:00:09Z`), finishedAt: Date.parse(`${prevMonth}-01T01:15:30Z`), status: 'partial', rows: { calls: 40, uidsStripped: 9120 }, error: null },
  ],
  erasures: [{ at: ago(12 * DAY), ticket: 'ZD-3988', operator: 'nadia@hana.example', scopeId: 's5d1e8a0c2f6b9', rows: { events: 412, app_users: 1, directory: 1 } }],
};

const dirRow = (provider: string, sub: string, email: string, extra: Record<string, unknown> = {}) => ({ provider, sub, email, emailVerified: true, hosted: provider === 'google' ? false : null, unverifiedClaim: false, appCount: 1, firstSeenMs: ago(20 * DAY), lastSeenMs: ago(3 * HOUR), ...extra });

export const userSearch = {
  users: [
    dirRow('google', '115829304712230984411', 'farah.aziz@gmail.example', { appCount: 2, name: { givenName: 'Farah', familyName: 'Aziz' } }),
    dirRow('email', 'e1.k3m9q2', 'farah.aziz@lumenpay.example', { name: { givenName: 'Farah', familyName: null } }),
    dirRow('google', '109227410063392001857', 'farah.a@workmail.example', { emailVerified: false, unverifiedClaim: true, lastSeenMs: ago(9 * DAY), name: null }),
  ],
  unverifiedWarning: 'UNVERIFIED: this Google account claims the address but Google hasn’t verified it; don’t treat it as the owner',
};

export const walletUser = {
  userId: 'u1_Qm7xK2pZ9rT4vW8nB3cD5e',
  supportId: 'HANA-2750-G5HM',
  internalId: 'hu_01jc9w4m8k2p6q0r3t5v7x9z1b',
  scopeId: 's5d1e8a0c2f6b9',
  orgId: 'org_01jc8lumenpay',
  createdAt: ago(18 * DAY),
  lastSeenAt: ago(3 * HOUR),
  identities: [
    { provider: 'google', sub: '115829304712230984411', identityKey: 'ab'.repeat(32), role: 'root', status: 'active', effectiveAt: null, firstSeenAt: ago(18 * DAY), observedAt: ago(3 * HOUR), directoryKey: { provider: 'google', sub: '115829304712230984411' }, name: { givenName: 'Farah', familyName: 'Aziz' } },
    { provider: 'email', sub: 'e1.k3m9q2', identityKey: 'cd'.repeat(32), role: 'member', status: 'active', effectiveAt: ago(10 * DAY), firstSeenAt: ago(11 * DAY), observedAt: ago(DAY), directoryKey: { provider: 'email', sub: 'e1.k3m9q2' }, name: { givenName: 'Farah', familyName: null } },
  ],
  name: { givenName: 'Farah', familyName: 'Aziz' },
  wallets: [
    { chain: 'stellar', address: 'GCFX7TQ2M4LJZ5W3R6N8K1B9H0V2D4S6A8E3Y5U7I9O1P3Q5R7T9V2X4', keyIndex: 0, firstSeenAt: ago(18 * DAY), lastUsedAt: ago(3 * HOUR), sharedWith: 0 },
    { chain: 'evm', address: '0x5aE3c1B9f2D47a6E08c1d3B5f7A9e2C4d6F8b0A1', keyIndex: 0, firstSeenAt: ago(12 * DAY), lastUsedAt: ago(2 * DAY), sharedWith: 1 },
    { chain: 'near', address: 'a8f3c2d17e4b9056c1d2e3f40718293a4b5c6d7e8f9012a3b4c5d6e7f8091a2b', keyIndex: 0, firstSeenAt: ago(3 * HOUR), lastUsedAt: ago(3 * HOUR), sharedWith: 0 },
  ],
};

export const userGet = (provider: string, sub: string) => ({
  provider,
  sub,
  user: userSearch.users.find((u) => u.sub === sub) ?? null,
  name: (userSearch.users.find((u) => u.sub === sub) as { name?: unknown } | undefined)?.name ?? null,
  apps: [
    { appId: 'app_01jcblumen', name: 'Lumen Pay checkout', deletedAt: null, orgId: 'org_01jc8lumenpay', environment: 'live', scopeId: 's5d1e8a0c2f6b9', firstSeenMs: ago(18 * DAY), lastSeenMs: ago(3 * HOUR) },
    { appId: 'app_01h7wend', name: 'Wend widget demo', deletedAt: null, orgId: 'org_legacy', environment: 'test', scopeId: 's8f2c1a9e4b7d3', firstSeenMs: ago(40 * DAY), lastSeenMs: ago(30 * DAY) },
  ],
  walletUsers: [walletUser],
  chain: [
    { ok: true, scopeId: 's5d1e8a0c2f6b9', status: 'active', path: 'hana/s5d1e8a0c2f6b9/google/115829304712230984411', opened: true, identityKey: 'ab'.repeat(32), blockHeight: 184_220_731, account: { root: { provider: 'google', sub: '115829304712230984411' }, epoch: 2, members: [{ provider: 'email', sub: 'e1.k3m9q2', key: 'cd'.repeat(32), active: true, effectiveAtMs: ago(10 * DAY) }] } },
    { ok: false, scopeId: 's8f2c1a9e4b7d3', reason: 'not_read' },
  ],
});

export const supportLookup = (askedIds: number) => ({
  query: { kind: 'supportId', code: '2750G5HM' },
  since: ago(30 * DAY),
  days: 30,
  matches: [
    {
      user: walletUser,
      apps: [{ appId: 'app_01jcblumen', name: 'Lumen Pay checkout', orgId: 'org_01jc8lumenpay', environment: 'live', persistence: 'session', deletedAt: null }],
      shares: [{ appId: 'app_01jcblumen', keyIndex: 0, createdAt: ago(3 * HOUR), idleUntil: NOW + 21 * HOUR, absExpiresAt: NOW + 6 * DAY, revokedAt: null, live: true }],
      changes: orgChanges('org_01jc8lumenpay').changes.slice(0, 2),
    },
  ],
  truncated: false,
  ledger: { available: true },
  activity: [
    [
      { requestId: 'req_9a1c47e2', at: ago(3 * HOUR), appId: 'app_01jcblumen', endpoint: 'login', status: 200, latencyMs: 812, relayed: true, nearTx: '4mXq…8sTk' },
      { requestId: 'req_9a1c47f0', at: ago(3 * HOUR - 2000), appId: 'app_01jcblumen', endpoint: 'derive', status: 200, latencyMs: 1290, relayed: false, nearTx: null },
    ],
  ],
  requests: askedIds
    ? [
        { requestId: 'req_5d2e9b01', at: ago(4 * HOUR), orgId: 'org_01jc8lumenpay', appId: 'app_01jcblumen', scopeId: 's5d1e8a0c2f6b9', endpoint: 'derive', outcome: 'error', code: 'mpc_timeout', status: 503, latencyMs: 30_000, relayed: false, nearTx: null, byMatch: false },
        { requestId: 'req_9a1c47e2', at: ago(3 * HOUR), orgId: 'org_01jc8lumenpay', appId: 'app_01jcblumen', scopeId: 's5d1e8a0c2f6b9', endpoint: 'login', outcome: 'ok', code: null, status: 200, latencyMs: 812, relayed: true, nearTx: '4mXq…8sTk', byMatch: true },
      ]
    : null,
  requestsNotFound: askedIds > 2 ? ['req_00000000'] : [],
  emails: [
    { provider: 'google', sub: '115829304712230984411', found: true, email: 'farah.aziz@gmail.example', emailVerified: true, hosted: false, unverifiedClaim: false, firstSeenMs: ago(18 * DAY), lastSeenMs: ago(3 * HOUR) },
    { provider: 'email', sub: 'e1.k3m9q2', found: true, email: 'farah.aziz@lumenpay.example', emailVerified: true, hosted: null, unverifiedClaim: false, firstSeenMs: ago(11 * DAY), lastSeenMs: ago(DAY) },
  ],
});


// ---- email login (build plan batch 9): the Email issuer and Account links pages ----

const dayAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

export function emailIssuer(days: number) {
  const apps = ['app_01jdzlumen01', 'app_01jdzsora001'];
  const issuance = [0, 1, 2, 3, 4].flatMap((n) => [
    { day: dayAgo(n), appId: apps[0]!, purpose: 'session', count: 180 - n * 11 },
    { day: dayAgo(n), appId: apps[1]!, purpose: 'session', count: 74 - n * 4 },
    { day: dayAgo(n), appId: apps[0]!, purpose: 'link_new', count: 6 - n },
  ]);
  issuance.push({ day: dayAgo(2), appId: null as unknown as string, purpose: 'client_proof', count: 2 });
  const metrics = [0, 1, 2, 3, 4].flatMap((n) => [
    { day: dayAgo(n), appId: apps[0]!, metric: 'sent', count: 186 - n * 9 },
    { day: dayAgo(n), appId: apps[0]!, metric: 'bounced', count: n === 1 ? 5 : 1 },
    { day: dayAgo(n), appId: apps[1]!, metric: 'sent', count: 70 - n * 3 },
    { day: dayAgo(n), appId: null as unknown as string, metric: 'refused:ip:start:10m', count: 12 + n },
    { day: dayAgo(n), appId: apps[0]!, metric: 'refused:app:start:1d', count: n === 3 ? 41 : 0 },
  ]);
  metrics.push({ day: dayAgo(1), appId: apps[1]!, metric: 'complained', count: 2 });
  metrics.push({ day: dayAgo(0), appId: null as unknown as string, metric: 'alert:email_budget:global_50', count: 1 });
  metrics.push({ day: dayAgo(1), appId: apps[0]!, metric: 'alert:send_budget_exhausted:app', count: 3 });
  metrics.push({ day: dayAgo(2), appId: null as unknown as string, metric: 'alert:mailbox_guess_limit:backstop', count: 2 });
  return {
    days,
    appNames: { [apps[0]!]: 'Lumen Pay', [apps[1]!]: 'Sora Wallet' },
    stats: { days, truncated: false, issuance, metrics: metrics.filter((m) => m.count > 0) },
    policy: {
      required: 1,
      signers: ['hana'],
      iss: ['https://hana-id-email-issuer-sandbox.preview.invalid/v1/email'],
      pinsConfigured: true,
      matchesPins: true,
      keys: [
        { kid: 'g7cQ0QKkU1rVwwX2W1Jd7uL9HjM4bQmH5GmQj1RzY2w', signer: 'hana', onChain: true, pinned: true },
        { kid: 'b2mZ3kTpW8vN6yLqF1sDjHa4QcXuE0iOaR9lVnPgT7o', signer: 'hana', onChain: true, pinned: true },
      ],
    },
    kms: { signerKind: 'worker-secret' as const, note: 'The CloudTrail reconciliation, the AWS key age and the Sign volume and budget alarms apply once the issuer signs with AWS KMS (build plan batch 10).' },
  };
}

export function emailLinks(days: number) {
  const app = { appId: 'app_01jdzlumen01', appName: 'Lumen Pay', orgId: 'org_01jdzlumenx', environment: 'live' as const };
  const rows = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({ ...app, day: dayAgo(n), proposed: n === 0 ? 64 : 3 + (n % 3), linked: n === 0 ? 12 : 1, activated: 2 + (n % 2), cancelled: n === 2 ? 1 : 0, unlinked: n === 5 ? 2 : 0, auto: n === 0 ? 60 : 3, explicit: n === 0 ? 16 : 1 }));
  rows.push({ ...app, appId: 'app_01jdzsora001', appName: 'Sora Wallet', orgId: 'org_01jdzsorax', day: dayAgo(0), proposed: 1, linked: 0, activated: 0, cancelled: 0, unlinked: 0, auto: 1, explicit: 0 });
  return {
    days,
    today: dayAgo(0),
    rows,
    jumps: [
      { appId: 'app_01jdzlumen01', appName: 'Lumen Pay', today: 76, median: 4, jumped: true },
      { appId: 'app_01jdzsora001', appName: 'Sora Wallet', today: 1, median: 0, jumped: false },
    ],
  };
}
