// The on-chain watcher (docs/batch-c-spec.md "Tests: Apps, scopes, owner actions": "The watcher emails a SetOwners
// adding an Oidc and an AddClient relayed directly, once each, and an owner or client diff once"). Scopes come from
// the real API's listScopes; get_scope is the fake NEAR RPC; state is an in-memory ops store.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Budget } from '../src/mail.ts';
import { readableTime } from '../src/email/render.ts';
import { WATCH_CURSOR, runWatcher } from '../src/watcher.ts';
import { ALIAS, FakeEmail, chainScope, memoryOps, nearCalls, newOpsData, seedHotApp, setNearDown, stubNetwork } from './helpers.ts';

beforeEach(async () => {
  await stubNetwork();
  setNearDown(false);
});
afterEach(() => vi.restoreAllMocks());

const OWNER = { Oidc: { provider: 'google', sub: 'owner-sub-1' } };
const NEW_OWNER = { Oidc: { provider: 'google', sub: 'attacker-sub-9' } };

/** A store whose watch cursor sits just before `scope`, so the next run starts with it. */
function storeAt(scope: string) {
  const data = newOpsData();
  data.state.set(WATCH_CURSOR, { value: scope.slice(0, -1), updatedAt: 0 });
  return data;
}

async function run(data: ReturnType<typeof newOpsData>, fake = new FakeEmail()) {
  const r = await runWatcher(env, memoryOps(data), fake, new Budget(1000));
  return { r, fake };
}

describe('the watcher', () => {
  it('stores a scope seen for the first time as the baseline, without an email', async () => {
    const app = await seedHotApp();
    chainScope(app.scope);
    const data = storeAt(app.scope);
    const { fake } = await run(data);
    expect(nearCalls).toContain(`get_scope:${app.scope}`);
    expect(data.snapshots.get(app.scope)).toMatchObject({ owners: [OWNER], allowShared: false });
    expect(fake.about(app.scope)).toEqual([]);
  });

  it('a pending proposal whose unlock time is not a valid time is never emailed or marked notified (fails closed)', async () => {
    const app = await seedHotApp();
    chainScope(app.scope, { pending: [{ id: 9, change: { SetOwners: { owners: [OWNER, NEW_OWNER] } }, unlock_at_ms: 1e300 }] });
    const data = storeAt(app.scope);
    const fake = new FakeEmail();
    // The render throws (as isoTime always did), so the run stops before any send for it.
    await expect(run(data, fake)).rejects.toThrow(RangeError);
    expect(fake.about(`scope ${app.scope}`)).toEqual([]);
    expect(data.watch.get(`${app.scope}#9`)?.notifiedAt ?? null).toBeNull();
    // Leave the fake chain valid for the other tests.
    chainScope(app.scope);
  });

  it('emails a SetOwners adding an Oidc owner once, to the alias and the contacts, with the new owner marked', async () => {
    const app = await seedHotApp();
    const unlock = Date.now() + 86_400_000;
    chainScope(app.scope, { pending: [{ id: 7, change: { SetOwners: { owners: [OWNER, NEW_OWNER] } }, unlock_at_ms: unlock }] });
    const data = storeAt(app.scope);
    const { fake } = await run(data);
    const mails = fake.about(`scope ${app.scope}`);
    expect(mails.map((m) => m.to).sort()).toEqual([ALIAS, app.contact].sort());
    const text = mails[0]!.text;
    expect(mails[0]!.subject).toContain(`On-chain proposal for ${app.scope}: new owners`);
    expect(text).toContain('google sign-in attacker-sub-9 (NEW)');
    expect(text).not.toContain('google sign-in owner-sub-1 (NEW)');
    expect(text).toContain('WARNING: It adds a sign-in owner');
    // Readable in the designed notice (D697 as amended by D700); the HTML part is the designed layout.
    expect(text).toContain(`Can execute from: ${readableTime(unlock)}`);
    expect(mails[0]!.html).toContain('A change to your scope was proposed on chain</h1>');
    expect(data.watch.get(`${app.scope}#7`)!.notifiedAt).not.toBeNull();
    data.state.set(WATCH_CURSOR, { value: app.scope.slice(0, -1), updatedAt: 0 });
    const second = await run(data);
    expect(second.fake.about(`scope ${app.scope}`)).toEqual([]);
  });

  it('emails an AddClient relayed outside the console once, and retries until every send is accepted', async () => {
    const app = await seedHotApp();
    chainScope(app.scope, { pending: [{ id: 3, change: { AddClient: { provider: 'google', aud: 'rogue.apps.googleusercontent.com' } }, unlock_at_ms: Date.now() + 1000 }] });
    const data = storeAt(app.scope);
    const fake = new FakeEmail();
    fake.failFor.add(app.contact);
    await run(data, fake);
    expect(data.watch.get(`${app.scope}#3`)).toMatchObject({ notifiedAt: null });
    fake.failFor.clear();
    data.state.set(WATCH_CURSOR, { value: app.scope.slice(0, -1), updatedAt: 0 });
    await run(data, fake);
    expect(fake.to(app.contact).filter((m) => m.text.includes('rogue.apps.googleusercontent.com'))).toHaveLength(1);
    const first = data.watch.get(`${app.scope}#3`)!;
    expect(first.notifiedAt).not.toBeNull();
    data.state.set(WATCH_CURSOR, { value: app.scope.slice(0, -1), updatedAt: 0 });
    const again = await run(data);
    expect(again.fake.about('rogue.apps.googleusercontent.com')).toEqual([]);
  });

  it('emails an owner or client diff once (executed or immediate changes), then takes it as the new baseline', async () => {
    const app = await seedHotApp();
    chainScope(app.scope);
    const data = storeAt(app.scope);
    await run(data);
    chainScope(app.scope, { owners: [OWNER, NEW_OWNER], clients: [] });
    data.state.set(WATCH_CURSOR, { value: app.scope.slice(0, -1), updatedAt: 0 });
    const { fake } = await run(data);
    const m = fake.about(`changed since the last check`).filter((x) => x.text.includes(app.scope));
    expect(m.map((x) => x.to).sort()).toEqual([ALIAS, app.contact].sort());
    expect(m[0]!.text).toContain('owner added: google sign-in attacker-sub-9');
    expect(m[0]!.text).toContain('client removed: google client-1.apps.googleusercontent.com');
    expect(data.snapshots.get(app.scope)!.owners).toEqual([OWNER, NEW_OWNER]);
    data.state.set(WATCH_CURSOR, { value: app.scope.slice(0, -1), updatedAt: 0 });
    const again = await run(data);
    expect(again.fake.about(app.scope)).toEqual([]);
    // Owner order alone is not a change.
    chainScope(app.scope, { owners: [NEW_OWNER, OWNER], clients: [] });
    data.state.set(WATCH_CURSOR, { value: app.scope.slice(0, -1), updatedAt: 0 });
    expect((await run(data)).fake.about(app.scope)).toEqual([]);
  });

  it('a SetAllowShared proposal lists the scope’s active origins', async () => {
    const app = await seedHotApp(undefined, { origins: ['https://shop.partner.example'] });
    chainScope(app.scope, { pending: [{ id: 1, change: { SetAllowShared: { allow: true } }, unlock_at_ms: Date.now() + 1000 }] });
    const { fake } = await run(storeAt(app.scope));
    const m = fake.about(`scope ${app.scope}`)[0]!;
    expect(m.subject).toContain('shared login');
    expect(m.text).toContain('https://shop.partner.example');
  });

  it('NEAR down: nothing is emailed or stored for the scope, and the run goes on', async () => {
    const app = await seedHotApp();
    chainScope(app.scope, { pending: [{ id: 9, change: { AddClient: { provider: 'google', aud: 'x.apps.googleusercontent.com' } }, unlock_at_ms: 1 }] });
    setNearDown(true);
    const data = storeAt(app.scope);
    const { r, fake } = await run(data);
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect(fake.attempts).toEqual([]);
    expect(data.snapshots.has(app.scope)).toBe(false);
  });

  it('pages the scopes round-robin: the cursor moves to the page’s end and back to the start after the last page', async () => {
    const app = await seedHotApp();
    const data = storeAt(app.scope);
    await run(data);
    const after = data.state.get(WATCH_CURSOR)!.value;
    expect(after === '' || after >= app.scope).toBe(true);
    // Past the last scope: the next run starts over (empty cursor).
    data.state.set(WATCH_CURSOR, { value: 'szzzzzzzzzzzzzzzzzzzzzzzzzzzz', updatedAt: 0 });
    await run(data);
    expect(data.state.get(WATCH_CURSOR)!.value).not.toBe('szzzzzzzzzzzzzzzzzzzzzzzzzzzz');
  });
});
