import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.ts';
import { pruneShares, rewrapShares, vaultMaintenance } from '../src/vault/cron.ts';
import { clearKekCache, loadKeks, parseKek, unwrapShareKey, wrapShareKey } from '../src/vault/kek.ts';
import { NearMock } from './near-mock.ts';
import { act, createShare, newKek, setShare, storedShare, vaultSetup } from './vault-helpers.ts';

afterEach(() => {
  vi.restoreAllMocks();
  clearKekCache();
});

describe('KEK envelope', () => {
  it('wraps K_s bound to the share, the app and the session key', async () => {
    const kek = (await parseKek(newKek(3)))!;
    expect(kek.id).toBe(3);
    const binding = { shareId: new Uint8Array(16).fill(1), appId: 'app_a', sessionPk: new Uint8Array(32).fill(2) };
    const ks = crypto.getRandomValues(new Uint8Array(32));
    const enc = await wrapShareKey(kek, binding, ks);
    expect(enc).toHaveLength(60);
    expect(await unwrapShareKey(kek, binding, enc)).toEqual(ks);
    // A fresh IV per wrap.
    expect(await wrapShareKey(kek, binding, ks)).not.toEqual(enc);
    for (const moved of [{ ...binding, shareId: new Uint8Array(16).fill(9) }, { ...binding, appId: 'app_b' }, { ...binding, sessionPk: new Uint8Array(32).fill(9) }]) {
      expect(await unwrapShareKey(kek, moved, enc)).toBeNull();
    }
    const tampered = enc.slice();
    tampered[20]! ^= 1;
    expect(await unwrapShareKey(kek, binding, tampered)).toBeNull();
    expect(await unwrapShareKey((await parseKek(newKek(3)))!, binding, enc)).toBeNull();
    await expect(wrapShareKey(kek, binding, new Uint8Array(31))).rejects.toThrow();
  });

  it('parses only `<id>:<base64 of 32 bytes>`', async () => {
    const b64 = newKek(1).split(':')[1]!;
    expect((await parseKek(`7:${b64}`))?.id).toBe(7);
    for (const bad of [undefined, '', b64, `0:${b64}`, `-1:${b64}`, `x:${b64}`, `1:${b64.slice(4)}`, `1:${b64}AAAA`, `1:${b64.replace(/=$/u, '')}`]) expect(await parseKek(bad)).toBeNull();
    expect(await loadKeks({ VAULT_KEK: `1:${b64}`, VAULT_KEK_PREVIOUS: 'junk' })).toBeNull();
    expect((await loadKeks({ VAULT_KEK: `2:${b64}`, VAULT_KEK_PREVIOUS: newKek(1) }))?.previous?.id).toBe(1);
  });
});

describe('vault cron', () => {
  it('runs from the scheduled trigger: prunes revoked and absolutely expired shares, keeps live and idle-expired ones', async () => {
    const { app, near } = await vaultSetup();
    const live = await createShare(app, near);
    const revoked = await createShare(app, near);
    const expired = await createShare(app, near);
    const idle = await createShare(app, near);
    await setShare(revoked.shareId, { revoked_at: Date.now() });
    await setShare(expired.shareId, { abs_expires_at: Date.now() - 1 });
    await setShare(idle.shareId, { idle_until: Date.now() - 1 });
    vi.restoreAllMocks();
    // The JWKS sync runs alongside (and needs its own chain answers).
    const jwks = new NearMock();
    jwks.views.get_issuer = () => ({ provider: 'google', iss_values: [], kids: [] });
    jwks.install();
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: '*/15 * * * *', scheduledTime: Date.UTC(2026, 9, 29, 12, 0) }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await storedShare(live.shareId)).not.toBeNull();
    expect(await storedShare(idle.shareId)).not.toBeNull();
    expect(await storedShare(revoked.shareId)).toBeNull();
    expect(await storedShare(expired.shareId)).toBeNull();
    expect(await pruneShares(env.DB, Date.now())).toBe(0);
  });

  it('re-wraps rows under the previous KEK, which then unlock under the current one alone', async () => {
    const { app, near } = await vaultSetup();
    const shares = [await createShare(app, near), await createShare(app, near), await createShare(app, near)];
    const current = newKek(5);
    const rotated = { ...env, VAULT_KEK: current, VAULT_KEK_PREVIOUS: env.VAULT_KEK };
    const result = await vaultMaintenance(rotated);
    expect(result.rewrapped).toBeGreaterThanOrEqual(3);
    expect(result.unknownKek).toBe(0);
    for (const s of shares) expect((await storedShare(s.shareId))!.kek_id).toBe(5);
    // Nothing left under the old id.
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM vault_shares WHERE kek_id = 1').first<{ n: number }>())!.n).toBe(0);
    const res = await act(app, shares[0]!, 'unlock', 1, { env: { VAULT_KEK: current } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ks: shares[0]!.ks });
    // Back to the original key for the other tests: re-wrap everything to it.
    await vaultMaintenance({ ...env, VAULT_KEK: env.VAULT_KEK, VAULT_KEK_PREVIOUS: current });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM vault_shares WHERE kek_id = 5').first<{ n: number }>())!.n).toBe(0);
  });

  it('never overwrites a row the previous KEK can’t read, and bounds a run', async () => {
    const { app, near } = await vaultSetup();
    const a = await createShare(app, near);
    const b = await createShare(app, near);
    const c = await createShare(app, near);
    const encA = (await storedShare(a.shareId))!.share_enc;
    await env.DB.prepare('UPDATE vault_shares SET share_enc = ?1 WHERE share_id = ?2').bind(Uint8Array.from(encA), Uint8Array.from(b.shareId)).run();
    const keks = (await loadKeks({ VAULT_KEK: newKek(6), VAULT_KEK_PREVIOUS: env.VAULT_KEK }))!;
    const before = (await storedShare(b.shareId))!.share_enc;
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => void lines.push(line));
    // A run handles at most `limit` rows.
    expect(await rewrapShares(env.DB, keks, 1)).toBeLessThanOrEqual(1);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM vault_shares WHERE kek_id = 6').first<{ n: number }>())!.n).toBeLessThanOrEqual(1);
    await rewrapShares(env.DB, keks);
    expect((await storedShare(b.shareId))!).toMatchObject({ kek_id: 1, share_enc: before });
    expect((await storedShare(a.shareId))!.kek_id).toBe(6);
    expect((await storedShare(c.shareId))!.kek_id).toBe(6);
    expect(lines.some((l) => l.includes('vault_rewrap_unreadable'))).toBe(true);
    const result = await vaultMaintenance({ ...env, VAULT_KEK: newKek(7) });
    expect(result.unknownKek).toBeGreaterThan(0);
    await env.DB.prepare('DELETE FROM vault_shares WHERE kek_id != 1').run();
  });

  it('without VAULT_KEK it still prunes, and warns', async () => {
    const { app, near } = await vaultSetup();
    const revoked = await createShare(app, near);
    await setShare(revoked.shareId, { revoked_at: Date.now() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await vaultMaintenance({ ...env, VAULT_KEK: undefined });
    expect(result.pruned).toBeGreaterThanOrEqual(1);
    expect(await storedShare(revoked.shareId)).toBeNull();
    expect(warn.mock.calls.some(([l]) => String(l).includes('vault_key_unavailable'))).toBe(true);
  });
});
