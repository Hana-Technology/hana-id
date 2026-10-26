import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.ts';
import { GOOGLE_JWKS_URL, type Jwk, REMOVE_AFTER_MISSING_MS, diffIssuerKeys, issuerKids, syncIssuerKeys, usableJwks } from '../src/issuer-keys.ts';
import { NearMock, panic } from './near-mock.ts';

afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM issuer_key_missing').run();
});

const N = 'x'.repeat(342);
const jwk = (kid: string, extra: Partial<Jwk> = {}): Jwk => ({ kid, n: N, e: 'AQAB', kty: 'RSA', alg: 'RS256', use: 'sig', ...extra });
const updaterPk = (): string => KeyPair.fromString(env.KEYS_UPDATER_KEY as KeyPairString).getPublicKey().toString();

function chainWithKids(kids: string[]): NearMock & { kids: Set<string> } {
  const near = Object.assign(new NearMock(), { kids: new Set(kids) });
  near.views.get_issuer = (a) => (a.provider === 'google' ? { provider: 'google', iss_values: ['https://accounts.google.com'], kids: [...near.kids] } : null);
  near.contract.set_issuer_key = (a) => void near.kids.add(a.kid as string);
  near.contract.remove_issuer_key = (a) => void near.kids.delete(a.kid as string);
  near.install();
  return near;
}

describe('JWKS diffing', () => {
  it('adds missing kids and removes kids Google no longer publishes', () => {
    expect(diffIssuerKeys([jwk('a'), jwk('b')], ['b', 'c'])).toEqual({ add: [jwk('a')], remove: ['c'] });
    expect(diffIssuerKeys([jwk('a')], ['a'])).toEqual({ add: [], remove: [] });
    expect(diffIssuerKeys([jwk('a'), jwk('a')], [])).toEqual({ add: [jwk('a')], remove: [] });
  });

  it('never removes everything when the JWKS is empty', () => {
    expect(diffIssuerKeys([], ['a', 'b'])).toEqual({ add: [], remove: [] });
  });

  it('keeps only RS256 RSA signing keys', () => {
    const keys = usableJwks({
      keys: [jwk('ok'), jwk('noalg', { alg: undefined }), jwk('es', { kty: 'EC' }), jwk('ps', { alg: 'PS256' }), jwk('enc', { use: 'enc' }), jwk('bad-n', { n: 'a+b/' }), { kid: 5 }],
    });
    expect(keys.map((k) => k.kid)).toEqual(['ok', 'noalg']);
    expect(usableJwks(null)).toEqual([]);
    expect(usableJwks({ keys: 'x' })).toEqual([]);
  });

  it('reads kids from the get_issuer view in its accepted shapes', () => {
    expect(issuerKids({ kids: ['a'] })).toEqual(['a']);
    expect(issuerKids({ keys: ['a'] })).toEqual(['a']);
    expect(issuerKids(['a', 1])).toEqual(['a']);
    expect(issuerKids(null)).toBeNull();
  });
});

describe('scheduled JWKS sync', () => {
  it('runs from the cron trigger: set_issuer_key for new kids; a stale kid is removed only once it stays missing', async () => {
    const near = chainWithKids(['old', 'kept']);
    near.jwks = { keys: [jwk('kept'), jwk('new1'), jwk('new2')] };
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: '0 * * * *' }), env, ctx);
    await waitOnExecutionContext(ctx);

    // First run that sees 'old' missing: adds only.
    expect(near.sent.map((t) => [t.method, t.args.kid])).toEqual([
      ['set_issuer_key', 'new1'],
      ['set_issuer_key', 'new2'],
    ]);
    expect(near.sent[0]!.args).toEqual({ provider: 'google', kid: 'new1', n: N, e: 'AQAB' });
    // Next hourly run, still missing: removed.
    const later = Date.now() + 60 * 60_000;
    expect(await syncIssuerKeys(env, 'google', GOOGLE_JWKS_URL, later)).toEqual({ added: [], removed: ['old'], failed: [] });
    expect(near.sent[2]!.args).toEqual({ provider: 'google', kid: 'old' });
    // Signed by the keys-updater key on the signer account itself, consecutive nonces.
    expect(near.sent.every((t) => t.signerId === env.SIGNER_ACCOUNT && t.receiverId === env.SIGNER_ACCOUNT && t.publicKey === updaterPk())).toBe(true);
    expect(near.sent.map((t) => t.nonce)).toEqual([101n, 102n, 103n]);
    expect(near.sent.every((t) => t.gas === 30_000_000_000_000n)).toBe(true);
    expect([...near.kids].sort()).toEqual(['kept', 'new1', 'new2']);
    // Nothing left to track.
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM issuer_key_missing').first<{ n: number }>())!.n).toBe(0);
  });

  it('does not remove a key that one JWKS fetch omitted but the next one lists again', async () => {
    const near = chainWithKids(['k1', 'k2', 'k3']);
    const t0 = Date.now();
    // A stale response without the pre-published k3.
    near.jwks = { keys: [jwk('k1'), jwk('k2')] };
    expect(await syncIssuerKeys(env, 'google', GOOGLE_JWKS_URL, t0)).toEqual({ added: [], removed: [], failed: [] });
    // k3 is back an hour later: the missing mark is cleared.
    near.jwks = { keys: [jwk('k1'), jwk('k2'), jwk('k3')] };
    expect(await syncIssuerKeys(env, 'google', GOOGLE_JWKS_URL, t0 + 60 * 60_000)).toEqual({ added: [], removed: [], failed: [] });
    // Omitted once more much later: counts from scratch, so still not removed.
    near.jwks = { keys: [jwk('k1'), jwk('k2')] };
    expect(await syncIssuerKeys(env, 'google', GOOGLE_JWKS_URL, t0 + 2 * 60 * 60_000)).toEqual({ added: [], removed: [], failed: [] });
    expect(await syncIssuerKeys(env, 'google', GOOGLE_JWKS_URL, t0 + 2 * 60 * 60_000 + REMOVE_AFTER_MISSING_MS - 1)).toEqual({ added: [], removed: [], failed: [] });
    expect(near.sent).toHaveLength(0);
    expect([...near.kids].sort()).toEqual(['k1', 'k2', 'k3']);
  });

  it('does nothing when the chain already matches', async () => {
    const near = chainWithKids(['a', 'b']);
    near.jwks = { keys: [jwk('b'), jwk('a')] };
    expect(await syncIssuerKeys(env)).toEqual({ added: [], removed: [], failed: [] });
    expect(near.sent).toHaveLength(0);
  });

  it('touches nothing when the JWKS fetch fails or is empty', async () => {
    const near = chainWithKids(['a']);
    near.jwksStatus = 500;
    expect((await syncIssuerKeys(env)).skipped).toBe('jwks_fetch_failed');
    near.jwksStatus = 200;
    near.jwks = { keys: [] };
    expect((await syncIssuerKeys(env)).skipped).toBe('jwks_empty');
    near.jwks = { keys: [jwk('x', { kty: 'EC' })] };
    expect((await syncIssuerKeys(env)).skipped).toBe('jwks_empty');
    expect(near.sent).toHaveLength(0);
  });

  it('skips when the issuer is not configured on chain', async () => {
    const near = chainWithKids([]);
    near.views.get_issuer = () => null;
    near.jwks = { keys: [jwk('a')] };
    expect((await syncIssuerKeys(env)).skipped).toBe('issuer_not_configured');
    expect(near.sent).toHaveLength(0);
  });

  it('keeps stale keys when adding a new key failed', async () => {
    const near = chainWithKids(['old']);
    near.jwks = { keys: [jwk('new')] };
    near.contract.set_issuer_key = () => panic('Only the owner can do this');
    const result = await syncIssuerKeys(env);
    expect(result).toMatchObject({ added: [], removed: [], failed: ['new'] });
    expect(near.sent.map((t) => t.method)).toEqual(['set_issuer_key']);
  });

  it('recovers from InvalidNonce once', async () => {
    const near = chainWithKids([]);
    near.jwks = { keys: [jwk('a')] };
    let first = true;
    near.onSendTx = (tx) => {
      if (!first) return undefined;
      first = false;
      near.akNonce.set(tx.publicKey, 500n);
      return { error: { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION' }, data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { ak_nonce: 500, tx_nonce: Number(tx.nonce) } } } } } };
    };
    expect(await syncIssuerKeys(env)).toMatchObject({ added: ['a'], failed: [] });
    expect(near.sent.map((t) => t.nonce)).toEqual([501n]);
  });

  it('skips with a malformed keys-updater key', async () => {
    const near = chainWithKids([]);
    near.jwks = { keys: [jwk('a')] };
    expect((await syncIssuerKeys({ ...env, KEYS_UPDATER_KEY: 'not-a-key' })).skipped).toBe('bad_keys_updater_key');
    expect(near.sent).toHaveLength(0);
  });

  it('skips without a keys-updater key', async () => {
    const near = chainWithKids([]);
    expect((await syncIssuerKeys({ ...env, KEYS_UPDATER_KEY: undefined })).skipped).toBe('no_keys_updater_key');
    expect(near.rpcMethods).toHaveLength(0);
  });
});
