// A tiny SQL builder for the RPC writes (src/changes/*): a statement is text with `?` placeholders and its arguments in
// order, composed from fragments, so the commit predicate, the "this write committed" condition and the rest can be
// written once and spliced into many statements. Every value is a bound parameter; only `raw` text (SQL written in
// this code, never input) is spliced in as is.
export type SqlValue = string | number | null | ArrayBuffer;

export interface Q {
  readonly sql: string;
  readonly args: readonly SqlValue[];
}

const isQ = (v: unknown): v is Q => typeof v === 'object' && v !== null && 'sql' in v && 'args' in v && Array.isArray((v as Q).args);

/** q`… ${value} … ${fragment} …`: values become `?` and arguments, fragments are spliced with theirs. */
export function q(strings: TemplateStringsArray, ...values: (SqlValue | Q | boolean)[]): Q {
  let sql = strings[0]!;
  const args: SqlValue[] = [];
  values.forEach((v, i) => {
    if (isQ(v)) {
      sql += v.sql;
      args.push(...v.args);
    } else {
      sql += '?';
      args.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    sql += strings[i + 1]!;
  });
  return { sql, args };
}

/** SQL text written in this code (column lists, constant clauses). Never pass input here. */
export const raw = (sql: string): Q => ({ sql, args: [] });

/** Fragments joined by `sep` (e.g. `, ` or ` AND `). */
export function join(parts: readonly Q[], sep: string): Q {
  return { sql: parts.map((p) => p.sql).join(sep), args: parts.flatMap((p) => p.args) };
}

export const prepare = (db: D1Database, s: Q): D1PreparedStatement => db.prepare(s.sql).bind(...s.args);
