// The rule for the RPC, Horizon and Soroban RPC URLs a partner configures (sweep PART-3, docs/decisions.md D115): http(s)
// only, and for a live app (`pk_live_`) https only, except on a loopback host (a local node). Over plaintext http an
// on-path attacker would fill fees and nonces, answer every read and see every broadcast.

/** localhost and its subdomains, 127.0.0.0/8 and [::1]: hosts that never leave the device. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/u.test(h);
}

/**
 * `value` if it is a usable service URL, else a TypeError naming `name`: an http(s) URL with no credentials, and https
 * for a live app unless its host is loopback. `live` defaults to true, the strict rule.
 */
export function serviceUrl(value: unknown, name: string, live = true): string {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new TypeError(`${name} must be a URL`);
  }
  if (typeof value !== 'string' || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw new TypeError(`${name} must be an http(s) URL`);
  if (url.username || url.password) throw new TypeError(`${name} must not carry credentials`);
  if (live && url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new TypeError(`${name} must be https for a live app (pk_live_); plaintext http is allowed only on localhost`);
  }
  return value;
}
