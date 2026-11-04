// The recovery playbooks of "Security & monitoring" (D126; docs/batch-c-spec.md "Security & monitoring: recovery
// playbooks"): every playbook in `@hana-id/playbooks`, bundled into this Worker at build time and served to the SPA,
// which renders them as text. Nothing is copied by hand, so a playbook edit ships with the next admin deploy. Read-only:
// the pages send nothing, and owner calls stay in `scripts/` and the council's own signing.
//
//   GET /api/playbooks?q=&kind=&severity=   the list (id, title, kind, severity, status, summary, alert kinds),
//                                           filtered: every word of `q` in the title, summary, signals or impact
//   GET /api/playbooks/:id                  one playbook in display order, its refs as links, its related playbooks
//
// The search runs here rather than in the browser (D334): the SPA has no build step, and the same function is tested.
import { ACTORS, LAST_VERIFIED, NOTES, PLAYBOOKS, type Playbook, getPlaybook, playbookForAlertKind } from '@hana-id/playbooks';
import { errorResponse, json } from './http.ts';

/** Where a ref's doc lives (the repo is private: staff have access). */
export const REPO_BLOB = 'https://github.com/Hana-Technology/hana-id/blob/develop/';

export interface PlaybookLink {
  id: string;
  title: string;
}

/** The link target of an alert kind: the id the watchdog serves if it names a playbook, else the package's own. */
export function playbookFor(kind: string, served?: unknown): PlaybookLink | null {
  const p = (typeof served === 'string' ? getPlaybook(served) : undefined) ?? playbookForAlertKind(kind);
  return p ? { id: p.id, title: p.title } : null;
}

export interface PlaybookSummary {
  id: string;
  title: string;
  kind: Playbook['kind'];
  severity: Playbook['severity'];
  status: Playbook['status'];
  summary: string;
  alertKinds: string[];
}

const summaryOf = (p: Playbook): PlaybookSummary => ({ id: p.id, title: p.title, kind: p.kind, severity: p.severity, status: p.status, summary: p.summary, alertKinds: p.alertKinds ?? [] });

/** Playbooks whose title, summary, signals or impact contain every word of `q` (case-insensitive), of a kind and severity. */
export function searchPlaybooks(f: { q?: string | null; kind?: string | null; severity?: string | null } = {}): PlaybookSummary[] {
  const words = (f.q ?? '').toLowerCase().split(/\s+/u).filter(Boolean).slice(0, 10);
  return PLAYBOOKS.filter((p) => {
    if (f.kind && p.kind !== f.kind) return false;
    if (f.severity && p.severity !== f.severity) return false;
    if (!words.length) return true;
    const text = [p.title, p.summary, ...p.signals, ...p.impact].join('\n').toLowerCase();
    return words.every((w) => text.includes(w));
  }).map(summaryOf);
}

/** A ref as a link: a decision id to the decisions file, a doc anchor to its heading. */
export function refLink(ref: string): { ref: string; href: string } {
  if (/^D\d{1,4}$/u.test(ref)) return { ref, href: `${REPO_BLOB}docs/decisions.md` };
  return { ref, href: `${REPO_BLOB}${ref}` };
}

/** One playbook in the spec's order: signals, impact, steps (who, title, detail, commands verbatim), verify, follow-ups, refs, related. */
export function playbookView(p: Playbook) {
  return {
    ...summaryOf(p),
    signals: p.signals,
    impact: p.impact,
    steps: p.steps.map((s, i) => ({ n: i + 1, title: s.title, who: s.who, detail: s.detail, commands: s.commands ?? [] })),
    verify: p.verify,
    followUps: p.followUps,
    refs: p.refs.map(refLink),
    related: (p.related ?? []).flatMap((id) => {
      const r = getPlaybook(id);
      return r ? [{ id: r.id, title: r.title }] : [];
    }),
  };
}

const KINDS = new Set(['alert', 'incident']);
const SEVERITIES = new Set(['critical', 'warning', 'info']);

export function listPlaybooksRoute(url: URL): Response {
  const kind = url.searchParams.get('kind');
  const severity = url.searchParams.get('severity');
  const q = url.searchParams.get('q');
  if ((kind && !KINDS.has(kind)) || (severity && !SEVERITIES.has(severity)) || (q && q.length > 200)) return errorResponse('bad_request', 'Unknown kind or severity, or a search over 200 characters');
  return json(200, { notes: NOTES, actors: ACTORS, lastVerified: LAST_VERIFIED, playbooks: searchPlaybooks({ q, kind, severity }) });
}

export function getPlaybookRoute(id: string): Response {
  const p = getPlaybook(id);
  if (!p) return errorResponse('not_found', 'No such playbook');
  return json(200, { notes: NOTES, playbook: playbookView(p) });
}
