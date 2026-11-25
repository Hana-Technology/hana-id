// D915: the staff app page for an app that shares a wallet. On a scope marked as shared, or for an app the platform
// created, the auto-approve row says it is off and there is no proposal form (Remove stays, as a kill switch); the
// "Shared wallet" row shows the scope's mark, and for an unmarked scope offers the one-way control behind a
// confirmation. An API from before migration 0026 (no fields) shows neither the row nor any change.
import { SHARED_WALLET_NO_AUTO_APPROVE } from '@hana-id/console-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Answer, type Call, SRC, boot, closeWindow } from './boot.ts';

afterEach(closeWindow);

const BASE = { id: 'app_pay', name: 'Lumen checkout', scopeId: 's_pay', environment: 'test', deleted: false, suspendedBy: 0, activeOrigins: 1, pendingChanges: 0, orgId: 'org_lumen', originsVersion: 1, settingsVersion: 4, origins: [], changes: [], keys: [] };
const SETTINGS = { rawSign: 'off', persistence: 'session', policy: null };

const ORG_APPS = [
  { id: 'app_pay', name: 'Lumen checkout', scopeId: 's_pay', environment: 'test', deleted: false },
  { id: 'app_pay2', name: 'Lumen rewards', scopeId: 's_pay', environment: 'test', deleted: false },
  { id: 'app_gone', name: 'Old demo', scopeId: 's_pay', environment: 'test', deleted: true },
  { id: 'app_other', name: 'Elsewhere', scopeId: 's_other', environment: 'test', deleted: false },
];

function api(app: Record<string, unknown>, write: (c: Call) => Answer = () => ({ body: { changed: true } }), org: () => Answer = () => ({ body: { org: { id: 'org_lumen', name: 'Lumen Pay' }, apps: ORG_APPS } })) {
  return (c: Call): Answer => {
    if (c.method !== 'GET') return write(c);
    if (c.path.startsWith('/api/apps/app_pay')) return { body: { app: { ...BASE, settings: SETTINGS, ...app } } };
    if (c.path === '/api/orgs/org_lumen') return org();
    if (c.path === '/api/orgs/org_lumen/changes') return { body: { changes: [] } };
    return { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };
  };
}

type Session = ReturnType<typeof boot>;
const rows = (s: Session) => [...s.main().querySelectorAll('.settings .jp-setting')].map((r) => ({ title: r.querySelector('b')!.textContent, text: r.querySelector('small')!.textContent, buttons: [...r.querySelectorAll('button')].filter((b) => !b.hidden).map((b) => b.textContent) }));
const row = (s: Session, title: string) => rows(s).find((r) => r.title === title);
const open = async (app: Record<string, unknown>, write?: (c: Call) => Answer, org?: () => Answer) => {
  const s = boot('/orgs/org_lumen/apps/app_pay', api(app, write, org));
  await vi.waitFor(() => expect(s.text()).toContain('Signing settings'));
  return s;
};

describe('the staff app page for an app that shares a wallet (D915)', () => {
  it('the SPA’s words are console-core’s', () => {
    expect(/const SHARED_WALLET_NO_AUTO_APPROVE = '([^']+)';/u.exec(SRC)![1]).toBe(SHARED_WALLET_NO_AUTO_APPROVE);
  });

  it('on a marked scope: auto-approve off, no proposal form; the scope shown as shared, with no control', async () => {
    const s = await open({ sharedScope: true, createdByKind: 'hana', sharedWallet: true });
    expect(row(s, 'Auto-approve policy')).toEqual({ title: 'Auto-approve policy', text: 'Auto-approve is off for apps that share a wallet: every signature asks the user.', buttons: [] });
    expect(row(s, 'Shared wallet')!.text).toBe('On: several partners’ apps share this scope’s wallet. Auto-approve is off for every app on it. This can’t be undone.');
    expect(row(s, 'Shared wallet')!.buttons).toEqual([]);
    expect(s.text()).not.toContain('Propose an auto-approve policy');
    expect(s.main().querySelector('textarea[name="policy"]')).toBeNull();
  });

  it('the User IDs row (D919): its own on a marked scope’s new app, the scope’s otherwise; none from an API before 0030', async () => {
    const own = await open({ sharedScope: true, createdByKind: 'hana', sharedWallet: true, userIds: 'app' });
    expect(row(own, 'User IDs')).toEqual({ title: 'User IDs', text: 'Its own: each person gets a User ID and Support ID on this app that no other app has. The Support ID lookup doesn’t find these yet.', buttons: [] });
    closeWindow();
    const before = await open({ sharedScope: true, createdByKind: 'hana', sharedWallet: true, userIds: 'scope' });
    expect(row(before, 'User IDs')!.text).toBe('The scope’s: this app was made before the scope was marked as shared, so it keeps the User IDs it already had.');
    closeWindow();
    const plain = await open({ sharedScope: false, createdByKind: 'hana', sharedWallet: false, userIds: 'scope' });
    expect(row(plain, 'User IDs')!.text).toBe('The scope’s: each person has the same User ID and Support ID on every app of this scope.');
    closeWindow();
    const old = await open({ sharedScope: false, createdByKind: 'hana', sharedWallet: false });
    expect(row(old, 'User IDs')).toBeUndefined();
  });

  it('a platform-created app: auto-approve off, no proposal form; a policy found there can still be removed', async () => {
    const s = await open({ sharedScope: false, createdByKind: 'platform', sharedWallet: true, settings: { ...SETTINGS, policy: { policyId: 'a'.repeat(64), label: 'Found', json: {} } } });
    expect(row(s, 'Auto-approve policy')!.buttons).toEqual(['Remove the policy']);
    expect(row(s, 'Shared wallet')!.text).toBe('This scope isn’t marked as shared, but the platform created this app, so auto-approve is off for it.');
    expect(row(s, 'Shared wallet')!.buttons).toEqual(['Mark the scope as shared']);
    expect(s.main().querySelector('textarea[name="policy"]')).toBeNull();
  });

  it('an unmarked app is unchanged, and marking its scope asks first, then posts once with the org', async () => {
    const s = await open({ sharedScope: false, createdByKind: 'hana', sharedWallet: false });
    expect(row(s, 'Auto-approve policy')).toEqual({ title: 'Auto-approve policy', text: 'None: every signature asks the user.', buttons: ['Propose an auto-approve policy'] });
    expect(row(s, 'Shared wallet')!.text).toBe('Off: this scope isn’t marked as shared by several partners’ apps.');
    s.button('Mark the scope as shared').click();
    const confirm = s.main().querySelector('.confirm')!;
    expect(confirm.textContent).toContain('Mark scope s_pay as shared by several partners’ apps? Auto-approve is then off for every app on it, for good: this can’t be undone.');
    // The scope's apps (not a deleted one, not another scope's) are named before anything is sent.
    expect(confirm.textContent).toContain('Its apps: Lumen checkout (app_pay), Lumen rewards (app_pay2).');
    expect(s.api().filter((c) => c.method !== 'GET')).toEqual([]);
    (confirm.querySelector('button') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(s.api().filter((c) => c.method !== 'GET')).toHaveLength(1));
    expect(s.api().find((c) => c.method === 'POST')).toMatchObject({ method: 'POST', path: '/api/scopes/s_pay/app-user-ids', body: { orgId: 'org_lumen' } });
    await vi.waitFor(() => expect(s.toasts()).toContain('The scope is marked as shared. Auto-approve is off for every app on it.'));
  });

  it('a refusal (a policy in the way) is shown in plain words, with the API’s reason', async () => {
    const reason = 'An app on this scope has an auto-approve policy in force or waiting: remove it or cancel it first, then mark the scope as shared';
    const s = await open({ sharedScope: false, createdByKind: 'hana', sharedWallet: false }, () => ({ status: 409, body: { error: { code: 'conflict', message: reason } } }));
    s.button('Mark the scope as shared').click();
    (s.main().querySelector('.confirm button') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(s.main().querySelector('.jp-alert-danger')).not.toBeNull());
    expect(s.main().querySelector('.jp-alert-danger')!.textContent).toContain('That clashes with the current state');
    expect(s.main().querySelector('.jp-alert-danger')!.textContent).toContain(reason);
  });

  it('a live app: no mark offered, and the row says why (test scopes only for now)', async () => {
    const s = await open({ environment: 'live', sharedScope: false, createdByKind: 'hana', sharedWallet: false });
    expect(row(s, 'Shared wallet')).toEqual({ title: 'Shared wallet', text: 'Off. Only a test scope can be marked as shared for now: a live shared scope needs its own security review first.', buttons: [] });
    expect(s.api().some((c) => c.path === '/api/orgs/org_lumen')).toBe(false);
  });

  it('the scope’s apps unreadable: the confirmation says so, and the mark can still be confirmed', async () => {
    const s = await open({ sharedScope: false, createdByKind: 'hana', sharedWallet: false }, undefined, () => ({ status: 503, body: { error: { code: 'upstream_unavailable', message: 'down' } } }));
    s.button('Mark the scope as shared').click();
    expect(s.main().querySelector('.confirm')!.textContent).toContain('Its apps couldn’t be read: check them on the organisation’s page first.');
  });

  it('an API from before migration 0026: no Shared wallet row, the policy form as before', async () => {
    const s = await open({});
    expect(rows(s).map((r) => r.title)).toEqual(['Raw signing', 'Auto-approve policy', 'Other settings']);
    expect(row(s, 'Auto-approve policy')!.buttons).toEqual(['Propose an auto-approve policy']);
  });
});
