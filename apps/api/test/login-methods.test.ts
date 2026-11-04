// apps.login_methods (migration 0010) as the API reads it, and the signer panics it turns into errors.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { appLoginMethods, parseLoginMethods } from '../src/login-methods.ts';
import { signerPanic } from '../src/panics.ts';
import { seedApp } from './helpers.ts';

describe('login_methods', () => {
  it('parses the column: Google by default, a fixed order, unknown names ignored', () => {
    expect(parseLoginMethods(null)).toEqual(['google']);
    expect(parseLoginMethods(undefined)).toEqual(['google']);
    expect(parseLoginMethods('')).toEqual(['google']);
    expect(parseLoginMethods('google')).toEqual(['google']);
    expect(parseLoginMethods('email,google')).toEqual(['google', 'email']);
    expect(parseLoginMethods(' email ')).toEqual(['email']);
    expect(parseLoginMethods('apple')).toEqual([]);
  });

  it('every app starts Google-only (the migration default)', async () => {
    const app = await seedApp();
    expect(await appLoginMethods(env.DB, app.id)).toEqual(['google']);
  });

  it('before migration 0010 (no column) every app is Google-only; any other D1 error throws', async () => {
    const missing = { prepare: () => ({ bind: () => ({ first: () => Promise.reject(new Error('D1_ERROR: no such column: login_methods: SQLITE_ERROR')) }) }) } as unknown as D1Database;
    expect(await appLoginMethods(missing, 'app_x')).toEqual(['google']);
    const down = { prepare: () => ({ bind: () => ({ first: () => Promise.reject(new Error('D1_ERROR: network')) }) }) } as unknown as D1Database;
    await expect(appLoginMethods(down, 'app_x')).rejects.toThrow(/network/u);
  });
});

describe('a real D1 before migration 0010 (batch 6 review L7)', () => {
  it('reads every app as Google-only, and 0010 then applies on it', async () => {
    const db = env.PRE_0010_DB;
    await applyD1Migrations(db, env.TEST_MIGRATIONS.filter((m) => m.name < '0010'));
    await db.prepare("INSERT OR IGNORE INTO scopes (scope_id, org_id, environment, created_at, assigned_at) VALUES ('s0', 'org_legacy', 'test', 0, 0)").run();
    await db.prepare("INSERT INTO apps (id, name, scope_id, publishable_key) VALUES ('app_pre', 'Pre', 's0', 'pk_test_1111111111111111111111111111111p')").run();
    expect(await appLoginMethods(db, 'app_pre')).toEqual(['google']);
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    expect(await appLoginMethods(db, 'app_pre')).toEqual(['google']);
    await db.prepare("UPDATE apps SET login_methods = 'google,email' WHERE id = 'app_pre'").run();
    expect(await appLoginMethods(db, 'app_pre')).toEqual(['google', 'email']);
  });
});

describe('signer panics as errors', () => {
  const failure = (error: string, executor = env.SIGNER_ACCOUNT) => ({ ok: false as const, status: 422, code: 'contract_rejected' as const, error, executor, nearTx: 'tx' });

  it('the states have their own codes (409), the link refusals a reason; other receipts and other panics are left alone', () => {
    expect(signerPanic(env, failure('Smart contract panicked: Links wait until the owner accepts the wallets opened before v3'))).toMatchObject({ status: 409, body: { code: 'links_unavailable' } });
    expect(signerPanic(env, failure('Sign-in method is linked to an account'))).toMatchObject({ status: 409, body: { code: 'identity_linked' } });
    expect(signerPanic(env, failure('Sign-in method link is pending'))).toMatchObject({ status: 409, body: { code: 'link_pending' } });
    expect(signerPanic(env, failure('Sign-in method is already linked'))).toMatchObject({ status: 422, body: { code: 'contract_rejected', reason: 'already_linked' } });
    expect(signerPanic(env, failure('Wrong epoch'))).toMatchObject({ body: { reason: 'stale_epoch' } });
    expect(signerPanic(env, failure('Sign-in method link is pending', env.MPC_ACCOUNT))).toBeNull();
    expect(signerPanic(env, failure('Session key already in use'))).toBeNull();
    expect(signerPanic(env, { ok: false, status: 504, code: 'timeout', error: 'Sign-in method link is pending', nearTx: 'tx' } as never)).toBeNull();
  });
});
