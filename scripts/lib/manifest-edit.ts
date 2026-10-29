// Edits string fields of an env manifest in place, keeping the file's formatting.
import { manifestSchema } from '@hana-id/env';

function replaceString(text: string, parsed: Record<string, unknown>, key: string, value: string): string {
  if (typeof parsed[key] !== 'string') throw new Error(`Manifest has no string field "${key}"`);
  const re = new RegExp(`("${key}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'u');
  const matches = text.match(new RegExp(re.source, 'gu')) ?? [];
  if (matches.length === 1) return text.replace(re, (_m, head: string) => `${head}${JSON.stringify(value)}`);
  // Ambiguous (the key also appears nested): rewrite the whole file.
  return `${JSON.stringify({ ...parsed, [key]: value }, null, 2)}\n`;
}

/**
 * Replaces the values of top-level string fields in manifest JSON text, all at once (fields that must change together,
 * such as `owner` and `ownerKind`, are validated together); the result must still validate.
 */
export function setManifestStrings(text: string, fields: Record<string, string>): string {
  let out = text;
  for (const [key, value] of Object.entries(fields)) out = replaceString(out, JSON.parse(out) as Record<string, unknown>, key, value);
  const check = JSON.parse(out) as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) if (check[key] !== value) throw new Error(`Failed to set "${key}" in the manifest`);
  manifestSchema.parse(check);
  return out;
}

/** Replaces the value of a top-level string field `key` in manifest JSON text; the result must still validate. */
export function setManifestString(text: string, key: string, value: string): string {
  return setManifestStrings(text, { [key]: value });
}
