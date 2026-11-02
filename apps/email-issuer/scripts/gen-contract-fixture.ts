// Writes contracts/hana-signer/src/issuer_tokens_fixture.json: email tokens minted by the issuer's own code (its
// layouts, `judge`, commitment parser, Worker-secret signer and JWS JSON minting) with a throwaway RSA-2048 key whose
// private half is discarded, for the contract's unit test `tests/email/issuer_tokens.rs`, which feeds them into the
// real contract: an email login, auto_link case A and case B, and link_identity with a link_account token (tokens
// review L4). The chain state each join is judged from is the one that test sets up.
//
//   corepack pnpm --filter @hana-id/email-issuer exec tsx scripts/gen-contract-fixture.ts
//
// Re-run it when a layout, the join or the token format changes (the tokens are random: every run changes the file).
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
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

/** The Ed25519 public key of the 32-byte seed [seed; 32] (ed25519-dalek's SigningKey::from_bytes, the tests' pk()). */
export function sessionPk(seed: number): Uint8Array {
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seed)]);
  const jwk = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).export({ format: 'jwk' }) as { x: string };
  return new Uint8Array(Buffer.from(jwk.x, 'base64url'));
}

const session = (seed: number) => ({ scopeId: SCOPE, sessionPublicKey: sessionPk(seed), expiresAtMs: EXPIRES_MS, keyIndex: 0, maxUses: 3, salt: SALT });
const own = (scope: string, provider: string, sub: string, opened: boolean): IdentityView => ({ key: toHex(identityKey(scope, provider, sub)), status: 'own', opened, root: null, accountEpoch: 0 });

export async function build(): Promise<Record<string, unknown>> {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
  const jwk = privateKey.export({ format: 'jwk' }) as Record<string, string>;
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
    _comment: 'Generated by apps/email-issuer/scripts/gen-contract-fixture.ts: tokens minted by the email issuer\'s own code with a throwaway key (private half discarded). Consumed by src/tests/email/issuer_tokens.rs.',
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
  console.log(`wrote ${FIXTURE_PATH} (kid ${fixture.kid as string}; the RSA private key was not kept)`);
}
