// Logo upload, console side (src/logo.ts; docs/batch-c-spec.md "Other app settings, name and logo", Tests "Settings,
// keys, logos"), through the real API's ConsoleRpc (getApp, setLogo) over the console's `API` binding, the local R2
// bucket and a fake Images binding: SVG, GIF, polyglot and oversized files refused; a JPEG becomes a 256 × 256 PNG
// without metadata, stored content-addressed and pointed at; the replaced object is marked for the 30-day purge.
import { newId } from '@hana-id/console-core';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOGO_UPLOAD_PATH_RE, bodyTypeFor, csrfProblem } from '../src/csrf.ts';
import type { Env } from '../src/env.ts';
import { LOGO_MAX_INPUT_BYTES, LOGO_OUTPUT, LOGO_TRANSFORM, type LogoCaller, logoRemoveRoute, logoUploadRoute } from '../src/logo.ts';
import { pngChunkTypes } from '../src/logo-format.ts';
import { AVIF, type FakeImages, GIF, HTML_TAIL, METADATA_CHUNKS, SVG, ZIP_TAIL, concat, fakeImages, jpeg, png, webp } from './logo-fixtures.ts';
import { CSRF, ORIGIN, auditRows, request, rid, seedHotApp } from './helpers.ts';

afterEach(() => vi.restoreAllMocks());

const FILES = env.FILES_ORIGIN;

function caller(orgId: string, appId: string): LogoCaller {
  return { orgId, appId, actor: { kind: 'member', id: newId('user'), sub: 'sub-1', email: 'owner@partner.example', sessionHash: 'A'.repeat(43) } };
}
const info = () => ({ requestId: rid(), clientIp: '203.0.113.9', country: 'AU' });
const settingsVersion = async (appId: string) => (await env.HOT_DB.prepare('SELECT settings_version AS v FROM apps WHERE id = ?').bind(appId).first<number>('v'))!;
const logoKey = async (appId: string) => (await env.HOT_DB.prepare('SELECT logo_key AS k FROM apps WHERE id = ?').bind(appId).first<string | null>('k')) ?? null;
const rowOf = (key: string) => env.CONSOLE_DB.prepare('SELECT app_id, replaced_at FROM logo_objects WHERE key = ?').bind(key).first<{ app_id: string; replaced_at: number | null }>();

/** An upload as the session route (C10) will make it, for an owner of the app's org. */
async function upload(c: LogoCaller, body: Uint8Array, o: { images?: FakeImages; version?: number | null; contentLength?: boolean; e?: Partial<Env> } = {}): Promise<Response> {
  const version = o.version === undefined ? await settingsVersion(c.appId) : o.version;
  const url = `${ORIGIN}/api/orgs/${c.orgId}/apps/${c.appId}/logo${version === null ? '' : `?expectedVersion=${version}`}`;
  const headers: Record<string, string> = { ...CSRF, 'content-type': 'application/octet-stream' };
  if (o.contentLength !== false) headers['content-length'] = String(body.length);
  const req = new Request(url, { method: 'POST', headers, body: o.contentLength === false ? new Response(body).body : body, ...(o.contentLength === false ? { duplex: 'half' } : {}) } as RequestInit);
  return logoUploadRoute(req, { ...env, IMAGES: o.images ?? fakeImages(), ...o.e } as Env, info(), c);
}

const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe('logo upload: refused files (nothing stored, nothing pointed at)', () => {
  it.each([
    ['SVG', SVG, 'logo_type', 400],
    ['GIF', GIF, 'logo_type', 400],
    ['AVIF', AVIF, 'logo_type', 400],
    ['HTML', HTML_TAIL, 'logo_type', 400],
    ['empty', new Uint8Array(0), 'logo_type', 400],
    ['a PNG with an HTML page appended (polyglot)', concat(png(256, 256), HTML_TAIL), 'logo_type', 400],
    ['a JPEG with an archive appended (polyglot)', jpeg(256, 256, { trailing: ZIP_TAIL }), 'logo_type', 400],
    ['a WebP with bytes after its RIFF size (polyglot)', webp(256, 256, { trailing: HTML_TAIL }), 'logo_type', 400],
    ['an animated WebP', webp(256, 256, { animated: true }), 'logo_type', 400],
    ['too small (127 px)', png(127, 127), 'logo_type', 400],
    ['too large (2049 px)', png(2049, 2049), 'logo_type', 400],
    ['too wide (aspect 1.26)', png(252, 200), 'logo_type', 400],
    ['over 512 KiB', png(256, 256, { idat: LOGO_MAX_INPUT_BYTES }), 'logo_too_large', 413],
  ])('%s', async (_, body, code, status) => {
    const app = await seedHotApp();
    const images = fakeImages();
    const before = await settingsVersion(app.id);
    const res = await upload(caller(app.org, app.id), body, { images });
    expect([res.status, await errorCode(res)]).toEqual([status, code]);
    // No transform was paid for and nothing changed.
    expect(images.calls.transforms).toEqual([]);
    expect(await logoKey(app.id)).toBeNull();
    expect(await settingsVersion(app.id)).toBe(before);
    expect((await env.LOGOS!.list({ prefix: `logos/${app.id}/` })).objects).toEqual([]);
  });

  it('a file whose decoder sees another type or size than its header (a disguised file) is refused', async () => {
    const app = await seedHotApp();
    const c = caller(app.org, app.id);
    const gifInside = fakeImages({ info: () => ({ format: 'image/gif', fileSize: 1, width: 256, height: 256 }) });
    expect(await errorCode(await upload(c, png(256, 256), { images: gifInside }))).toBe('logo_type');
    const svgInside = fakeImages({ info: () => ({ format: 'image/svg+xml' }) });
    expect(await errorCode(await upload(c, png(256, 256), { images: svgInside }))).toBe('logo_type');
    const otherSize = fakeImages({ info: () => ({ format: 'image/png', fileSize: 1, width: 4000, height: 4000 }) });
    expect(await errorCode(await upload(c, png(256, 256), { images: otherSize }))).toBe('logo_type');
    const undecodable = fakeImages({ throwOnInfo: Object.assign(new Error('bad'), { code: 9412 }) });
    expect(await errorCode(await upload(c, png(256, 256), { images: undecodable }))).toBe('logo_type');
    for (const images of [gifInside, svgInside, otherSize, undecodable]) expect(images.calls.transforms).toEqual([]);
  });

  it('an encoder answer that isn’t a 256 × 256 PNG, or is over 128 KiB once stripped, is refused', async () => {
    const app = await seedHotApp();
    const c = caller(app.org, app.id);
    expect(await errorCode(await upload(c, png(300, 300), { images: fakeImages({ output: png(256, 200) }) }))).toBe('logo_type');
    expect(await errorCode(await upload(c, png(300, 300), { images: fakeImages({ output: jpeg(256, 256) }) }))).toBe('logo_type');
    expect(await errorCode(await upload(c, png(300, 300), { images: fakeImages({ contentType: 'image/jpeg' }) }))).toBe('logo_type');
    expect(await errorCode(await upload(c, png(300, 300), { images: fakeImages({ output: png(256, 256, { idat: 128 * 1024 }) }) }))).toBe('logo_too_large');
    expect(await logoKey(app.id)).toBeNull();
  });

  it('needs a Content-Length and ?expectedVersion', async () => {
    const app = await seedHotApp();
    const c = caller(app.org, app.id);
    expect(await errorCode(await upload(c, png(256, 256), { contentLength: false }))).toBe('bad_request');
    expect(await errorCode(await upload(c, png(256, 256), { version: null }))).toBe('bad_request');
  });

  it('without the Images binding, uploads answer internal (never a logo stored unchecked)', async () => {
    const app = await seedHotApp();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await logoUploadRoute(
      new Request(`${ORIGIN}/api/orgs/${app.org}/apps/${app.id}/logo?expectedVersion=0`, { method: 'POST', headers: { 'content-length': String(png(256, 256).length) }, body: png(256, 256) }),
      { ...env, IMAGES: undefined } as Env,
      info(),
      caller(app.org, app.id),
    );
    expect([res.status, await errorCode(res)]).toEqual([500, 'internal']);
    expect(errors).toHaveBeenCalled();
  });
});

/**
 * ConsoleRpc's hot-DB budget is global (30 statements/s, burst 60; apps/api changes/guard.ts) and an upload spends 8
 * (getApp, setLogo): these tests give it a second to refill first, so they test the logo, not the budget.
 */
const refill = () => new Promise((r) => setTimeout(r, 1_000));

describe('logo upload: stored and pointed at', () => {
  beforeEach(refill);

  it('a JPEG becomes a 256 × 256 PNG without metadata, at logos/<app>/<sha256>.png, and GET-able through the API', async () => {
    const app = await seedHotApp();
    const c = caller(app.org, app.id);
    const images = fakeImages();
    const version = await settingsVersion(app.id);
    const res = await upload(c, jpeg(640, 600), { images });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logoUrl: string; version: number };
    // Re-encoded exactly as the spec says: fit inside 256 × 256, transparent padding, PNG.
    expect(images.calls.transforms).toEqual([{ width: 256, height: 256, fit: 'pad', background: 'rgba(0,0,0,0)' }]);
    expect(images.calls.outputs).toEqual([{ format: 'image/png', anim: false }]);
    expect([LOGO_TRANSFORM, LOGO_OUTPUT]).toEqual([images.calls.transforms[0], images.calls.outputs[0]]);
    // The input decoded once, the output decoded again.
    expect(images.calls.info).toBe(2);
    const key = body.logoUrl.slice(`${FILES}/`.length);
    expect(key).toMatch(new RegExp(`^logos/${app.id}/[0-9a-f]{64}\\.png$`, 'u'));
    expect(body.version).toBe(version + 1);
    const obj = (await env.LOGOS!.get(key))!;
    expect(obj.httpMetadata?.contentType).toBe('image/png');
    const stored = new Uint8Array(await obj.arrayBuffer());
    // No metadata chunk the encoder wrote survives; the key is the stored bytes' sha256.
    expect(pngChunkTypes(stored)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(key).toBe(`logos/${app.id}/${[...new Uint8Array(await crypto.subtle.digest('SHA-256', stored))].map((b) => b.toString(16).padStart(2, '0')).join('')}.png`);
    // The pointer, through ConsoleRpc (app_changes has the change); getApp serves the same URL.
    expect(await logoKey(app.id)).toBe(key);
    const changes = await env.HOT_DB.prepare("SELECT kind FROM app_changes WHERE app_id = ? AND kind LIKE 'app.logo%'").bind(app.id).all<{ kind: string }>();
    expect(changes.results).toEqual([{ kind: 'app.logo_set' }]);
    const view = await env.API.getApp({ actor: c.actor, requestId: rid(), clientIp: '203.0.113.9', orgId: app.org, appId: app.id });
    expect(view.ok && view.app.logoUrl).toBe(body.logoUrl);
    // Recorded for the purge, unmarked; and the outcome in the console's audit log.
    expect(await rowOf(key)).toEqual({ app_id: app.id, replaced_at: null });
    const audit = await auditRows("action = 'app.logo_set' AND app_id = ?", app.id);
    expect(audit).toEqual([expect.objectContaining({ actor_kind: 'member', org_id: app.org, outcome: 'ok', details_json: JSON.stringify({ logoKey: key }) })]);
  });

  it('PNG and WebP uploads too; a replaced logo is marked, the current one is not', async () => {
    const app = await seedHotApp();
    const c = caller(app.org, app.id);
    const first = (await (await upload(c, png(512, 512), { images: fakeImages({ output: png(256, 256, { seed: 1 }) }) })).json()) as { logoUrl: string };
    const second = (await (await upload(c, webp(400, 400), { images: fakeImages({ output: png(256, 256, { seed: 2 }) }) })).json()) as { logoUrl: string };
    const k1 = first.logoUrl.slice(FILES.length + 1);
    const k2 = second.logoUrl.slice(FILES.length + 1);
    expect(k1).not.toBe(k2);
    expect(await logoKey(app.id)).toBe(k2);
    expect((await rowOf(k1))!.replaced_at).toEqual(expect.any(Number));
    expect((await rowOf(k2))!.replaced_at).toBeNull();
    // The replaced object stays in R2 until the hourly purge, 30 days on (cron.test.ts).
    expect(await env.LOGOS!.head(k1)).not.toBeNull();
    // The same image again (its key is the hash): current again, and the other one replaced.
    const third = (await (await upload(c, png(512, 512), { images: fakeImages({ output: png(256, 256, { seed: 1 }) }) })).json()) as { logoUrl: string };
    expect(third.logoUrl).toBe(first.logoUrl);
    expect(await logoKey(app.id)).toBe(k1);
    expect((await rowOf(k1))!.replaced_at).toBeNull();
    expect((await rowOf(k2))!.replaced_at).toEqual(expect.any(Number));
  });

  it('the current logo again changes nothing (no new version, no app_changes row)', async () => {
    const app = await seedHotApp();
    const c = caller(app.org, app.id);
    const a = (await (await upload(c, png(300, 300))).json()) as { logoUrl: string; version: number };
    const b = (await (await upload(c, png(300, 300))).json()) as { logoUrl: string; version: number };
    expect(b).toEqual(a);
    expect(await settingsVersion(app.id)).toBe(a.version);
  });

  it('a stale screen (version_conflict) and another org’s app (not_found) are refused before any transform', async () => {
    const app = await seedHotApp();
    const images = fakeImages();
    const stale = await upload(caller(app.org, app.id), png(300, 300), { images, version: (await settingsVersion(app.id)) + 5 });
    expect([stale.status, await errorCode(stale)]).toEqual([409, 'version_conflict']);
    const other = await upload(caller(newId('org'), app.id), png(300, 300), { images, version: 0 });
    expect([other.status, await errorCode(other)]).toEqual([404, 'not_found']);
    expect(images.calls.transforms).toEqual([]);
    expect(await logoKey(app.id)).toBeNull();
  });

  it('a setLogo that fails after the object is written leaves only an unmarked object, audited as failed', async () => {
    const app = await seedHotApp();
    const c = caller(app.org, app.id);
    const failing = { getApp: (x: never) => env.API.getApp(x), setLogo: async () => ({ ok: false as const, code: 'version_conflict' as const, error: 'moved' }) };
    const res = await upload(c, png(300, 300), { e: { API: failing as unknown as Env['API'] } });
    expect(await errorCode(res)).toBe('version_conflict');
    expect(await logoKey(app.id)).toBeNull();
    const audit = await auditRows("action = 'app.logo_set' AND app_id = ?", app.id);
    expect(audit).toEqual([expect.objectContaining({ outcome: 'failed', details_json: expect.stringContaining('"code":"version_conflict"') })]);
  });

  it('uploads are limited per org (each is a paid transform)', async () => {
    const app = await seedHotApp();
    const c = caller(app.org, app.id);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await upload(c, SVG)).status);
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});

describe('logo removal', () => {
  beforeEach(refill);

  it('points at nothing and marks the old object; with no logo it changes nothing', async () => {
    const app = await seedHotApp();
    const c = caller(app.org, app.id);
    const { logoUrl } = (await (await upload(c, png(300, 300))).json()) as { logoUrl: string };
    const res = await logoRemoveRoute(env as Env, info(), c, await settingsVersion(app.id));
    expect(res.status).toBe(200);
    expect(await logoKey(app.id)).toBeNull();
    expect((await rowOf(logoUrl.slice(FILES.length + 1)))!.replaced_at).toEqual(expect.any(Number));
    expect((await auditRows("action = 'app.logo_removed' AND app_id = ?", app.id)).map((r) => r.outcome)).toEqual(['ok']);
    const v = await settingsVersion(app.id);
    expect(await (await logoRemoveRoute(env as Env, info(), c, v)).json()).toEqual({ version: v });
  });
});

describe('CSRF on the logo route', () => {
  const at = (path: string, type: string) =>
    new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { ...CSRF, 'content-type': type } });
  const LOGO = '/api/orgs/org_abc/apps/app_def/logo';

  it('takes exactly application/octet-stream there, JSON everywhere else', () => {
    expect(LOGO_UPLOAD_PATH_RE.test(LOGO)).toBe(true);
    expect(bodyTypeFor(LOGO)).toBe('application/octet-stream');
    expect(csrfProblem(at(LOGO, 'application/octet-stream'), ORIGIN)).toBeNull();
    for (const t of ['application/json', 'image/png', 'text/plain', 'multipart/form-data', 'application/x-www-form-urlencoded']) expect(csrfProblem(at(LOGO, t), ORIGIN), t).toBe('content-type');
    expect(csrfProblem(at('/api/cancel', 'application/octet-stream'), ORIGIN)).toBe('content-type');
    for (const p of [`${LOGO}/x`, '/api/orgs/org_abc/apps/app_def/logo2', '/api/orgs/abc/apps/app_def/logo']) expect(bodyTypeFor(p), p).toBe('application/json');
  });

  it('the other three checks still apply to it', () => {
    const r = (h: Record<string, string>) => new Request(`${ORIGIN}${LOGO}`, { method: 'POST', headers: { ...CSRF, 'content-type': 'application/octet-stream', ...h } });
    expect(csrfProblem(r({ 'sec-fetch-site': 'cross-site' }), ORIGIN)).toBe('sec-fetch-site');
    expect(csrfProblem(r({ origin: 'https://evil.example' }), ORIGIN)).toBe('origin');
    expect(csrfProblem(r({ 'x-hana-console': '0' }), ORIGIN)).toBe('x-hana-console');
  });

  it('the upload route needs a session (C10): 401 after CSRF passes, before the body is read', async () => {
    const res = await request(LOGO, { method: 'POST', headers: { ...CSRF, 'content-type': 'application/octet-stream' }, body: 'x' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'unauthenticated' } });
  });
});
