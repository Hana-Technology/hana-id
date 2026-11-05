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

/**
 * Replaces `council.members` in manifest JSON text, keeping the rest of the file's formatting (the list is written on
 * one line, `["a", "b", "c"]`); the whole file is rewritten only when the field can't be placed unambiguously. The
 * result must validate.
 */
export function setCouncilMembers(text: string, members: readonly string[]): string {
  const parsed = JSON.parse(text) as { council?: Record<string, unknown> };
  if (!parsed.council || typeof parsed.council !== 'object') throw new Error('Manifest has no council');
  const list = `[${members.map((x) => JSON.stringify(x)).join(', ')}]`;
  const block = /("council"\s*:\s*)\{[^{}]*\}/gu;
  const blocks = text.match(block) ?? [];
  let out: string | null = null;
  if (blocks.length === 1) {
    const inner = blocks[0]!;
    const field = /("members"\s*:\s*)\[[^\]]*\]/gu;
    if ((inner.match(field) ?? []).length === 1) out = text.replace(inner, () => inner.replace(field, (_m, head: string) => `${head}${list}`));
  }
  out ??= `${JSON.stringify({ ...parsed, council: { ...parsed.council, members: [...members] } }, null, 2)}\n`;
  const check = JSON.parse(out) as { council?: { members?: unknown } };
  if (JSON.stringify(check.council?.members) !== JSON.stringify(members)) throw new Error('Failed to set council.members in the manifest');
  manifestSchema.parse(check);
  return out;
}

/**
 * Sets `admin.accessTeamDomain` and `admin.accessAud` in manifest JSON text (access-setup --write-manifest, D409),
 * keeping the rest of the file's formatting: each value is replaced in place inside the one `"admin": {…}` block
 * (which holds no nested object); the whole file is rewritten only when that can't be done unambiguously. The result
 * must validate.
 */
export function setAdminAccess(text: string, fields: { accessTeamDomain: string; accessAud: string }): string {
  const parsed = JSON.parse(text) as { admin?: Record<string, unknown> };
  if (!parsed.admin || typeof parsed.admin !== 'object') throw new Error('Manifest has no admin block');
  const blocks = text.match(/"admin"\s*:\s*\{[^{}]*\}/gu) ?? [];
  let out: string | null = null;
  if (blocks.length === 1) {
    let inner = blocks[0]!;
    let ok = true;
    for (const [key, value] of Object.entries(fields)) {
      const field = new RegExp(`("${key}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gu');
      if ((inner.match(field) ?? []).length !== 1) ok = false;
      else inner = inner.replace(field, (_m, head: string) => `${head}${JSON.stringify(value)}`);
    }
    if (ok) out = text.replace(blocks[0]!, () => inner);
  }
  out ??= `${JSON.stringify({ ...parsed, admin: { ...parsed.admin, ...fields } }, null, 2)}\n`;
  const check = JSON.parse(out) as { admin?: Record<string, unknown> };
  for (const [key, value] of Object.entries(fields)) if (check.admin?.[key] !== value) throw new Error(`Failed to set admin.${key} in the manifest`);
  manifestSchema.parse(check);
  return out;
}
