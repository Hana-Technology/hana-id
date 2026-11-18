// D853's plain-words rule, as a check for tests: the chain and engineering words an end user never reads above the
// fold (docs/security.md "Browser", the plain-wording word list). A surface's test lists the files whose strings users
// read, takes their sentences with `sentencesIn` and expects `jargonIn` to find nothing, with a short allowlist of exact
// strings where a term is deliberate (a labelled technical explanation, the setting another app shows by that name).
// Node or browser: no imports.

/**
 * Each banned word or phrase, matched as a whole word, any case. The plain word to use instead is in D853's word list
 * (network fee for gas, test network for testnet, Ethereum-style for EVM, your account for account id, …).
 */
export const JARGON: readonly string[] = Object.freeze([
  'gas',
  'gasless',
  'nonce',
  'RPC',
  'block hash',
  'block height',
  'vault',
  'ledger',
  'decoder',
  'API',
  'relayer',
  'relay',
  'sponsored',
  'faucet',
  'testnet',
  'mainnet',
  'sandbox',
  'pk_test',
  'EVM',
  'chain id',
  'allowance',
  'spender',
  'signer',
  'calldata',
  'on chain',
  'on-chain',
  'smart contract',
  'contract',
  'NFT',
  'wei',
  'yocto',
  'yoctoNEAR',
  'stroops',
  'COOP',
  'key service',
  'CKD',
  'MPC',
  'storage balance',
  'full-access key',
  'function-call key',
  'access key',
  'account id',
  'delegate action',
  'explorer',
  'Not production',
  // The approval window's words (feat/plain-approval-wording): one list for every surface.
  'chain',
  'chains',
  'contracts',
  'operator',
  'revoke',
  'revoked',
  'revokes',
  'unlimited',
  'signers',
  'threshold',
  'thresholds',
  'weight',
  'weights',
  'burn',
  'burnt',
  'burned',
  'burns',
  'trust line',
  'trust lines',
  'trustline',
  'trustlines',
  'smallest units',
  'decimals',
  'gwei',
  'NFTs',
  'verified',
  'unverified',
  'reviewed list',
  'pinned',
  'authorization',
  'authorize',
  'authorizes',
  'authorized',
  'delegate',
  'declined',
  'log in',
  'technical details',
  'sponsor',
  'sponsorship',
  'relayed',
]);

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/ /gu, '\\s+');
// A word boundary that treats `_` and `-` as part of a word, so a code (`mainnet_not_allowed`, `jp-vault`) never matches.
const PATTERNS: readonly [string, RegExp][] = JARGON.map((w) => [w, new RegExp(`(?<![\\w-])${escape(w)}(?![\\w-])`, 'iu')]);

/** The banned words in `text`, in JARGON's order (empty when it is plain). */
export function jargonIn(text: string): string[] {
  const found = PATTERNS.filter(([, re]) => re.test(text)).map(([w]) => w);
  // A word reported inside a banned phrase found too ("chain" in "on chain") is reported once, as the phrase.
  return found.filter((w) => !found.some((p) => p !== w && p.includes(' ') && new RegExp(`(?<![\\w-])${escape(w)}(?![\\w-])`, 'iu').test(p)));
}

/**
 * The string literals of a TypeScript source that may be words for a person: outside comment lines, holding a space
 * and a letter, and not a URL (a class list or a selector holds no banned word as a whole word). A template literal is
 * taken whole, with its `${…}` placeholders read as "…" (they are names, not words users read: `${ctx.chain}`).
 */
export function sentencesIn(source: string): string[] {
  const code = source
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/u.test(l))
    .join('\n');
  const literals = [...code.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/gu)].map((m) => m[0].slice(1, -1).replace(/\$\{[^}]*\}/gu, '…'));
  return literals.filter((s) => /\s/u.test(s) && /[A-Za-z]{2}/u.test(s) && !/^https?:\/\//u.test(s));
}
