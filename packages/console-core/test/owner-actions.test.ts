// The owner-action argument bytes and nonces (src/owner-actions.ts) against hana-signer's test_fixture.json: its
// worked layouts (the bytes of `borsh(args without auth)`) and the nonces its owner and client-proof tokens carry
// (computed there by the contract's own Rust and the independent gen-fixtures.mjs), so the console, the API's
// precheck and the contract agree byte for byte.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  borshChange,
  borshOptionString,
  borshOwner,
  changeOriginsInput,
  clientProofNonce,
  consoleProposeChangeInput,
  hex,
  ownerActionArgsBorsh,
  ownerActionInput,
  ownerActionNonce,
} from '../src/index.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../contracts/hana-signer/src/test_fixture.json', import.meta.url), 'utf8')) as {
  signer: string;
  layouts: Record<string, { parts: [string, string][]; nonce: string }>;
  nonces: Record<string, string>;
  tokens: Record<string, string>;
};
const SIGNER = fixture.signer;
const APP = (name: string) => `${name}.apps.googleusercontent.com`;
const argsPart = (layout: string) => fixture.layouts[layout]!.parts.find(([label]) => label === 'borsh(args without auth)')![1];

describe('borsh(args without auth): the fixture layouts', () => {
  it('remove_client, propose_change SetAllowShared, disable_shared_login', () => {
    expect(hex(ownerActionArgsBorsh('remove_client', { scope_id: 's1', auth: { Oidc: { jwt: 'x' } }, provider: 'google', aud: APP('app-a2') }))).toBe(argsPart('owner_action_remove_client'));
    expect(hex(ownerActionArgsBorsh('propose_change', { scope_id: 's1', change: { SetAllowShared: { allow: true } }, client_proof: null }))).toBe(argsPart('owner_action_allow_shared'));
    expect(hex(ownerActionArgsBorsh('disable_shared_login', { scope_id: 's1' }))).toBe(argsPart('owner_action_disable_shared'));
  });

  it('an absent client_proof is None, like null', () => {
    expect(ownerActionArgsBorsh('propose_change', { scope_id: 's1', change: { SetAllowShared: { allow: true } } })).toEqual(
      ownerActionArgsBorsh('propose_change', { scope_id: 's1', change: { SetAllowShared: { allow: true } }, client_proof: null }),
    );
  });
});

describe('the owner and client-proof nonces the fixture tokens carry', () => {
  const nonce = (method: string, args: Record<string, unknown>, actionNonce: number) => ownerActionNonce({ signer: SIGNER, method, args, actionNonce });

  it('every method and change kind', async () => {
    const owner = { Oidc: { provider: 'google', sub: 'owner-111' } };
    expect(await nonce('propose_change', { scope_id: 's1', change: { AddClient: { provider: 'google', aud: APP('app-e') } }, client_proof: fixture.tokens.cp_e_s1_0 }, 0)).toBe(fixture.nonces.owner_propose_e_s1_0);
    expect(await nonce('propose_change', { scope_id: 's1', change: { SetOwners: { owners: [owner] } }, client_proof: null }, 0)).toBe(fixture.nonces.owner_set_owners_s1_0);
    expect(await nonce('propose_change', { scope_id: 's1', change: { SetAllowShared: { allow: true } } }, 0)).toBe(fixture.nonces.owner_allow_shared_s1_0);
    expect(await nonce('cancel_change', { scope_id: 's1', change_id: 0 }, 1)).toBe(fixture.nonces.owner_cancel_s1_0_at_1);
    expect(await nonce('remove_client', { scope_id: 's1', provider: 'google', aud: APP('app-a2') }, 0)).toBe(fixture.nonces.owner_remove_a2_s1_0);
    expect(await nonce('disable_shared_login', { scope_id: 's1' }, 1)).toBe(fixture.nonces.owner_disable_shared_s1_1);
    expect(await nonce('disable_shared_login', { scope_id: 's1' }, 2)).toBe(fixture.nonces.owner_disable_shared_s1_2);
    expect(await clientProofNonce({ signer: SIGNER, scopeId: 's1', actionNonce: 0 })).toBe(fixture.nonces.client_s1_0);
    expect(await clientProofNonce({ signer: SIGNER, scopeId: 's2', actionNonce: 0 })).toBe(fixture.nonces.client_s2_0);
  });

  it('the args a token commits to are the whole action: another method, scope, nonce, signer or proof changes it', async () => {
    const args = { scope_id: 's1', provider: 'google', aud: APP('app-a2') };
    const base = await nonce('remove_client', args, 0);
    expect(await nonce('remove_client', args, 1)).not.toBe(base);
    expect(await nonce('remove_client', { ...args, aud: APP('app-a') }, 0)).not.toBe(base);
    expect(await ownerActionNonce({ signer: 'other.testnet', method: 'remove_client', args, actionNonce: 0 })).not.toBe(base);
    // The contract's own example: cancel_change with remove_client's arguments is another nonce.
    expect(fixture.nonces.owner_cancel_method_remove_args_s1_0).not.toBe(base);
    const add = { scope_id: 's1', change: { AddClient: { provider: 'google', aud: APP('app-e') } } };
    expect(await nonce('propose_change', { ...add, client_proof: fixture.tokens.cp_e_s1_1 }, 0)).not.toBe(await nonce('propose_change', { ...add, client_proof: fixture.tokens.cp_e_s1_0 }, 0));
  });
});

describe('encoders refuse what the contract would not take', () => {
  it('unknown methods, missing or extra fields, wrong types', () => {
    expect(() => ownerActionArgsBorsh('execute_change', { scope_id: 's1', change_id: 1 })).toThrow(TypeError);
    expect(() => ownerActionArgsBorsh('set_owner', { scope_id: 's1' })).toThrow(TypeError);
    expect(() => ownerActionArgsBorsh('cancel_change', { scope_id: 's1', change_id: -1 })).toThrow(TypeError);
    expect(() => ownerActionArgsBorsh('cancel_change', { scope_id: 's1', change_id: '1' })).toThrow(TypeError);
    expect(() => ownerActionArgsBorsh('disable_shared_login', {})).toThrow(TypeError);
    expect(() => borshChange({ AddClient: { provider: 'google' } })).toThrow(TypeError);
    expect(() => borshChange({ SetAllowShared: { allow: 'yes' } })).toThrow(TypeError);
    expect(() => borshChange({ AddClient: { provider: 'google', aud: 'a' }, SetAllowShared: { allow: true } })).toThrow(TypeError);
    expect(() => borshOwner({ Near: { account_id: 'a.testnet', extra: 1 } })).toThrow(TypeError);
    expect(() => borshOptionString(7)).toThrow(TypeError);
  });

  it('Owner and Change tags', () => {
    expect(hex(borshOwner({ Near: { account_id: 'a' } }))).toBe('000100000061');
    expect(hex(borshOwner({ Oidc: { provider: 'g', sub: 's' } }))).toBe('01010000006701000000' + '73');
    expect(hex(borshChange({ SetOwners: { owners: [] } }))).toBe('0100000000');
    expect(hex(borshChange({ SetAllowShared: { allow: false } }))).toBe('0200');
  });
});

describe('C6 RPC inputs', () => {
  const member = { actor: { kind: 'member', id: 'usr_1', sub: 's', email: 'o@p.example', sessionHash: 'A'.repeat(43) }, requestId: 'req_12345678', clientIp: '203.0.113.1' } as const;
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzIn0.c2ln';

  it('changeOrigins and proposeChange take a step-up JWT; removes may be empty', () => {
    expect(changeOriginsInput.safeParse({ ...member, orgId: 'org_a', appId: 'app_a', add: ['https://a.example'], remove: [], expectedVersion: 0, stepUpJwt: jwt }).success).toBe(true);
    expect(changeOriginsInput.safeParse({ ...member, orgId: 'org_a', appId: 'app_a', add: [], remove: [], expectedVersion: 0, stepUpJwt: jwt }).success).toBe(false);
    expect(changeOriginsInput.safeParse({ ...member, orgId: 'org_a', appId: 'app_a', add: ['https://a.example'], remove: [], expectedVersion: 0, stepUpJwt: 'not a jwt' }).success).toBe(false);
    expect(changeOriginsInput.safeParse({ ...member, orgId: 'org_a', appId: 'app_a', add: ['https://a.example'], remove: [], expectedVersion: 0, stepUpJwt: `${'a'.repeat(7200)}.b.c` }).success).toBe(false);
    expect(consoleProposeChangeInput.safeParse({ ...member, orgId: 'org_a', appId: 'app_a', kind: 'raw_sign_on', expectedVersion: 2, stepUpJwt: jwt }).success).toBe(true);
    expect(consoleProposeChangeInput.safeParse({ ...member, orgId: 'org_a', appId: 'app_a', kind: 'raw_sign_on', expectedVersion: 2 }).success).toBe(false);
  });

  it('ownerAction takes the body as the contract takes it, with one of the allowlisted methods', () => {
    expect(ownerActionInput.safeParse({ ...member, orgId: 'org_a', body: { method: 'execute_change', args: { scope_id: 's1', change_id: 1 } } }).success).toBe(true);
    expect(ownerActionInput.safeParse({ ...member, orgId: 'org_a', body: { method: 'register_scope', args: {} } }).success).toBe(false);
    expect(ownerActionInput.safeParse({ ...member, orgId: 'org_a', body: { method: 'execute_change', args: {}, extra: 1 } }).success).toBe(false);
  });
});
