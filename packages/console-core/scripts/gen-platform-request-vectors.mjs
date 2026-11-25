#!/usr/bin/env node
// Writes test/platform-request-vectors.json: worked examples of the platform API's signed request (D927;
// docs/partner-platform-spec.md A3 "The request"): a key, a GET, a GET with a query, a POST with a body, a POST with an
// Idempotency-Key, a high-S signature that must verify, a DER signature that must be refused, and requests signed for
// another env (its ENV_NAME, its SIGNER_ACCOUNT) that must be refused here.
//
// An independent implementation: node:crypto for SHA-256 and HMAC, the ECDSA P-256 signature computed here in BigInt
// arithmetic (affine points, a deterministic k = HMAC-SHA256(d, sha256(message)) mod n, retried until valid), each
// signature then checked with node:crypto's own verifier, and the public key checked against node:crypto's. Nothing
// here imports src/; src/platform-request.ts and the API's verifier (apps/api/src/platform/request.ts) must agree with
// it byte for byte (test/platform-request.test.ts, apps/api/test/platform-request.test.ts). The private key is a test
// value derived from a fixed string: never a real one.
//
//   node packages/console-core/scripts/gen-platform-request-vectors.mjs
//
// test/platform-request.test.ts imports buildVectors() and checks the committed file is current.
import { createHash, createHmac, createPublicKey, verify } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'platform-request-vectors.json');

// The API test manifest's values (apps/api/vitest.config.ts), so the API's own tests verify these vectors as its env.
const ENV_NAME = 'sandbox-test';
const SIGNER_ACCOUNT = 'signer.test.near';
const KEY_ID = 'pkc_7Hq2Vx9Lm4Rt8Kd';
const TIMESTAMP = '1800000000000';

// ---- P-256 (SEC 2), affine arithmetic ----
const p = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const a = p - 3n;
const G = [0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n, 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n];
const mod = (x, m) => ((x % m) + m) % m;
function pow(b, e, m) {
  let r = 1n;
  b = mod(b, m);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}
const inv = (x, m) => pow(x, m - 2n, m); // m is prime
function add(P, Q) {
  if (P === null) return Q;
  if (Q === null) return P;
  if (P[0] === Q[0] && mod(P[1] + Q[1], p) === 0n) return null;
  const l = P[0] === Q[0] && P[1] === Q[1] ? mod((3n * P[0] * P[0] + a) * inv(2n * P[1], p), p) : mod((Q[1] - P[1]) * inv(mod(Q[0] - P[0], p), p), p);
  const x = mod(l * l - P[0] - Q[0], p);
  return [x, mod(l * (P[0] - x) - P[1], p)];
}
function mul(k, P) {
  let R = null;
  let A = P;
  while (k > 0n) {
    if (k & 1n) R = add(R, A);
    A = add(A, A);
    k >>= 1n;
  }
  return R;
}

const buf32 = (x) => Buffer.from(x.toString(16).padStart(64, '0'), 'hex');
const int = (b) => BigInt(`0x${Buffer.from(b).toString('hex') || '0'}`);
const sha256 = (b) => createHash('sha256').update(b).digest();
const b64url = (b) => Buffer.from(b).toString('base64url');

/** ECDSA over sha256(message), k from an HMAC of the key and the hash (a deterministic test signer, not RFC 6979). */
function ecdsaSign(d, message) {
  const z = int(sha256(message));
  for (let i = 0; ; i++) {
    const k = mod(int(createHmac('sha256', buf32(d)).update(sha256(message)).update(Buffer.from([i])).digest()), n);
    if (k === 0n) continue;
    const r = mod(mul(k, G)[0], n);
    if (r === 0n) continue;
    const s = mod(inv(k, n) * (z + r * d), n);
    if (s === 0n) continue;
    return { r, s };
  }
}

/** DER `SEQUENCE { INTEGER r, INTEGER s }`, each integer minimal with a 0x00 when its top bit is set. */
function der(r, s) {
  const intDer = (x) => {
    let b = Buffer.from(x.toString(16).padStart(64, '0'), 'hex');
    while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return Buffer.concat([Buffer.from([0x02, b.length]), b]);
  };
  const body = Buffer.concat([intDer(r), intDer(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

// The test key: d from a fixed string (never a real key), its point computed here and compared with node:crypto's.
const D = mod(int(sha256(Buffer.from('journear platform request vectors: test key 1', 'utf8'))), n);
const Q = mul(D, G);
const JWK = { kty: 'EC', crv: 'P-256', x: b64url(buf32(Q[0])), y: b64url(buf32(Q[1])) };
const nodeKey = createPublicKey({ key: JWK, format: 'jwk' });
{
  const back = createPublicKey({ key: { ...JWK, d: b64url(buf32(D)) }, format: 'jwk' }).export({ format: 'jwk' });
  if (back.x !== JWK.x || back.y !== JWK.y) throw new Error('the public key disagrees with node:crypto');
}
const THUMBPRINT = b64url(sha256(Buffer.from(`{"crv":"P-256","kty":"EC","x":"${JWK.x}","y":"${JWK.y}"}`, 'utf8')));

function message(o) {
  return [
    'journear-platform-v1',
    o.envName ?? ENV_NAME,
    o.signerAccount ?? SIGNER_ACCOUNT,
    o.method,
    o.path,
    KEY_ID,
    TIMESTAMP,
    o.nonce,
    o.idempotencyKey ?? '',
    sha256(Buffer.from(o.body ?? '', 'utf8')).toString('hex'),
  ].join('\n');
}

function signed(name, o, expect) {
  const nonce = b64url(sha256(Buffer.from(`nonce:${name}`, 'utf8')).subarray(0, 16));
  const signedFor = { envName: o.envName ?? ENV_NAME, signerAccount: o.signerAccount ?? SIGNER_ACCOUNT };
  const text = message({ ...o, nonce });
  const bytes = Buffer.from(text, 'utf8');
  let { r, s } = ecdsaSign(D, bytes);
  // The high-S case carries n - s, the other valid S value; every other case carries the low one.
  if (o.highS ? s <= n / 2n : s > n / 2n) s = n - s;
  const raw = Buffer.concat([buf32(r), buf32(s)]);
  if (!verify('sha256', bytes, { key: nodeKey, dsaEncoding: 'ieee-p1363' }, raw)) throw new Error(`${name}: node:crypto refuses the signature`);
  const derSig = der(r, s);
  if (!verify('sha256', bytes, { key: nodeKey, dsaEncoding: 'der' }, derSig)) throw new Error(`${name}: node:crypto refuses the DER form`);
  const v = {
    name,
    method: o.method,
    path: o.path,
    headers: {
      'Journear-Key-Id': KEY_ID,
      'Journear-Timestamp': TIMESTAMP,
      'Journear-Nonce': nonce,
      'Journear-Signature': o.sendDer ? b64url(derSig) : b64url(raw),
      ...(o.idempotencyKey ? { 'Idempotency-Key': o.idempotencyKey } : {}),
      ...(o.method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    body: o.body ?? '',
    bodySha256: sha256(Buffer.from(o.body ?? '', 'utf8')).toString('hex'),
    signedFor,
    message: text,
    signatureRawHex: raw.toString('hex'),
    signatureDerHex: derSig.toString('hex'),
    highS: s > n / 2n,
    expect,
  };
  return v;
}

export function buildVectors() {
  return {
    format: 'journear-platform-v1',
    note: 'Test vectors for the platform API request signature (docs/api.md "Platform API"). The key is a test key whose private half is derived in the generator from a fixed string: never use it.',
    env: { envName: ENV_NAME, signerAccount: SIGNER_ACCOUNT },
    // No private key in the file (the secret scan's rule, and nothing needs it): it is derived above from a fixed string.
    key: { keyId: KEY_ID, jwk: JWK, publicKeyHex: Buffer.concat([Buffer.from([4]), buf32(Q[0]), buf32(Q[1])]).toString('hex'), thumbprint: THUMBPRINT },
    timestampMs: Number(TIMESTAMP),
    cases: [
      signed('get', { method: 'GET', path: '/v1/platform/credential' }, 'verifies'),
      signed('get_query', { method: 'GET', path: '/v1/platform/apps?scopeId=s1abc&cursor=app_9xYz' }, 'verifies'),
      signed('post_body', { method: 'POST', path: '/v1/platform/credential/revoke', body: '{"reason":"Moving to the standby key"}' }, 'verifies'),
      signed('post_idempotency', { method: 'POST', path: '/v1/platform/credential/revoke', body: '{}', idempotencyKey: 'op-2026-11-25-0001' }, 'verifies'),
      signed('high_s', { method: 'GET', path: '/v1/platform/credential', highS: true }, 'verifies'),
      signed('der', { method: 'GET', path: '/v1/platform/credential', sendDer: true }, 'refused'),
      signed('other_env_name', { method: 'GET', path: '/v1/platform/credential', envName: 'sandbox-other' }, 'refused'),
      signed('other_signer_account', { method: 'GET', path: '/v1/platform/credential', signerAccount: 'signer.other.near' }, 'refused'),
    ],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(OUT, `${JSON.stringify(buildVectors(), null, 2)}\n`);
  console.log(`wrote ${OUT}`);
}
