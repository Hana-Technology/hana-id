// The fixed words of a partner label (D892): the verbs a partner may pick and the few joining words a sentence may
// hold. They are Journear's words, not the partner's: a label names one of them, and the window writes it. The verb
// list is the founder's to confirm (D892 "The verb list"); every word here passes the partner text rules too (a test).
// Pure data, no imports.

/**
 * The verbs a partner's label may use, lower case, as the window writes them after "{App} says: ". Chosen for plain
 * words a non-crypto user reads without help, and against abuse (D892 lists what was left out and why: "approve",
 * "burn", "mint", "bridge", "sign", "verify", "allow", "connect", "unlock", "get", "earn", "win", "receive",
 * "refund", "protect").
 */
export const PARTNER_VERBS = Object.freeze([
  'add',
  'bid',
  'book',
  'borrow',
  'buy',
  'cancel',
  'check in',
  'claim',
  'collect',
  'create',
  'deposit',
  'donate',
  'join',
  'leave',
  'lend',
  'list',
  'pay',
  'redeem',
  'register',
  'remove',
  'renew',
  'repay',
  'sell',
  'send',
  'sign up',
  'stake',
  'subscribe',
  'swap',
  'transfer',
  'unstake',
  'unsubscribe',
  'update',
  'vote',
  'withdraw',
] as const);

export type PartnerVerb = (typeof PARTNER_VERBS)[number];

export const isPartnerVerb = (v: unknown): v is PartnerVerb => typeof v === 'string' && (PARTNER_VERBS as readonly string[]).includes(v);

/**
 * The joining words a sentence may put between its parts ("pay for order 1042", "swap 10 USDC for at least 9.95
 * EURC", "send 5 USDC to your account"). Journear's words, from this list only, so a partner can't write a sentence of
 * its own between the true values.
 */
export const PARTNER_CONNECTORS = Object.freeze(['and', 'at least', 'at most', 'for', 'from', 'in', 'of', 'on', 'to', 'until', 'with'] as const);

export type PartnerConnector = (typeof PARTNER_CONNECTORS)[number];

export const isPartnerConnector = (v: unknown): v is PartnerConnector => typeof v === 'string' && (PARTNER_CONNECTORS as readonly string[]).includes(v);

/** What the window says under a partner's sentence, always (D892, from the proposal's section 4.1). */
export const partnerAttribution = (appName: string): string => `These are ${appName}’s words. Journear hasn’t checked them.`;
