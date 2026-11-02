// The contract fixture is deterministic (tokens review N2): regenerated in memory, it equals the committed file, so the
// contract's tests always run tokens the issuer's current code mints.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIXTURE_PATH, build, testRsaJwk } from '../gen-contract-fixture.ts';

describe('gen-contract-fixture', () => {
  it('derives the same test key every time, and a valid one', () => {
    const a = testRsaJwk();
    expect(testRsaJwk()).toEqual(a);
    expect(Buffer.from(a.n!, 'base64url')).toHaveLength(256);
    expect(a.e).toBe('AQAB');
  });

  it('regenerates exactly the committed issuer_tokens_fixture.json', async () => {
    const committed = readFileSync(FIXTURE_PATH, 'utf8');
    expect(`${JSON.stringify(await build(), null, 2)}\n`).toBe(committed);
  }, 60_000);
});
