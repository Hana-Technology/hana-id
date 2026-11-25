// D930 (docs/partner-platform-spec.md A11, piece P5): the partner console's reads for the platform screens, over the
// real API. The Platform activity route (any member, frozen orgs too; the org's own calls only, never another org's,
// never the caller's network; the key labels and app names it shows; bad parameters refused); the labels of the
// platform keys an app or the Audit names (only the org's own keys); the key page's count of owners. Reads only.
import { newId, parsePlatformPublicKey } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { breathe, getAs, member } from './c10.ts';
import { seedHotApp } from './helpers.ts';

beforeEach(async () => {
  await breathe(700);
});
afterEach(() => vi.restoreAllMocks());

const hot = env.HOT_DB;

/** A platform key of `org` written as the API writes a registration (bare D1). */
async function platformKey(org: string, scope: string, label: string): Promise<string> {
  const id = newId('platformKey');
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey;
  const p = await parsePlatformPublicKey(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }));
  if (!p.ok) throw new Error(p.problem);
  await hot
    .prepare(
      `INSERT INTO platform_keys (id, org_id, label, alg, public_key, thumbprint, scopes_json, status, proposed_by_kind, proposed_by, proposer_sub, proposer_email_key, proposed_at, four_eyes, min_delay_ms, request_id)
       VALUES (?1, ?2, ?3, 'ES256', ?4, ?5, ?6, 'pending', 'member', 'usr_registrant', 'sub-registrant', 'owner@partner.example', ?7, 0, 86400000, ?8)`,
    )
    .bind(id, org, label, p.key.raw, p.key.thumbprint, JSON.stringify([scope]), Date.now(), `r_${id}`)
    .run();
  return id;
}

const call = (org: string, keyId: string, appId: string | null, status = 200, code: string | null = null) =>
  hot
    .prepare("INSERT INTO platform_calls (at, org_id, key_id, method, route, app_id, status, code, request_id, ip_prefix) VALUES (?1, ?2, ?3, 'GET', ?4, ?5, ?6, ?7, ?8, '203.0.113.0/24')")
    .bind(Date.now(), org, keyId, appId ? '/v1/platform/apps/:appId' : '/v1/platform/credential', appId, status, code, `rq_${newId('app').slice(4)}`)
    .run();

describe('platform activity', () => {
  it('any member reads the org’s own calls with its keys’ labels and its apps’ names, never the caller’s network or another org’s', async () => {
    const viewer = await member('viewer');
    const app = await seedHotApp(viewer.org);
    const key = await platformKey(viewer.org, app.scope, 'Production backend');
    await call(viewer.org, key, app.id);
    await call(viewer.org, key, null, 429, 'rate_limited');
    const other = await member('owner');
    const theirs = await seedHotApp(other.org);
    await call(other.org, await platformKey(other.org, theirs.scope, 'Not yours'), theirs.id);
    const r = await getAs<{ calls: { keyId: string; appId?: string; status: number; code?: string; ipPrefix?: string }[]; keyLabels: Record<string, string>; appNames: Record<string, string>; apps: unknown[] }>(viewer, `/api/orgs/${viewer.org}/platform-activity`);
    expect(r.status).toBe(200);
    expect(r.body.calls).toHaveLength(2);
    expect(r.body.calls[0]).toMatchObject({ keyId: key, status: 429, code: 'rate_limited' });
    expect(r.body.calls[1]).toMatchObject({ keyId: key, appId: app.id, status: 200 });
    for (const c of r.body.calls) expect(c).not.toHaveProperty('ipPrefix');
    expect(r.body.keyLabels).toEqual({ [key]: 'Production backend' });
    expect(r.body.appNames[app.id]).toBe(`Test ${app.id}`);
    expect(JSON.stringify(r.body)).not.toContain('Not yours');
    // Narrowed to one app; another org's app named here finds nothing.
    const one = await getAs<{ calls: unknown[] }>(viewer, `/api/orgs/${viewer.org}/platform-activity?app=${app.id}`);
    expect(one.body.calls).toHaveLength(1);
    const foreign = await getAs<{ calls: unknown[] }>(viewer, `/api/orgs/${viewer.org}/platform-activity?app=${theirs.id}`);
    expect(foreign.body.calls).toEqual([]);
    // Another org's page: 404, as any org the member can't use.
    expect((await getAs(viewer, `/api/orgs/${other.org}/platform-activity`)).status).toBe(404);
  });

  it('refuses a malformed app or cursor, and stays readable in a frozen org', async () => {
    const m = await member('owner', { status: 'frozen' });
    expect((await getAs(m, `/api/orgs/${m.org}/platform-activity?app=../x`)).status).toBe(400);
    expect((await getAs(m, `/api/orgs/${m.org}/platform-activity?before=0`)).status).toBe(400);
    expect((await getAs(m, `/api/orgs/${m.org}/platform-activity?before=abc`)).status).toBe(400);
    expect((await getAs(m, `/api/orgs/${m.org}/platform-activity`)).status).toBe(200);
  });
});

describe('the platform keys the screens name', () => {
  it('an app and the Audit name a platform key by its label (the org’s own keys only)', async () => {
    const m = await member('viewer');
    const app = await seedHotApp(m.org);
    const key = await platformKey(m.org, app.scope, 'Partner backend');
    const id = newId('guardedChange');
    const origin = `https://shop-${newId('app').slice(4).toLowerCase()}.partner.example`;
    await hot.prepare('INSERT INTO platform_origin_waits (change_id, app_id, origin, key_id, min_delay_ms, at) VALUES (?1, ?2, ?3, ?4, 86400000, ?5)').bind(id, app.id, origin, key, Date.now()).run();
    await hot
      .prepare("INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, request_id) VALUES (?1, ?2, 'origin_add', ?3, 'pending', 'platform', ?4, ?5, ?6)")
      .bind(id, app.id, origin, key, Date.now(), `pf_${id}`)
      .run();
    await hot
      .prepare("INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (?1, ?2, ?3, ?4, 'origin.proposed', ?5, 'platform', ?6, ?7)")
      .bind(Date.now(), m.org, app.id, app.scope, JSON.stringify({ origins: [origin] }), key, `pf_${id}`)
      .run();
    const a = await getAs<{ keyLabels?: Record<string, string> }>(m, `/api/orgs/${m.org}/apps/${app.id}`);
    expect(a.status).toBe(200);
    expect(a.body.keyLabels).toEqual({ [key]: 'Partner backend' });
    const audit = await getAs<{ keyLabels?: Record<string, string> }>(m, `/api/orgs/${m.org}/audit`);
    expect(audit.body.keyLabels).toEqual({ [key]: 'Partner backend' });
    // An app nothing of the platform names: no extra read, no labels.
    const plain = await seedHotApp(m.org);
    expect((await getAs<{ keyLabels?: unknown }>(m, `/api/orgs/${m.org}/apps/${plain.id}`)).body).not.toHaveProperty('keyLabels');
  });

  it('the key page says how many owners the organisation has now', async () => {
    const m = await member('owner');
    await member('owner', { org: m.org });
    await member('viewer', { org: m.org });
    const app = await seedHotApp(m.org);
    const key = await platformKey(m.org, app.scope, 'Counted key');
    const r = await getAs<{ owners: number }>(m, `/api/orgs/${m.org}/platform-keys/${key}`);
    expect(r.status).toBe(200);
    expect(r.body.owners).toBe(2);
  });
});
