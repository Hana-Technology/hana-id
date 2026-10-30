import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs script without types (the independent implementation)
import { buildVectors } from '../scripts/gen-vectors.mjs';
import {
  b64url,
  clientProofDigest,
  consoleLoginNonce,
  DOMAINS,
  fromB64url,
  fromHex,
  hex,
  linkToken,
  linkTokenHash,
  linkTokenMatches,
  nonceOf,
  originChangeDigest,
  ownerActionDigest,
  pathIdentity,
  settingsChangeDigest,
  stepUpDigest,
  type StepUpAction,
  uid,
  uidFromPath,
} from '../src/index.ts';
import vectors from './vectors.json' with { type: 'json' };

const v = vectors;
const key = (h: string) => fromHex(h);
const SIGNER = v.inputs.signer;

describe('vectors.json', () => {
  it('is what the independent generator writes today', () => {
    expect(JSON.parse(JSON.stringify(buildVectors()))).toEqual(v);
  });
});

describe('console layouts match the independent implementation', () => {
  it('console login nonce', async () => {
    expect(await consoleLoginNonce(fromHex(v.inputs.login_random_hex))).toBe(v.console_login.nonce);
    await expect(consoleLoginNonce(new Uint8Array(31))).rejects.toThrow();
  });

  it('generic step-up: digest over sha256(cookie) and sha256(JCS(action))', async () => {
    const d = await stepUpDigest({ sessionHash: fromHex(v.inputs.session_hash_hex), action: v.step_up.action as StepUpAction });
    expect(hex(d)).toBe(v.step_up.digest_hex);
    expect(nonceOf(d)).toBe(v.step_up.nonce);
    // Key order in the input doesn't matter (canonical JSON).
    const reordered = { params: { role: 'viewer', email: 'new@partner.example' }, kind: 'member.invite', org_id: v.step_up.action.org_id, env: 'sandbox-dev', v: 1 } as StepUpAction;
    expect(hex(await stepUpDigest({ sessionHash: fromHex(v.inputs.session_hash_hex), action: reordered }))).toBe(v.step_up.digest_hex);
  });

  it('a step-up action must name v: 1, env, org_id and kind', async () => {
    const sessionHash = new Uint8Array(32);
    for (const bad of [{ env: 'e', org_id: 'o', kind: 'k' }, { v: 2, env: 'e', org_id: 'o', kind: 'k' }, { v: 1, org_id: 'o', kind: 'k' }, { v: 1, env: 'e', kind: 'k' }, { v: 1, env: 'e', org_id: 'o' }]) {
      await expect(stepUpDigest({ sessionHash, action: bad as unknown as StepUpAction })).rejects.toThrow(/needs v: 1/u);
    }
    await expect(stepUpDigest({ sessionHash: new Uint8Array(31), action: v.step_up.action as StepUpAction })).rejects.toThrow();
  });

  it('origin change: adds and removes sorted by byte order', async () => {
    const o = v.origin_change;
    expect(nonceOf(await originChangeDigest({ signer: SIGNER, appId: o.app_id, add: o.add, remove: o.remove, originsVersion: o.origins_version }))).toBe(o.nonce);
    expect(nonceOf(await originChangeDigest({ signer: SIGNER, appId: o.app_id, add: [...o.add].reverse(), remove: o.remove, originsVersion: BigInt(o.origins_version) }))).toBe(o.nonce);
    const a = v.origin_change_add_only;
    expect(nonceOf(await originChangeDigest({ signer: SIGNER, appId: a.app_id, add: a.add, remove: [], originsVersion: 0 }))).toBe(a.nonce);
  });

  it('origin change refuses unnormalised, duplicate, overlapping or missing adds', async () => {
    const base = { signer: SIGNER, appId: 'app_x', remove: [] as string[], originsVersion: 0 };
    await expect(originChangeDigest({ ...base, add: ['https://App.example'] })).rejects.toThrow(/not a normalised origin/u);
    await expect(originChangeDigest({ ...base, add: ['https://bücher.example'] })).rejects.toThrow(/not a normalised origin/u);
    await expect(originChangeDigest({ ...base, add: ['https://a.example', 'https://a.example'] })).rejects.toThrow(/duplicate/u);
    await expect(originChangeDigest({ ...base, add: ['https://a.example'], remove: ['https://a.example'] })).rejects.toThrow(/both added and removed/u);
    await expect(originChangeDigest({ ...base, add: [] })).rejects.toThrow(/at least one/u);
    await expect(originChangeDigest({ ...base, add: ['https://a.example'], originsVersion: -1 })).rejects.toThrow();
  });

  it('settings change: policy_set commits to the policyId, raw_sign_on to 32 zero bytes', async () => {
    const p = v.settings_policy_set;
    expect(nonceOf(await settingsChangeDigest({ signer: SIGNER, appId: p.app_id, kind: 'policy_set', policyId: v.inputs.policy_id, settingsVersion: p.settings_version }))).toBe(p.nonce);
    const r = v.settings_raw_sign_on;
    expect(nonceOf(await settingsChangeDigest({ signer: SIGNER, appId: r.app_id, kind: 'raw_sign_on', settingsVersion: r.settings_version }))).toBe(r.nonce);
    await expect(settingsChangeDigest({ signer: SIGNER, appId: 'a', kind: 'policy_set', settingsVersion: 0 })).rejects.toThrow(/policyId/u);
    await expect(settingsChangeDigest({ signer: SIGNER, appId: 'a', kind: 'policy_set', policyId: 'A1'.repeat(32), settingsVersion: 0 })).rejects.toThrow(/policyId/u);
    await expect(settingsChangeDigest({ signer: SIGNER, appId: 'a', kind: 'raw_sign_on', policyId: v.inputs.policy_id, settingsVersion: 0 })).rejects.toThrow(/no policyId/u);
    await expect(settingsChangeDigest({ signer: SIGNER, appId: 'a', kind: 'off' as 'raw_sign_on', settingsVersion: 0 })).rejects.toThrow(/Unknown/u);
  });

  it('link tokens are deterministic per id and stored only as sha256', async () => {
    const c = v.cancel_link;
    const t = await linkToken('cancelLink', key(v.inputs.link_key_hex), c.change_id);
    expect(b64url(t)).toBe(c.token);
    expect(b64url(await linkToken('cancelLink', key(v.inputs.link_key_hex), c.change_id))).toBe(c.token);
    expect(hex(await linkTokenHash(t))).toBe(c.token_hash_hex);
    expect(await linkTokenMatches(fromB64url(c.token), fromHex(c.token_hash_hex))).toBe(true);
    expect(await linkTokenMatches(fromB64url(v.invite.token), fromHex(c.token_hash_hex))).toBe(false);
    expect(b64url(await linkToken('invite', key(v.inputs.invite_key_hex), v.invite.invite_id))).toBe(v.invite.token);
    expect(hex(await linkTokenHash(fromB64url(v.invite.token)))).toBe(v.invite.token_hash_hex);
    expect(b64url(await linkToken('ownerGrantCancel', key(v.inputs.link_key_hex), v.owner_grant_cancel.grant_id))).toBe(v.owner_grant_cancel.token);
    await expect(linkToken('invite', new Uint8Array(16), 'inv_x')).rejects.toThrow();
    await expect(linkToken('invite', new Uint8Array(32), '')).rejects.toThrow();
  });

  it('uid: per scope, provider and sub; key_index ignored', async () => {
    const k = key(v.inputs.user_id_key_hex);
    for (const u of v.uid) {
      expect(b64url(await uid(k, { scopeId: u.scope_id, provider: u.provider, sub: u.sub }))).toBe(u.uid);
      expect(b64url((await uidFromPath(k, u.scope_id, u.path))!)).toBe(u.uid);
    }
    expect(v.uid[0]!.uid).toBe(v.uid[1]!.uid); // key_index 0 and 3: one user
    expect(v.uid[0]!.uid).not.toBe(v.uid[2]!.uid); // another scope: another pseudonym
    expect((await uid(k, { scopeId: 's1', provider: 'google', sub: '1' })).length).toBe(16);
  });
});

describe('uid path parsing', () => {
  it('needs the request scope prefix and exactly three parts', () => {
    expect(pathIdentity('s1', 's1#google#123#0')).toEqual({ provider: 'google', sub: '123' });
    for (const bad of ['s2#google#123#0', 's1#google#123', 's1#google#123#0#x', 's1#google##0', 's1##123#0', 's1#google#123#-1', 's1#google#123#01', 's1#google#123#x', 's10#google#123#0', '#google#123#0', 's1']) {
      expect(pathIdentity('s1', bad), bad).toBeNull();
    }
    expect(pathIdentity('', '#google#123#0')).toBeNull();
  });

  it('uidFromPath gives null for a path of another scope', async () => {
    expect(await uidFromPath(new Uint8Array(32), 's1', 's2#google#1#0')).toBeNull();
  });
});

describe('the contract layouts (test_fixture.json)', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../contracts/hana-signer/src/test_fixture.json', import.meta.url), 'utf8')) as {
    signer: string;
    layouts: Record<string, { parts: [string, string][]; nonce: string }>;
  };

  it('client proof', async () => {
    const l = fixture.layouts.client_proof!;
    expect(nonceOf(await clientProofDigest({ signer: fixture.signer, scopeId: 's1', actionNonce: 0 }))).toBe(l.nonce);
  });

  for (const [name, method, nonce] of [
    ['owner_action_remove_client', 'remove_client', 0],
    ['owner_action_allow_shared', 'propose_change', 0],
    ['owner_action_disable_shared', 'disable_shared_login', 1],
  ] as const) {
    it(`owner action ${name}`, async () => {
      const l = fixture.layouts[name]!;
      const args = l.parts.find(([label]) => label === 'borsh(args without auth)')![1];
      expect(nonceOf(await ownerActionDigest({ signer: fixture.signer, scopeId: 's1', method, argsBorsh: fromHex(args), actionNonce: nonce }))).toBe(l.nonce);
    });
  }
});

describe('purpose separation', () => {
  it('every domain is distinct and none is a prefix of another', () => {
    const list = Object.values(DOMAINS);
    expect(new Set(list).size).toBe(list.length);
    for (const a of list) for (const b of list) if (a !== b) expect(b.startsWith(a), `${a} / ${b}`).toBe(false);
  });

  it('the same fields give different digests under the origin and settings layouts', async () => {
    const origin = await originChangeDigest({ signer: SIGNER, appId: 'app_x', add: ['https://a.example'], remove: [], originsVersion: 1 });
    const settings = await settingsChangeDigest({ signer: SIGNER, appId: 'app_x', kind: 'raw_sign_on', settingsVersion: 1 });
    const proof = await clientProofDigest({ signer: SIGNER, scopeId: 'app_x', actionNonce: 1 });
    expect(new Set([hex(origin), hex(settings), hex(proof)]).size).toBe(3);
  });

  it('a different signer (env) or version gives a different nonce', async () => {
    const base = { appId: 'app_x', add: ['https://a.example'], remove: [] as string[] };
    const a = nonceOf(await originChangeDigest({ ...base, signer: 'a.testnet', originsVersion: 1 }));
    expect(nonceOf(await originChangeDigest({ ...base, signer: 'b.testnet', originsVersion: 1 }))).not.toBe(a);
    expect(nonceOf(await originChangeDigest({ ...base, signer: 'a.testnet', originsVersion: 2 }))).not.toBe(a);
  });
});
