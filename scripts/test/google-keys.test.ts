// post-google-keys on the governance contract: proposes adds and removals, executes due changes only with --execute,
// never calls remove_issuer_key (owner-only now), never executes a pending key Google doesn't publish. A v1 contract
// keeps the direct set/remove.
import { describe, expect, it } from 'vitest';
import { loadEnv } from '@hana-id/env';
import { KeyPair } from '@near-js/crypto';
import type { Action } from '@near-js/transactions';
import type { KeyChangeView } from '../lib/contract.ts';
import { normB64url, planKeySync, postGoogleKeysMain } from '../lib/google-keys.ts';
import { writeKeysUpdater } from '../lib/keys.ts';
import type { TxSigner } from '../lib/near.ts';
import { NOW, tempRoots } from './sim-fixtures.ts';

const m = loadEnv('sandbox-dev');
const N = (s: string) => Buffer.from(s.padEnd(256, s)).toString('base64url');
const jwks = (...kids: string[]) => ({ keys: kids.map((kid) => ({ kid, kty: 'RSA', alg: 'RS256', use: 'sig', n: N(kid), e: 'AQAB' })) });
const change = (over: Partial<KeyChangeView>): KeyChangeView => ({ id: 1, provider: 'google', kid: 'k', op: 'Add', n: null, e: null, by: m.signer, proposed_at_ms: NOW - 1000, executable_at_ms: NOW + 1000, ...over });

describe('planKeySync', () => {
  it('proposes new kids and removals of retired ones, skipping kids already pending', () => {
    const p = planKeySync('google', ['old', 'cur'], [change({ id: 4, kid: 'pend', n: N('pend'), e: 'AQAB' })], jwks('cur', 'new', 'pend'), NOW, false);
    expect(p.actions).toEqual([
      { kind: 'propose-add', kid: 'new', n: N('new'), e: 'AQAB' },
      { kind: 'propose-removal', kid: 'old' },
    ]);
    expect(p.notes.join()).toContain('#4 Add pend is due at');
  });

  it('never proposes removing the last active key', () => {
    const p = planKeySync('google', ['old'], [], jwks('new'), NOW, false);
    expect(p.actions).toEqual([{ kind: 'propose-add', kid: 'new', n: N('new'), e: 'AQAB' }]);
    expect(p.notes.join()).toContain('is the last active key');
    const pendingRemoval = planKeySync('google', ['a', 'b'], [change({ id: 2, kid: 'a', op: 'Remove' })], jwks('c'), NOW, false);
    expect(pendingRemoval.actions.filter((x) => x.kind === 'propose-removal')).toEqual([]);
  });

  it('executes due changes only with --execute, additions before removals', () => {
    const due = [change({ id: 7, kid: 'gone', op: 'Remove', executable_at_ms: NOW }), change({ id: 6, kid: 'new', n: N('new'), e: 'AQAB', executable_at_ms: NOW - 1 })];
    expect(planKeySync('google', ['gone', 'cur'], due, jwks('cur', 'new'), NOW, false).notes.join()).toContain('pass --execute');
    expect(planKeySync('google', ['gone', 'cur'], due, jwks('cur', 'new'), NOW, true).actions).toEqual([
      { kind: 'execute', id: 6, kid: 'new', op: 'Add' },
      { kind: 'execute', id: 7, kid: 'gone', op: 'Remove' },
    ]);
  });

  it('never executes a pending add Google does not publish (or with other key material), nor a removal of a published kid', () => {
    const forged = [change({ id: 8, kid: 'evil', n: N('evil'), e: 'AQAB', executable_at_ms: NOW }), change({ id: 9, kid: 'cur', n: N('x'), e: 'AQAB', executable_at_ms: NOW })];
    const p = planKeySync('google', ['cur', 'b'], [...forged, change({ id: 10, kid: 'b', op: 'Remove', executable_at_ms: NOW })], jwks('cur', 'b'), NOW, true);
    expect(p.actions).toEqual([]);
    expect(p.notes.join('\n')).toContain('#8 (evil');
    expect(p.notes.join('\n')).toContain('is not in');
    expect(p.notes.join('\n')).toContain('other key material');
    expect(p.notes.join('\n')).toContain('Google still publishes it');
  });

  it('compares n with leading zeros stripped, as get_key_changes reports it', () => {
    const n = Buffer.from([0, 0, 1, 2, 3]).toString('base64url');
    expect(normB64url(n)).toBe(Buffer.from([1, 2, 3]).toString('base64url'));
    const p = planKeySync('google', ['cur'], [change({ id: 3, kid: 'z', n: Buffer.from([1, 2, 3]).toString('base64url'), e: 'AQAB', executable_at_ms: NOW })], { keys: [{ kid: 'z', kty: 'RSA', n, e: 'AQAB' }, ...jwks('cur').keys] }, NOW, true);
    expect(p.actions).toEqual([{ kind: 'execute', id: 3, kid: 'z', op: 'Add' }]);
  });

  it('refuses an empty JWKS', () => {
    expect(() => planKeySync('google', ['a'], [], { keys: [] }, NOW, false)).toThrow('no usable RS256 keys');
  });
});

describe('postGoogleKeysMain', () => {
  async function run(argv: string[], chain: { kids: string[]; changes: KeyChangeView[] | null }) {
    const roots = tempRoots();
    writeKeysUpdater(m.name, m.signer, KeyPair.fromRandom('ed25519'), roots.secretsRoot);
    const sent: { signer: string; method: string; args: unknown }[] = [];
    const out: string[] = [];
    await postGoogleKeysMain(argv, {
      loadManifest: () => m,
      secretsRoot: roots.secretsRoot,
      now: () => NOW,
      fetchJwks: async () => jwks('cur', 'new'),
      log: (l) => out.push(l),
      rpc: () => ({
        chainId: async () => 'testnet',
        view: (async (_a: string, method: string) => {
          if (method === 'get_issuer') return { iss_values: [], kids: chain.kids };
          if (method === 'get_key_changes') {
            if (!chain.changes) throw new Error('MethodNotFound');
            return chain.changes;
          }
          return null;
        }) as <T>() => Promise<T>,
        sendTx: async (signer: TxSigner, _r: string, actions: Action[]) => {
          sent.push({ signer: signer.accountId, method: actions[0]!.functionCall!.methodName, args: JSON.parse(Buffer.from(actions[0]!.functionCall!.args).toString()) });
          return { hash: 'h', value: null };
        },
      }),
    });
    return { sent, out: out.join('\n') };
  }

  it('governance contract: proposes with the updater key and never calls remove_issuer_key', async () => {
    const r = await run([m.name], { kids: ['old', 'cur'], changes: [] });
    expect(r.sent.map((s) => s.method)).toEqual(['set_issuer_key', 'propose_issuer_key_removal']);
    expect(r.sent.every((s) => s.signer === m.signer)).toBe(true);
    expect(r.out).toContain('queued');
  });

  it('--execute runs a due change; --dry-run sends nothing', async () => {
    const due = [change({ id: 5, kid: 'new', n: N('new'), e: 'AQAB', executable_at_ms: NOW })];
    expect((await run([m.name, '--execute'], { kids: ['cur'], changes: due })).sent).toEqual([{ signer: m.signer, method: 'execute_issuer_key_change', args: { id: 5 } }]);
    expect((await run([m.name, '--dry-run'], { kids: ['old', 'cur'], changes: [] })).sent).toEqual([]);
  });

  it('a v1 contract keeps the direct set and remove', async () => {
    const r = await run([m.name], { kids: ['old', 'cur'], changes: null });
    expect(r.sent.map((s) => s.method)).toEqual(['set_issuer_key', 'remove_issuer_key']);
    expect(r.out).toContain('v1 contract');
  });

  it('--as-owner is gone', async () => {
    await expect(run([m.name, '--as-owner'], { kids: [], changes: [] })).rejects.toThrow("Unknown option '--as-owner'");
  });
});
