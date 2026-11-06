// Every NEAR RPC client in the API's source is made by near/rpc.ts `nearRpc(env)`, so every read and every broadcast
// gets the env's fallbacks (NEAR_RPC_FALLBACKS, D432); none reads NEAR_RPC alone.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', '..', 'src');
const RPC_MODULE = join(SRC, 'near', 'rpc.ts');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

describe('the API’s RPC clients', () => {
  it('are all made by nearRpc: no `new Rpc(` and no client over NEAR_RPC alone outside near/rpc.ts', () => {
    const files = sources(SRC).filter((f) => f !== RPC_MODULE);
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.filter((f) => /new Rpc\(|Rpc\([^)]*NEAR_RPC\)/u.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
    expect(files.filter((f) => readFileSync(f, 'utf8').includes('nearRpc(')).length).toBeGreaterThan(5);
  });
});
