// Logo upload and removal (docs/batch-c-spec.md "Other app settings, name and logo", "Console BFF routes"; batch C11):
// `POST /api/orgs/:org/apps/:app/logo` with the image as the raw body. The backend only: the route needs a session and
// the owner role, which the session routes of C9/C10 check before they call `logoUploadRoute` (no route reaches it
// until then; index.ts). In order, cheapest first:
//
// 1. the body: Content-Length required, ≤ 512 KiB (`logo_too_large`), the type by magic bytes (PNG, JPEG or WebP,
//    else `logo_type`), one well-formed image with nothing after it and no animation (logo-format.ts);
// 2. the Images binding's `info`: the decoder's type must be the sniffed one, its size the header's, 128 to 2048 px
//    per side, aspect ratio ≤ 1.25;
// 3. the app: `ConsoleRpc.getApp` (the org's own app, not deleted) at the version the caller saw (`version_conflict`
//    otherwise), which also names the logo it replaces;
// 4. the re-encode (the paid transform) to a 256 × 256 PNG (fit contain, transparent padding), checked and stripped to
//    its image chunks (no metadata), ≤ 128 KiB, and decoded again;
// 5. the object: `logo_objects` first (so the hourly purge never takes a key being written), then `LOGOS.put` at
//    `logos/<app id>/<sha256 hex>.png` (`image/png`; content-addressed, so a re-put writes the same bytes);
// 6. `ConsoleRpc.setLogo` points `apps.logo_key` at it (CAS on `settings_version`, `app_changes` row, feed); then the
//    replaced object is marked, and the hourly cron deletes it 30 days later; an audit row records the outcome.
//
// A failure after step 5 leaves an object nothing points at, with its row unmarked: storage only, never a broken logo.
import { type Actor, LOGO_KEY_RE } from '@hana-id/console-core';
import { type AuditAction, type Writer, auditInsert, entry } from './audit.ts';
import type { Env } from './env.ts';
import { type ErrorCode, errorResponse, json, readBodyCapped } from './http.ts';
import { ipPrefix } from './ip.ts';
import { CONSOLE_LIMIT_PERIOD_S, consoleIpKey } from './limits.ts';
import type { RequestInfo } from './links.ts';
import { log } from './log.ts';
import { type LogoType, checkContainer, sniffLogoType, stripPng } from './logo-format.ts';

/** The upload cap (the raw body). */
export const LOGO_MAX_INPUT_BYTES = 512 * 1024;
/** Decoded size bounds, per side, and the aspect-ratio cap (long side / short side). */
export const LOGO_MIN_PX = 128;
export const LOGO_MAX_PX = 2048;
export const LOGO_MAX_ASPECT = 1.25;
/** The stored logo: a square PNG of this side, at most LOGO_MAX_OUTPUT_BYTES. */
export const LOGO_OUTPUT_PX = 256;
export const LOGO_MAX_OUTPUT_BYTES = 128 * 1024;
/** How much of the encoder's answer is read at most (it is checked against LOGO_MAX_OUTPUT_BYTES after stripping). */
const ENCODER_READ_CAP = 1024 * 1024;

/** The Images binding's transform: 256 × 256, the image fitted inside, the rest transparent. */
export const LOGO_TRANSFORM = Object.freeze({ width: LOGO_OUTPUT_PX, height: LOGO_OUTPUT_PX, fit: 'pad', background: 'rgba(0,0,0,0)' } as const);
/** Its output: PNG, first frame only (animated inputs are refused before this anyway). */
export const LOGO_OUTPUT = Object.freeze({ format: 'image/png', anim: false } as const);

/** The member a session route resolved (C9/C10): the caller has checked the session, the org and the owner role. */
export interface LogoCaller {
  orgId: string;
  appId: string;
  actor: Extract<Actor, { kind: 'member' }>;
}

export class LogoRefusal extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    /** Why, for the log only (a format reason, never the input). */
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'LogoRefusal';
  }
}

const refuse = (code: ErrorCode, message: string, reason?: string): never => {
  throw new LogoRefusal(code, message, reason);
};

const streamOf = (b: Uint8Array): ReadableStream<Uint8Array> => new Response(b).body as ReadableStream<Uint8Array>;

async function readStream(stream: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Images throws code 9412 for bytes that aren't an image it can read. */
const notAnImage = (err: unknown): boolean => typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 9412;

/** Steps 1's type and container checks; the sniffed type. */
export function checkUpload(input: Uint8Array): LogoType {
  if (input.byteLength === 0) refuse('logo_type', 'The logo is empty');
  if (input.byteLength > LOGO_MAX_INPUT_BYTES) refuse('logo_too_large', 'The logo is larger than 512 KiB');
  const type = sniffLogoType(input) ?? refuse('logo_type', 'A logo must be a PNG, JPEG or WebP image (SVG, GIF and AVIF are not accepted)', 'type');
  const container = checkContainer(type, input);
  if (!container.ok) {
    refuse('logo_type', container.reason === 'animated' ? 'An animated image can’t be a logo' : 'The logo is not one well-formed PNG, JPEG or WebP image', container.reason);
  }
  return type;
}

/** Step 2: the decoder's view of the input (type, size, shape). No transform is paid for here. */
export async function inspect(images: ImagesBinding, input: Uint8Array, type: LogoType): Promise<void> {
  const header = checkContainer(type, input);
  if (!header.ok) return refuse('logo_type', 'The logo is not one well-formed image', header.reason);
  let info: ImageInfoResponse;
  try {
    info = await images.info(streamOf(input));
  } catch (err) {
    if (notAnImage(err)) refuse('logo_type', 'The logo could not be read as an image', 'undecodable');
    throw err;
  }
  if (info.format !== type || !('width' in info)) refuse('logo_type', 'The logo’s content is not the image type it starts as', 'decoder_type');
  const { width, height } = info as { width: number; height: number };
  // The decoder and the header agree on the size (a JPEG's EXIF orientation may swap the two sides).
  const sameSize = (width === header.width && height === header.height) || (type === 'image/jpeg' && width === header.height && height === header.width);
  if (!sameSize) refuse('logo_type', 'The logo’s size is not the one its header states', 'decoder_size');
  if (width < LOGO_MIN_PX || height < LOGO_MIN_PX || width > LOGO_MAX_PX || height > LOGO_MAX_PX) {
    refuse('logo_type', `A logo is ${LOGO_MIN_PX} to ${LOGO_MAX_PX} pixels on each side`, 'dimensions');
  }
  if (Math.max(width, height) / Math.min(width, height) > LOGO_MAX_ASPECT) refuse('logo_type', 'A logo must be close to square (aspect ratio at most 1.25)', 'aspect');
}

/** Step 4: the re-encode, and the checks on its output. The stored bytes. */
export async function reencode(images: ImagesBinding, input: Uint8Array): Promise<Uint8Array> {
  let encoded: ImageTransformationResult;
  try {
    encoded = await images.input(streamOf(input)).transform(LOGO_TRANSFORM).output(LOGO_OUTPUT);
  } catch (err) {
    if (notAnImage(err)) refuse('logo_type', 'The logo could not be read as an image', 'undecodable');
    throw err;
  }
  if (encoded.contentType() !== 'image/png') refuse('logo_type', 'The logo could not be converted to PNG', 'encoder_type');
  const raw = await readStream(encoded.image(), ENCODER_READ_CAP);
  if (!raw) return refuse('logo_too_large', 'The converted logo is larger than 128 KiB', 'encoder_size');
  const stored = stripPng(raw, LOGO_OUTPUT_PX) ?? refuse('logo_type', 'The logo could not be converted to a 256 × 256 PNG', 'encoder_output');
  if (stored.byteLength > LOGO_MAX_OUTPUT_BYTES) refuse('logo_too_large', 'The converted logo is larger than 128 KiB; try a simpler image', 'encoder_size');
  // The stored bytes decode again, as the PNG of the size they claim.
  let again: ImageInfoResponse;
  try {
    again = await images.info(streamOf(stored));
  } catch (err) {
    if (notAnImage(err)) refuse('logo_type', 'The converted logo does not decode', 'output_undecodable');
    throw err;
  }
  if (again.format !== 'image/png' || !('width' in again) || again.width !== LOGO_OUTPUT_PX || again.height !== LOGO_OUTPUT_PX) {
    refuse('logo_type', 'The converted logo does not decode as a 256 × 256 PNG', 'output_check');
  }
  return stored;
}

/** The app as the API serves it: its settings version and its current logo key (from `logoUrl`), or a refusal. */
async function currentLogo(env: Env, c: LogoCaller, info: RequestInfo, expectedVersion: number): Promise<{ key: string | null; version: number }> {
  const answer = await env.API.getApp({ actor: c.actor, requestId: info.requestId, clientIp: info.clientIp, orgId: c.orgId, appId: c.appId });
  if (!answer.ok) return refuse(answer.code, answer.error ?? 'The app could not be read');
  const app = answer.app;
  if (app.deleted) refuse('not_found', 'No such app');
  if (app.settingsVersion !== expectedVersion) refuse('version_conflict', 'The app changed since it was read; reload and try again');
  if (app.logoUrl === undefined) return { key: null, version: app.settingsVersion };
  // The API names the logo on the same files origin this Worker's CSP allows; anything else is a misconfiguration.
  const prefix = `${env.FILES_ORIGIN}/`;
  const key = app.logoUrl.startsWith(prefix) ? app.logoUrl.slice(prefix.length) : null;
  if (!key || LOGO_KEY_RE.exec(key)?.[1] !== c.appId) {
    log({ event: 'logo', requestId: info.requestId, outcome: 'error', code: 'files_origin_mismatch' }, 'error');
    return refuse('internal', 'The app’s logo is on another files origin');
  }
  return { key, version: app.settingsVersion };
}

async function audit(env: Env, info: RequestInfo, c: LogoCaller, action: AuditAction, outcome: 'ok' | 'failed', details: Record<string, string>): Promise<void> {
  const w: Writer = { actor: c.actor, requestId: info.requestId, now: Date.now(), ipPrefix: ipPrefix(info.clientIp), country: info.country };
  try {
    await auditInsert(env.CONSOLE_DB, entry(w, action, { orgId: c.orgId, appId: c.appId, target: c.appId, outcome, details })).run();
  } catch (err) {
    log({ event: 'audit_write_failed', requestId: info.requestId, error: err instanceof Error ? err.name : 'unknown' }, 'warn');
  }
}

/** Step 6: the pointer, the replaced object's mark, the audit row. */
async function pointAt(env: Env, c: LogoCaller, info: RequestInfo, key: string | null, previous: string | null, expectedVersion: number): Promise<number> {
  const action: AuditAction = key === null ? 'app.logo_removed' : 'app.logo_set';
  const answer = await env.API.setLogo({ actor: c.actor, requestId: info.requestId, clientIp: info.clientIp, orgId: c.orgId, appId: c.appId, logoKey: key, expectedVersion });
  if (!answer.ok) {
    await audit(env, info, c, action, 'failed', { code: answer.code, ...(key ? { logoKey: key } : {}) });
    return refuse(answer.code, answer.error ?? 'The logo could not be set');
  }
  // The object the pointer left (at this version, by the CAS) starts its 30 days now.
  if (previous !== null && previous !== key) {
    await env.CONSOLE_DB.prepare('UPDATE logo_objects SET replaced_at = ?1 WHERE key = ?2 AND replaced_at IS NULL').bind(Date.now(), previous).run();
  }
  await audit(env, info, c, action, 'ok', key ? { logoKey: key } : {});
  return answer.version;
}

/** Upload: steps 1–6. Answers the new logo's URL and the app's settings version. */
export async function setAppLogo(env: Env, c: LogoCaller, info: RequestInfo, input: Uint8Array, expectedVersion: number): Promise<{ logoUrl: string; version: number }> {
  const type = checkUpload(input);
  if (!env.IMAGES || !env.LOGOS) {
    log({ event: 'logo', requestId: info.requestId, outcome: 'error', code: 'images_or_logos_unbound' }, 'error');
    return refuse('internal', 'Logo uploads are not configured');
  }
  await inspect(env.IMAGES, input, type);
  const current = await currentLogo(env, c, info, expectedVersion);
  const stored = await reencode(env.IMAGES, input);
  const sha256 = hex(await crypto.subtle.digest('SHA-256', stored));
  const key = `logos/${c.appId}/${sha256}.png`;
  const logoUrl = `${env.FILES_ORIGIN}/${key}`;
  if (current.key === key) return { logoUrl, version: current.version };
  // The row first, unmarked (a key replaced earlier and uploaded again is current again), then the object.
  await env.CONSOLE_DB.prepare('INSERT INTO logo_objects (key, app_id, created_at, replaced_at) VALUES (?1, ?2, ?3, NULL) ON CONFLICT (key) DO UPDATE SET replaced_at = NULL')
    .bind(key, c.appId, Date.now())
    .run();
  await env.LOGOS.put(key, stored, { httpMetadata: { contentType: 'image/png' }, sha256 });
  const version = await pointAt(env, c, info, key, current.key, expectedVersion);
  return { logoUrl, version };
}

/** Removal: the pointer to null; the object goes 30 days later. */
export async function removeAppLogo(env: Env, c: LogoCaller, info: RequestInfo, expectedVersion: number): Promise<{ version: number }> {
  const current = await currentLogo(env, c, info, expectedVersion);
  if (current.key === null) return { version: current.version };
  return { version: await pointAt(env, c, info, null, current.key, expectedVersion) };
}

/** Uploads per org per minute (the Images binding is paid per transform): the console's flood limiter, keyed by org. */
async function limited(env: Env, orgId: string): Promise<Response | null> {
  const { success } = await env.CONSOLE_IP_LIMIT.limit({ key: consoleIpKey(env.ENV_NAME, 'logo', orgId) });
  return success ? null : errorResponse('rate_limited', undefined, { 'retry-after': String(CONSOLE_LIMIT_PERIOD_S) });
}

/** `?expectedVersion=<n>`: the settings version the owner's screen showed. */
function expectedVersionOf(request: Request): number | null {
  const v = new URL(request.url).searchParams.getAll('expectedVersion');
  return v.length === 1 && /^\d{1,15}$/u.test(v[0]!) ? Number(v[0]) : null;
}

function answerRefusal(err: unknown, info: RequestInfo, c: LogoCaller): Response {
  if (err instanceof LogoRefusal) {
    log({ event: 'logo', requestId: info.requestId, orgId: c.orgId, outcome: 'rejected', code: err.reason ? `${err.code}:${err.reason}` : err.code });
    return errorResponse(err.code, err.message);
  }
  log({ event: 'logo', requestId: info.requestId, orgId: c.orgId, outcome: 'error', code: 'internal', error: err instanceof Error ? err.name : 'unknown' }, 'error');
  return errorResponse('internal');
}

/**
 * `POST /api/orgs/:org/apps/:app/logo?expectedVersion=<n>`, the image as the body (`content-type:
 * application/octet-stream`, csrf.ts) → `{logoUrl, version}`. The session route (C10) calls it for an owner of the org.
 */
export async function logoUploadRoute(request: Request, env: Env, info: RequestInfo, c: LogoCaller): Promise<Response> {
  const over = await limited(env, c.orgId);
  if (over) return over;
  const expectedVersion = expectedVersionOf(request);
  if (expectedVersion === null) return errorResponse('bad_request', 'Expected ?expectedVersion=<the app’s settings version>');
  if (request.headers.get('content-length') === null) return errorResponse('bad_request', 'A logo upload needs a Content-Length');
  const body = await readBodyCapped(request, LOGO_MAX_INPUT_BYTES);
  if (!body.ok) return body.code === 'payload_too_large' ? errorResponse('logo_too_large', 'The logo is larger than 512 KiB') : errorResponse(body.code);
  try {
    const out = await setAppLogo(env, c, info, body.bytes, expectedVersion);
    log({ event: 'logo', requestId: info.requestId, orgId: c.orgId, outcome: 'ok' });
    return json(200, out);
  } catch (err) {
    return answerRefusal(err, info, c);
  }
}

/** Removing the logo (`{expectedVersion}` → `{version}`): the backend of a C10 control; no route of its own in the spec. */
export async function logoRemoveRoute(env: Env, info: RequestInfo, c: LogoCaller, expectedVersion: number): Promise<Response> {
  try {
    return json(200, await removeAppLogo(env, c, info, expectedVersion));
  } catch (err) {
    return answerRefusal(err, info, c);
  }
}
