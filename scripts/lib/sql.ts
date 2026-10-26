// SQL for `wrangler d1 execute --command`, which has no bind parameters: every value goes through `sqlValue`,
// so statements are built only with the `sql` tag (values escaped, never spliced as raw text).

export type SqlParam = string | number | bigint | boolean | null;

/** Escapes one value as an SQLite literal. Strings: single-quoted with '' doubling; NUL and invalid UTF-16 rejected. */
export function sqlValue(v: SqlParam): string {
  if (v === null) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error(`Only safe integers can be used in SQL, got ${v}`);
    return String(v);
  }
  if (typeof v !== 'string') throw new Error(`Unsupported SQL value type: ${typeof v}`);
  if (v.includes('\0')) throw new Error('SQL strings must not contain NUL');
  if (!v.isWellFormed()) throw new Error('SQL strings must be valid Unicode');
  return `'${v.replaceAll("'", "''")}'`;
}

/** Tagged template: `sql\`SELECT * FROM apps WHERE id = ${id}\`` with every interpolation escaped. */
export function sql(strings: TemplateStringsArray, ...values: SqlParam[]): string {
  let out = strings[0] ?? '';
  values.forEach((v, i) => {
    out += sqlValue(v) + (strings[i + 1] ?? '');
  });
  return out;
}
