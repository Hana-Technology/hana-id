// The routes (D799): `/` and `/p/<account_id>`, the id strictly validated; the explorer links.
import { describe, expect, it } from 'vitest';
import { explorerAccountUrl, explorerTxUrl, isViewableAccount, parseRoute, passportPath } from '../src/routes.ts';
import { TX_HASH } from './fakes.ts';
import { NEAR_ACCOUNT } from './fixtures.ts';

describe('parseRoute', () => {
  it('home and public passports of implicit and named .testnet accounts', () => {
    expect(parseRoute('/')).toEqual({ kind: 'mine' });
    expect(parseRoute(`/p/${NEAR_ACCOUNT}`)).toEqual({ kind: 'public', accountId: NEAR_ACCOUNT });
    expect(parseRoute('/p/alice.testnet')).toEqual({ kind: 'public', accountId: 'alice.testnet' });
    expect(parseRoute('/p/hana-id-stamps-dev1.testnet')).toEqual({ kind: 'public', accountId: 'hana-id-stamps-dev1.testnet' });
  });

  it('refuses anything else: mainnet and other names, case, encoding, slashes, traversal, overlong, EVM-style', () => {
    for (const path of [
      '',
      '/p/',
      '/p',
      `/p/${NEAR_ACCOUNT}/`,
      `/p/${NEAR_ACCOUNT.toUpperCase()}`,
      `/p/${NEAR_ACCOUNT.slice(1)}`,
      '/p/alice.near',
      '/p/near',
      '/p/testnet',
      '/p/Alice.testnet',
      '/p/alice%2etestnet',
      '/p/..%2f..%2fetc',
      '/p/../index.html',
      '/p/alice..testnet',
      '/p/-alice.testnet',
      `/p/${'a'.repeat(57)}.testnet`,
      '/p/0x8ba1f109551bd432803012645ac136ddd64dba72',
      '/index.html',
      '/p/alice.testnet?x=1',
      '//p/alice.testnet',
    ]) expect(parseRoute(path), path).toEqual({ kind: 'not_found' });
  });

  it('passportPath only for a viewable id', () => {
    expect(passportPath(NEAR_ACCOUNT)).toBe(`/p/${NEAR_ACCOUNT}`);
    expect(() => passportPath('alice.near')).toThrow();
    expect(isViewableAccount('0x8ba1f109551bd432803012645ac136ddd64dba72')).toBe(false);
  });
});

describe('explorer links', () => {
  it('NearBlocks testnet for the account and a checked transaction hash', () => {
    expect(explorerAccountUrl('https://testnet.nearblocks.io', NEAR_ACCOUNT)).toBe(`https://testnet.nearblocks.io/address/${NEAR_ACCOUNT}`);
    expect(explorerTxUrl('https://testnet.nearblocks.io', TX_HASH)).toBe(`https://testnet.nearblocks.io/txns/${TX_HASH}`);
    expect(explorerTxUrl('https://testnet.nearblocks.io', 'not/a hash')).toBeNull();
    expect(explorerTxUrl(null, TX_HASH)).toBeNull();
    expect(explorerAccountUrl(null, NEAR_ACCOUNT)).toBeNull();
  });
});
