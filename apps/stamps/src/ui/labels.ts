// The words of the passport: each stamp's title and one-line blurb, the cover, and the fixed labels. Plain words; the
// product is "Journear Passport" and the company "Journear" (D765), never the code name.
import type { StampId } from './types.ts';

export const STAMP_LABELS: Readonly<Record<StampId, { readonly title: string; readonly blurb: string }>> = Object.freeze({
  arrival: { title: 'Arrival', blurb: 'Your first stamp. It opens your passport on NEAR’s test network.' },
  sponsored: { title: 'Fare paid', blurb: 'Free for you: Journear pays the network fee, so you need no NEAR.' },
  own_fare: { title: 'Own fare', blurb: 'You pay the network fee yourself, with free test NEAR.' },
  signature: { title: 'Signature', blurb: 'Two approvals: sign a message, then send it. The stamps program checks it.' },
  postcard: { title: 'Postcard', blurb: 'Leave a public note of up to 140 characters.' },
  layover: { title: 'Layover', blurb: 'Wait two minutes after Arrival, then stamp again.' },
});

/**
 * What each stamp shows NEAR can do: the identity page's legend, for whoever is watching the demo (the hackathon's
 * judges). D853's one exception: it stays technical, under a heading that says it is the technical explanation
 * (`UI_TEXT.proofs`), and the plain-words test allows its terms by name.
 */
export const STAMP_PROOFS: Readonly<Record<StampId, string>> = Object.freeze({
  arrival: 'Your first call to the stamps contract. It opens your passport.',
  sponsored: 'A NEP-366 delegate action: you sign, the relay sends it and pays the gas.',
  own_fare: 'A transaction you sign and pay for yourself, from your own NEAR.',
  signature: 'A NEP-413 signed message, checked on chain with ed25519_verify.',
  postcard: 'Your note, kept by the contract and shown on your public page.',
  layover: 'Block time: at least two minutes after your Arrival.',
});

export const COVER_COPY = Object.freeze({
  eyebrow: 'NEAR test network',
  title: 'Journear Passport',
  line: 'Sign in with email or Google to get a NEAR account, with no recovery words to keep and no NEAR to buy, then collect six stamps. Each one is really recorded on NEAR’s test network.',
  signIn: 'Sign in',
  fine: 'A test version: nothing here is real money.',
});

export const UI_TEXT = Object.freeze({
  mine: 'Your passport',
  public: 'Passport',
  publicNote: 'Read from NEAR’s test network. Anyone can see it.',
  stamps: 'Stamps',
  account: 'Account',
  network: 'Network',
  networkValue: 'NEAR test network',
  balance: 'Balance',
  collectedOf: (n: number) => `${n} of 6`,
  copy: 'Copy',
  copyAccount: 'Copy account',
  showFull: 'Show full',
  hideFull: 'Hide full',
  explorer: 'See it on NEAR ↗',
  share: 'Public passport',
  signOut: 'Sign out',
  ownPassport: 'Get your own passport',
  collect: 'Collect',
  collectPostcard: 'Send postcard',
  working: 'Working…',
  retry: 'Try again',
  noteLabel: 'Your note',
  notePlaceholder: 'Greetings from my passport',
  noteHint: 'Public: anyone can see it.',
  noGas: 'Free',
  noGasLong: 'Free: Journear paid the network fee',
  viewTx: 'See this stamp on NEAR ↗',
  notYet: 'Not collected yet',
  proofs: 'The technical explanation: what each stamp proves',
  recent: 'Recent stamps',
  recentEmpty: 'No stamps yet. Yours could be the first.',
  refresh: 'Refresh',
  totals: (p: number, s: number) => `${p.toLocaleString('en-US')} ${p === 1 ? 'passport' : 'passports'} · ${s.toLocaleString('en-US')} ${s === 1 ? 'stamp' : 'stamps'}`,
  continue: 'Continue',
  status: { collected: 'collected', available: 'ready to collect', locked: 'locked', working: 'in progress', continue: 'needs your click to continue', failed: 'failed' },
});
