// The user's Support ID on the client side (batch C15; D96, D276 as amended by D346): `HANA-XXXX-XXXX`, the short form
// of the identity token's `sub` for the account root (8 Crockford base32 characters of its first 40 bits). Only the
// API computes it (it needs IDENTITY_SUB_KEY's output); it arrives with the session in the `/v1/login` and
// `/v1/sessions` answers, the vault keeps it with the session, and partners read it in `hana_status`. Nothing here
// derives one: a client only checks the shape of what the API sent. It carries no address and no sub, and it is not a
// credential (staff change nothing on a code alone).

/** `HANA-` + 4 + `-` + 4 characters of Crockford's alphabet (no I, L, O, U), uppercase: the API's exact output. */
export const SUPPORT_ID_RE = /^HANA-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/u;

export const isSupportId = (v: unknown): v is string => typeof v === 'string' && SUPPORT_ID_RE.test(v);

/**
 * The Support ID of an API answer (`body.supportId`), or null when it is absent or not one. A malformed value is
 * dropped, never a reason to refuse the answer: the session it came with is already on chain, and the code is only
 * shown to the user.
 */
export function supportIdFrom(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const v = (body as { supportId?: unknown }).supportId;
  return isSupportId(v) ? v : null;
}

/**
 * The first SDK version whose protocol validators take `supportId` in `hana_status`, `hana_login` and the `ready`
 * event. The vault adds the field only for an SDK whose `hana:hello` names this version or a later one: an older SDK's
 * validators refuse any key they don't know (a reply it can't parse fails the call; a `ready` it can't parse never
 * arrives), so it must keep getting exactly the shapes it knows.
 */
export const SUPPORT_ID_SDK_MIN = '0.2.0';

/**
 * Whether the `sdk` version of a `hana:hello` (semver: `x.y.z`, optionally `-prerelease`) is at least `min`. A
 * prerelease counts as its release's predecessor (`0.2.0-rc.1` < `0.2.0`), as semver orders them; anything that isn't
 * a version is false (the safe answer: the old shapes).
 */
export function sdkAtLeast(sdk: string | null | undefined, min: string): boolean {
  const parse = (v: string): { n: [number, number, number]; pre: boolean } | null => {
    const m = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(-[0-9A-Za-z.-]+)?$/u.exec(v);
    return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] !== undefined } : null;
  };
  if (typeof sdk !== 'string') return false;
  const a = parse(sdk);
  const b = parse(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a.n[i] !== b.n[i]) return a.n[i]! > b.n[i]!;
  return !a.pre || b.pre;
}
