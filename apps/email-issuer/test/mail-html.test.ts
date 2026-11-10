// The user mails' two parts (mail.ts, @hana-id/brand/email): the text part as before, the designed HTML part saying the
// same thing; no link in a code mail and exactly the expected one in a notice; the logo the one image; partner strings
// escaped, kept out of the heading and written so clients don't link them; the env banner; tracking off on the wire;
// the size.
import { MAIL_LOGO_PATH } from '@hana-id/brand/mail-logo';
import { describe, expect, it } from 'vitest';
import type { Purpose } from '../src/commitment.ts';
import { CODE_HEADINGS, codeMail, confirmMail, displayAppName, linkNoticeMail, mailEnvNotice, mailLook, unlockMail } from '../src/mail.ts';
import { SendGridSender } from '../src/sendgrid.ts';

const AUTH = 'https://hana-id-auth-sandbox-dev.example.workers.dev';
const FILES = 'https://hana-id-files-sandbox-dev.example.workers.dev';
const LOGO = `${FILES}${MAIL_LOGO_PATH}`;
const PURPOSES: Purpose[] = ['session', 'link_new', 'link_account', 'link_change', 'auto_link', 'home', 'home_session'];
const LOOK = mailLook({ ENV_NAME: 'sandbox-dev', ENV_LABEL: '[SANDBOX]', NEAR_NETWORK: 'testnet', FILES_ORIGIN: FILES });

/** The HTML part's visible text: the preview line, the head and the tags dropped, entities decoded, spaces collapsed. */
function visibleText(html: string): string {
  return html
    .replace(/<head>[\s\S]*?<\/head>/u, '')
    .replace(/<div style="display:none[\s\S]*?<\/div>/u, '')
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<br>/gu, ' ')
    .replace(/<[^>]+>/gu, '')
    .replace(/&#(\d+);/gu, (_m, n: string) => String.fromCharCode(Number(n)))
    .replace(/&nbsp;/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

const preview = (html: string): string => /<div style="display:none[^"]*">([^&<]*)/u.exec(html)![1]!;
const heading = (html: string): string => /<h1[^>]*>([\s\S]*?)<\/h1>/u.exec(html)![1]!;
const title = (html: string): string => /<title>([\s\S]*?)<\/title>/u.exec(html)![1]!;
/** Every `<img>` tag, and every other attribute that could load something. */
const imgs = (html: string): string[] => [...html.matchAll(/<img\b[^>]*>/giu)].map((m) => m[0]);

/** The one image: the logo on the env's files origin, alt "Hana ID", fixed size; nothing else remote. */
function expectOnlyTheLogo(html: string): void {
  const all = imgs(html);
  expect(all).toHaveLength(1);
  expect(all[0]).toContain(`src="${LOGO}"`);
  expect(all[0]).toContain('alt="Hana ID"');
  expect(all[0]).toMatch(/ width="\d+" height="\d+"/u);
  expect([...html.matchAll(/\bsrc=/giu)]).toHaveLength(1);
  expect(html).not.toMatch(/<script|<form|<input|<link|<iframe|<object|<svg|url\(|@import|background=/iu);
}

describe('code mails: the designed HTML part', () => {
  for (const purpose of PURPOSES) {
    it(`${purpose}: the text part as before; the HTML says each of its sentences, holds the code once, and links nowhere`, () => {
      const m = codeMail({ to: 'a@example.com', code: '550046', appName: 'Sodax Demo', authOrigin: AUTH, purpose, look: LOOK });
      expect(m.text).toMatchSnapshot('text');
      expect(m.subject).toMatchSnapshot('subject');
      expect(m.html).toMatchSnapshot('html');
      // The text part is unchanged by the look (D419 leaves user mail's text and subject alone).
      const bare = codeMail({ to: 'a@example.com', code: '550046', appName: 'Sodax Demo', authOrigin: AUTH, purpose });
      expect(bare.text).toBe(m.text);
      expect(bare.subject).toBe(m.subject);
      expect(bare.html).not.toContain('Not production');
      expect(imgs(bare.html)).toEqual([]);
      expect(m.html).toContain('[SANDBOX] Not production: this email is from Hana ID sandbox-dev (testnet), for testing.');
      // Every line of the text part is in the HTML part, in the same order.
      const seen = visibleText(m.html);
      let at = 0;
      for (const line of m.text.split('\n').filter(Boolean)) {
        const i = seen.indexOf(line, at);
        expect(i, line).toBeGreaterThanOrEqual(0);
        at = i + line.length;
      }
      // No link; the logo the one image; the code once, not in the subject or the preview line.
      expect(m.html).not.toMatch(/<a[\s>]|href=/iu);
      expectOnlyTheLogo(m.html);
      expect(m.html.split('550046')).toHaveLength(2);
      expect(m.subject).not.toContain('550046');
      expect(preview(m.html)).not.toContain('550046');
      expect(preview(m.html)).toBe(`${CODE_HEADINGS[purpose]}. It expires in 10 minutes.`);
      // The heading and the title are fixed words: never the app's name (D687).
      expect(heading(m.html)).toBe(CODE_HEADINGS[purpose]);
      expect(title(m.html)).toBe(CODE_HEADINGS[purpose]);
      expect(`${heading(m.html)}${title(m.html)}${preview(m.html)}`).not.toContain('Sodax');
      // The auth host is text, broken at each dot so no client links it; the anti-phishing lines are there.
      expect(m.html).toContain('hana-id-auth-sandbox-dev<span>.</span><wbr>example');
      expect(m.html).not.toContain('hana-id-auth-sandbox-dev.example');
      expect(seen).toContain('Hana never asks for it by phone, chat or on another site.');
      // Far under Gmail's 102 KB clip.
      expect(new TextEncoder().encode(m.html).length).toBeLessThan(16_000);
    });
  }

  it('the Hana Home sign-in mail’s text part is word for word the mail users get today', () => {
    const m = codeMail({ to: 'a@example.com', code: '550046', appName: '', authOrigin: 'https://hana-id-auth-sandbox-dev.tingtc.workers.dev', purpose: 'home', look: LOOK });
    expect(m.subject).toBe('Your sign-in code for Hana Home');
    expect(m.text).toBe(
      [
        'Your code to sign in to Hana Home:',
        '',
        '550046',
        '',
        'It expires in 10 minutes.',
        '',
        'Type this code only in the Hana window you opened (hana-id-auth-sandbox-dev.tingtc.workers.dev). Hana never asks for it by phone, chat or on another site.',
        '',
        'If you didn’t try to sign in to Hana Home, ignore this mail.',
        '',
      ].join('\n'),
    );
  });

  it('Hana Home mails name no app, whatever name is passed (D620)', () => {
    for (const purpose of ['home', 'home_session'] as const) {
      const m = codeMail({ to: 'a@example.com', code: '550046', appName: 'Evil App', authOrigin: AUTH, purpose });
      expect(`${m.subject}${m.text}${m.html}`).not.toContain('Evil');
    }
  });

  it('names that pass for Hana or an address are "an app" (D686); none reaches a heading, a subject or a link', () => {
    const lookalike = `${String.fromCharCode(0x041d)}ana Home`; // Cyrillic En
    for (const appName of ['Sign in at evil.example', 'www.evil.example', 'evil.com', 'Hana Home', 'Hana', lookalike, 'https://evil.example', 'HANA wallet', 'h a n a']) {
      expect(displayAppName(appName), appName).toBeNull();
      const m = codeMail({ to: 'a@example.com', code: '550046', appName, authOrigin: AUTH, purpose: 'session', look: LOOK });
      expect(m.subject, appName).toBe('Your sign-in code');
      expect(m.text, appName).toContain('Your code to sign in to an app with Hana:');
      expect(m.html, appName).not.toContain('evil');
      expect(heading(m.html)).toBe('Your sign-in code');
      expect(m.html).toMatchSnapshot(`html for ${JSON.stringify(appName)}`);
    }
    // The real Home mail's heading and subject stay its own.
    const fake = codeMail({ to: 'a@example.com', code: '550046', appName: 'Hana Home', authOrigin: AUTH, purpose: 'session' });
    const real = codeMail({ to: 'a@example.com', code: '550046', appName: '', authOrigin: AUTH, purpose: 'home' });
    expect(fake.subject).not.toBe(real.subject);
    expect(heading(fake.html)).not.toBe(heading(real.html));
  });

  it('a shown name is unlinked text: each dot or slash in its own element, so no client turns it into a link', () => {
    // A name that passes the rule but holds a dot (a stored name, e.g. "Dr. Wallet") is still written unlinked.
    const m = codeMail({ to: 'a@example.com', code: '550046', appName: 'Dr. Wallet / Pay', authOrigin: AUTH, purpose: 'session' });
    expect(displayAppName('Dr. Wallet / Pay')).toBe('Dr. Wallet / Pay');
    expect(m.html).toContain('“Dr<span>.</span><wbr> Wallet <span>/</span><wbr> Pay”');
    expect(visibleText(m.html)).toContain('Your code to sign in to “Dr. Wallet / Pay” with Hana:');
  });

  it('hostile app names: escaped or replaced by "an app"; no markup, link, bidi or invisible character gets in', () => {
    const names = [
      '<img src=x onerror=alert(1)>',
      '"><a href="javascript:alert(1)">Claim</a>',
      "O'Brien & <Sons>",
      `Wal${String.fromCharCode(0x202e)}let`,
      `Wallet${String.fromCharCode(0x200b)}`,
      'javascript:alert(1)',
      'W'.repeat(65),
      `Line\r\nBcc: victim@example.com`,
    ];
    for (const appName of names) {
      const m = codeMail({ to: 'a@example.com', code: '550046', appName, authOrigin: AUTH, purpose: 'session', look: LOOK });
      expect(m.html, appName).not.toMatch(/<a[\s>]|href="|<script|onerror="/iu);
      expectOnlyTheLogo(m.html);
      expect(m.subject, appName).not.toMatch(/[\r\n]/u);
      for (const cp of [0x202e, 0x200b, 0x0d]) expect(m.html.includes(String.fromCharCode(cp)), appName).toBe(false);
    }
    const quoted = codeMail({ to: 'a@example.com', code: '550046', appName: "O'Brien & <Sons>", authOrigin: AUTH, purpose: 'session' });
    expect(quoted.html).toContain('O&#39;Brien &#38; &#60;Sons&#62;');
    expect(visibleText(quoted.html)).toContain('Your code to sign in to “O\'Brien & <Sons>” with Hana:');
    const long = codeMail({ to: 'a@example.com', code: '550046', appName: 'W'.repeat(65), authOrigin: AUTH, purpose: 'session' });
    expect(long.html).not.toContain('WWW');
    expect(long.text).toContain('sign in to an app');
  });

  it('the look: the env banner only for a known label on testnet; the logo only with a files origin', () => {
    expect(mailEnvNotice({ ENV_NAME: 'sandbox-dev', ENV_LABEL: '[SANDBOX]', NEAR_NETWORK: 'testnet' })).toBe('[SANDBOX] Not production: this email is from Hana ID sandbox-dev (testnet), for testing.');
    expect(mailEnvNotice({ ENV_NAME: 'x', ENV_LABEL: '[SANDBOX]', NEAR_NETWORK: 'mainnet' })).toBe('');
    expect(mailEnvNotice({ ENV_NAME: 'x', ENV_LABEL: '<b>[PROD]</b>', NEAR_NETWORK: 'testnet' })).toBe('');
    expect(mailEnvNotice({ ENV_NAME: 'x', NEAR_NETWORK: 'testnet' })).toBe('');
    expect(mailEnvNotice({ ENV_NAME: 'x', ENV_LABEL: '[SANDBOX]' })).toBe('');
    expect(mailLook({ ENV_NAME: 'prod', NEAR_NETWORK: 'mainnet', FILES_ORIGIN: 'https://files.hana.example/' })).toEqual({ logoUrl: `https://files.hana.example${MAIL_LOGO_PATH}` });
    expect(mailLook({ ENV_NAME: 'prod', NEAR_NETWORK: 'mainnet' })).toEqual({});
    // The logo's URL is the same for every recipient and message: no query, no token.
    const a = codeMail({ to: 'a@example.com', code: '111111', appName: 'Sodax Demo', authOrigin: AUTH, purpose: 'session', look: LOOK });
    const b = codeMail({ to: 'b@example.org', code: '222222', appName: 'Other', authOrigin: AUTH, purpose: 'home', look: LOOK });
    expect(imgs(a.html)).toEqual(imgs(b.html));
    expect(LOGO).not.toMatch(/[?#]/u);
  });

  it('goes out as text/plain then text/html, click and open tracking off', async () => {
    let body: { content: { type: string; value: string }[]; tracking_settings: unknown } | undefined;
    const fetcher = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const m = codeMail({ to: 'a@example.com', code: '550046', appName: 'Sodax Demo', authOrigin: AUTH, purpose: 'home', look: LOOK });
    expect(await new SendGridSender('SG.key', 'Hana ID (testnet) <login@mail.example.com>', fetcher).send(m)).toEqual({ ok: true });
    expect(body!.content.map((c) => c.type)).toEqual(['text/plain', 'text/html']);
    expect(body!.content[0]!.value).toBe(m.text);
    expect(body!.content[1]!.value).toBe(m.html);
    expect(body!.tracking_settings).toEqual({ click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false }, subscription_tracking: { enable: false }, ganalytics: { enable: false } });
  });
});

describe('notices: the designed HTML part', () => {
  const hrefs = (html: string): string[] => [...html.matchAll(/href="([^"]+)"/gu)].map((m) => m[1]!);

  it('the link notice: one button to the cancel page on authOrigin, the URL also as text; the text part as before', () => {
    const m = linkNoticeMail({ to: 'a@example.com', appName: 'Sodax Demo', authOrigin: `${AUTH}/`, pending: true, look: LOOK });
    expect(m.text).toMatchSnapshot('text');
    expect(m.html).toMatchSnapshot('html');
    expect(hrefs(m.html)).toEqual([`${AUTH}/link/cancel`]);
    expect(visibleText(m.html)).toContain(`${AUTH}/link/cancel`);
    expect(heading(m.html)).toBe('A sign-in method was added');
    expectOnlyTheLogo(m.html);
  });

  it('unlock and confirm: one button to their page with the token in the fragment', () => {
    const u = unlockMail({ to: 'a@example.com', token: 'tok_abc', authOrigin: AUTH, look: LOOK });
    const c = confirmMail({ to: 'a@example.com', token: 'tok_def', authOrigin: AUTH, look: LOOK });
    expect(hrefs(u.html)).toEqual([`${AUTH}/email/unlock#tok_abc`]);
    expect(hrefs(c.html)).toEqual([`${AUTH}/email/confirm#tok_def`]);
    expect(u.text).toMatchSnapshot('unlock text');
    expect(c.text).toMatchSnapshot('confirm text');
    for (const m of [u, c]) {
      expectOnlyTheLogo(m.html);
      for (const line of m.text.split('\n').filter(Boolean)) expect(visibleText(m.html)).toContain(line);
    }
  });
});
