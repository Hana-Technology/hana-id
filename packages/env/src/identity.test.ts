import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { identityTokenRules } from './identity.ts';
import { identityIssuerFor, kmsArnParts, manifestPath, manifestSchema, p256Thumbprint } from './index.ts';

const raw = () => JSON.parse(readFileSync(manifestPath('sandbox-dev'), 'utf8')) as Record<string, unknown>;

/** A fresh public JWKS entry (throwaway key; the private half is discarded). */
function publicKey() {
  const { publicKey: pub } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pub.export({ format: 'jwk' }) as { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  return { kty: 'EC' as const, crv: 'P-256' as const, x: jwk.x, y: jwk.y, kid: p256Thumbprint(jwk), use: 'sig' as const, alg: 'ES256' as const };
}

const block = (over: Record<string, unknown> = {}) => {
  const m = raw();
  const active = publicKey();
  const standby = publicKey();
  const identityToken = { iss: identityIssuerFor(m.apiUrl as string), signer: { kind: 'worker-secret', activeKid: active.kid }, publicKeys: [active, standby], ...over };
  // The watchdog pins every published key (D211): pin whatever this block publishes, so only the rule under test fails.
  const kids = Array.isArray(identityToken.publicKeys) ? (identityToken.publicKeys as { kid?: unknown }[]).flatMap((k) => (typeof k?.kid === 'string' ? [k.kid] : [])) : [];
  const watchdog = { ...(m.watchdog as Record<string, unknown>), pinnedIdentityKeys: [...new Set(kids)].length ? [...new Set(kids)] : undefined };
  return { ...m, watchdog, identityToken };
};
const issues = (v: unknown): string[] => manifestSchema.safeParse(v).error?.issues.map((i) => i.message) ?? [];

describe('manifestSchema: identityToken', () => {
  it('is optional, and a well-formed block parses', () => {
    const { identityToken: _, ...base } = raw();
    expect(manifestSchema.safeParse(base).success).toBe(true);
    const parsed = manifestSchema.parse(block());
    expect(parsed.identityToken?.signer.kind).toBe('worker-secret');
    expect(parsed.identityToken?.publicKeys).toHaveLength(2);
  });

  it('iss is the API’s /v1/identity', () => {
    expect(identityIssuerFor('https://api.example/')).toBe('https://api.example/v1/identity');
    expect(issues(block({ iss: 'https://id.example' })).join()).toContain('/v1/identity');
  });

  it('kid must be the key’s RFC 7638 thumbprint and appear once', () => {
    const k = publicKey();
    const wrongKid = { ...k, kid: publicKey().kid };
    expect(issues(block({ signer: { kind: 'worker-secret', activeKid: wrongKid.kid }, publicKeys: [wrongKid] })).join()).toContain('thumbprint');
    expect(issues(block({ signer: { kind: 'worker-secret', activeKid: k.kid }, publicKeys: [k, k] })).join()).toContain('Duplicate');
  });

  it('refuses a private member or any other extra field in a public key', () => {
    const k = publicKey();
    expect(manifestSchema.safeParse(block({ signer: { kind: 'worker-secret', activeKid: k.kid }, publicKeys: [{ ...k, d: 'x'.repeat(43) }] })).success).toBe(false);
    expect(manifestSchema.safeParse(block({ signer: { kind: 'worker-secret', activeKid: k.kid }, publicKeys: [{ ...k, alg: 'RS256' }] })).success).toBe(false);
  });

  it('the signer’s keys must be in the list', () => {
    expect(issues(block({ signer: { kind: 'worker-secret', activeKid: publicKey().kid } })).join()).toContain('not in identityToken.publicKeys');
  });

  it('1 to 4 keys', () => {
    expect(manifestSchema.safeParse(block({ publicKeys: [] })).success).toBe(false);
    const keys = Array.from({ length: 5 }, publicKey);
    expect(manifestSchema.safeParse(block({ signer: { kind: 'worker-secret', activeKid: keys[0]!.kid }, publicKeys: keys })).success).toBe(false);
  });


  it('refuses a Worker-secret signer off testnet (the rule gen relies on once mainnet manifests exist)', () => {
    const t = (block().identityToken as unknown) as Parameters<typeof identityTokenRules>[1];
    const messages: string[] = [];
    const ctx = { addIssue: (i: { message: string }) => void messages.push(i.message) } as unknown as Parameters<typeof identityTokenRules>[2];
    identityTokenRules({ network: 'mainnet', apiUrl: raw().apiUrl as string }, t, ctx);
    expect(messages.join()).toMatch(/testnet only/u);
    messages.length = 0;
    identityTokenRules({ network: 'testnet', apiUrl: raw().apiUrl as string }, t, ctx);
    expect(messages).toEqual([]);
  });
});

describe('manifestSchema: identityToken.signer aws-kms (build step 7, D215, D219)', () => {
  const ACCOUNT = '111122223333';
  const arn = (region: string, n: number) => `arn:aws:kms:${region}:${ACCOUNT}:key/${String(n).padStart(8, '0')}-1111-4222-8333-444455556666`;
  const credentials = { kind: 'worker-secret', iamUser: 'hana-identity-signer' };
  const pub = new Map<string, ReturnType<typeof publicKey>>();
  const key = (region: string, n: number) => {
    const k = publicKey();
    pub.set(k.kid, k);
    return { kid: k.kid, arn: arn(region, n) };
  };
  const kms = (keys: Record<string, { kid: string; arn: string }>, publicKeys?: unknown[], over: Record<string, unknown> = {}) =>
    block({ signer: { kind: 'aws-kms', credentials, keys, ...over }, publicKeys: publicKeys ?? Object.values(keys).map((k) => pub.get(k.kid)) });

  it('parses active and standby in two regions, with next and previous during a rotation', () => {
    const parsed = manifestSchema.parse(kms({ active: key('ap-east-1', 1), standby: key('ap-southeast-1', 2) }));
    expect(parsed.identityToken?.signer).toMatchObject({ kind: 'aws-kms', credentials, keys: { active: { arn: arn('ap-east-1', 1) } } });
    expect(manifestSchema.safeParse(kms({ active: key('ap-east-1', 1), standby: key('ap-southeast-1', 2), next: key('ap-east-1', 3), previous: key('ap-east-1', 4) })).success).toBe(true);
    // Right after a switch to the standby: no standby until the new one is added.
    expect(manifestSchema.safeParse(kms({ active: key('ap-southeast-1', 2), previous: key('ap-east-1', 1) })).success).toBe(true);
  });

  it('kmsArnParts reads the region and account; malformed, alias, multi-region and other-partition ARNs are refused', () => {
    expect(kmsArnParts(arn('ap-east-1', 1))).toEqual({ region: 'ap-east-1', account: ACCOUNT });
    for (const bad of [
      `arn:aws:kms:ap-east-1:${ACCOUNT}:alias/hana-identity`,
      `arn:aws:kms:ap-east-1:${ACCOUNT}:key/mrk-1234abcd12ab34cd56ef1234567890ab`,
      `arn:aws-cn:kms:cn-north-1:${ACCOUNT}:key/00000001-1111-4222-8333-444455556666`,
      `arn:aws:kms:ap-east-1:1234:key/00000001-1111-4222-8333-444455556666`,
      `arn:aws:kms:ap-east-1:${ACCOUNT}:key/00000001-1111-4222-8333-44445555666G`,
      '00000001-1111-4222-8333-444455556666',
      `${arn('ap-east-1', 1)} `,
    ]) {
      expect(kmsArnParts(bad)).toBeNull();
      expect(manifestSchema.safeParse(kms({ active: { ...key('ap-east-1', 1), arn: bad }, standby: key('ap-southeast-1', 2) })).success).toBe(false);
    }
  });

  it('refuses a standby in the active key’s region, two roles on one key, and keys in two accounts', () => {
    expect(issues(kms({ active: key('ap-east-1', 1), standby: key('ap-east-1', 2) })).join()).toContain('another region than the active key');
    // `next` becomes the active key at a switch: not in the standby's region either.
    expect(issues(kms({ active: key('ap-east-1', 1), standby: key('ap-southeast-1', 2), next: key('ap-southeast-1', 3) })).join()).toContain('another region than the standby');
    const a = key('ap-east-1', 1);
    expect(issues(kms({ active: a, standby: { kid: a.kid, arn: arn('ap-southeast-1', 2) } }, [pub.get(a.kid)])).join()).toContain('a kid appears in two roles');
    expect(issues(kms({ active: a, standby: { ...key('ap-southeast-1', 2), arn: a.arn } })).join()).toContain('an ARN appears in two roles');
    const other = { ...key('ap-southeast-1', 2), arn: arn('ap-southeast-1', 2).replace(ACCOUNT, '444455556666') };
    expect(issues(kms({ active: key('ap-east-1', 1), standby: other })).join()).toContain('same AWS account');
  });

  it('every published key has a role, and every role’s key is published', () => {
    const roles = { active: key('ap-east-1', 1), standby: key('ap-southeast-1', 2) };
    const stray = publicKey();
    expect(issues(kms(roles, [...Object.values(roles).map((k) => pub.get(k.kid)), stray])).join()).toContain(`Published key ${stray.kid} has no role`);
    expect(issues(kms(roles, [pub.get(roles.active.kid)])).join()).toContain('not in identityToken.publicKeys');
  });

  it('needs the credentials block (the IAM user); refuses the old awsRegion shape, other credential kinds and extra fields', () => {
    const keys = { active: key('ap-east-1', 1), standby: key('ap-southeast-1', 2) };
    const publicKeys = Object.values(keys).map((k) => pub.get(k.kid));
    expect(manifestSchema.safeParse(block({ signer: { kind: 'aws-kms', keys }, publicKeys })).success).toBe(false);
    expect(manifestSchema.safeParse(kms(keys, publicKeys, { awsRegion: 'ap-east-1' })).success).toBe(false);
    expect(manifestSchema.safeParse(kms(keys, publicKeys, { credentials: { kind: 'role', iamUser: 'x' } })).success).toBe(false);
    expect(manifestSchema.safeParse(kms(keys, publicKeys, { credentials: { ...credentials, accessKeyId: 'AKIAEXAMPLE' } })).success).toBe(false);
    expect(manifestSchema.safeParse(kms(keys, publicKeys, { credentials: { kind: 'worker-secret', iamUser: 'has space' } })).success).toBe(false);
    expect(manifestSchema.safeParse(kms({ active: { kid: 'short', arn: arn('ap-east-1', 1) } }, [publicKey()])).success).toBe(false);
    expect(manifestSchema.safeParse(kms({ active: { ...keys.active, region: 'ap-east-1' } as never }, [pub.get(keys.active.kid)])).success).toBe(false);
  });
});
