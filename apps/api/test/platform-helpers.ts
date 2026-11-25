// Helpers for the platform API's tests (D927, piece P3): a platform key in force for a fresh org (written as the API's
// own life cycle leaves it: registered by a member, announced, confirmed; bare D1 writes that every table rule of
// migration 0028 accepts), the org's switch, and a signed request sent straight to the platform handler with its own
// clock, so each test has its own limiter windows.
import { PLATFORM_KEY_LIFETIME_MS, jwkThumbprint, newId, signPlatformRequest } from '@hana-id/console-core';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { handlePlatform } from '../src/platform/request.ts';
import { type OrgApp, orgApp } from './rpc-helpers.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface Seeded {
  id: string;
  org: string;
  scope: string;
  app: OrgApp;
  privateKey: CryptoKey;
  publicRaw: Uint8Array;
  thumbprint: string;
}

/** A fresh P-256 key pair: the private half (for signing) and the public point and thumbprint. */
export async function keyPair(): Promise<{ privateKey: CryptoKey; publicRaw: Uint8Array; thumbprint: string }> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const publicRaw = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey;
  return { privateKey: kp.privateKey, publicRaw, thumbprint: await jwkThumbprint(jwk.x!, jwk.y!) };
}

/**
 * A key in force from `activeFrom` (default now) for a year, for `o.org` or a fresh org with one test app. `state`:
 * `active` (confirmed, in force), `pending` (announced, waiting a day), `registered` (not announced yet).
 */
export async function seedKey(
  o: { org?: OrgApp; id?: string; pair?: { privateKey: CryptoKey; publicRaw: Uint8Array; thumbprint: string }; activeFrom?: number; state?: 'active' | 'pending' | 'registered'; switchOn?: boolean } = {},
): Promise<Seeded> {
  const app = o.org ?? (await orgApp());
  const pair = o.pair ?? (await keyPair());
  const id = o.id ?? newId('platformKey');
  const now = Date.now();
  const blob = pair.publicRaw.buffer.slice(pair.publicRaw.byteOffset, pair.publicRaw.byteOffset + pair.publicRaw.byteLength);
  await env.DB.prepare(
    `INSERT INTO platform_keys (id, org_id, label, alg, public_key, thumbprint, scopes_json, status, proposed_by_kind, proposed_by, proposer_sub, proposer_email_key, proposed_at, four_eyes, min_delay_ms, request_id)
     VALUES (?1, ?2, 'Backend key', 'ES256', ?3, ?4, ?5, 'pending', 'member', 'usr_registrant', 'owner-sub-1', 'owner@partner.example', ?6, 0, ?7, ?8)`,
  )
    .bind(id, app.org, blob, pair.thumbprint, JSON.stringify([app.scope]), now, DAY, `req_reg_${id}`)
    .run();
  if (o.state !== 'registered') {
    await env.DB.prepare('UPDATE platform_keys SET notified_at = ?2, unconfirmed_active_from = ?3, active_from = ?3, expires_at = ?3 + ?4 WHERE id = ?1').bind(id, now, now + DAY, PLATFORM_KEY_LIFETIME_MS).run();
  }
  if (o.state === undefined || o.state === 'active') {
    const from = o.activeFrom ?? now;
    await env.DB.prepare(
      `UPDATE platform_keys SET confirmed_kind = 'confirm', confirmed_by = 'usr_registrant', confirmed_sub = 'owner-sub-1', confirmed_at = ?2,
              active_from = ?3, expires_at = ?3 + ?4, status = 'active', activated_recorded_at = ?2 WHERE id = ?1`,
    )
      .bind(id, now, from, PLATFORM_KEY_LIFETIME_MS)
      .run();
  }
  if (o.switchOn !== false) await switchOn(app.org);
  return { id, org: app.org, scope: app.scope, app, ...pair };
}

/** The org's platform switch on, with the review naming its current keys (the table's rule), and not frozen. */
export async function switchOn(org: string): Promise<void> {
  await env.DB.prepare("INSERT INTO platform_orgs (org_id, enabled, frozen, set_by, set_at) SELECT ?1, 0, 0, 'test', ?2 WHERE NOT EXISTS (SELECT 1 FROM platform_orgs WHERE org_id = ?1)").bind(org, Date.now()).run();
  await env.DB.prepare('UPDATE platform_orgs SET enabled = 0 WHERE org_id = ?1').bind(org).run();
  await env.DB.prepare(
    `UPDATE platform_orgs SET enabled = 1, frozen = 0, review_json = (SELECT json_group_array(id) FROM (SELECT id FROM platform_keys k WHERE k.org_id = ?1
       AND k.status IN ('awaiting_acceptance', 'pending', 'active') AND (k.expires_at IS NULL OR k.expires_at > ((julianday('now') - 2440587.5) * 86400000.0)) ORDER BY id))
     WHERE org_id = ?1`,
  )
    .bind(org)
    .run();
}

export const switchOff = (org: string) => env.DB.prepare('UPDATE platform_orgs SET enabled = 0, review_json = NULL WHERE org_id = ?1').bind(org).run();
export const freeze = (org: string) => env.DB.prepare('UPDATE platform_orgs SET frozen = 1, frozen_at = ?2 WHERE org_id = ?1').bind(org, Date.now()).run();

let ipCounter = 0;
/** An address of its own for each test (the per-IP window is the IP's). */
export const freshIp = (): string => `198.18.${Math.floor(++ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;

let clockSlot = 0;
/**
 * A clock of its own for each test: an hour apart, so every limiter window starts empty, a second into a clock minute
 * (a test's run of requests a few hundred ms apart stays in one minute window). Within the key's year.
 */
export const freshNow = (): number => Math.floor((Date.now() + ++clockSlot * HOUR) / 60_000) * 60_000 + 1000;

export interface SendOpts {
  method?: string;
  path?: string;
  /** The path the signature covers when it differs from the one sent (a path changed after signing). */
  signedPath?: string;
  body?: string;
  /** The body the signature covers when it differs from the one sent. */
  signedBody?: string;
  now?: number;
  timestampMs?: number;
  nonce?: string;
  idempotencyKey?: string;
  envName?: string;
  signerAccount?: string;
  keyId?: string;
  /** Headers to set over the signed ones; null removes one. */
  headers?: Record<string, string | null>;
  ip?: string;
  /** The same `cf-ray` makes the same request id, so two answers can be compared byte for byte. */
  ray?: string;
  bindings?: Partial<typeof env>;
  /** Sign with another private key (a key pair not registered here). */
  signWith?: CryptoKey;
  /** Change the signature header's value. */
  signature?: (s: string) => string;
}

export interface Sent {
  res: Response;
  status: number;
  body: Record<string, unknown>;
  text: string;
  headers: [string, string][];
  /** The request as signed, for a replay. */
  request: () => Request;
}

/** One signed request through the platform handler (straight, with `now`), every waitUntil awaited. */
export async function send(k: Pick<Seeded, 'id' | 'privateKey'>, o: SendOpts = {}): Promise<Sent> {
  const method = o.method ?? 'GET';
  const path = o.path ?? '/v1/platform/credential';
  const now = o.now ?? Date.now();
  const body = o.body ?? (method === 'POST' ? '{}' : undefined);
  const signed = await signPlatformRequest(o.signWith ?? k.privateKey, {
    envName: o.envName ?? env.ENV_NAME,
    signerAccount: o.signerAccount ?? env.SIGNER_ACCOUNT,
    keyId: o.keyId ?? k.id,
    method: method === 'POST' ? 'POST' : 'GET',
    path: o.signedPath ?? path,
    body: method === 'POST' ? (o.signedBody ?? body) : undefined,
    idempotencyKey: o.idempotencyKey,
    timestampMs: o.timestampMs ?? now,
    nonce: o.nonce,
  });
  const ip = o.ip ?? freshIp();
  const make = () => {
    const headers = new Headers(signed.headers);
    headers.set('cf-connecting-ip', ip);
    headers.set('cf-ray', o.ray ?? `ray${Math.random().toString(36).slice(2, 10)}`);
    if (o.signature) headers.set('journear-signature', o.signature(signed.headers['Journear-Signature']!));
    for (const [name, v] of Object.entries(o.headers ?? {})) {
      if (v === null) headers.delete(name);
      else headers.set(name, v);
    }
    return new Request(`https://api.test${path}`, { method, headers, ...(body !== undefined && method !== 'GET' && method !== 'HEAD' ? { body } : {}) });
  };
  const res = await deliver(make(), now, o.bindings);
  return { ...(await read(res)), request: make };
}

/** A request delivered to the platform handler at `now`, waiting for its waitUntil work. */
export async function deliver(request: Request, now = Date.now(), bindings?: Partial<typeof env>): Promise<Response> {
  const ctx = createExecutionContext();
  const ray = request.headers.get('cf-ray');
  const res = await handlePlatform(request, new URL(request.url), { ...env, ...(bindings ?? {}) } as typeof env, ray ?? crypto.randomUUID(), ctx, now);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function read(res: Response): Promise<Omit<Sent, 'request'>> {
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // not JSON
  }
  return { res, status: res.status, body, text, headers: [...res.headers.entries()].sort(([a], [b]) => (a < b ? -1 : 1)) };
}

export const keyRow = async (id: string) => (await env.DB.prepare('SELECT * FROM platform_keys WHERE id = ?1').bind(id).first<Record<string, unknown>>())!;
export const callsOf = async (keyId: string) =>
  (await env.DB.prepare('SELECT * FROM platform_calls WHERE key_id = ?1 ORDER BY seq').bind(keyId).all<{ route: string; method: string; status: number; code: string | null; request_id: string; ip_prefix: string | null; app_id: string | null; org_id: string; at: number }>()).results;
