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

/** A flat object on one line, in the manifests' style: `{ "a": 1, "b": ["x", "y"] }`. */
function inlineObject(value: Record<string, string | number | readonly string[]>): string {
  const field = (v: string | number | readonly string[]) => (Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : JSON.stringify(v));
  return `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${field(v)}`).join(', ')} }`;
}

/**
 * Sets the top-level field `key` to a flat object (string, number or string-array values), on one line: replaced in
 * place when present, else inserted right after the top-level string field `after`. The rest of the file keeps its
 * formatting; when the field can't be placed unambiguously the whole file is rewritten. The result must validate.
 */
export function setManifestObject(text: string, key: string, value: Record<string, string | number | readonly string[]>, after: string): string {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const line = inlineObject(value);
  let out: string | null = null;
  if (key in parsed) {
    const re = new RegExp(`("${key}"\\s*:\\s*)\\{[^{}]*\\}`, 'gu');
    if ((text.match(re) ?? []).length === 1) out = text.replace(re, (_m, head: string) => `${head}${line}`);
  } else {
    const re = new RegExp(`^([ \\t]*)("${after}"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*")(,?)`, 'gmu');
    const matches = [...text.matchAll(re)];
    if (matches.length === 1 && matches[0]![3] === ',') out = text.replace(re, (_m, indent: string, field: string) => `${indent}${field},\n${indent}"${key}": ${line},`);
  }
  out ??= `${JSON.stringify({ ...parsed, [key]: value }, null, 2)}\n`;
  const check = JSON.parse(out) as Record<string, unknown>;
  if (JSON.stringify(check[key]) !== JSON.stringify(value)) throw new Error(`Failed to set "${key}" in the manifest`);
  manifestSchema.parse(check);
  return out;
}
