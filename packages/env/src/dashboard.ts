// Batch C's manifest additions (docs/batch-c-spec.md "Manifest"): the guarded-change delay every env sets, and the
// dashboard blocks (`console`, `files`, `admin`, `usage`, `email`, `ownerGrantDelayMs`), which an env has together
// or not at all, so an env without a dashboard still validates and deploys the API.
import { z } from './zod.ts';
import { hanaOriginProblem, isDevEnv, siteOf } from './origins.ts';

const DAY_MS = 24 * 60 * 60_000;
/** `appChangeDelayMs` and `ownerGrantDelayMs` bounds: 60 s (sandbox-dev's drills) to 7 days. */
export const MIN_APP_CHANGE_DELAY_MS = 60_000;
export const MAX_APP_CHANGE_DELAY_MS = 7 * DAY_MS;
/** On a production network both are at least 24 h (D93 Q12), and the contract timelock is no shorter. */
export const PRODUCTION_APP_CHANGE_DELAY_MS = DAY_MS;

export const delayMs = z.number().int().min(MIN_APP_CHANGE_DELAY_MS).max(MAX_APP_CHANGE_DELAY_MS);

const workerName = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u, 'A Worker name is 1-63 lowercase letters, digits and inner hyphens');
const resourceName = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u, 'A D1, R2 or Hyperdrive name is 1-63 lowercase letters, digits and inner hyphens');
/** R2 bucket names: 3-63 lowercase letters, digits and inner hyphens. */
const bucketName = z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u, 'An R2 bucket name is 3-63 lowercase letters, digits and inner hyphens');
const lowerEmail = z
  .string()
  .email()
  .refine((e) => e === e.toLowerCase(), 'Email addresses here are lowercased');

/**
 * An RFC 5322 `From` value: `Display Name <address>` or a bare address. No CR, LF, quotes or angle brackets in the
 * display name, so the value can't inject a header or a second address.
 */
export function emailFromProblem(value: string): string | null {
  if (/[\r\n]/u.test(value)) return 'must not contain a line break';
  const m = /^(?:([^"<>,;]{1,64}) )?<([^<>\s]+)>$/u.exec(value) ?? /^()([^<>\s"]+)$/u.exec(value);
  if (!m) return 'must be "Display Name <address>" or a bare address';
  if (!z.string().email().safeParse(m[2]).success) return `has an invalid address (${m[2]})`;
  if (m[2] !== m[2]!.toLowerCase()) return 'has an address that is not lowercased';
  return null;
}

export const consoleSchema = z
  .object({
    workerName,
    d1Name: resourceName,
    /** The partner console's origin (SPA and its /api/* backend). */
    origin: z.string(),
    /** The thin Worker serving only `/start` and `/callback` for the console's Google code flow (D66, D75). */
    authWorkerName: workerName,
    /** Its origin; the console client's only redirect URI is `authOrigin + "/callback"`. */
    authOrigin: z.string(),
  })
  .strict();

export const filesSchema = z
  .object({
    workerName,
    /** Serves partner logos from R2 (D74); no cookies, sandboxed. */
    origin: z.string(),
    logosBucket: bucketName,
    statementsBucket: bucketName,
    exportsBucket: bucketName,
  })
  .strict();

export const adminSchema = z
  .object({
    workerName,
    origin: z.string(),
    /** The Cloudflare Access team domain, `<team>.cloudflareaccess.com`: the Access JWT's issuer and JWKS host. */
    accessTeamDomain: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/u, 'accessTeamDomain is <team>.cloudflareaccess.com'),
    /** The Access application's AUD tag (64 hex characters), or `UNSET` until the application exists. */
    accessAud: z.string().regex(/^(?:[0-9a-f]{64}|UNSET)$/u, 'accessAud is the 64-hex-character AUD tag (or UNSET)'),
    /** The admin Worker's own allowlist behind the Access policy (D88): lowercased, non-empty. */
    staffEmails: z.array(lowerEmail).min(1).max(50),
    /**
     * The Access session (application and policy): whole hours, `1h` to `8h`, default `1h` (D437). Anything but `1h`
     * is refused outside a dev env on testnet (`accessSessionDurationProblem`): production is always 1 h (D409).
     */
    accessSessionDuration: z.string().regex(/^[1-8]h$/u, 'admin.accessSessionDuration is a whole number of hours from 1h to 8h').optional(),
  })
  .strict();

export const usageSchema = z
  .object({
    /** The Neon region (D73: Sydney, for the Privacy Act). */
    neonRegion: z.literal('aws-ap-southeast-2'),
    /** Hyperdrive config names: the API's (role `usage_writer`) and the admin Worker's (role `usage_admin`). */
    writerHyperdrive: resourceName,
    adminHyperdrive: resourceName,
  })
  .strict();

export const emailSchema = z
  .object({
    /** The sender on the dedicated sending subdomain (D87). */
    from: z.string().superRefine((v, ctx) => {
      const problem = emailFromProblem(v);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `email.from ${problem}` });
    }),
    /** Hana security's alias: every blocking notice and direct alert goes here too. */
    securityAlias: lowerEmail,
  })
  .strict();

export const DASHBOARD_BLOCKS = ['console', 'files', 'admin', 'usage', 'email', 'ownerGrantDelayMs'] as const;

interface DashboardFields {
  name: string;
  network: string;
  apiUrl: string;
  vaultOrigin?: string | undefined;
  authOrigin?: string | undefined;
  changeDelayMs: number;
  appChangeDelayMs: number;
  ownerGrantDelayMs?: number | undefined;
  cloudflare: { workerName: string; d1Name: string };
  watchdog?: { cloudflare: { workerName: string; d1Name: string } } | undefined;
  console?: z.infer<typeof consoleSchema> | undefined;
  files?: z.infer<typeof filesSchema> | undefined;
  admin?: z.infer<typeof adminSchema> | undefined;
  usage?: z.infer<typeof usageSchema> | undefined;
  email?: z.infer<typeof emailSchema> | undefined;
}

/**
 * Every origin Hana serves in this env: the API's, the two batch B page origins and, with a dashboard, the console,
 * its auth origin, the files and the admin origins. The API refuses each of them as a partner app origin
 * (`REFUSED_ORIGINS`), so no Hana page can act as a partner parent. Sorted, without duplicates.
 */
export function hanaOwnOrigins(m: Pick<DashboardFields, 'apiUrl' | 'vaultOrigin' | 'authOrigin' | 'console' | 'files' | 'admin'>): string[] {
  const list = [
    new URL(m.apiUrl).origin,
    m.vaultOrigin,
    m.authOrigin,
    m.console?.origin,
    m.console?.authOrigin,
    m.files?.origin,
    m.admin?.origin,
  ].filter((o): o is string => typeof o === 'string');
  return [...new Set(list)].sort();
}

/**
 * Problems with the guarded-change delays (`appChangeDelayMs`, `ownerGrantDelayMs`) for this env, or []: on a
 * production network (`mainnet`) each is at least 24 h, and the contract timelock `changeDelayMs` is no shorter
 * than `appChangeDelayMs` (docs/batch-c-spec.md "Manifest", "Contract changes").
 */
export function appChangeDelayProblems(m: Pick<DashboardFields, 'network' | 'changeDelayMs' | 'appChangeDelayMs' | 'ownerGrantDelayMs'>): { path: string; message: string }[] {
  if (m.network !== 'mainnet') return [];
  const out: { path: string; message: string }[] = [];
  if (m.appChangeDelayMs < PRODUCTION_APP_CHANGE_DELAY_MS) out.push({ path: 'appChangeDelayMs', message: `appChangeDelayMs must be at least ${PRODUCTION_APP_CHANGE_DELAY_MS} (24 h) on a production network` });
  if (m.ownerGrantDelayMs !== undefined && m.ownerGrantDelayMs < PRODUCTION_APP_CHANGE_DELAY_MS) {
    out.push({ path: 'ownerGrantDelayMs', message: `ownerGrantDelayMs must be at least ${PRODUCTION_APP_CHANGE_DELAY_MS} (24 h) on a production network` });
  }
  if (m.changeDelayMs < m.appChangeDelayMs) out.push({ path: 'changeDelayMs', message: 'changeDelayMs (the contract timelock) must be at least appChangeDelayMs on a production network' });
  return out;
}

/** Dashboard rules: blocks together, origins valid and distinct, names distinct. */
export function dashboardRules(m: DashboardFields, ctx: z.RefinementCtx): void {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  for (const p of appChangeDelayProblems(m)) issue([p.path], p.message);

  const present = DASHBOARD_BLOCKS.filter((k) => m[k] !== undefined);
  if (present.length === 0) return;
  if (present.length !== DASHBOARD_BLOCKS.length) {
    const missing = DASHBOARD_BLOCKS.filter((k) => m[k] === undefined);
    issue([missing[0]!], `The dashboard fields ${DASHBOARD_BLOCKS.join(', ')} are set together or not at all (missing: ${missing.join(', ')})`);
    return;
  }
  const { console: c, files: f, admin: a, usage: u } = m as Required<DashboardFields>;

  // Origins: each a valid Hana origin, all distinct from each other and from the API's and the batch B pages'.
  const dashboardOrigins: [string[], string][] = [
    [['console', 'origin'], c.origin],
    [['console', 'authOrigin'], c.authOrigin],
    [['files', 'origin'], f.origin],
    [['admin', 'origin'], a.origin],
  ];
  const seen = new Map<string, string>();
  let apiOrigin: string | null = null;
  try {
    apiOrigin = new URL(m.apiUrl).origin;
  } catch {
    // apiUrl's own check reports it
  }
  for (const [label, origin] of [['apiUrl', apiOrigin], ['vaultOrigin', m.vaultOrigin], ['authOrigin', m.authOrigin]] as const) {
    if (origin) seen.set(origin, label);
  }
  for (const [path, origin] of dashboardOrigins) {
    const field = path.join('.');
    const problem = hanaOriginProblem(origin, m.name);
    if (problem) {
      issue(path, `${field} ${problem}`);
      continue;
    }
    const other = seen.get(origin);
    if (other) issue(path, `${field} must be its own origin (it equals ${other})`);
    else seen.set(origin, field);
    // D38: the vault's registrable domain hosts nothing else outside dev envs.
    if (m.vaultOrigin && !isDevEnv(m.name) && hanaOriginProblem(m.vaultOrigin, m.name) === null && siteOf(origin) === siteOf(m.vaultOrigin)) {
      issue(path, `${field} must be a different site from vaultOrigin outside local*/sandbox* envs (D38)`);
    }
  }

  // Worker, D1, bucket and Hyperdrive names: one resource each.
  const distinct = (kind: string, entries: [string[], string | undefined][]) => {
    const names = new Map<string, string>();
    for (const [path, name] of entries) {
      if (name === undefined) continue;
      const other = names.get(name);
      if (other) issue(path, `${kind} name ${name} is also ${other}`);
      else names.set(name, path.join('.'));
    }
  };
  distinct('Worker', [
    [['cloudflare', 'workerName'], m.cloudflare.workerName],
    [['watchdog', 'cloudflare', 'workerName'], m.watchdog?.cloudflare.workerName],
    [['console', 'workerName'], c.workerName],
    [['console', 'authWorkerName'], c.authWorkerName],
    [['files', 'workerName'], f.workerName],
    [['admin', 'workerName'], a.workerName],
  ]);
  distinct('D1', [
    [['cloudflare', 'd1Name'], m.cloudflare.d1Name],
    [['watchdog', 'cloudflare', 'd1Name'], m.watchdog?.cloudflare.d1Name],
    [['console', 'd1Name'], c.d1Name],
  ]);
  distinct('R2 bucket', [
    [['files', 'logosBucket'], f.logosBucket],
    [['files', 'statementsBucket'], f.statementsBucket],
    [['files', 'exportsBucket'], f.exportsBucket],
  ]);
  distinct('Hyperdrive', [
    [['usage', 'writerHyperdrive'], u.writerHyperdrive],
    [['usage', 'adminHyperdrive'], u.adminHyperdrive],
  ]);
  if (new Set(a.staffEmails).size !== a.staffEmails.length) issue(['admin', 'staffEmails'], 'Duplicate staff email');
  const sessionProblem = accessSessionDurationProblem(m);
  if (sessionProblem) issue(['admin', 'accessSessionDuration'], sessionProblem);
}

/** The admin console's Cloudflare Access session when the manifest sets none, and the only value a production env may have (D409, D437). */
export const DEFAULT_ACCESS_SESSION_DURATION = '1h';

/** The admin's Access session length: the manifest's `admin.accessSessionDuration`, default 1 h (D437). */
export const accessSessionDurationOf = (admin: { accessSessionDuration?: string | undefined }): string => admin.accessSessionDuration ?? DEFAULT_ACCESS_SESSION_DURATION;

/**
 * Why this env's `admin.accessSessionDuration` isn't allowed, or null (D437): any other value than 1 h only in a dev env
 * (`local*`/`sandbox*`) on testnet. Also checked by `access-setup` itself, which writes the value to Cloudflare.
 */
export function accessSessionDurationProblem(m: { name: string; network: string; admin?: { accessSessionDuration?: string | undefined } | undefined }): string | null {
  const v = accessSessionDurationOf(m.admin ?? {});
  if (v === DEFAULT_ACCESS_SESSION_DURATION || (isDevEnv(m.name) && m.network === 'testnet')) return null;
  return `admin.accessSessionDuration ${v} is refused on ${m.name}: an Access session other than ${DEFAULT_ACCESS_SESSION_DURATION} is only for a dev env (local*, sandbox*) on testnet (D437)`;
}
