// D853: the words people read on the sign-in, email-code, sharing and key-export windows and in Passport Home hold no
// chain or engineering jargon (`@hana-id/brand/plain-words`): every sentence-like string literal of those pages'
// modules, outside comments. Codes are fine (`mainnet_not_allowed` is not a word); a technical fact a person may need
// goes behind "Error code (for support)". The approval window's modules (render-approval.ts, approve-page.ts,
// render-consent.ts) have their own rules (D808–D814) and test; chain-login.ts's messages never reach the page (the page
// maps its codes to errors.ts's sentences).
import { readFileSync } from 'node:fs';
import { jargonIn, sentencesIn } from '@hana-id/brand/plain-words';
import { describe, expect, it } from 'vitest';
import { errorMessage } from '../../src/auth/errors.ts';
import { NOT_OFFERED } from '../../src/client/evm-sponsor.ts';
import { SPONSOR_TEXT } from '../../src/vault/evm-sponsor.ts';
import { STRING_ERROR_CODES } from '@hana-id/core';

const DIR = new URL('../../src/', import.meta.url);
const FILES = [
  'auth/errors.ts',
  'auth/dom.ts',
  'auth/login-page.ts',
  'auth/email-page.ts',
  'auth/callback-page.ts',
  'auth/home-callback-page.ts',
  'auth/share-page.ts',
  // D866: the staff unlock and confirm mails' pages.
  'auth/support-page.ts',
  'auth/export-page.ts',
  'auth/key-reveal.ts',
  'auth/home-page.ts',
  'auth/home-problems.ts',
  'auth/home-export.ts',
  'auth/home-devices.ts',
  'auth/home-email.ts',
  'auth/home-profile.ts',
  // D874: the ways to sign in to an app's wallet.
  'auth/home-sign-ins.ts',
  'client/user-messages.ts',
  'vault/approvals.ts',
  // The sponsored action's words (SPONSOR_TEXT: the vault's errors and the approval flow's notes). client/evm-sponsor.ts's
  // own messages are the developer's (`message`); its one user sentence, NOT_OFFERED, is checked below.
  'vault/evm-sponsor.ts',
];

/**
 * Deliberate, by exact string: another wallet app's setting is called "testnet", so moving a NEAR account out names it
 * (in quotes, after the plain words).
 */
const ALLOWED: ReadonlySet<string> = new Set(['NEAR’s test network (“testnet”)']);

describe('plain words on the sign-in pages and Passport Home (D853)', () => {
  it('no sentence holds a banned word', () => {
    const found: string[] = [];
    for (const f of FILES) {
      for (const s of sentencesIn(readFileSync(new URL(f, DIR), 'utf8'))) {
        if (ALLOWED.has(s)) continue;
        const words = jargonIn(s);
        if (words.length > 0) found.push(`${f}: [${words.join(', ')}] ${s.slice(0, 120)}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('each allowed string is still in use (the list only shrinks)', () => {
    const all = FILES.flatMap((f) => sentencesIn(readFileSync(new URL(f, DIR), 'utf8')));
    for (const s of ALLOWED) expect(all, s).toContain(s);
  });

  it('every sign-in error the pages show is plain, and the scan finds a banned word when there is one', () => {
    for (const code of STRING_ERROR_CODES) expect(jargonIn(errorMessage(code)), code).toEqual([]);
    for (const [k, t] of Object.entries({ ...SPONSOR_TEXT, NOT_OFFERED })) expect(jargonIn(t), k).toEqual([]);
    expect(jargonIn('The vault named another signer.')).toEqual(['vault', 'signer']);
    expect(jargonIn('mainnet_not_allowed')).toEqual([]);
  });
});
