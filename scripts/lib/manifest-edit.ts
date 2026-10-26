// Edits one string field of an env manifest in place, keeping the file's formatting.
import { manifestSchema } from '@hana-id/env';

/** Replaces the value of a top-level string field `key` in manifest JSON text; the result must still validate. */
export function setManifestString(text: string, key: string, value: string): string {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (typeof parsed[key] !== 'string') throw new Error(`Manifest has no string field "${key}"`);
  const re = new RegExp(`("${key}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'u');
  const matches = text.match(new RegExp(re.source, 'gu')) ?? [];
  let out: string;
  if (matches.length === 1) {
    out = text.replace(re, (_m, head: string) => `${head}${JSON.stringify(value)}`);
  } else {
    // Ambiguous (the key also appears nested): rewrite the whole file.
    out = `${JSON.stringify({ ...parsed, [key]: value }, null, 2)}\n`;
  }
  const check = JSON.parse(out) as Record<string, unknown>;
  if (check[key] !== value) throw new Error(`Failed to set "${key}" in the manifest`);
  manifestSchema.parse(check);
  return out;
}
