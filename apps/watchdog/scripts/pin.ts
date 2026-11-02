// Prints the watchdog pin of an RSA public key: its RFC 7638 JWK thumbprint, which is also the `kid` Hana's email
// issuer gives that key (D190). One function for both (`rsaThumbprint`, `packages/jwks`), so the issuer's kid and the
// manifest's pin can't disagree (leading zero bytes are stripped first, as the contract stores the key).
//
//   pnpm --filter @hana-id/watchdog pin <public key file>
//
// The file holds a public key only: a JWK (`{"kty":"RSA","n":…,"e":…}`, or a JWKS whose keys are each printed) or a
// PEM `PUBLIC KEY` / `RSA PUBLIC KEY`. A private key (a JWK with `d`, a `PRIVATE KEY` PEM) is refused unread: export
// the public half first. Nothing but kids and thumbprints is printed.
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rsaThumbprint } from '@hana-id/jwks';

export interface PinLine {
  /** The key's own `kid` in the file, if any. */
  kid: string | null;
  thumbprint: string;
}

const PRIVATE_PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/u;

async function pinOfJwk(k: unknown): Promise<PinLine> {
  const j = k as { kty?: unknown; n?: unknown; e?: unknown; d?: unknown; kid?: unknown };
  if (typeof k !== 'object' || k === null) throw new Error('Not a JWK');
  if ('d' in j || 'p' in j) throw new Error('This is a private key: pass its public JWK (kty, n, e) only');
  if (j.kty !== 'RSA' || typeof j.n !== 'string' || typeof j.e !== 'string') throw new Error('Not an RSA public JWK (kty "RSA", n, e)');
  const thumbprint = await rsaThumbprint({ n: j.n, e: j.e });
  if (!thumbprint) throw new Error('The key material is not valid base64url');
  return { kid: typeof j.kid === 'string' ? j.kid : null, thumbprint };
}

/** The pin of every public key in `text` (a JWK, a JWKS or a PEM). */
export async function pinsOfText(text: string): Promise<PinLine[]> {
  const trimmed = text.trim();
  // Anywhere in the file (openssl writes "Bag Attributes" and other text before the block): never parse a file that
  // holds a private key, whatever else it holds.
  if (PRIVATE_PEM.test(trimmed)) throw new Error('This is a private key: pass the public key PEM only');
  const pem = /-----BEGIN (RSA )?PUBLIC KEY-----[\s\S]*?-----END \1?PUBLIC KEY-----/u.exec(trimmed)?.[0];
  if (pem) return [await pinOfJwk(createPublicKey(pem).export({ format: 'jwk' }))];
  if (trimmed.includes('-----BEGIN')) throw new Error('No PUBLIC KEY block found (a certificate? export its public key first)');
  let v: unknown;
  try {
    v = JSON.parse(trimmed);
  } catch {
    throw new Error('Not a JWK, a JWKS or a PEM public key');
  }
  const keys = (v as { keys?: unknown }).keys;
  return Array.isArray(keys) ? Promise.all(keys.map(pinOfJwk)) : [await pinOfJwk(v)];
}

/** One line per key: the thumbprint, and whether the file's own kid matches it. */
export function formatPins(lines: PinLine[]): string {
  return lines.map((l) => `${l.thumbprint}${l.kid === null ? '' : l.kid === l.thumbprint ? '  (kid matches)' : `  (kid ${JSON.stringify(l.kid)} does NOT match: the issuer must use the thumbprint as kid)`}`).join('\n');
}

export async function main(argv: string[]): Promise<number> {
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: pin <public key file (JWK, JWKS or PEM)>');
    return 2;
  }
  try {
    console.log(formatPins(await pinsOfText(readFileSync(file, 'utf8'))));
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'failed');
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main(process.argv.slice(2)).then((code) => process.exit(code));
