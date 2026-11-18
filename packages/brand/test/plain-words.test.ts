// D853's word check (src/plain-words.ts): whole words in any case, never inside a code or a class name, and the
// sentence-like literals of a source outside its comments.
import { describe, expect, it } from 'vitest';
import { JARGON, jargonIn, sentencesIn } from '../src/plain-words.ts';

describe('jargonIn', () => {
  it('finds whole words and phrases, any case, across line breaks', () => {
    expect(jargonIn('You paid no gas.')).toEqual(['gas']);
    expect(jargonIn('Get testnet NEAR from the Faucet')).toEqual(['faucet', 'testnet']);
    expect(jargonIn('Public, on\nchain.')).toEqual(['on chain']);
    expect(jargonIn('The EVM key')).toEqual(['EVM']);
  });

  it('ignores codes, class names and words that only contain a banned one', () => {
    for (const s of ['mainnet_not_allowed', 'jp-vault', 'near_delegate_nonce_used', 'gaslight', 'relayed', 'blocked', 'contracted', 'Ethereum-style key', 'hana-id-auth-sandbox-dev.example']) expect(jargonIn(s), s).toEqual([]);
  });

  it('lists each word once', () => {
    expect(new Set(JARGON.map((w) => w.toLowerCase())).size).toBe(JARGON.length);
  });
});

describe('sentencesIn', () => {
  it('takes literals with a space outside comment lines, and skips URLs', () => {
    const src = ["// 'a comment with gas'", "const a = 'You paid no gas.';", 'const b = `${x} on chain`;', "const c = 'https://a.example/x y';", "const d = 'single';"].join('\n');
    expect(sentencesIn(src)).toEqual(['You paid no gas.', '${x} on chain']);
  });
});
