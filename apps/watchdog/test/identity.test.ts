// The partner identity token's watchdog check (docs/identity-token-spec.md "JWKS and discovery", D210–D212): Hana's
// identity JWKS and discovery document against watchdog.pinnedIdentityKeys and identityToken.iss, read in the advisory
// phase; an identity key's thumbprint as an issuer kid on chain. Every finding is an alert: the chain isn't involved,
// so nothing is cancelled or paused for it. Stub chain, stub documents, no network.
import { describe, expect, it } from 'vitest';
import { identityKeysOnChain, judgeDiscovery, judgeIdentityJwks, p256Thumbprint, parseIdentityPins } from '../src/identity.ts';
import { runWatchdog } from '../src/run.ts';
import { alertsOf, IDENTITY_ISS, identityKey, initialized, jwk, OWNER } from './helpers.ts';

type Key = Awaited<ReturnType<typeof identityKey>>;
const checkOf = (r: { checks: { id: string; outcome: string; detail?: string }[] }, id: string) => r.checks.find((c) => c.id === id);
const openKinds = async (w: Awaited<ReturnType<typeof initialized>>) => (await w.store.openAlerts()).map((a) => a.kind).sort();

/** A world past its first run with sandbox-dev's identity setup: an active and a standby key, both pinned and published. */
async function live(over: { pins?: string[] | null } = {}): Promise<{ w: Awaited<ReturnType<typeof initialized>>; active: Key; standby: Key }> {
  const [active, standby] = [await identityKey(), await identityKey()];
  const w = await initialized({ identity: { published: [active, standby], ...(over.pins !== undefined ? { pins: over.pins } : {}) } });
  return { w, active, standby };
}

describe('pure verdicts', () => {
  it('thumbprints a P-256 key as RFC 7638 does, and refuses anything else', async () => {
    // RFC 7638 §3.1's example is RSA; this is the P-256 form @hana-id/env and @hana-id/core compute (sandbox-dev's active key).
    const k = { kty: 'EC', crv: 'P-256', x: 'K-9yfj4EQcl4NpjqbvU8Jd6o1qP6QXvq1H9vOcU4daI', y: '3ycRO9-5NiONOnFznQC004TVM9-Q_LTTxFJUJ-ayJac' };
    expect(await p256Thumbprint(k)).toBe('17xAVaTfgwnOkdwq1uOmwHR31pPKB90xw5oGN5HcBgY');
    expect(await p256Thumbprint({ ...k, kid: 'ignored', use: 'sig', alg: 'ES256' })).toBe('17xAVaTfgwnOkdwq1uOmwHR31pPKB90xw5oGN5HcBgY');
    for (const bad of [{ ...k, crv: 'P-384' }, { ...k, kty: 'RSA' }, { ...k, x: `${k.x}A` }, { ...k, x: k.x.replace(/I$/u, 'J') }, { ...k, y: 7 }, null, 'k', jwk('r', 1)]) expect(await p256Thumbprint(bad)).toBeNull();
  });

  it('parses the pins: absent is nothing pinned, malformed is nothing pinned with a problem', () => {
    const tp = 'a'.repeat(43);
    expect(parseIdentityPins(undefined)).toEqual({ pins: null, problems: [] });
    expect(parseIdentityPins(' ')).toEqual({ pins: null, problems: [] });
    expect(parseIdentityPins(JSON.stringify([tp]))).toEqual({ pins: [tp], problems: [] });
    for (const raw of ['{', '[]', '["short"]', JSON.stringify([tp, tp]), JSON.stringify({ pins: [tp] }), JSON.stringify(Array.from({ length: 9 }, (_, i) => String(i).repeat(43)))]) {
      expect(parseIdentityPins(raw).pins, raw).toBeNull();
      expect(parseIdentityPins(raw).problems, raw).toHaveLength(1);
    }
  });

  it('judges each JWKS entry by its material, never by its kid', async () => {
    const [a, b, evil] = [await identityKey(), await identityKey(), await identityKey()];
    const v = await judgeIdentityJwks({ keys: [a, { ...evil, kid: b.kid }, { ...a, kid: 'renamed' }] }, { pins: [a.kid, b.kid], problems: [] });
    expect(v.unpinned.map((k) => [k.kid, k.thumbprint, k.reason])).toEqual([[b.kid, evil.kid, 'not_pinned']]);
    // b is pinned but not published (its kid names other material); a is there, also under another kid (fine).
    expect(v.missing).toEqual([{ thumbprint: b.kid, reason: 'not_published' }]);
    const renamed = await judgeIdentityJwks({ keys: [{ ...a, kid: 'renamed' }] }, { pins: [a.kid], problems: [] });
    expect(renamed.missing).toEqual([{ thumbprint: a.kid, reason: 'kid_differs' }]);
    expect(renamed.unpinned).toEqual([]);
  });

  it('refuses a body that is not a JWKS', async () => {
    for (const body of [null, [], 'x', { keys: 'x' }, { keys: [1] }, { keys: [[]] }, { nokeys: [] }]) await expect(judgeIdentityJwks(body, { pins: null, problems: [] })).rejects.toThrow(/not a JWKS/u);
    expect((await judgeIdentityJwks({ keys: [] }, { pins: null, problems: [] })).keys).toEqual([]);
  });

  it('judges the discovery document against the configured issuer and its JWKS URL', () => {
    expect(judgeDiscovery({ issuer: IDENTITY_ISS, jwks_uri: `${IDENTITY_ISS}/jwks.json` }, IDENTITY_ISS).problems).toEqual([]);
    expect(judgeDiscovery({ issuer: `${IDENTITY_ISS}/`, jwks_uri: 'https://evil.example/jwks.json' }, IDENTITY_ISS).problems.map((p) => p.field)).toEqual(['issuer', 'jwks_uri']);
    expect(judgeDiscovery({}, IDENTITY_ISS).problems.map((p) => p.published)).toEqual([null, null]);
    expect(() => judgeDiscovery([], IDENTITY_ISS)).toThrow(/not a discovery document/u);
  });

  it('finds identity kids among active keys and pending additions only', () => {
    const tp = 'a'.repeat(43);
    const pending = [
      { id: 1, provider: 'google', kid: tp, op: 'Add' },
      { id: 2, provider: 'email', kid: tp, op: 'Remove' },
      { id: 3, provider: 'other', kid: 'k9', op: 'Add' },
    ];
    expect(identityKeysOnChain({ issuerKids: ['k1', tp], emailKids: [tp], pending }, new Set([tp]))).toEqual([
      { where: 'active', provider: 'google', kid: tp },
      { where: 'active', provider: 'email', kid: tp },
      { where: 'pending', provider: 'google', kid: tp, change: 1 },
    ]);
  });
});

describe("Hana's identity JWKS and discovery document (advisory, no pause)", () => {
  it('pinned keys published and the right discovery document: ok, nothing raised, nothing sent to the chain', async () => {
    const { w } = await live();
    const r = await w.run();
    expect(checkOf(r, 'identity_jwks')).toMatchObject({ outcome: 'ok', detail: expect.stringContaining('2 published, 0 unpinned') });
    expect(w.identity.fetches).toEqual({ jwks: 2, discovery: 2 });
    expect(await openKinds(w)).toEqual([]);
    expect(w.writer.calls).toEqual([]);
  });

  it('an unpinned key published: critical, paged, never a chain call; a different set is a new page; resolved once gone', async () => {
    const { w, active, standby } = await live();
    const evil = await identityKey();
    w.identity.keys = [active, standby, evil];
    const r = await w.run();
    expect(w.writer.calls).toEqual([]);
    expect(r.outcome).toBe('ok');
    const [a] = await alertsOf(w.store, 'identity_key_unpinned');
    expect(a).toMatchObject({ severity: 'critical', resolved_at: null });
    expect(a?.title).toContain(evil.kid);
    expect(a?.title).toContain('No pause');
    expect(a?.details.keys).toEqual([{ kid: evil.kid, thumbprint: evil.kid, reason: 'not_pinned', private: [] }]);
    expect(w.notifier.sent.map((s) => s.channel).sort()).toEqual(['email', 'pager', 'slack']);
    expect(checkOf(r, 'identity_jwks')?.outcome).toBe('alert');

    // Still published next run: the same condition, no new page (re-sends are the 15-minute rule's).
    w.notifier.clear();
    await w.run();
    expect(await alertsOf(w.store, 'identity_key_unpinned')).toHaveLength(1);

    const evil2 = await identityKey();
    w.identity.keys = [active, standby, evil, evil2];
    await w.run();
    const all = await alertsOf(w.store, 'identity_key_unpinned');
    expect(all).toHaveLength(2);
    expect(all.filter((x) => x.resolved_at === null)).toHaveLength(1);

    w.identity.keys = [active, standby];
    await w.run();
    expect((await alertsOf(w.store, 'identity_key_unpinned')).every((x) => x.resolved_at !== null)).toBe(true);
  });

  it('a pinned kid over other material is unpinned (judged by material); a non-P-256 key too, its hostile kid escaped', async () => {
    const { w, active, standby } = await live();
    const evil = await identityKey();
    const hostile = 'x\n<!channel>é'.padEnd(200, 'y');
    w.identity.keys = [active, { ...evil, kid: standby.kid }, { ...jwk('r', 5), kid: hostile }];
    await w.run();
    const [a] = await alertsOf(w.store, 'identity_key_unpinned');
    expect((a?.details.keys as { reason: string }[]).map((k) => k.reason)).toEqual(['not_pinned', 'not_p256']);
    expect(a?.title).not.toMatch(/[\r\n]/u);
    expect(a?.title).not.toContain('<!channel>\n');
    for (const s of w.notifier.sent) expect(s.msg.title).not.toMatch(/[\r\n]/u);
    // The real standby isn't published under its kid any more: a warning beside the page.
    expect((await alertsOf(w.store, 'identity_key_missing'))[0]).toMatchObject({ severity: 'warning', key: `identity_key_missing:${standby.kid}` });
  });

  it('private key material published: critical, the member names stored, never the values', async () => {
    const { w, active, standby } = await live();
    const d = 'Zm9yZ2VkLXByaXZhdGUtc2NhbGFyLXZhbHVlLTEyMzQ';
    w.identity.keys = [{ ...active, d }, standby];
    await w.run();
    const [a] = await alertsOf(w.store, 'identity_private_key_published');
    expect(a).toMatchObject({ severity: 'critical', resolved_at: null });
    expect(a?.details.keys).toEqual([{ kid: active.kid, thumbprint: active.kid, reason: null, private: ['d'] }]);
    // A pinned key with `d` is still pinned: only the private alert.
    expect(await alertsOf(w.store, 'identity_key_unpinned')).toEqual([]);
    const stored = JSON.stringify(await w.store.listAlerts(null, 50)) + JSON.stringify(await w.store.getMeta('identity_jwks'));
    expect(stored).not.toContain(d);
    for (const s of w.notifier.sent) expect(JSON.stringify(s)).not.toContain(d);
    w.identity.keys = [active, standby];
    await w.run();
    expect((await alertsOf(w.store, 'identity_private_key_published'))[0]?.resolved_at).not.toBeNull();
  });

  it('a pinned key missing warns (not_published or kid_differs) and resolves when published again', async () => {
    const { w, active, standby } = await live();
    w.identity.keys = [active];
    await w.run();
    expect((await alertsOf(w.store, 'identity_key_missing'))[0]).toMatchObject({ severity: 'warning', details: expect.objectContaining({ reason: 'not_published', thumbprint: standby.kid }) });
    expect(w.notifier.sent.map((s) => s.channel).sort()).toEqual(['email', 'slack']);
    w.identity.keys = [active, { ...standby, kid: 'standby' }];
    await w.run();
    expect((await alertsOf(w.store, 'identity_key_missing'))[0]?.details.reason).toBe('not_published'); // same condition key, first details kept
    w.identity.keys = [active, standby];
    await w.run();
    expect((await alertsOf(w.store, 'identity_key_missing'))[0]?.resolved_at).not.toBeNull();
  });

  it('a wrong issuer or jwks_uri in the discovery document is critical, one alert per field and value', async () => {
    const { w } = await live();
    w.identity.discovery = { issuer: 'https://evil.example/v1/identity', jwks_uri: 'https://evil.example/jwks.json' };
    await w.run();
    const alerts = await alertsOf(w.store, 'identity_discovery_mismatch');
    expect(alerts.map((a) => [a.severity, a.details.field, a.details.published]).sort()).toEqual([
      ['critical', 'issuer', 'https://evil.example/v1/identity'],
      ['critical', 'jwks_uri', 'https://evil.example/jwks.json'],
    ]);
    expect(w.writer.calls).toEqual([]);
    w.identity.discovery = { jwks_uri: `${IDENTITY_ISS}/jwks.json` };
    await w.run();
    const open = (await alertsOf(w.store, 'identity_discovery_mismatch')).filter((a) => a.resolved_at === null);
    expect(open.map((a) => [a.details.field, a.details.published])).toEqual([['issuer', null]]);
    w.identity.discovery = null;
    await w.run();
    expect((await alertsOf(w.store, 'identity_discovery_mismatch')).every((a) => a.resolved_at !== null)).toBe(true);
  });

  it('fetch failures warn after 3 runs in a row, per document; a malformed body counts; a failed read resolves nothing it would judge', async () => {
    const { w, active, standby } = await live();
    const evil = await identityKey();
    w.identity.keys = [active, standby, evil];
    await w.run();
    expect((await alertsOf(w.store, 'identity_key_unpinned'))[0]?.resolved_at).toBeNull();
    w.identity.failJwks = true;
    let r = await w.run();
    expect(checkOf(r, 'identity_jwks')?.outcome).toBe('error');
    w.identity.failJwks = false;
    w.identity.jwks = { keys: 'not a list' };
    await w.run();
    expect(await alertsOf(w.store, 'identity_jwks_failing')).toEqual([]);
    w.identity.jwks = [];
    r = await w.run();
    const [f] = await alertsOf(w.store, 'identity_jwks_failing');
    expect(f).toMatchObject({ key: 'identity_jwks_failing:jwks', severity: 'warning', resolved_at: null });
    // The unpinned key's page stays open while the JWKS can't be read.
    expect((await alertsOf(w.store, 'identity_key_unpinned'))[0]?.resolved_at).toBeNull();
    expect(checkOf(r, 'identity_jwks')?.outcome).toBe('alert');

    w.identity.jwks = null;
    w.identity.keys = [active, standby];
    await w.run();
    expect((await alertsOf(w.store, 'identity_jwks_failing'))[0]?.resolved_at).not.toBeNull();
    expect((await alertsOf(w.store, 'identity_key_unpinned'))[0]?.resolved_at).not.toBeNull();

    // The discovery document has its own counter.
    w.identity.failDiscovery = true;
    for (let i = 0; i < 3; i++) await w.run();
    expect((await alertsOf(w.store, 'identity_jwks_failing')).find((a) => a.resolved_at === null)?.key).toBe('identity_jwks_failing:discovery');
  });

  it('nothing pinned: every published key is unpinned (absence pins nothing)', async () => {
    const { w } = await live({ pins: null });
    // initialized() already ran once: the page is from the first run, as pins are configuration, not history.
    const [a] = await alertsOf(w.store, 'identity_key_unpinned');
    expect(a?.severity).toBe('critical');
    expect(a?.title).toContain('nothing is pinned');
    expect(a?.details.count).toBe(2);
  });

  it('unreadable pins: pins_invalid:identity pages, and every published key is unpinned (pins_unreadable)', async () => {
    const { w } = await live();
    w.deps.config.identity.pins = { pins: null, problems: ['IDENTITY_PINS is malformed: every published identity key is treated as unpinned'] };
    const r = await w.run();
    expect((await alertsOf(w.store, 'pins_invalid'))[0]).toMatchObject({ key: 'pins_invalid:identity', severity: 'critical' });
    expect(checkOf(r, 'config')).toMatchObject({ outcome: 'alert', detail: expect.stringContaining('IDENTITY_PINS') });
    const [a] = await alertsOf(w.store, 'identity_key_unpinned');
    expect((a?.details.keys as { reason: string }[]).map((k) => k.reason)).toEqual(['pins_unreadable', 'pins_unreadable']);
  });

  it('an env without an identity token skips the check and fetches nothing', async () => {
    const w = await initialized();
    const r = await w.run();
    expect(checkOf(r, 'identity_jwks')).toMatchObject({ outcome: 'skipped', detail: 'no identity token configured (IDENTITY_ISS)' });
    expect(w.identity.fetches).toEqual({ jwks: 0, discovery: 0 });
    expect(checkOf(r, 'identity_on_chain')).toMatchObject({ outcome: 'skipped' });
  });

  it('reads only after the protective work, the delivery, the heartbeat and the run record; a failure there blocks none of them', async () => {
    const { w } = await live();
    w.chain.propose('Add', 'k1x', { key: jwk('k1x', 66) });
    w.jwks.keys = [jwk('k1', 1), jwk('k1x', 7)];
    let seen: { actions: number; pings: number; paged: number; recorded: boolean; locked: boolean } | null = null;
    const pingsBefore = w.notifier.pings;
    w.deps.fetchIdentity = {
      jwks: async () => {
        const last = await w.store.lastRun();
        seen = { actions: w.writer.calls.length, pings: w.notifier.pings, paged: w.notifier.on('pager').length, recorded: last?.finished_at != null, locked: (await w.store.getMeta('run_lock')) !== null };
        throw new Error('a hostile answer');
      },
      discovery: async () => {
        throw new Error('down');
      },
    };
    const r = await w.run();
    expect(seen).toEqual({ actions: 3, pings: pingsBefore + 1, paged: 1, recorded: true, locked: false });
    expect(r.outcome).toBe('ok');
    expect(checkOf(r, 'identity_jwks')?.outcome).toBe('error');
    expect(w.writer.methods()).toEqual(['cancel_issuer_key_change', 'delete_updater_key', 'delete_updater_key']);
  });

  it('a throwing identity check is contained: marked error, its open alerts kept, the email advisory unaffected', async () => {
    const { w, active, standby } = await live();
    w.identity.keys = [active, standby, await identityKey()];
    await w.run();
    w.store.setMeta = (async (key: string, value: unknown) => {
      if (key === 'identity_jwks') throw new Error('D1 hiccup');
      return Object.getPrototypeOf(w.store).setMeta.call(w.store, key, value);
    }) as typeof w.store.setMeta;
    w.identity.keys = [active, standby];
    const r = await w.run();
    expect(checkOf(r, 'identity_jwks')).toMatchObject({ outcome: 'error', detail: 'the check failed' });
    expect(checkOf(r, 'email_jwks')?.outcome).not.toBe('error');
    expect((await alertsOf(w.store, 'identity_key_unpinned'))[0]?.resolved_at).toBeNull();
  });

  it('runs without a chain read (it needs none); the email advisory is skipped then', async () => {
    const { w, active, standby } = await live();
    w.identity.keys = [active, standby, await identityKey()];
    w.chain.failReads = true;
    const r = await w.run();
    expect(checkOf(r, 'chain_read')?.outcome).toBe('error');
    expect(checkOf(r, 'email_jwks')).toMatchObject({ outcome: 'skipped', detail: 'no chain read' });
    expect((await alertsOf(w.store, 'identity_key_unpinned'))[0]?.severity).toBe('critical');
  });
});

describe('an identity key on chain (D212)', () => {
  it("a pending addition with a pinned identity key's kid: critical beside the provider's own rule", async () => {
    const { w, active } = await live();
    w.chain.propose('Add', active.kid, { key: jwk(active.kid, 70), by: OWNER, provider: 'other' });
    const r = await w.run();
    const [a] = await alertsOf(w.store, 'identity_key_on_chain');
    expect(a).toMatchObject({ severity: 'critical', details: expect.objectContaining({ where: 'pending', provider: 'other', kid: active.kid, pinned: true }) });
    expect(checkOf(r, 'identity_on_chain')?.outcome).toBe('alert');
    expect(await alertsOf(w.store, 'unverifiable_key_change')).toHaveLength(1);
  });

  it("an active Google key with an identity kid: critical, and the Google rule pauses on it (Google never published it)", async () => {
    const { w, standby } = await live();
    w.chain.active.set(standby.kid, { n: jwk('x', 71).n, e: 'AQAB' });
    await w.run();
    expect((await alertsOf(w.store, 'identity_key_on_chain'))[0]?.key).toBe(`identity_key_on_chain:active:google:${standby.kid}`);
    expect(w.writer.methods()[0]).toBe('pause');
    w.chain.active.delete(standby.kid);
    await w.run();
    expect((await alertsOf(w.store, 'identity_key_on_chain'))[0]?.resolved_at).not.toBeNull();
  });

  it('also an unpinned key Hana published at the last read', async () => {
    const { w, active, standby } = await live();
    const evil = await identityKey();
    w.identity.keys = [active, standby, evil];
    await w.run();
    w.chain.propose('Add', evil.kid, { key: jwk(evil.kid, 72), by: OWNER, provider: 'other' });
    await w.run();
    expect((await alertsOf(w.store, 'identity_key_on_chain'))[0]?.details).toMatchObject({ kid: evil.kid, pinned: false });
  });

  it('is judged in the protective phase, before the advisory reads', async () => {
    const { w, active } = await live();
    w.chain.propose('Add', active.kid, { key: jwk(active.kid, 70), by: OWNER, provider: 'other' });
    let raised = -1;
    w.deps.fetchIdentity = {
      jwks: async () => {
        raised = (await alertsOf(w.store, 'identity_key_on_chain')).length;
        throw new Error('down');
      },
      discovery: async () => ({}),
    };
    await runWatchdog(w.deps);
    expect(raised).toBe(1);
  });
});
