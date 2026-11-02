import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');

export const readText = (rel: string): string => readFileSync(join(PKG, rel), 'utf8');
export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

export interface VectorFile {
  version: number;
  provider: string;
  subPrefix: string;
  subLabel: string;
  idna: { standard: string; library: string; version: string; unicode: string };
  testKey: { preimage: string; derivation: string };
  normalize: { label: string; in: string; out: string }[];
  reject: { label: string; in: string }[];
  sub: { email: string; sub: string }[];
}

export const VECTORS_TEXT = readText('vectors/email-v1.json');
export const V = JSON.parse(VECTORS_TEXT) as VectorFile;
/** The vectors' TEST key (never an environment's K_sub). */
export const testKey = (): Uint8Array<ArrayBuffer> => new Uint8Array(createHash('sha256').update(V.testKey.preimage, 'utf8').digest());
