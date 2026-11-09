// Build plan batch 9 (the links view, D445; the email toggle, D444): the link counts per app and day from the contract's
// NEP-297 events (counts only, never a key out of a log line), AdminRpc.linkStats (staff or the cron, one app or all,
// the window, nothing to read), and the app's sign-in methods (`apps.login_methods`) through updateSettings and the
// turnOff kill switch, including another org's app.
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countLinkUsage, linkStats, linkTallyOf } from '../src/link-usage.ts';
import { waitForOutcome } from '../src/near/tx.ts';
import type { Rpc } from '../src/near/rpc.ts';
import { DELAY, adminRpc, consoleRpc, hana, member, newOrg, orgApp, rid } from './rpc-helpers.ts';
import { uid } from './helpers.ts';

const SIGNER = 'hana-signer-test.testnet';

const event = (name: string, data: Record<string, unknown>) => `EVENT_JSON:${JSON.stringify({ standard: 'hana-id', version: '1.2.0', event: name, data: [data] })}`;
const receipt = (executor: string, ...logs: string[]) => ({ outcome: { executor_id: executor, logs, status: { SuccessValue: '' }, gas_burnt: 1, tokens_burnt: '1' } });

describe('linkTallyOf (D445)', () => {
  it('counts each kind of link event of the signer contract, auto and explicit', () => {
    const t = linkTallyOf(
      [
        receipt(
          SIGNER,
          event('identity_link_proposed', { auto: true, root: 'aa', member: 'bb' }),
          event('identity_linked', { auto: false }),
          event('identity_link_activated', {}),
          event('identity_link_cancelled', { by: 'cc' }),
          event('identity_unlinked', {}),
        ),
      ],
      SIGNER,
    );
    expect(t).toEqual({ proposed: 1, linked: 1, activated: 1, cancelled: 1, unlinked: 1, auto: 1, explicit: 1 });
    // Keys in the log lines are not carried out.
    expect(JSON.stringify(t)).not.toMatch(/aa|bb|cc/u);
  });

  it('ignores another contract, another standard, malformed lines and plain logs; no link event is null', () => {
    expect(linkTallyOf([receipt('v1.signer.testnet', event('identity_linked', { auto: true }))], SIGNER)).toBeNull();
    expect(linkTallyOf([receipt(SIGNER, `EVENT_JSON:${JSON.stringify({ standard: 'nep171', event: 'identity_linked', data: [{}] })}`, 'EVENT_JSON:{not json', 'plain log')], SIGNER)).toBeNull();
    expect(linkTallyOf([receipt(SIGNER)], SIGNER)).toBeNull();
    expect(linkTallyOf([], SIGNER)).toBeNull();
  });

  it('waitForOutcome carries the tally only when asked (the relayer asks with the signer account)', async () => {
    const initial = {
      status: { SuccessValue: '' },
      transaction: { hash: 'h' },
      transaction_outcome: { outcome: { gas_burnt: 1, tokens_burnt: '1' } },
      receipts_outcome: [receipt(SIGNER, event('identity_linked', { auto: true }))],
      final_execution_status: 'EXECUTED',
    };
    const rpc = {} as unknown as Rpc;
    const r = await waitForOutcome(rpc, "h", "relayer.testnet", initial as never, { linkEventsFrom: SIGNER });
    expect(r.ok && r.linkTally).toEqual({ proposed: 0, linked: 1, activated: 0, cancelled: 0, unlinked: 0, auto: 1, explicit: 0 });
    const none = await waitForOutcome(rpc, "h", "relayer.testnet", initial as never);
    expect(none.ok && 'linkTally' in none).toBe(false);
  });
});

describe('countLinkUsage and AdminRpc.linkStats (D445)', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-06-15T12:00:00Z').getTime() + Math.floor(Math.random() * 40) * 3_600_000 * 24, toFake: ['Date'] }));
  afterEach(() => vi.useRealTimers());
  const now = () => Date.now();
  const day = (offset = 0) => new Date(now() - offset * 86_400_000).toISOString().slice(0, 10);

  it('adds to the day’s row, keeps apps apart and answers staff the app names, newest first', async () => {
    const a = await orgApp();
    const b = await orgApp();
    const ctx = { requestId: rid(), endpoint: '/v1/link' };
    await countLinkUsage(env, a.id, { proposed: 2, linked: 0, activated: 0, cancelled: 1, unlinked: 0, auto: 1, explicit: 1 }, ctx, undefined, now());
    await countLinkUsage(env, a.id, { proposed: 1, linked: 1, activated: 1, cancelled: 0, unlinked: 1, auto: 2, explicit: 0 }, ctx, undefined, now());
    await countLinkUsage(env, b.id, { proposed: 0, linked: 3, activated: 0, cancelled: 0, unlinked: 0, auto: 0, explicit: 3 }, ctx, undefined, now() - 2 * 86_400_000);

    const r = await adminRpc().linkStats({ ...hana(), days: 7 });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) throw new Error('refused');
    const mine = r.rows.filter((x) => x.appId === a.id || x.appId === b.id);
    expect(mine[0]).toMatchObject({ appId: a.id, day: day(), proposed: 3, linked: 1, activated: 1, cancelled: 1, unlinked: 1, auto: 3, explicit: 1, orgId: a.org, environment: 'test' });
    expect(mine[1]).toMatchObject({ appId: b.id, day: day(2), linked: 3, explicit: 3 });
    // One app, and the window.
    const oneApp = await adminRpc().linkStats({ ...hana(), days: 7, appId: b.id });
    expect(oneApp.ok && oneApp.rows.map((x) => x.appId)).toEqual([b.id]);
    const narrow = await adminRpc().linkStats({ ...hana(), days: 1 });
    expect(narrow.ok && narrow.rows.some((x) => x.appId === b.id)).toBe(false);
  });

  it('a missing tally writes nothing; a day after waits for the write through the context', async () => {
    const a = await orgApp();
    await countLinkUsage(env, a.id, undefined, { requestId: rid(), endpoint: '/v1/login' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM link_usage WHERE app_id = ?1').bind(a.id).first()).toEqual({ n: 0 });
    const exec = createExecutionContext();
    await countLinkUsage(env, a.id, { proposed: 1, linked: 0, activated: 0, cancelled: 0, unlinked: 0, auto: 1, explicit: 0 }, { requestId: rid(), endpoint: '/v1/login' }, exec, now());
    await waitOnExecutionContext(exec);
    expect(await env.DB.prepare('SELECT proposed FROM link_usage WHERE app_id = ?1').bind(a.id).first()).toEqual({ proposed: 1 });
  });

  it('a failed write only logs (the table not there yet)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fakeDb = { prepare: () => ({ bind: () => ({ run: () => Promise.reject(new Error('no such table')) }) }) } as unknown as D1Database;
    await expect(countLinkUsage({ DB: fakeDb } as typeof env, 'app_x', { proposed: 1, linked: 0, activated: 0, cancelled: 0, unlinked: 0, auto: 0, explicit: 0 }, { requestId: rid(), endpoint: '/v1/login' })).resolves.toBeUndefined();
    expect(errors.mock.calls.some(([line]) => String(line).includes('link_usage_write_failed'))).toBe(true);
    errors.mockRestore();
  });

  it('refuses a partner member, a malformed window and an unknown shape', async () => {
    const r = await adminRpc().linkStats({ ...member(), days: 7 });
    expect(r).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await adminRpc().linkStats({ ...hana(), days: 0 })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await adminRpc().linkStats({ ...hana(), days: 32 })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await adminRpc().linkStats({ ...hana(), extra: 1 })).toMatchObject({ ok: false, code: 'bad_request' });
  });

  it('nothing to read is an empty list', async () => {
    const r = await linkStats(env.DB, 1, 'app_NoSuchApp', now());
    expect(r).toEqual([]);
  });
});

describe('the app’s sign-in methods (D444)', () => {
  const version = async (appId: string) => (await env.DB.prepare('SELECT settings_version AS v, login_methods AS m FROM apps WHERE id = ?1').bind(appId).first<{ v: number; m: string }>())!;

  it('updateSettings turns email on; the app view and the list report it; turning it on again changes nothing', async () => {
    const a = await orgApp();
    const before = await version(a.id);
    expect(before.m).toBe('google');
    const on = await consoleRpc().updateSettings({ ...member(), orgId: a.org, appId: a.id, loginMethods: 'google,email', expectedVersion: before.v });
    expect(on).toEqual({ ok: true, version: before.v + 1 });
    const row = await version(a.id);
    expect(row).toEqual({ v: before.v + 1, m: 'google,email' });
    const detail = await consoleRpc().getApp({ ...member(), orgId: a.org, appId: a.id });
    expect(detail.ok && detail.app.settings.loginMethods).toBe('google,email');
    const list = await consoleRpc().listApps({ ...member(), orgId: a.org });
    expect(list.ok && list.apps.find((x) => x.id === a.id)?.emailOn).toBe(true);
    // Replayed: no new version.
    expect(await consoleRpc().updateSettings({ ...member(), orgId: a.org, appId: a.id, loginMethods: 'google,email', expectedVersion: row.v })).toEqual({ ok: true, version: row.v });
    expect((await version(a.id)).v).toBe(row.v);
  });

  it('turnOff email is immediate, ends email for the app, and is recorded', async () => {
    const a = await orgApp();
    const v = (await version(a.id)).v;
    await consoleRpc().updateSettings({ ...member(), orgId: a.org, appId: a.id, loginMethods: 'google,email', expectedVersion: v });
    const off = await consoleRpc().turnOff({ ...member(), orgId: a.org, appId: a.id, what: 'email', expectedVersion: v + 1 });
    expect(off).toEqual({ ok: true, version: v + 2 });
    expect((await version(a.id)).m).toBe('google');
    const change = await env.DB.prepare("SELECT kind FROM app_changes WHERE app_id = ?1 AND kind = 'email.off'").bind(a.id).first();
    expect(change).toEqual({ kind: 'email.off' });
    // Already off: no change.
    expect(await consoleRpc().turnOff({ ...member(), orgId: a.org, appId: a.id, what: 'email', expectedVersion: v + 2 })).toEqual({ ok: true, version: v + 2 });
  });

  it('a member can’t change another org’s app, and a stale version is refused', async () => {
    const a = await orgApp();
    const other = newOrg();
    const v = (await version(a.id)).v;
    expect(await consoleRpc().updateSettings({ ...member(), orgId: other, appId: a.id, loginMethods: 'google,email', expectedVersion: v })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await consoleRpc().turnOff({ ...member(), orgId: other, appId: a.id, what: 'email', expectedVersion: v })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await consoleRpc().updateSettings({ ...member(), orgId: a.org, appId: a.id, loginMethods: 'google,email', expectedVersion: v + 5 })).toMatchObject({ ok: false, code: 'version_conflict' });
    expect((await version(a.id)).m).toBe('google');
    expect(DELAY).toBeGreaterThan(0);
    expect(uid()).toBeTruthy();
  });
});
