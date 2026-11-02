// The per-recipient-domain daily cap (H1, M4): code mails to one registrable domain (Public Suffix List rules, so
// `a.victim.example` and `b.victim.example` count as one) are capped, which bounds catch-all and subdomain mail-bombing
// and an attacker spreading a budget burn over invented addresses of one domain. The large consumer providers are
// exempt: their users are many and their mailboxes are separate (D198, the list to confirm).
import { getDomain } from 'tldts';

/** Exempt registrable domains (exact). */
export const EXEMPT_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'qq.com',
  '163.com',
  'mail.ru',
  'aol.com',
  'zoho.com',
  // gmx.* and yandex.*: the providers' own registrable domains, listed (not any `gmx.<tld>` someone can register).
  'gmx.com',
  'gmx.net',
  'gmx.de',
  'gmx.at',
  'gmx.ch',
  'gmx.fr',
  'gmx.es',
  'gmx.it',
  'gmx.co.uk',
  'gmx.us',
  'yandex.com',
  'yandex.ru',
  'yandex.ua',
  'yandex.by',
  'yandex.kz',
  'yandex.com.tr',
]);

/** The registrable domain of a normalized address's domain (itself when the PSL gives none). */
export function registrableDomain(domain: string): string {
  return getDomain(domain, { allowPrivateDomains: true }) ?? domain;
}

export const isExemptDomain = (registrable: string): boolean => EXEMPT_DOMAINS.has(registrable);
