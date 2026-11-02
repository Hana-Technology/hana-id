// The sign-in methods an app offers (`apps.login_methods`, migration 0010; docs/email-login-spec.md "API changes"):
// comma-separated, `'google'` by default, `'google,email'` once the partner turns email on (build plan batch 8; the
// partner console toggle later). Read beside the gate, never in it (apps.ts getAppByKey is the hot path every relay
// shares): only GET /v1/app and requests that carry an email token read it. The email issuer parses the same column
// the same way (apps/email-issuer/src/apps.ts).

export type LoginMethod = 'google' | 'email';
export const LOGIN_METHODS: readonly LoginMethod[] = ['google', 'email'];

/** The column's methods, in a fixed order; unknown names are ignored. A missing or empty value is `['google']`. */
export function parseLoginMethods(raw: string | null | undefined): LoginMethod[] {
  const named = (raw ?? 'google')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const methods = LOGIN_METHODS.filter((m) => named.includes(m));
  return raw === null || raw === undefined || raw.trim() === '' ? ['google'] : methods;
}

/**
 * The app's login methods. Before migration 0010 the column doesn't exist: every app is Google-only, as the default
 * says (so the API can be deployed before the migration without refusing anything it accepted before). Throws on any
 * other D1 error (callers answer 503 config_unavailable).
 */
export async function appLoginMethods(db: D1Database, appId: string): Promise<LoginMethod[]> {
  try {
    const row = await db.prepare('SELECT login_methods FROM apps WHERE id = ?1').bind(appId).first<{ login_methods: string | null }>();
    return parseLoginMethods(row?.login_methods);
  } catch (err) {
    if (err instanceof Error && /no such column: login_methods/u.test(err.message)) return ['google'];
    throw err;
  }
}
