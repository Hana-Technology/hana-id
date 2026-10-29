// The request timings a pk_test_ app's responses carry (docs/api.md "Timings"): `/v1/login`, `/v1/vault/shares` and
// `/v1/vault/unlock` answer with `timings: {totalMs, phases}` on success, only for pk_test_ keys, with durations and
// phase names only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearKekCache } from '../src/vault/kek.ts';
import { call, chain, newKey, seedApp, uid } from './helpers.ts';
import { hanaHeaders, loginBody, withCombinedCall } from './login-helpers.ts';
import { act, createShare, vaultSetup } from './vault-helpers.ts';

afterEach(() => {
  vi.restoreAllMocks();
  clearKekCache();
});

const body = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;

/** Every phase a request log can name (handlers.ts `lap`/`lapRelay`, vault/endpoints.ts). */
const PHASES = new Set(['app', 'limits', 'checks', 'relay', 'relayDispatch', 'relayQueue', 'relayChainRead', 'relaySign', 'relayPersist', 'relayOutcome', 'settings', 'session', 'insert', 'shareLimit', 'share', 'advance']);

/** `{totalMs, phases}` with known phase names and finite durations ≥ 0, no more than the total, and nothing else. */
function expectTimings(t: unknown, phases: string[]): void {
  expect(Object.keys(t as object).sort()).toEqual(['phases', 'totalMs']);
  const { totalMs, phases: got } = t as { totalMs: number; phases: Record<string, number> };
  expect(Number.isFinite(totalMs) && totalMs >= 0).toBe(true);
  for (const p of phases) expect(got).toHaveProperty(p);
  for (const [name, ms] of Object.entries(got)) {
    expect(PHASES.has(name)).toBe(true);
    expect(Number.isFinite(ms) && ms >= 0 && ms <= totalMs).toBe(true);
  }
}

async function loginSetup(key?: string) {
  const app = await seedApp(key ? { key } : {});
  const aud = `${uid()}.apps.googleusercontent.com`;
  withCombinedCall(chain({ [aud]: app.scope }));
  return { app, req: await loginBody(app.scope, aud) };
}

describe('POST /v1/login timings', () => {
  it('a pk_test_ app gets the request total and its gate, checks and relay phases; nothing sensitive', async () => {
    const { app, req } = await loginSetup();
    const res = await call('/v1/login', { headers: hanaHeaders(app), body: req });
    expect(res.status).toBe(200);
    const json = await body(res);
    expectTimings(json.timings, ['app', 'limits', 'checks', 'relay', 'relayDispatch', 'relayOutcome']);
    // Durations under names only: the token, the session key, the transaction and the request id stay out of it.
    const text = JSON.stringify(json.timings);
    for (const secret of [req.jwt as string, JSON.stringify(req.sessionPublicKey).slice(1, -1), json.nearTx as string, json.requestId as string]) expect(text).not.toContain(secret);
    expect(text).toMatch(/^[{}":,a-zA-Z0-9.]+$/u);
  });

  it('a pk_live_ app never gets timings', async () => {
    const { app, req } = await loginSetup(newKey('pk_live_'));
    const res = await call('/v1/login', { headers: hanaHeaders(app), body: req });
    expect(res.status).toBe(200);
    expect(await body(res)).not.toHaveProperty('timings');
  });

  it('an error answer carries no timings', async () => {
    const { app } = await loginSetup();
    const res = await call('/v1/login', { headers: hanaHeaders(app), body: { jwt: 'x' } });
    expect(res.status).toBe(400);
    expect(await body(res)).not.toHaveProperty('timings');
  });
});

describe('vault endpoint timings', () => {
  it('share creation and unlock answer a pk_test_ app with their phases; touch never does', async () => {
    const { app, near } = await vaultSetup();
    const share = await createShare(app, near);
    expectTimings((share as unknown as { timings: unknown }).timings, ['app', 'limits', 'settings', 'session', 'insert']);
    const unlocked = await body(await act(app, share, 'unlock', 1));
    // The share's own limit is asked alongside the gate's (D78): it is inside `limits`, no `shareLimit` phase.
    expectTimings(unlocked.timings, ['app', 'limits', 'share', 'advance']);
    // K_s and the share id are in the body, never in its timings.
    expect(JSON.stringify(unlocked.timings)).not.toContain(JSON.stringify(unlocked.ks).slice(1, -1));
    expect(await body(await act(app, share, 'touch', 2))).not.toHaveProperty('timings');
  });

  it('a pk_live_ app never gets timings from share creation or unlock', async () => {
    const { app, near } = await vaultSetup({ key: newKey('pk_live_') });
    const share = await createShare(app, near);
    expect(share).not.toHaveProperty('timings');
    const res = await act(app, share, 'unlock', 1);
    expect(res.status).toBe(200);
    expect(await body(res)).not.toHaveProperty('timings');
  });
});
