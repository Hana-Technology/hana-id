// SQL for the admin CLI, against the D1 schema in docs/batch-a-spec.md:
//   apps(id, name, scope_id, publishable_key UNIQUE, status 'active'|'suspended', plan, created_at)
//   app_origins(app_id, origin) · plans(id, per_minute, per_day) · usage(app_id, day, sessions, derives)
// Every value goes through the escaping `sql` tag.
import { type Manifest, partnerOriginProblem } from '@hana-id/env';
import { sql } from './sql.ts';

export type AppStatus = 'active' | 'suspended';

export interface NewApp {
  id: string;
  name: string;
  scopeId: string;
  publishableKey: string;
  plan: string;
  createdAt: number;
  origins: string[];
}

const LOCALHOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Literal dev wildcard accepted for pk_test_ apps (any localhost port). */
export const LOCALHOST_WILDCARD = 'http://localhost:*';

/** Validates and normalises an origin to `scheme://host[:port]` (lowercase host, no path/query). */
export function normaliseOrigin(input: string): string {
  if (input === LOCALHOST_WILDCARD) return input;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid origin: ${input}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`Origin must be http(s): ${input}`);
  if (url.username || url.password) throw new Error(`Origin must not contain credentials: ${input}`);
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || /[?#]/u.test(input)) {
    throw new Error(`Origin must not have a path, query or fragment: ${input}`);
  }
  if (url.protocol === 'http:' && !LOCALHOSTS.has(url.hostname)) throw new Error(`Plain http is only allowed for localhost: ${input}`);
  return url.origin;
}

/** Scope ids: "global" or contract-assigned "s" + base36. */
export function assertScopeId(s: string): string {
  if (!/^(global|s[0-9a-z]{1,13})$/u.test(s)) throw new Error(`Invalid scope id: ${s}`);
  return s;
}

/**
 * What can't be in an app name (OPER-11, AUTH-2): controls, format characters (bidi overrides and isolates, zero-width
 * characters), line and paragraph separators, private-use and unassigned code points. The name is shown beside the
 * verified origin in the consent and approval popups, and printed to the operator's terminal.
 */
const UNSAFE_NAME_RE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;

/** A trimmed, NFC-normalised app name of 1..100 characters with nothing UNSAFE_NAME_RE refuses. */
export function assertAppName(s: string): string {
  const name = s.normalize('NFC').trim();
  if (name.length < 1 || name.length > 100) throw new Error('App name must be 1..100 characters');
  if (UNSAFE_NAME_RE.test(name)) throw new Error('App name must not contain control, format (bidi, zero-width), separator or unassigned characters');
  return name;
}

/** A D1 value as the CLI prints it: anything UNSAFE_NAME_RE matches (ANSI escapes, bidi overrides) shown as \u{…}. */
export function printable(s: string): string {
  return s.replace(new RegExp(UNSAFE_NAME_RE.source, 'gu'), (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
}

/**
 * Refuses origins the API would drop or misuse for this app (OPER-6): see `partnerOriginProblem` in @hana-id/env.
 * Checked on create and add, never on remove (removing a bad entry must always work).
 */
export function assertAppOrigins(m: Pick<Manifest, 'name' | 'apiUrl' | 'vaultOrigin' | 'authOrigin'>, publishableKey: string, origins: readonly string[]): void {
  const hanaOrigins = [m.vaultOrigin, m.authOrigin, new URL(m.apiUrl).origin].filter((o): o is string => !!o);
  for (const origin of origins) {
    const problem = partnerOriginProblem(origin, { envName: m.name, testKey: publishableKey.startsWith('pk_test_'), hanaOrigins });
    if (problem) throw new Error(`Origin ${origin} ${problem}`);
  }
}

export function assertPlanId(s: string): string {
  if (!/^[a-z0-9_-]{1,32}$/u.test(s)) throw new Error(`Invalid plan id: ${s}`);
  return s;
}

export function createAppSql(app: NewApp): string {
  const stmts = [
    sql`INSERT INTO apps (id, name, scope_id, publishable_key, status, plan, created_at) VALUES (${app.id}, ${app.name}, ${app.scopeId}, ${app.publishableKey}, ${'active'}, ${app.plan}, ${app.createdAt})`,
    ...app.origins.map((o) => sql`INSERT INTO app_origins (app_id, origin) VALUES (${app.id}, ${o})`),
  ];
  return `${stmts.join(';\n')};`;
}

/**
 * Apps on `scopeId` whose key type is the other one: a pk_test_ app may never share a scope with a pk_live_ app (the
 * API refuses such a test key with 403 scope_conflict), so creating either side of that pair is refused.
 */
export function scopeConflictSql(scopeId: string, publishableKey: string): string {
  const other = publishableKey.startsWith('pk_live_') ? 'pk\\_test\\_%' : 'pk\\_live\\_%';
  return sql`SELECT id FROM apps WHERE scope_id = ${scopeId} AND publishable_key LIKE ${other} ESCAPE '\\'`;
}

export function planExistsSql(plan: string): string {
  return sql`SELECT id FROM plans WHERE id = ${plan}`;
}

/** Finds an app by id or publishable key. */
export function findAppSql(idOrKey: string): string {
  return sql`SELECT id, name, scope_id, publishable_key, status, plan FROM apps WHERE id = ${idOrKey} OR publishable_key = ${idOrKey}`;
}

export function addOriginsSql(appId: string, origins: string[]): string {
  return `${origins
    .map((o) => sql`INSERT INTO app_origins (app_id, origin) SELECT ${appId}, ${o} WHERE NOT EXISTS (SELECT 1 FROM app_origins WHERE app_id = ${appId} AND origin = ${o})`)
    .join(';\n')};`;
}

export function removeOriginsSql(appId: string, origins: string[]): string {
  return `${origins.map((o) => sql`DELETE FROM app_origins WHERE app_id = ${appId} AND origin = ${o}`).join(';\n')};`;
}

export function setStatusSql(appId: string, status: AppStatus): string {
  return sql`UPDATE apps SET status = ${status} WHERE id = ${appId}`;
}

export function listAppsSql(): string {
  return (
    'SELECT a.id, a.name, a.scope_id, a.publishable_key, a.status, a.plan, a.created_at, ' +
    "group_concat(o.origin, ' ') AS origins FROM apps a LEFT JOIN app_origins o ON o.app_id = a.id " +
    'GROUP BY a.id ORDER BY a.created_at'
  );
}
