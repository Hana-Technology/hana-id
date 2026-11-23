// The partner text rules (src/partner-labels/text-rules.ts, D892): one function for every place partner text appears
// (object phrase, field label, enumeration label, address book name). Every rule with adversarial inputs: look-alike
// letters, bidi and zero-width characters, combining marks, full-width letters, mixed scripts, claim words with
// inflections, spacing and digits, addresses and amounts written as text, quotation marks, markup, Journear's names
// and the reviewed lists' names.
import { describe, expect, it } from 'vitest';
import { JARGON } from '../../brand/src/plain-words.ts';
import { PARTNER_JARGON, PARTNER_TEXT_MAX, type PartnerTextCode, type PartnerTextRole, partnerTextProblem } from '../src/partner-labels/text-rules.ts';
import { PARTNER_CONNECTORS, PARTNER_VERBS, partnerAttribution } from '../src/partner-labels/words.ts';

const ch = (n: number): string => String.fromCodePoint(n);
const code = (text: unknown, role: PartnerTextRole = 'object'): PartnerTextCode | null => partnerTextProblem(text, role)?.code ?? null;

describe('partner text: what passes', () => {
  it('accepts short plain phrases in Latin letters, with accents and the few punctuation marks', () => {
    const ok = [
      'the stamp',
      'a message to the guestbook',
      'Fare paid',
      'Gate 3',
      'Stamp',
      'Order',
      'Main till',
      'Rock & Roll',
      'check-in desk',
      'Members’ lounge',
      "member's card",
      'Café',
      'Crème brûlée',
      'Łódź store',
      'São Paulo',
      'Season 2024',
      'Top 10, row 2',
      'Ticket',
      'the raffle',
      'a seat',
      'AT&T',
      'MP3',
      'A380 seat',
    ];
    for (const t of ok) expect(partnerTextProblem(t, 'enumLabel'), t).toBeNull();
  });

  it('every verb and joining word on Journear’s lists passes the rules too, and the attribution names the app', () => {
    for (const w of [...PARTNER_VERBS, ...PARTNER_CONNECTORS]) expect(partnerTextProblem(w, 'object'), w).toBeNull();
    expect(partnerAttribution('Stamp Trail')).toBe('These are Stamp Trail’s words. Journear hasn’t checked them.');
  });

  it('the jargon list is the plain-words list, word for word (core has no runtime dependency on the brand package)', () => {
    expect([...PARTNER_JARGON]).toEqual([...JARGON]);
  });
});

describe('partner text: shape', () => {
  it('a string, not empty, within the role’s length, NFC, trimmed, single spaces', () => {
    expect(code(5)).toBe('text_not_string');
    expect(code(null)).toBe('text_not_string');
    expect(code(['a'])).toBe('text_not_string');
    expect(code('')).toBe('text_empty');
    for (const role of Object.keys(PARTNER_TEXT_MAX) as PartnerTextRole[]) {
      expect(code('a'.repeat(PARTNER_TEXT_MAX[role]), role), role).toBeNull();
      expect(code('a'.repeat(PARTNER_TEXT_MAX[role] + 1), role), role).toBe('text_too_long');
    }
    expect(PARTNER_TEXT_MAX).toEqual({ object: 30, fieldLabel: 24, enumLabel: 32, addressName: 32 });
    expect(code('Café')).toBe('text_not_nfc');
    for (const t of [' lead', 'trail ', 'two  spaces', 'tab\there', ' nbsp']) expect(code(t), JSON.stringify(t)).not.toBeNull();
    expect(code(' lead')).toBe('text_spacing');
    expect(code('two  spaces')).toBe('text_spacing');
  });
});

describe('partner text: characters (a Latin-script allowlist)', () => {
  const refused: [string, string][] = [
    [`F${ch(0x0430)}re paid`, 'Cyrillic а'],
    [`${ch(0x0405)}tamp`, 'Cyrillic Ѕ'],
    [`F${ch(0x03b1)}re`, 'Greek α'],
    [`St${ch(0x0585)}mp`, 'Armenian օ'],
    ['Ｆａｒｅ', 'full-width'],
    ['𝐅𝐚𝐫𝐞', 'mathematical bold'],
    [`Fare${ch(0x202e)}diap`, 'bidi override'],
    [`Fare${ch(0x2066)}paid${ch(0x2069)}`, 'bidi isolate'],
    [`Fa${ch(0x200b)}re`, 'zero-width space'],
    [`Fa${ch(0x200d)}re`, 'zero-width joiner'],
    [`Fa${ch(0xfeff)}re`, 'BOM'],
    [`Fare${ch(0xfe0f)}`, 'variation selector'],
    [`a${ch(0x0332)}b`, 'a combining mark'],
    [`Zalgo${ch(0x0336)}${ch(0x0337)}${ch(0x0338)}`, 'a run of combining marks'],
    ['🎉 party', 'emoji'],
    ['✓ Fare paid', 'check mark'],
    ['✔ paid', 'heavy check mark'],
    ['☑ paid', 'ballot box with check'],
    ['√ paid', 'square root as a check'],
    ['$5 off', 'dollar'],
    ['€5', 'euro'],
    ['Stamp™', 'trade mark'],
    ['"Fare paid"', 'straight double quotes'],
    ['“Fare paid”', 'curly double quotes'],
    ['«Fare»', 'guillemets'],
    ['‘Fare’', 'curly single open quote'],
    ['Fare″', 'double prime'],
    ['<b>Fare</b>', 'markup'],
    ['[link](x)', 'markdown'],
    ['a@b', 'at sign'],
    ['example.com', 'a dot'],
    ['https://x', 'a colon and slashes'],
    ['Fare\npaid', 'line feed'],
    ['Fare paid', 'line separator'],
    ['Fare paid!', 'exclamation'],
    ['Fare paid?', 'question mark'],
    ['Fare: paid', 'colon'],
    ['Fare; paid', 'semicolon'],
    ['Fare…', 'ellipsis'],
    ['Fare — paid', 'em dash'],
    ['Fare (paid)', 'brackets'],
    ['#1 stamp', 'hash'],
    ['ı stamp', 'dotless i'],
    ['ſtamp', 'long s'],
    ['ĳs', 'ij ligature'],
    ['Fare × 2', 'multiplication sign'],
    ['北京', 'Han'],
    ['مرحبا', 'Arabic'],
  ];
  it.each(refused)('refuses %j (%s)', (t) => {
    expect(code(t), t).toBe(/^ |  /u.test(t) ? 'text_spacing' : 'text_character');
  });
  it('names the character it refuses, as a code point', () => {
    expect(partnerTextProblem(`F${ch(0x0430)}re`, 'object')?.message).toContain('U+0430');
    expect(partnerTextProblem(`Fa${ch(0x200b)}re`, 'object')?.message).toContain('U+200B');
  });
});

describe('partner text: punctuation', () => {
  it.each([
    ['-Fare', 'starts with a hyphen'],
    ["'Fare", 'starts with an apostrophe'],
    ['Fare-', 'ends with a hyphen'],
    ['Fare,', 'ends with a comma'],
    ['Fare--paid', 'two hyphens'],
    ['Fare -paid', 'hyphen after a space'],
    ['Fare - paid', 'a spaced hyphen (a dash)'],
    ['Fare , paid', 'comma after a space'],
    ['Fare,paid', 'comma without a space after'],
    ["the 'stamp'", 'an apostrophe opening a quote'],
    ['Fare ’paid’', 'a curly apostrophe opening a quote'],
    ['a &, b', 'two marks together'],
  ])('refuses %j (%s)', (t) => {
    expect(code(t), t).toBe('text_punctuation');
  });
  it('refuses text with no letter', () => {
    expect(code('2024')).toBe('text_no_letter');
    expect(code('1 & 2')).toBe('text_no_letter');
  });
});

describe('partner text: numbers and addresses written as text', () => {
  it.each([
    ['10000 tickets', 'text_number'],
    ['Gate 12345', 'text_number'],
    ['1,000 tickets', 'text_number'],
    ['0x1234', 'text_looks_like_address'],
    ['0xAb', 'text_looks_like_address'],
    ['GBX3KQ2M', 'text_looks_like_address'],
    ['abc123def', 'text_looks_like_address'],
    ['Ab3dEf9h', 'text_looks_like_address'],
    ['GbXkQmZpRtYw', 'text_looks_like_address'],
    ['ABCDEFGHIJKLMNOP', 'text_looks_like_address'],
    ['GBX3 KQ2M', 'text_looks_like_address'],
    ['to GD7Q AA41', 'text_looks_like_address'],
  ])('refuses %j as %s', (t, c) => {
    expect(code(t), t).toBe(c);
  });
  it('keeps ordinary short numbers and words', () => {
    for (const t of ['Gate 3', 'Row 12', 'Season 2024', 'A380 seat', 'MP3 player', 'McDonald', 'International', 'B2B desk']) expect(code(t), t).toBeNull();
  });
});

describe('partner text: links, Journear’s names, the reviewed lists', () => {
  it('refuses link words', () => {
    for (const t of ['www stamps', 'http stamp', 'HTTPS desk', 'mailto desk']) expect(code(t), t).toBe('text_link');
  });
  it('refuses Journear, Passport and Hana in any case, accent, spacing, digit or look-alike', () => {
    for (const t of ['Journear stamp', 'journear', 'JOURNEAR', 'J0urnear', 'Joumear', 'J o u r n e a r', 'Jöurnéar', 'Journear’s', 'MyJournearPass', 'Passport stamp', 'P4ssport', 'Pa55port', 'p a s s p o r t', 'passports', 'Hana pay', 'H4na', 'Hanami']) {
      expect(code(t), t).toBe('text_brand');
    }
    for (const t of ['Johana Bakery', 'Shanahan', 'Journey', 'Port pass']) expect(code(t), t).toBeNull();
  });
  it('refuses the names of tokens, network coins and programs on Journear’s lists', () => {
    for (const t of ['USDC bonus', 'usdc', 'U5DC', 'EURC', 'USD Coin', 'Euro Coin', 'wNEAR', 'Wrapped NEAR', 'NEAR drop', 'N3AR', 'ETH', 'Ether', 'XLM', 'Stellar Lumens', 'Sodax swap', 'MySodaxPool', 'Bitcoin']) {
      expect(code(t), t).toBe('text_reviewed_name');
    }
    // Journear's own reviewed contracts are caught as Journear's name first.
    expect(code('Journear demo stamps')).toBe('text_brand');
    for (const t of ['Methods', 'together', 'nearly', 'Coin toss']) expect(code(t), t).toBeNull();
  });
});

describe('partner text: claim words', () => {
  // The proposal's list (checked, verified, official, safe, secure, guaranteed, risk-free, free, no fee, refund, insured,
  // approved by, recommended), each with inflections, spacing and digits for letters; then other forms and languages.
  const claims = [
    'checked',
    'Checked stamp',
    'verified',
    'Verified',
    'V3rified',
    'Ver1fied',
    'verify',
    'verification',
    'unverified',
    'superverified',
    'v e r i f i e d',
    'official',
    'Officially',
    '0fficial',
    'safe',
    'S4FE',
    's a f e',
    'safely',
    'safety',
    'Safest seat',
    'secure',
    'secured',
    'security deposit',
    'guaranteed',
    'guarantee',
    'risk-free',
    'risk free',
    'no risk',
    'free',
    'FREE stamp',
    'Fr33',
    'freely',
    'no fee',
    'no fees',
    'zero fees',
    'feeless',
    'refund',
    'refundable',
    'refunded',
    'insured',
    'insurance',
    'approved by banks',
    'approval',
    'recommended',
    'recommend',
    'trusted',
    'trust',
    'protected',
    'protection',
    'certified',
    'audited',
    'audit',
    'endorsed',
    'authentic',
    'genuine',
    'legit',
    'harmless',
    'reversible',
    'costs',
    'reimbursed',
    'warranty',
    'gratis',
    'gratuit',
    'kostenlos',
    'sicher',
    'seguro',
    'garantizado',
    'oficial',
    'aprobado',
    'percuma',
    'selamat',
    'disahkan',
    'rasmi',
    'dijamin',
  ];
  it.each(claims)('refuses %j', (t) => {
    expect(code(t), t).toBe('text_claim');
  });
  it('keeps words that only start like one', () => {
    for (const t of ['Auditorium seat', 'Safari tour', 'Freight', 'Coffee', 'Checkout', 'Verity Lane', 'Trudy']) expect(code(t), t).toBeNull();
  });
});

describe('partner text: words for the user, and jargon', () => {
  it('refuses "you" and "your", which would stand in for the window’s own "your account"', () => {
    for (const t of ['your reward', 'for you', 'Yours', 'you’re in', "you're in", 'to yourself', 'Y o u r prize', 'ur prize']) expect(code(t), t).toBe('text_you');
  });
  it('refuses the plain-words list’s jargon', () => {
    for (const t of ['gas refill', 'the contract', 'NFT', 'vault', 'relayer', 'testnet stamp', 'smart contract', 'burn', 'g4s refill', 'on chain', 'chain id', 'allowance', 'delegate']) {
      expect(code(t), t).toBe('text_jargon');
    }
    // The message names the word.
    expect(partnerTextProblem('gas refill', 'object')?.message).toContain('“gas”');
  });
});

describe('partner text: one rule for every role', () => {
  it('the same text gets the same answer in every role (only the length limit differs)', () => {
    const samples = ['Fare paid', 'verified', 'USDC', 'your seat', `F${ch(0x0430)}re`, 'Journear', 'gas', '0x12', '“x”', 'a'.repeat(24)];
    for (const t of samples) {
      const answers = (Object.keys(PARTNER_TEXT_MAX) as PartnerTextRole[]).map((r) => code(t, r));
      expect(new Set(answers).size, t).toBe(1);
    }
  });
  it('every message is plain words for a partner, one line', () => {
    const inputs: unknown[] = [5, '', 'a'.repeat(40), 'Café', ' x', 'Fаre', '-x', '12345 x', '0x1', 'www x', 'Journear', 'USDC', 'free', 'your x', 'gas'];
    for (const t of inputs) {
      const p = partnerTextProblem(t, 'object');
      expect(p, String(t)).not.toBeNull();
      expect(p!.message.length).toBeGreaterThan(10);
      expect(p!.message).not.toMatch(/\n/u);
    }
  });
});
