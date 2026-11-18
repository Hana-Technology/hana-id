// The local stack's EVM sponsorship relayer key (Node only: the browser bundles import src/stack.ts, not this). A
// random key made the first time the stack needs it and kept in the build directory (.build/, gitignored, mode 0600),
// so the bundles built for a run (their env pins the relayer's address, D834) and the API Worker that signs with it
// agree. It pays only on the mocked chain 31337: no network ever sees it. Never logged, never committed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';

const FILE = new URL('../.build/evm-relayer-key.json', import.meta.url);

let cached: { keysVar: string; address: `0x${string}` } | null = null;

function readKey(): `0x${string}` | null {
  try {
    const v = JSON.parse(readFileSync(FILE, 'utf8')) as { key?: unknown };
    return typeof v.key === 'string' && /^0x[0-9a-f]{64}$/u.test(v.key) ? (v.key as `0x${string}`) : null;
  } catch {
    return null;
  }
}

/** The relayer's EVM_RELAY_KEYS value and its EIP-55 address, made once (an existing file wins any race). */
export function e2eRelayer(): { keysVar: string; address: `0x${string}` } {
  if (cached) return cached;
  let key = readKey();
  if (!key) {
    mkdirSync(new URL('./', FILE), { recursive: true });
    try {
      writeFileSync(FILE, JSON.stringify({ key: generatePrivateKey() }), { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    key = readKey();
    if (!key) throw new Error('The e2e relayer key file is unreadable: delete apps/e2e/.build and run again');
  }
  cached = { keysVar: JSON.stringify([key]), address: privateKeyToAddress(key) };
  return cached;
}
