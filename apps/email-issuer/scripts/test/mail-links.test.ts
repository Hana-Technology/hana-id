// D862: every link in every user mail (src/mail.ts) opens a page the auth host serves. The link notice once linked to
// `{authOrigin}/link/cancel`, a page that was never built (D259), so the button answered 404. The auth host's pages are
// `AUTH_PAGE_PATHS` in apps/api src/pages/host.ts (any other path is a static asset or a 404), read here as text: the
// API's source needs Worker types this Node test doesn't load.
// D853: their words hold no chain or engineering jargon either (the last test), the test-env banner included.
import { readFileSync } from 'node:fs';
import { jargonIn } from '@hana-id/brand/plain-words';
import { describe, expect, it } from 'vitest';
import type { Purpose } from '../../src/commitment.ts';
import { codeMail, confirmMail, linkNoticeMail, mailLook, unlockMail } from '../../src/mail.ts';

const AUTH = 'https://hana-id-auth-sandbox-dev.example.workers.dev';
const LOOK = mailLook({ ENV_NAME: 'sandbox-dev', ENV_LABEL: '[SANDBOX]', NEAR_NETWORK: 'testnet', FILES_ORIGIN: 'https://files.example' });
const PURPOSES: readonly Purpose[] = ['session', 'link_new', 'link_account', 'link_change', 'auto_link', 'home', 'home_session'];

/** The auth host's page routes, from host.ts's `AUTH_PAGE_PATHS`. */
function authPagePaths(): string[] {
  const source = readFileSync(new URL('../../../api/src/pages/host.ts', import.meta.url), 'utf8');
  const list = /export const AUTH_PAGE_PATHS = \[([^\]]*)\] as const;/u.exec(source)?.[1];
  if (list === undefined) throw new Error('AUTH_PAGE_PATHS not found in apps/api/src/pages/host.ts');
  return [...list.matchAll(/'([^']+)'/gu)].map((m) => m[1]!);
}

/**
 * Pages a mail links to that the auth host doesn't serve yet: the staff unlock and unsuppress mails' pages (D259 "not
 * built", D862's open item). Each entry must still be missing, so building one makes this test ask for its removal.
 */
const NOT_BUILT: readonly string[] = ['/email/unlock', '/email/confirm'];

/** Every URL a mail carries: the HTML part's hrefs and any http(s) URL written in either part. */
function urlsOf(m: { text: string; html: string }): string[] {
  const hrefs = [...m.html.matchAll(/href="([^"]+)"/gu)].map((x) => x[1]!);
  const written = [...`${m.text}\n${m.html}`.matchAll(/https?:\/\/[^\s"<>)]+/gu)].map((x) => x[0]);
  return [...new Set([...hrefs, ...written])];
}

const MAILS = [
  ...PURPOSES.map((purpose) => codeMail({ to: 'a@example.com', code: '550046', appName: 'Sodax Demo', authOrigin: AUTH, purpose, look: LOOK })),
  linkNoticeMail({ to: 'a@example.com', appName: 'Sodax Demo', pending: true, look: LOOK }),
  linkNoticeMail({ to: 'a@example.com', appName: 'Sodax Demo', pending: false, look: LOOK }),
  unlockMail({ to: 'a@example.com', token: 'ug1.tok', authOrigin: AUTH, look: LOOK }),
  confirmMail({ to: 'a@example.com', token: 'uc1.tok', authOrigin: AUTH, look: LOOK }),
];

describe('links in user mail (D862)', () => {
  const served = authPagePaths();

  it('reads the auth host’s pages', () => {
    expect(served).toContain('/login');
    expect(served).toContain('/home');
  });

  it('every link on the auth host opens a page it serves (the two unbuilt staff pages excepted, by name)', () => {
    const broken: string[] = [];
    for (const m of MAILS) {
      for (const u of urlsOf(m)) {
        const url = new URL(u);
        // The logo on the files origin is an image, not a link.
        if (url.origin !== AUTH) continue;
        if (!served.includes(url.pathname) && !NOT_BUILT.includes(url.pathname)) broken.push(`${m.subject}: ${u}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('the pages still missing are missing (remove one here once it is served)', () => {
    for (const p of NOT_BUILT) expect(served, p).not.toContain(p);
  });

  it('the link notice has no link at all: no page can cancel from a mail today, so it says where cancelling is', () => {
    for (const pending of [true, false]) {
      const m = linkNoticeMail({ to: 'a@example.com', appName: 'Sodax Demo', pending, look: LOOK });
      expect(m.html).not.toMatch(/<a[\s>]|href=/iu);
      expect(m.text).not.toMatch(/https?:\/\//u);
      expect(m.text).not.toContain('/link/cancel');
      expect(m.text).toContain('Not you?');
      expect(m.text).toContain('Journear Passport sign-in window');
    }
  });

  it('the words are plain (D853): no banned word in any subject, text part or HTML part, the env banner included', () => {
    for (const m of MAILS) {
      const html = m.html.replace(/<head>[\s\S]*?<\/head>/u, '').replace(/<[^>]+>/gu, ' ');
      expect(jargonIn(`${m.subject}\n${m.text}\n${html}`), m.subject).toEqual([]);
    }
    expect(MAILS[0]!.html).toContain('Test email: this comes from a test version of Journear Passport. Don’t use it with real money.');
  });
});
