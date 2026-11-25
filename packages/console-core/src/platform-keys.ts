// Platform keys (D918; docs/partner-platform-spec.md A3 "Registration, rotation, revocation", "An owner's confirmation
// of a key", A7): a network's backend signs its requests to the platform API with an ECDSA P-256 key whose public half
// is registered here for one organisation, one env and one or two of its test scopes. Only the public key is ever sent
// or stored; nothing can authenticate with a key yet (piece P3). This module holds what the API, the console and the
// admin Worker share: the words, the limits, the key's parsing and RFC 7638 thumbprint, the label rule, the step-up
// layouts' inputs, the RPC inputs and the views.
import { z } from '@hana-id/env/zod';
import { b64url, borshString, borshStringVec, compareBytes, concatBytes, fromB64url, sha256, utf8 } from './bytes.ts';
import { DOMAINS } from './layouts.ts';
import { brandNameIn, isDisplaySafeName, looksLikeAddress } from './names.ts';
import { ctx } from './types.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** `platform_keys.status` (migration 0028's CHECK). `expired` is the hourly job's end of a key a year after it came in. */
export const PLATFORM_KEY_STATUSES = ['awaiting_acceptance', 'pending', 'active', 'cancelled', 'revoked', 'expired'] as const;
export type PlatformKeyStatus = (typeof PLATFORM_KEY_STATUSES)[number];
/** Who registered or accepted a key (`proposed_by_kind`, `accepted_by_kind`). The platform itself never does. */
export const PLATFORM_KEY_ACTOR_KINDS = ['hana', 'member'] as const;
/** How a key came into force before its date (`confirmed_kind`): an owner's confirmation, or an owner's acceptance of a staff key. */
export const PLATFORM_KEY_CONFIRM_KINDS = ['confirm', 'acceptance'] as const;

/** A key works for 365 days from the moment it comes into force (D913 question 3). */
export const PLATFORM_KEY_LIFETIME_MS = 365 * DAY_MS;
/** The platform minimum (D914): a key nobody confirms comes into force at least 24 h after its announcement, in every env but `local*` test envs. */
export const PLATFORM_MIN_DELAY_MS = DAY_MS;
/** At most two keys per organisation in force, waiting or awaiting acceptance (A5), so one can stand by for the other. */
export const PLATFORM_KEYS_PER_ORG = 2;
/** No registration, acceptance or confirmation within 7 days of a change of the org's security contacts (M5). */
export const PLATFORM_KEY_CONTACT_WAIT_MS = 7 * DAY_MS;
/**
 * A key not announced, or not accepted, within 7 days lapses (as a guarded change does). The 7 days run from its
 * registration, or from the end of a hold after a security-contact change when that is later (the hold refuses the
 * announcement and the acceptance), and never past PLATFORM_KEY_HOLD_MAX_MS after its registration.
 */
export const PLATFORM_KEY_LAPSE_MS = 7 * DAY_MS;
/** However often the security contacts change, a key not announced or accepted lapses 28 days after its registration. */
export const PLATFORM_KEY_HOLD_MAX_MS = 28 * DAY_MS;

/**
 * The freeze mirror's grace (D918, after the second review): an unfreeze of the API's mirror is refused while its last
 * freeze is younger than this, whoever asks. A staff route call (three RPCs) and the hourly check's read-then-write of
 * one org take seconds; 10 minutes is many times both, so a freeze racing an unfreeze always lands inside it.
 */
export const PLATFORM_UNFREEZE_GRACE_MS = 10 * 60_000;

/**
 * The freeze mirror's one rule for an unfreeze (D918): nothing to do when the row isn't frozen; refused while the last
 * freeze is younger than the grace; else allowed. The caller must have read the console's org as active just before.
 */
export function mirrorUnfreeze(row: { frozen: boolean; frozenAt: number | null } | null, now: number): 'not_frozen' | 'too_soon' | 'allowed' {
  if (!row?.frozen) return 'not_frozen';
  return (row.frozenAt ?? 0) > now - PLATFORM_UNFREEZE_GRACE_MS ? 'too_soon' : 'allowed';
}
/** The confirmation notice's one-click revoke link works for 7 days (A3, proposed). */
export const PLATFORM_KEY_REVOKE_LINK_MS = 7 * DAY_MS;
/** The expiry warnings: 30 and 7 days before (A3). Stored as the stage reached (`expiry_notice_stage`). */
export const PLATFORM_KEY_EXPIRY_STAGES = [30, 7] as const;
export type PlatformKeyExpiryStage = (typeof PLATFORM_KEY_EXPIRY_STAGES)[number];
/** The longest label, in characters after NFC and trimming (A7). */
export const PLATFORM_KEY_LABEL_MAX = 40;
/** A staff registration's and a second staff member's reason: how the key was checked with the network (A3, M5). */
export const PLATFORM_KEY_STAFF_REASON_MIN = 20;

/** The ledger kinds a key's life writes (org-level rows, `app_id` NULL; their titles are in audit-words.ts). */
export const PLATFORM_KEY_LEDGER_KINDS = [
  'platform.key_proposed',
  'platform.key_accepted',
  'platform.key_announced',
  'platform.key_confirmed',
  'platform.key_cancelled',
  'platform.key_active',
  'platform.key_revoked',
  'platform.key_expired',
  'platform.org_switch',
  'platform.org_frozen',
] as const;

/** Why waiting origins a key proposed were cancelled with it (the `change.cancelled` row's `reason`). */
export const PLATFORM_CANCEL_REASONS = ['key_revoked', 'key_expired', 'platform_off', 'org_frozen'] as const;
export type PlatformCancelReason = (typeof PLATFORM_CANCEL_REASONS)[number];

// ---- words the screens and the emails share (plain, for a partner's developers) ----

export const PLATFORM_KEY_WORDS = {
  privateKey: 'This is a private key. Never send it to anyone: paste only the public key.',
  notAKey: 'This isn’t a public key we can read. Paste the public key as a PEM block (-----BEGIN PUBLIC KEY-----) or as a JWK with kty "EC" and crv "P-256".',
  fourEyes: 'Another owner needs to confirm this key.',
  oneOwner: 'Your organisation has one owner, so this key starts working when its wait ends.',
  contactWait: 'Your organisation’s security contacts changed less than 7 days ago. Platform keys can’t be registered, accepted or confirmed until 7 days after that change.',
} as const;

// ---- the id ----

/** A platform key's id: `pkc_` and the body of every console-core id (ids.ts `newId`). */
export const PLATFORM_KEY_ID_RE = /^pkc_[1-9A-HJ-NP-Za-km-z]{12,17}$/u;
export const platformKeyIdInput = z.string().regex(PLATFORM_KEY_ID_RE);

// ---- the public key ----

/** The P-256 curve (SEC 2): field prime, `b`, and `a = -3`. */
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const mod = (v: bigint): bigint => ((v % P) + P) % P;
const big = (bytes: Uint8Array): bigint => bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);

/** Whether (x, y) is a point of P-256 (both coordinates below the prime, y² = x³ − 3x + b). Not the point at infinity. */
export function onP256(x: Uint8Array, y: Uint8Array): boolean {
  if (x.length !== 32 || y.length !== 32) return false;
  const X = big(x);
  const Y = big(y);
  if (X >= P || Y >= P) return false;
  return mod(Y * Y) === mod(X * X * X - 3n * X + B);
}

/** The DER header of an uncompressed P-256 SubjectPublicKeyInfo: SEQUENCE { SEQUENCE { ecPublicKey, prime256v1 }, BIT STRING (65 bytes) }. */
const SPKI_P256_PREFIX = Uint8Array.from([0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00]);
/** The JWK members a public key may carry; anything else (above all `d`) is refused. */
const JWK_MEMBERS = new Set(['kty', 'crv', 'x', 'y', 'alg', 'use', 'kid', 'key_ops', 'ext']);
/** The biggest public key text accepted (a PEM block is about 180 characters, a JWK about 200). */
export const PLATFORM_PUBLIC_KEY_INPUT_MAX = 2048;

export interface ParsedPlatformKey {
  /** The 65-byte uncompressed point 0x04 ‖ x ‖ y, as `platform_keys.public_key` stores it. */
  raw: Uint8Array;
  /** The public JWK in RFC 7638's member set. */
  jwk: { crv: 'P-256'; kty: 'EC'; x: string; y: string };
  /** RFC 7638: b64url(sha256(`{"crv":"P-256","kty":"EC","x":…,"y":…}`)), 43 characters. */
  thumbprint: string;
}

export type PlatformKeyParse = { ok: true; key: ParsedPlatformKey } | { ok: false; problem: string; private?: true };

/** RFC 7638 thumbprint of a P-256 public JWK (members in lexical order, no whitespace). */
export async function jwkThumbprint(x: string, y: string): Promise<string> {
  return b64url(await sha256(utf8(`{"crv":"P-256","kty":"EC","x":"${x}","y":"${y}"}`)));
}

const fromStdB64 = (s: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(s) || s.length % 4 !== 0) return null;
  try {
    return fromB64url(s.replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, ''));
  } catch {
    return null;
  }
};

const coord = (s: unknown): Uint8Array | null => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(s)) return null;
  try {
    const b = fromB64url(s);
    return b.length === 32 && b64url(b) === s ? b : null;
  } catch {
    return null;
  }
};

async function fromPoint(x: Uint8Array, y: Uint8Array): Promise<PlatformKeyParse> {
  if (!onP256(x, y)) return { ok: false, problem: 'This public key is not a point of the P-256 curve.' };
  const jwk = { crv: 'P-256' as const, kty: 'EC' as const, x: b64url(x), y: b64url(y) };
  return { ok: true, key: { raw: concatBytes(Uint8Array.of(4), x, y), jwk, thumbprint: await jwkThumbprint(jwk.x, jwk.y) } };
}

/**
 * A public key as a partner pastes it: a PEM `PUBLIC KEY` block (an uncompressed P-256 SubjectPublicKeyInfo) or a JWK
 * (`kty: "EC"`, `crv: "P-256"`, `x`, `y`; `alg` if present `ES256`). Refuses anything private (a PEM `PRIVATE KEY`, a
 * JWK with `d`), another curve or algorithm, a compressed point, and a point off the curve. Never echoes the input.
 */
export async function parsePlatformPublicKey(input: string): Promise<PlatformKeyParse> {
  const text = input.trim();
  if (text.length === 0 || text.length > PLATFORM_PUBLIC_KEY_INPUT_MAX) return { ok: false, problem: PLATFORM_KEY_WORDS.notAKey };
  if (/PRIVATE KEY/u.test(text) || /"d"\s*:/u.test(text)) return { ok: false, problem: PLATFORM_KEY_WORDS.privateKey, private: true };
  if (text.startsWith('-----BEGIN PUBLIC KEY-----')) {
    const m = /^-----BEGIN PUBLIC KEY-----\s+([A-Za-z0-9+/=\s]+?)\s*-----END PUBLIC KEY-----$/u.exec(text);
    const der = m ? fromStdB64(m[1]!.replace(/\s+/gu, '')) : null;
    if (!der || der.length !== SPKI_P256_PREFIX.length + 65 || compareBytes(der.subarray(0, SPKI_P256_PREFIX.length), SPKI_P256_PREFIX) !== 0 || der[SPKI_P256_PREFIX.length] !== 4) {
      return { ok: false, problem: 'This PEM block isn’t an uncompressed ECDSA P-256 public key.' };
    }
    const at = SPKI_P256_PREFIX.length + 1;
    return fromPoint(der.subarray(at, at + 32), der.subarray(at + 32, at + 64));
  }
  if (text.startsWith('{')) {
    let jwk: unknown;
    try {
      jwk = JSON.parse(text);
    } catch {
      return { ok: false, problem: PLATFORM_KEY_WORDS.notAKey };
    }
    if (typeof jwk !== 'object' || jwk === null || Array.isArray(jwk)) return { ok: false, problem: PLATFORM_KEY_WORDS.notAKey };
    const j = jwk as Record<string, unknown>;
    if ('d' in j) return { ok: false, problem: PLATFORM_KEY_WORDS.privateKey, private: true };
    if (Object.keys(j).some((k) => !JWK_MEMBERS.has(k))) return { ok: false, problem: 'This JWK has members a public key doesn’t need. Send only kty, crv, x and y.' };
    if (j.kty !== 'EC' || j.crv !== 'P-256') return { ok: false, problem: 'Only ECDSA P-256 keys (kty "EC", crv "P-256") can be platform keys.' };
    if (j.alg !== undefined && j.alg !== 'ES256') return { ok: false, problem: 'A platform key signs with ES256 only.' };
    const x = coord(j.x);
    const y = coord(j.y);
    if (!x || !y) return { ok: false, problem: 'The JWK’s x and y must each be 32 bytes in base64url without padding.' };
    return fromPoint(x, y);
  }
  return { ok: false, problem: PLATFORM_KEY_WORDS.notAKey };
}

/** The key's point from its stored 65 bytes, as a JWK (for WebCrypto's import, and the staff view). */
export function rawToJwk(raw: Uint8Array): { crv: 'P-256'; kty: 'EC'; x: string; y: string } {
  if (raw.length !== 65 || raw[0] !== 4) throw new RangeError('A platform key is 65 bytes, uncompressed');
  return { crv: 'P-256', kty: 'EC', x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33, 65)) };
}

// ---- the label ----

/** The stored form of a key's label (NFC, trimmed, at most 40 characters, one display-safe line, no brand or address), or why not. */
export function platformKeyLabel(input: string): { ok: true; label: string } | { ok: false; problem: string } {
  const label = input.normalize('NFC').trim();
  const n = [...label].length;
  if (n < 1 || n > PLATFORM_KEY_LABEL_MAX) return { ok: false, problem: `The label must be 1 to ${PLATFORM_KEY_LABEL_MAX} characters` };
  if (!isDisplaySafeName(label)) return { ok: false, problem: 'The label has a control, format, separator or other invisible character' };
  if (looksLikeAddress(label)) return { ok: false, problem: 'The label must not look like a web address' };
  const brand = brandNameIn(label);
  if (brand) return { ok: false, problem: `The label must not contain "${brand}": our emails name Journear Passport themselves` };
  return { ok: true, label };
}

/** The scopes a key names, distinct and sorted (by UTF-8 bytes): the layouts' and `scopes_json`'s order. */
export function sortedScopes(list: readonly string[]): string[] {
  if (new Set(list).size !== list.length) throw new TypeError('A scope is listed twice');
  return [...list].sort((a, b) => compareBytes(utf8(a), utf8(b)));
}

// ---- "a different person" (A3, D917) ----

/**
 * The email compared for four eyes: lower case, and in the local part every dot and a `+tag` removed, so
 * `a.b+x@example.com` and `ab@example.com` are one person. An address without `@` compares as itself, lower-cased.
 */
export function personEmailKey(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at <= 0) return e;
  const local = e.slice(0, at).split('+')[0]!.replace(/\./gu, '');
  return `${local}@${e.slice(at + 1)}`;
}

// ---- the step-up layouts (layouts.ts DOMAINS.platformKey*) ----

export type PlatformKeyStepKind = 'add' | 'accept' | 'confirm';

export const PLATFORM_KEY_DOMAINS: Readonly<Record<PlatformKeyStepKind, string>> = {
  add: DOMAINS.platformKeyAdd,
  accept: DOMAINS.platformKeyAccept,
  confirm: DOMAINS.platformKeyConfirm,
};

/**
 * A platform key's step-up (registration, acceptance, confirmation; D918): d = sha256(domain ‖ borsh(signer) ‖
 * borsh(env) ‖ borsh(org_id) ‖ borsh(key_id) ‖ borsh(thumbprint) ‖ borsh(sorted scopes) ‖ borsh(label)), each kind
 * with its own domain so no token of one stands in for another. `key_id` is "" for a registration (the id is made at
 * the write). The console builds it, and the API recomputes it from the request (a registration) or the stored key.
 */
export async function platformKeyDigest(i: { kind: PlatformKeyStepKind; signer: string; env: string; orgId: string; keyId: string; thumbprint: string; scopes: readonly string[]; label: string }): Promise<Uint8Array> {
  const domain = PLATFORM_KEY_DOMAINS[i.kind];
  if (!domain) throw new TypeError(`Unknown platform key step ${String(i.kind)}`);
  if ((i.kind === 'add') !== (i.keyId === '')) throw new TypeError('A registration has no key id yet; an acceptance or a confirmation names one');
  if (!/^[A-Za-z0-9_-]{43}$/u.test(i.thumbprint)) throw new TypeError('The thumbprint is 43 characters of base64url');
  if (i.scopes.length < 1 || i.scopes.length > 2) throw new TypeError('A platform key names one or two scopes');
  if (!i.signer || !i.env || !i.orgId || !i.label) throw new TypeError('A platform key step needs the signer, the env, the org and the label');
  return sha256(concatBytes(utf8(domain), borshString(i.signer), borshString(i.env), borshString(i.orgId), borshString(i.keyId), borshString(i.thumbprint), borshStringVec(sortedScopes(i.scopes)), borshString(i.label)));
}

// ---- RPC inputs ----

const org = { orgId: z.string().regex(/^org_[A-Za-z0-9]{1,64}$/u) };
const scopeId = z.string().regex(/^(global|s[0-9a-z]{1,32})$/u);
const scopeIds = z.array(scopeId).min(1).max(2);
const jwt = z.string().max(7168).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
const publicKey = z.string().min(1).max(PLATFORM_PUBLIC_KEY_INPUT_MAX);
const label = z.string().min(1).max(4 * PLATFORM_KEY_LABEL_MAX);
const b64url32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const staffReason = z.string().trim().min(PLATFORM_KEY_STAFF_REASON_MIN).max(1000);
const keyId = { keyId: platformKeyIdInput };

/** ConsoleRpc.proposePlatformKey: an on-chain owner of each scope registers a key, with the step-up of kind `platform.key_add`. */
export const proposePlatformKeyInput = ctx.extend({ ...org, scopeIds, label, publicKey, stepUpJwt: jwt }).strict();
/** ConsoleRpc.acceptPlatformKey / confirmPlatformKey: the step-up of kind `platform.key_accept` / `platform.key_confirm`. */
export const stepUpPlatformKeyInput = ctx.extend({ ...org, ...keyId, stepUpJwt: jwt }).strict();
/** ConsoleRpc and AdminRpc: list, read, cancel (no step-up: cancelling only ever stops a key). */
export const listPlatformKeysInput = ctx.extend(org).strict();
export const platformKeyInput = ctx.extend({ ...org, ...keyId }).strict();
/** Revocation: immediate. Staff give a reason; an owner and the key itself may. */
export const revokePlatformKeyInput = ctx.extend({ ...org, ...keyId, reason: z.string().trim().max(200).optional() }).strict();
export const adminRevokePlatformKeyInput = ctx.extend({ ...org, ...keyId, reason: z.string().trim().min(1).max(200) }).strict();
/** The emailed links (no session: the token is the proof; the `link` actor). */
export const platformKeyByLinkInput = ctx.extend({ ...keyId, token: b64url32 }).strict();
/** AdminRpc.registerPlatformKey: staff, after checking the thumbprint with the network out of band (the reason says how). */
export const registerPlatformKeyInput = ctx.extend({ ...org, scopeIds, label, publicKey, reason: staffReason }).strict();
/** AdminRpc.approvePlatformKey: a second staff member, never the one who registered it. */
export const approvePlatformKeyInput = ctx.extend({ ...org, ...keyId, reason: staffReason }).strict();
/** AdminRpc.setPlatformOrg: the org's platform switch. Turning it on names every key of the org still in force or waiting (the review, L5). */
export const setPlatformOrgInput = ctx.extend({ ...org, enabled: z.boolean(), reason: z.string().trim().min(1).max(500), reviewedKeys: z.array(platformKeyIdInput).max(10).optional() }).strict();
/**
 * AdminRpc.setPlatformOrgFrozen: the admin Worker mirrors the console's freeze of an org. An unfreeze follows
 * `mirrorUnfreeze`; `expectedVersion` makes it a compare-and-swap on the row read with the hourly check's list.
 */
export const setPlatformOrgFrozenInput = ctx.extend({ ...org, frozen: z.boolean(), expectedVersion: z.number().int().nonnegative().optional() }).strict();
export const platformKeyNoticesInput = ctx.extend({ limit: z.number().int().min(1).max(100) }).strict();
export const ackPlatformKeyNoticeInput = ctx.extend({ ...keyId, cancelTokenHash: b64url32, revokeTokenHash: b64url32.optional() }).strict();
export const ackPlatformKeyConfirmNoticeInput = ctx.extend({ ...keyId, revokeTokenHash: b64url32 }).strict();
export const ackPlatformKeyEndNoticeInput = ctx.extend(keyId).strict();
export const ackPlatformKeyExpiryNoticeInput = ctx.extend({ ...keyId, stage: z.union([z.literal(30), z.literal(7)]) }).strict();
export const notePlatformKeyNoticeFailureInput = ctx.extend(keyId).strict();
export const platformOrgsInput = ctx.extend({ limit: z.number().int().min(1).max(500), cursor: z.string().regex(/^org_[A-Za-z0-9]{1,64}$/u).optional() }).strict();

// ---- views ----

/** What a screen calls a key's state. */
export const PLATFORM_KEY_STATES = ['awaiting_acceptance', 'waiting', 'in_force', 'cancelled', 'revoked', 'expired'] as const;
export type PlatformKeyState = (typeof PLATFORM_KEY_STATES)[number];

/** A key as the console and the admin portal see it. Never a Google `sub`, a token or a hash; staff identities only in the staff view. */
export interface PlatformKeyView {
  id: string;
  orgId: string;
  label: string;
  thumbprint: string;
  scopes: string[];
  status: PlatformKeyStatus;
  state: PlatformKeyState;
  /** A real-money setup: only an owner other than the one who registered it may confirm it. */
  fourEyes: boolean;
  proposedByKind: 'hana' | 'member';
  /** A member's console user id; `hana` for staff in the partner view. */
  proposedBy: string;
  /** Staff view only: the registering staff member's email. */
  proposedByEmail?: string;
  /** The partner view for one member (ConsoleRpc.getPlatformKey): whether this member is the registrant as four eyes counts it (the console user, the Google account or the email). */
  registeredByYou?: boolean;
  proposedAt: number;
  acceptedByKind?: 'hana' | 'member';
  acceptedBy?: string;
  acceptedByEmail?: string;
  acceptedAt?: number;
  notifiedAt?: number;
  /** When it came (or comes) into force; for a waiting key, the date it comes into force if nobody confirms it. */
  activeFrom?: number;
  expiresAt?: number;
  confirmedKind?: 'confirm' | 'acceptance';
  confirmedBy?: string;
  confirmedAt?: number;
  cancelledAt?: number;
  cancelledByKind?: string;
  revokedAt?: number;
  revokedByKind?: string;
  revokeReason?: string;
  lastUsedAt?: number;
  /** A key not announced (or not accepted) yet, held after a change of the org's security contacts until this date (M5). */
  heldUntil?: number;
}

/** The platform switch of an org as the admin portal sees it (a missing row: off). */
export interface PlatformOrgView {
  orgId: string;
  enabled: boolean;
  frozen: boolean;
  maxApps: number;
  creationsPerDay: number;
  proposalsPerDay: number;
  setBy: string | null;
  setAt: number | null;
}

/** One notice the admin Worker sends for a key (AdminRpc.platformKeyNotices). */
export interface PlatformKeyNotice {
  kind: 'announce' | 'confirmed' | 'ended' | 'expiring';
  key: PlatformKeyView & { proposedByEmail?: string; acceptedByEmail?: string };
  contacts: string[];
  /** announce: whether it is in force at once when acked (an owner accepted a staff key): the email then carries the revoke link, not a Confirm link. */
  inForceAtOnce?: boolean;
  /** announce: how long after the announcement it comes into force if nobody confirms it (the env's wait, at least 24 h outside `local*` test envs). */
  waitMs?: number;
  /** expiring: the warning's stage (days before). */
  stage?: PlatformKeyExpiryStage;
  /** ended: the waiting web addresses cancelled with it (app id and name, the address). */
  cancelledOrigins?: { appId: string; appName: string; origin: string }[];
  /** ended: the org's other keys still awaiting acceptance or waiting (their labels and ids; `announced`: its emailed cancel link works). */
  waitingKeys?: { id: string; label: string; announced: boolean }[];
  /** How many times in a row this notice's sends failed (0 when none). */
  failures?: number;
}
