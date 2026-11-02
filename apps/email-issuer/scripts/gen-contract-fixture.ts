// Writes contracts/hana-signer/src/issuer_tokens_fixture.json: email tokens minted by the issuer's own code (its
// layouts, `judge`, commitment parser, Worker-secret signer and JWS JSON minting) with an RSA-2048 test key derived from
// a public seed, for the contract's unit test `tests/email/issuer_tokens.rs`, which feeds them into the real contract:
// an email login, auto_link case A and case B, and link_identity with a link_account token (tokens review L4). The
// chain state each join is judged from is the one that test sets up.
//
//   corepack pnpm --filter @hana-id/email-issuer exec tsx scripts/gen-contract-fixture.ts
//
// Deterministic (tokens review N2): the key comes from TEST_RSA_SEED (public: the key is a test key and nothing else),
// `iat` and every `jti` are fixed, RS256 (PKCS #1 v1.5) signatures are deterministic. So every run writes the same file,
// and `scripts/test/gen-contract-fixture.test.ts` regenerates it in memory and compares it with the committed one. Re-run
// it when a layout, the join or the token format changes.
import { createHash, createPrivateKey } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emailSub, importSubKey } from '@hana-id/email';
import { rsaThumbprint } from '@hana-id/jwks';
import { sha256, toHex, utf8 } from '../src/bytes.ts';
import type { IdentityView } from '../src/chain.ts';
import { commitmentNonce } from '../src/commitment.ts';
import { judge } from '../src/decide.ts';
import { mintJws } from '../src/jws.ts';
import { autoLinkPreimage, identityKey, nonceOf, sessionNonceOf, sessionPreimage } from '../src/layouts.ts';
import { WorkerSecretSigner } from '../src/signer.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PATH = join(here, '..', '..', '..', 'contracts', 'hana-signer', 'src', 'issuer_tokens_fixture.json');
const emailFixture = JSON.parse(readFileSync(join(here, '..', '..', '..', 'contracts', 'hana-signer', 'src', 'email_fixture.json'), 'utf8')) as { signer: string; email_iss: string };

// The contract unit tests' constants (contracts/hana-signer/src/tests.rs, tests/email.rs).
export const SIGNER = emailFixture.signer;
export const ISS = emailFixture.email_iss;
export const NOW_MS = 1_800_000_000_000;
export const EXPIRES_MS = NOW_MS + 3_600_000;
export const SALT = new Uint8Array(16).fill(9);
export const SCOPE = 's1';
export const G = 'g-alice';
export const G2 = 'g-bob';
export const ADDRESS = 'alice@example.com';
/** A public, test-only K_sub (never an environment's): sha256 of this label. */
export const TEST_SUB_KEY_LABEL = 'hana-id issuer_tokens_fixture TEST K_sub (never an environment key)';
/** The public seed of the fixture's RSA test key (never an environment key). */
export const TEST_RSA_SEED = 'hana-id issuer_tokens_fixture TEST RSA-2048 seed (public; never an environment key)';

// ---- a deterministic RSA-2048 test key (SHA-256 counter stream, sieve + Miller-Rabin) ----

function stream(seed: string): (n: number) => Buffer {
  let counter = 0;
  let buf = Buffer.alloc(0);
  return (n) => {
    while (buf.length < n) {
      const c = Buffer.alloc(4);
      c.writeUInt32BE(counter++);
      buf = Buffer.concat([buf, createHash('sha256').update(seed).update(c).digest()]);
    }
    const out = buf.subarray(0, n);
    buf = buf.subarray(n);
    return out;
  };
}
const big = (b: Buffer): bigint => BigInt(`0x${b.toString('hex')}`);
function modPow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b %= m;
  for (; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
  }
  return r;
}
function modInv(a: bigint, m: bigint): bigint {
  let [r0, r1, s0, s1] = [a % m, m, 1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1, s0, s1] = [r1, r0 - q * r1, s1, s0 - q * s1];
  }
  if (r0 !== 1n) throw new Error('not invertible');
  return ((s0 % m) + m) % m;
}
const SMALL_PRIMES = (() => {
  const out: bigint[] = [];
  for (let n = 3; n < 2000; n += 2) if (out.every((p) => BigInt(n) % p !== 0n)) out.push(BigInt(n));
  return out;
})();
function probablePrime(n: bigint, rand: (n: number) => Buffer): boolean {
  for (const p of SMALL_PRIMES) if (n % p === 0n) return n === p;
  let d = n - 1n;
  let s = 0;
  while ((d & 1n) === 0n) {
    d >>= 1n;
    s++;
  }
  witness: for (let i = 0; i < 32; i++) {
    const a = 2n + (big(rand(128)) % (n - 3n));
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    for (let k = 1; k < s; k++) {
      x = (x * x) % n;
      if (x === n - 1n) continue witness;
    }
    return false;
  }
  return true;
}
function prime1024(rand: (n: number) => Buffer, e: bigint): bigint {
  for (;;) {
    const c = big(rand(128)) | (3n << 1022n) | 1n;
    if ((c - 1n) % e !== 0n && probablePrime(c, rand)) return c;
  }
}
const b64u = (n: bigint): string => {
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return Buffer.from(hex, 'hex').toString('base64url');
};

/** The fixture's RSA-2048 private JWK, the same on every run (from TEST_RSA_SEED). */
export function testRsaJwk(): Record<string, string> {
  const rand = stream(TEST_RSA_SEED);
  const e = 65537n;
  const p = prime1024(rand, e);
  let q = prime1024(rand, e);
  while (q === p) q = prime1024(rand, e);
  const n = p * q;
  const d = modInv(e, (p - 1n) * (q - 1n));
  return { kty: 'RSA', n: b64u(n), e: b64u(e), d: b64u(d), p: b64u(p), q: b64u(q), dp: b64u(d % (p - 1n)), dq: b64u(d % (q - 1n)), qi: b64u(modInv(q, p)) };
}

/** The Ed25519 public key of the 32-byte seed [seed; 32] (ed25519-dalek's SigningKey::from_bytes, the tests' pk()). */
export function sessionPk(seed: number): Uint8Array {
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seed)]);
  const jwk = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).export({ format: 'jwk' }) as { x: string };
  return new Uint8Array(Buffer.from(jwk.x, 'base64url'));
}

const session = (seed: number) => ({ scopeId: SCOPE, sessionPublicKey: sessionPk(seed), expiresAtMs: EXPIRES_MS, keyIndex: 0, maxUses: 3, salt: SALT });
const own = (scope: string, provider: string, sub: string, opened: boolean): IdentityView => ({ key: toHex(identityKey(scope, provider, sub)), status: 'own', opened, root: null, accountEpoch: 0 });

export async function build(): Promise<Record<string, unknown>> {
  const jwk = testRsaJwk();
  const kid = (await rsaThumbprint({ n: jwk.n!, e: jwk.e! }))!;
  const signer = await WorkerSecretSigner.create(JSON.stringify(jwk), kid);
  const published = [{ kty: 'RSA' as const, n: jwk.n!, e: jwk.e!, kid, use: 'sig' as const, alg: 'RS256' as const }];
  const sub = await emailSub(await importSubKey(sha256(utf8(TEST_SUB_KEY_LABEL))), ADDRESS);
  const iat = Math.floor(NOW_MS / 1000) - 60;
  let n = 0;
  const token = (nonce: string) => mintJws({ iss: ISS, aud: `email:${SCOPE}`, sub, iat, exp: iat + 600, nonce, jti: `fixture-jti-${n++}` }, [signer], published);

  // 1. An email login (session, key 7).
  const sessionE7 = await token(sessionNonceOf(SIGNER, session(7)));
  const sessionE9 = await token(sessionNonceOf(SIGNER, session(9)));
  // 2. Case A: E has its wallet (from 1), G none: the issuer's judge gives the join, the nonce commits to G's session (key 8).
  const a = judge(SCOPE, { sub: G, identity: own(SCOPE, 'google', G, false), account: null }, { sub, identity: own(SCOPE, 'email', sub, true), account: null });
  if (a.decision !== 'case_a' || !a.join) throw new Error('fixture: expected case A');
  const gIk = identityKey(SCOPE, 'google', G);
  const autoLinkA = await token(nonceOf(autoLinkPreimage(SIGNER, SCOPE, sha256(sessionPreimage(SIGNER, session(8))), gIk, { ...a.join, mode: 1 })));
  // 3. Case B (another contract): G has its wallet, E none; Google-hosted, so at once.
  const b = judge(SCOPE, { sub: G, identity: own(SCOPE, 'google', G, true), account: null }, { sub, identity: own(SCOPE, 'email', sub, false), account: null });
  if (b.decision !== 'case_b' || !b.join) throw new Error('fixture: expected case B');
  const autoLinkB = await token(nonceOf(autoLinkPreimage(SIGNER, SCOPE, sha256(sessionPreimage(SIGNER, session(8))), gIk, { ...b.join, mode: 1 })));
  // 4. link_identity: E (with its wallet, root of no account yet: epoch 0) proves the account; G2 is the new identity.
  const eIk = toHex(identityKey(SCOPE, 'email', sub));
  const g2Ik = toHex(identityKey(SCOPE, 'google', G2));
  const la = commitmentNonce(SIGNER, 'link_account', { scopeId: SCOPE, rootIk: eIk, newIk: g2Ik, epoch: 0, salt: [...SALT] }, NOW_MS);
  if (!la.ok) throw new Error('fixture: link_account commitment');
  const linkAccount = await token(la.value.nonce);
  return {
    _comment: 'Generated by apps/email-issuer/scripts/gen-contract-fixture.ts: tokens minted by the email issuer\'s own code with a test key from a public seed (deterministic; checked by its vitest). Consumed by src/tests/email/issuer_tokens.rs.',
    signer: SIGNER,
    iss: ISS,
    kid,
    n: jwk.n,
    e: jwk.e,
    email_sub: sub,
    session_pk_hex: { '7': toHex(sessionPk(7)), '8': toHex(sessionPk(8)), '9': toHex(sessionPk(9)) },
    google: G,
    google2: G2,
    tokens: { session_e7: sessionE7, session_e9: sessionE9, auto_link_a_g8: autoLinkA, auto_link_b_g8: autoLinkB, link_account_e_g2: linkAccount },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fixture = await build();
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${FIXTURE_PATH} (kid ${fixture.kid as string}; the test key is derived from a public seed and not written)`);
}
