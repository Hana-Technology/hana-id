// Domains that must never be on the disposable-domain list, nor any parent of them: the Google-hosted domains of the
// spec ("The four cases": gmail.com, googlemail.com) and Google's own Workspace domain. One source for
// scripts/update-disposable-domains.mjs (refuses such a list) and test/disposable.test.ts (the guard).
export const PROTECTED_DOMAINS = Object.freeze(['gmail.com', 'googlemail.com', 'google.com']);

/** The listed entries that would block a protected domain (the domain itself or any of its parents). */
export function protectedConflicts(listed) {
  const hits = [];
  for (const p of PROTECTED_DOMAINS) {
    const labels = p.split('.');
    for (let i = 0; i < labels.length; i++) {
      const suffix = labels.slice(i).join('.');
      if (listed.has(suffix)) hits.push(suffix);
    }
  }
  return hits;
}
