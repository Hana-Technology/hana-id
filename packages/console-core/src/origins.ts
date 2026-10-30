// Partner origin input rules (docs/batch-c-spec.md "Origin input rules"), shared by the API, the console and the CLI:
// `normaliseOrigin` gives the one stored and compared form (ASCII, punycode), `originDisplay` the decoded form shown
// beside it, and `originProblem` the refusals. A label mixing scripts is refused on live scopes (UTS #39 "highly
// restrictive": one script, or Latin with the CJK combinations).
import { dnsNameProblem, isDevEnv, isLoopbackHost, LOCALHOST_WILDCARD } from '@hana-id/env/origins';

export { LOCALHOST_WILDCARD };

/** At most this many active-or-pending origins per app (the vault page's MAX_APP_ORIGINS; docs/security.md (i)). */
export const MAX_APP_ORIGINS = 20;

export class OriginError extends Error {
  constructor(
    readonly reason: OriginRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'OriginError';
  }
}

export type OriginRefusal =
  | 'invalid'
  | 'not_http'
  | 'credentials'
  | 'path'
  | 'not_https'
  | 'loopback'
  | 'wildcard'
  | 'ip_or_suffix'
  | 'refused'
  | 'mixed_script';

/**
 * The stored form of an origin, or throws `OriginError`: http(s) only, no credentials, path, query or fragment; host
 * lowercased and in ASCII (punycode) form as the WHATWG URL parser writes it; default port dropped; a trailing dot
 * removed. `http://localhost:*` (any localhost port) passes through as the literal it is.
 */
export function normaliseOrigin(input: string): string {
  if (input === LOCALHOST_WILDCARD) return input;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new OriginError('invalid', `Not a URL: ${input}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new OriginError('not_http', `An origin is http(s): ${input}`);
  if (url.username || url.password) throw new OriginError('credentials', `An origin has no credentials: ${input}`);
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || /[?#]/u.test(input)) {
    throw new OriginError('path', `An origin has no path, query or fragment: ${input}`);
  }
  const host = url.hostname.endsWith('.') ? url.hostname.slice(0, -1) : url.hostname;
  if (!host) throw new OriginError('invalid', `No host: ${input}`);
  return `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}`;
}

// ---- punycode (RFC 3492) decoding, for display only ----

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;

function adapt(delta: number, numPoints: number, first: boolean): number {
  let d = first ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((BASE - T_MIN) * T_MAX) >> 1) {
    d = Math.floor(d / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + SKEW));
}

function digit(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 22; // 0-9 → 26-35
  if (c >= 0x61 && c <= 0x7a) return c - 0x61; // a-z → 0-25
  if (c >= 0x41 && c <= 0x5a) return c - 0x41;
  return BASE;
}

/** Decodes one punycode label body (without `xn--`). Throws on malformed input. */
export function punycodeDecode(input: string): string {
  const out: number[] = [];
  const basic = input.lastIndexOf('-');
  for (let j = 0; j < Math.max(basic, 0); j++) {
    const c = input.charCodeAt(j);
    if (c >= 0x80) throw new RangeError('punycode: non-basic code point');
    out.push(c);
  }
  let n = INITIAL_N;
  let bias = INITIAL_BIAS;
  let i = 0;
  for (let at = basic > 0 ? basic + 1 : 0; at < input.length; ) {
    const oldI = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (at >= input.length) throw new RangeError('punycode: truncated');
      const d = digit(input.charCodeAt(at++));
      if (d >= BASE) throw new RangeError('punycode: bad digit');
      i += d * w;
      if (i > 0x7fff_ffff) throw new RangeError('punycode: overflow');
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (d < t) break;
      w *= BASE - t;
      if (w > 0x7fff_ffff) throw new RangeError('punycode: overflow');
    }
    bias = adapt(i - oldI, out.length + 1, oldI === 0);
    n += Math.floor(i / (out.length + 1));
    if (n > 0x10ffff) throw new RangeError('punycode: out of range');
    i %= out.length + 1;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}

/** The host with every `xn--` label decoded; a label that doesn't decode stays in ASCII. */
export function hostToUnicode(host: string): string {
  return host
    .split('.')
    .map((label) => {
      if (!label.toLowerCase().startsWith('xn--')) return label;
      try {
        return punycodeDecode(label.slice(4));
      } catch {
        return label;
      }
    })
    .join('.');
}

/**
 * How an origin is shown: `display` decodes `xn--` labels and `idn` flags that it has one, so the console, the notice
 * and the admin console show both forms side by side (homograph review).
 */
export function originDisplay(origin: string): { origin: string; display: string; idn: boolean } {
  if (origin === LOCALHOST_WILDCARD) return { origin, display: origin, idn: false };
  const url = new URL(origin);
  const idn = url.hostname.split('.').some((l) => l.startsWith('xn--'));
  if (!idn) return { origin, display: origin, idn: false };
  return { origin, display: `${url.protocol}//${hostToUnicode(url.hostname)}${url.port ? `:${url.port}` : ''}`, idn: true };
}

// ---- scripts (UTS #39 restriction levels, the "highly restrictive" profile) ----

/** Unicode script names the engine's `\p{Script=…}` knows; each letter of a label is classified into one of them. */
const SCRIPT_NAMES = [
  'Latin', 'Greek', 'Cyrillic', 'Armenian', 'Hebrew', 'Arabic', 'Syriac', 'Thaana', 'Nko', 'Samaritan', 'Mandaic',
  'Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Sinhala',
  'Thai', 'Lao', 'Tibetan', 'Myanmar', 'Georgian', 'Hangul', 'Ethiopic', 'Cherokee', 'Canadian_Aboriginal', 'Ogham',
  'Runic', 'Tagalog', 'Hanunoo', 'Buhid', 'Tagbanwa', 'Khmer', 'Mongolian', 'Limbu', 'Tai_Le', 'New_Tai_Lue',
  'Buginese', 'Tai_Tham', 'Balinese', 'Sundanese', 'Batak', 'Lepcha', 'Ol_Chiki', 'Glagolitic', 'Coptic', 'Tifinagh',
  'Hiragana', 'Katakana', 'Bopomofo', 'Han', 'Yi', 'Lisu', 'Vai', 'Bamum', 'Syloti_Nagri', 'Phags_Pa', 'Saurashtra',
  'Kayah_Li', 'Rejang', 'Javanese', 'Cham', 'Tai_Viet', 'Meetei_Mayek', 'Adlam', 'Osage', 'Wancho', 'Hanifi_Rohingya',
  'Gothic', 'Deseret', 'Shavian', 'Osmanya', 'Old_Italic', 'Old_Turkic', 'Brahmi', 'Kaithi', 'Chakma', 'Sharada',
  'Takri', 'Ahom', 'Tirhuta', 'Modi', 'Khojki', 'Mahajani', 'Grantha', 'Newa', 'Siddham', 'Dogra', 'Nandinagari',
  'Masaram_Gondi', 'Gunjala_Gondi', 'Soyombo', 'Zanabazar_Square', 'Medefaidrin', 'Miao', 'Mro', 'Bassa_Vah',
  'Pahawh_Hmong', 'Nyiakeng_Puachue_Hmong', 'Toto', 'Tangsa', 'Kawi', 'Nag_Mundari', 'Yezidi', 'Vithkuqi',
] as const;

const SCRIPT_RES: [string, RegExp][] = SCRIPT_NAMES.flatMap((name) => {
  try {
    return [[name, new RegExp(`\\p{Script=${name}}`, 'u')] as [string, RegExp]];
  } catch {
    return []; // a script this engine's Unicode version doesn't know: its letters fall into 'Unknown'
  }
});

/** Common and Inherited code points (digits, hyphen, combining marks) belong to every script. */
const SCRIPT_NEUTRAL = /[\p{Script=Common}\p{Script=Inherited}]/u;

/** The scripts of a label's characters ('Unknown' for a letter of no listed script). */
export function labelScripts(label: string): Set<string> {
  const scripts = new Set<string>();
  for (const ch of label) {
    if (SCRIPT_NEUTRAL.test(ch)) continue;
    scripts.add(SCRIPT_RES.find(([, re]) => re.test(ch))?.[0] ?? 'Unknown');
  }
  return scripts;
}

/** UTS #39 "highly restrictive": a single script, or a subset of one of these sets. */
const ALLOWED_SCRIPT_SETS = [
  ['Latin', 'Han', 'Hiragana', 'Katakana'],
  ['Latin', 'Han', 'Bopomofo'],
  ['Latin', 'Han', 'Hangul'],
];

/** Whether any label of the (Unicode) host mixes scripts beyond what "highly restrictive" allows. */
export function isMixedScript(unicodeHost: string): boolean {
  return unicodeHost.split('.').some((label) => {
    const scripts = labelScripts(label);
    // A letter of no listed script fails closed: it can't be checked against the allowed combinations.
    if (scripts.has('Unknown')) return true;
    if (scripts.size <= 1) return false;
    return !ALLOWED_SCRIPT_SETS.some((set) => [...scripts].every((s) => set.includes(s)));
  });
}

export interface OriginRules {
  /** The manifest name: loopback origins are possible only in a dev env (`local*`, `sandbox*`). */
  envName: string;
  /** The manifest network (`NETWORK`): on `mainnet` only https, never loopback or the wildcard. */
  network: string;
  /** The scope's environment: loopback only on `test` scopes, the mixed-script refusal on `live` scopes. */
  environment: 'test' | 'live';
  /** Every Hana origin (`REFUSED_ORIGINS`). */
  refusedOrigins: readonly string[];
}

/**
 * Why a (normalised) origin can't be added to an app, or null. Loopback origins and the `http://localhost:*` wildcard
 * only on test scopes in a dev env on a non-production network; every other origin https with a real DNS name (no IP,
 * public suffix or single label); never a Hana origin; on live scopes no mixed-script label.
 */
export function originProblem(origin: string, rules: OriginRules): { reason: OriginRefusal; message: string } | null {
  let norm: string;
  try {
    norm = normaliseOrigin(origin);
  } catch (e) {
    return e instanceof OriginError ? { reason: e.reason, message: e.message } : { reason: 'invalid', message: String(e) };
  }
  if (norm !== origin) return { reason: 'invalid', message: `Not in normalised form (${norm})` };
  const loopbackOk = rules.environment === 'test' && isDevEnv(rules.envName) && rules.network !== 'mainnet';
  if (origin === LOCALHOST_WILDCARD) {
    return loopbackOk ? null : { reason: 'wildcard', message: 'The localhost wildcard is only for test scopes in dev envs' };
  }
  if (rules.refusedOrigins.includes(origin)) return { reason: 'refused', message: "A Hana origin can't be an app's origin" };
  const url = new URL(origin);
  if (url.hostname.includes('*')) return { reason: 'wildcard', message: 'Wildcard hosts are refused' };
  if (isLoopbackHost(url.hostname)) {
    return loopbackOk ? null : { reason: 'loopback', message: 'Loopback origins are only for test scopes in dev envs' };
  }
  if (url.protocol !== 'https:') return { reason: 'not_https', message: 'Origins are https (http only for loopback)' };
  const dns = dnsNameProblem(url.hostname);
  if (dns) return { reason: 'ip_or_suffix', message: `The host ${dns}` };
  if (rules.environment === 'live' && isMixedScript(hostToUnicode(url.hostname))) {
    return { reason: 'mixed_script', message: 'A host label mixes scripts (refused on live scopes)' };
  }
  return null;
}
