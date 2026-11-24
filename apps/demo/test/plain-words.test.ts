// D853 on the hosted demo (D889): the words people read, checked with `@hana-id/brand/plain-words` as the stamps site
// and the sign-in windows are. The NEAR card is plain throughout. The rest of the page is an SDK demo for partners and
// still names the vault, EVM, the explorer and so on: every such sentence is listed below by exact string, under what
// it is (a developer-only message, the signed test text, a technical area, or left for a later pass), so a new one
// can't slip in unnoticed. Codes are fine (`near_page_rpc_failed` is not a word).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jargonIn, sentencesIn } from '@hana-id/brand/plain-words';
import { describe, expect, it } from 'vitest';
import { ALREADY_IN_GUESTBOOK, NEAR_NETWORK_LABEL, STAGES, guestbookDone } from '../src/near-card.ts';
import { STELLAR_NETWORK_LABEL } from '../src/page.ts';

const root = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const FILES = ['src/near-card.ts', 'src/near.ts', 'src/page.ts', 'src/errors.ts', 'src/result.ts', 'src/gas-free-card.ts', 'src/requests.ts'];

/**
 * Words the demo has used and dropped (D889), on top of the brand's list: kept out of the demo here. (The brand's list
 * is shared with the approval window, whose folded technical details name `add_message` on purpose.)
 */
const DEMO_JARGON = ['zero-value', 'add_message', 'implicit account', 'relayed'];
const demoJargonIn = (s: string): string[] => DEMO_JARGON.filter((w) => new RegExp(`(?<![\\w-])${w}(?![\\w-])`, 'iu').test(s));

/** Thrown with a code errors.ts maps to plain words: the message goes to diagnostics only, never on the page. */
const DEVELOPER_ONLY = new Set([
  'The account has no key on testnet yet',
  'The key’s nonce is at the bound for the block height NEAR reported',
  "NEAR testnet's RPC gave no usable answer to …",
  'NEAR testnet failed the transaction',
  'NEAR testnet gave no outcome for the transaction',
  'NEAR testnet refused the transaction',
  'NEAR testnet did not confirm the transaction',
  "This build's vault origin … is not the SDK's …",
  'No demo check-in is pinned on chain …',
  'Not the pinned check-in',
  'Not an EVM address',
]);

/** What the signing buttons sign (D889 reworded them; the stamps site's signed text is the contract's and never changes). */
const SIGNED_TEXT = new Set<string>([]);

/** The page's technical areas (D889 item 3): login timings, the identity token, the developer footer. */
const TECHNICAL = new Set([
  'Released on NEAR testnet',
  'Expires …. Send it to your backend as Authorization: Bearer <token>.',
  'No per-stage times: the vault returns them for test apps (pk_test_) only.',
  'This page load restored your session in … ms (vault frame, page and one API call).',
  'Each stage’s time from the vault (test apps only), in milliseconds.',
  'chain',
  // The footer (environment, app key prefix, SDK version, networks), as sentencesIn reads its nested template.
  'Environment … · app …… · @hana-id/web … · EVM: … (…) · NEAR: testnet${config.near.guestbook ? ',
]);

/** Outside the NEAR card, not in D889's scope: listed for the Tech Lead (vault, EVM, explorer, declined). */
const LATER = new Set([
  'Connecting to the Journear vault…',
  'The Journear vault reported an error. Reload the page.',
  'EVM · …',
  'EVM personal_sign',
  'You declined the Google sign-in.',
  'This page’s security policy blocks the Journear vault frame. …',
  'The Journear vault loaded but didn’t answer (is this site on the demo app’s allowed origins?). Reload the page. …',
  'Something replaced the Journear vault frame (an extension?). Reload the page.',
  'Could not load the Journear vault in time. Check your connection and any content blocker, then reload the page.',
  'The connection to the Journear vault was lost. Reload the page.',
  'This EVM chain is not configured on the demo.',
  'This demo uses test networks only (Stellar, EVM and NEAR), so nothing here holds real money.',
  '(we send a code to your inbox; Google sign-in works for listed testers) to get a Stellar, an EVM and a NEAR wallet, with no extension and no seed phrase.',
  'EVM',
  'View on explorer ↗',
  'Sign a message (EVM personal_sign)',
  'Export EVM key',
]);

const ALLOWED = (s: string) => DEVELOPER_ONLY.has(s) || SIGNED_TEXT.has(s) || TECHNICAL.has(s) || LATER.has(s);

/** The page's text nodes, attribute words and titles, whitespace collapsed (a lead sentence spans lines). */
function htmlTexts(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/content="([^"]+)"|title="([^"]+)"|>([^<>]+)</gu)) {
    const t = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\s+/gu, ' ').trim();
    if (!t) continue;
    // The lead paragraph is one text node broken by <strong> and <code>: check it sentence by sentence.
    out.push(...t.split(/(?<=\.)\s+/u));
  }
  return out;
}

describe('plain words on the hosted demo (D853, D889)', () => {
  it('no sentence people read holds a banned word, except the listed ones', () => {
    const found: string[] = [];
    const check = (where: string, s: string) => {
      if (ALLOWED(s)) return;
      const words = [...jargonIn(s), ...demoJargonIn(s)];
      if (words.length > 0) found.push(`${where}: [${words.join(', ')}] ${s}`);
    };
    for (const f of FILES) for (const s of sentencesIn(read(f))) check(f, s);
    for (const s of htmlTexts(read('index.html'))) check('index.html', s);
    expect(found).toEqual([]);
  });

  it('the NEAR card is plain throughout: its section of the page, its stages and its own sentences, none listed', () => {
    const card = /<section id="near"[\s\S]*?<\/section>/u.exec(read('index.html'))![0];
    const texts = [...htmlTexts(card), ...Object.values(STAGES), guestbookDone(true), guestbookDone(false), ALREADY_IN_GUESTBOOK, NEAR_NETWORK_LABEL];
    for (const t of texts) expect([...jargonIn(t), ...demoJargonIn(t)], t).toEqual([]);
    for (const s of sentencesIn(read('src/near-card.ts'))) if (!DEVELOPER_ONLY.has(s)) expect([...jargonIn(s), ...demoJargonIn(s)], s).toEqual([]);
  });

  it('names the networks as the approval window and the stamps site do: “NEAR test network” on a label, “NEAR’s test network” in a sentence', () => {
    expect(NEAR_NETWORK_LABEL).toBe('NEAR test network');
    expect(STELLAR_NETWORK_LABEL).toBe('Stellar test network');
    expect(guestbookDone(false)).toBe('Written to the guestbook on NEAR’s test network. Journear paid the network fee, so it cost you nothing.');
    // No user-facing "testnet" left outside the listed areas (identifiers, URLs and the signed text aside).
    const page = htmlTexts(read('index.html')).filter((s) => !ALLOWED(s));
    for (const s of page) expect(s, s).not.toMatch(/testnet/iu);
  });

  it('every list entry is still on the page (a fixed sentence leaves the list)', () => {
    const all = new Set([...FILES.flatMap((f) => sentencesIn(read(f))), ...htmlTexts(read('index.html'))]);
    for (const s of [...DEVELOPER_ONLY, ...SIGNED_TEXT, ...TECHNICAL, ...LATER]) expect(all.has(s), s).toBe(true);
  });
});
