// The disposable-address domain block (docs/email-login-spec.md "Rate limits and abuse", Q10, D123): checked at
// `start` after normalization, `400 email_domain_not_allowed`. Not address-defining: it decides who may start a
// login, never what `sub` is.

import { DISPOSABLE_DOMAINS_TEXT } from './disposable-domains.ts';
import { normalizeDomain } from './normalize.ts';

let set: ReadonlySet<string> | undefined;

/** The pinned list as a set (parsed once, on first use). */
export function disposableDomains(): ReadonlySet<string> {
  set ??= new Set(DISPOSABLE_DOMAINS_TEXT.slice(0, -1).split('\n'));
  return set;
}

/**
 * True when the normalized domain or any parent of it (`a.b.example.com` → `b.example.com` → `example.com`) is on the
 * list (D157; the upstream list names registrable domains and expects implementers to match subdomains). Throws a
 * `TypeError` for a domain that is not `normalizeDomain`'s output.
 */
export function isDisposableDomain(domain: string): boolean {
  const n = normalizeDomain(domain);
  if (!n.ok || n.domain !== domain) throw new TypeError('isDisposableDomain needs a normalized domain');
  const list = disposableDomains();
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    if (list.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}
