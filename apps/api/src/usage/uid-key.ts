// USER_ID_KEY, the uid's key (D96, D224): the usage ledger's uid and the wallet directory's user id (D312) both come
// from it. Parsed once per value; a missing or malformed key is one warning per value, never a thrown error.
import type { Env } from '../env.ts';
import { log } from '../log.ts';

/** USER_ID_KEY (base64 of 32 bytes), parsed once per value; null (and one warning per value) when unusable. */
let uidKey: { raw: string | undefined; key: Uint8Array | null } | null = null;
export function userIdKey(env: Pick<Env, 'USER_ID_KEY'>): Uint8Array | null {
  if (uidKey && uidKey.raw === env.USER_ID_KEY) return uidKey.key;
  let key: Uint8Array | null = null;
  try {
    const raw = env.USER_ID_KEY?.trim() ?? '';
    if (/^[A-Za-z0-9+/]{43}=$/u.test(raw)) key = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  } catch {
    key = null;
  }
  if (key?.length !== 32) {
    key = null;
    log({ event: 'usage_uid_unavailable', code: env.USER_ID_KEY === undefined ? 'missing_key' : 'bad_key' }, 'warn');
  }
  uidKey = { raw: env.USER_ID_KEY, key };
  return key;
}
