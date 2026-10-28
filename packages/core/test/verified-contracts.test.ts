// Hana's verified contract list and explorers (docs/decisions.md D44, src/verified-contracts.ts): every entry has
// sources, a well-formed address and a unique (chain, address) key; lookups are lowercase for EVM and exact for
// Stellar; look-alike partner names are caught; explorer links per chain, none for an unknown chain.
import { describe, expect, it } from 'vitest';
import { STRKEY_VERSION, decodeStrKey } from '../src/addresses.ts';
import { checksumAddress, parseHex0x } from '../src/decode/hex.ts';
import { STELLAR_MAINNET_PASSPHRASE, TEST_EVM_CHAINS } from '../src/networks.ts';
import { POLICY_NAME_MAX } from '../src/policy/validate.ts';
import {
  type ContractChain,
  EVM_EXPLORERS,
  STELLAR_EXPLORERS,
  STELLAR_TESTNET_PASSPHRASE,
  VERIFIED_CONTRACTS,
  type VerifiedContract,
  displayPartnerName,
  explorerContractUrl,
  nameCollision,
  nameSkeleton,
  shortAddress,
  verifiedContract,
  verifiedContractKey,
  verifiedContractOnAll,
} from '../src/verified-contracts.ts';

const BASE: ContractChain = { kind: 'evm', chainId: 8453 };
const SONIC: ContractChain = { kind: 'evm', chainId: 146 };
const STELLAR: ContractChain = { kind: 'stellar', networkPassphrase: STELLAR_MAINNET_PASSPHRASE };
const STELLAR_TEST: ContractChain = { kind: 'stellar', networkPassphrase: STELLAR_TESTNET_PASSPHRASE };
const BASE_ASSET_MANAGER = '0x348BE44F63A458be9C1b13D6fD8e99048F297Bc3';
const STELLAR_ASSET_MANAGER = 'CCGF33A4CO6D3BXFEKPXVCFCZBK76I3AQOZK6KIKRPAWAZR3632WHCJ3';
const OTHER = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';
const TODAY = '2026-10-28';

describe('VERIFIED_CONTRACTS entries', () => {
  it('is not empty and is frozen, entries included', () => {
    expect(VERIFIED_CONTRACTS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(VERIFIED_CONTRACTS)).toBe(true);
    for (const e of VERIFIED_CONTRACTS) {
      expect(Object.isFrozen(e)).toBe(true);
      expect(Object.isFrozen(e.chain)).toBe(true);
      expect(Object.isFrozen(e.sources)).toBe(true);
    }
    expect(() => (VERIFIED_CONTRACTS as VerifiedContract[]).push(VERIFIED_CONTRACTS[0] as VerifiedContract)).toThrow();
  });

  it.each(VERIFIED_CONTRACTS.map((e) => [`${e.name} ${verifiedContractKey(e.chain, e.address)}`, e] as const))('%s: sources, date, name', (_, e) => {
    expect(e.sources.length).toBeGreaterThan(0);
    expect(new Set(e.sources).size).toBe(e.sources.length);
    for (const s of e.sources) {
      const url = new URL(s);
      expect(url.protocol).toBe('https:');
      // A package source pins an exact version: name@x.y.z.
      if (url.hostname === 'unpkg.com' || url.hostname === 'cdn.jsdelivr.net') expect(url.pathname).toMatch(/@\d+\.\d+\.\d+\//u);
    }
    expect(e.added).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(new Date(`${e.added}T00:00:00Z`).toISOString().slice(0, 10)).toBe(e.added);
    expect(e.added <= TODAY || e.added <= new Date().toISOString().slice(0, 10)).toBe(true);
    expect(e.name.trim()).toBe(e.name);
    expect(e.name.length).toBeGreaterThan(0);
    expect(e.name.length).toBeLessThanOrEqual(POLICY_NAME_MAX);
    expect(e.name).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/u);
    expect(nameSkeleton(e.name)).toContain(nameSkeleton(e.protocol));
  });

  it.each(VERIFIED_CONTRACTS.map((e) => [`${e.name} ${verifiedContractKey(e.chain, e.address)}`, e] as const))('%s: well-formed address', (_, e) => {
    if (e.chain.kind === 'evm') {
      expect(Number.isSafeInteger(e.chain.chainId) && e.chain.chainId > 0).toBe(true);
      expect(e.address).toMatch(/^0x[0-9a-fA-F]{40}$/u);
      // Stored EIP-55, so a mistyped mixed-case address fails its checksum here.
      expect(e.address).toBe(checksumAddress(parseHex0x(e.address, 20)));
      expect(e.address.toLowerCase()).not.toBe(`0x${'0'.repeat(40)}`);
    } else {
      expect([STELLAR_MAINNET_PASSPHRASE, STELLAR_TESTNET_PASSPHRASE]).toContain(e.chain.networkPassphrase);
      expect(() => decodeStrKey(STRKEY_VERSION.contract, e.address)).not.toThrow();
    }
  });

  it('has unique (chain, normalized address) keys', () => {
    const keys = VERIFIED_CONTRACTS.map((e) => verifiedContractKey(e.chain, e.address));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('Sodax entries are mainnet only (Sodax has no testnet deployments)', () => {
    for (const e of VERIFIED_CONTRACTS.filter((x) => x.protocol === 'Sodax')) {
      if (e.chain.kind === 'evm') expect(Object.hasOwn(TEST_EVM_CHAINS, e.chain.chainId)).toBe(false);
      else expect(e.chain.networkPassphrase).toBe(STELLAR_MAINNET_PASSPHRASE);
    }
  });
});

describe('verifiedContract', () => {
  it('finds an EVM entry whatever the address case', () => {
    expect(verifiedContract(BASE, BASE_ASSET_MANAGER)?.name).toBe('Sodax Asset Manager');
    expect(verifiedContract(BASE, BASE_ASSET_MANAGER.toLowerCase())?.name).toBe('Sodax Asset Manager');
    expect(verifiedContract(BASE, `0x${BASE_ASSET_MANAGER.slice(2).toUpperCase()}`)?.name).toBe('Sodax Asset Manager');
  });

  it('is keyed by chain: the same address on another chain is not verified', () => {
    expect(verifiedContract({ kind: 'evm', chainId: 84532 }, BASE_ASSET_MANAGER)).toBeNull();
    expect(verifiedContract({ kind: 'evm', chainId: 999_999 }, BASE_ASSET_MANAGER)).toBeNull();
    expect(verifiedContract(SONIC, BASE_ASSET_MANAGER)).toBeNull();
  });

  it('compares Stellar contract IDs exactly, per network', () => {
    expect(verifiedContract(STELLAR, STELLAR_ASSET_MANAGER)?.name).toBe('Sodax Asset Manager');
    expect(verifiedContract(STELLAR, STELLAR_ASSET_MANAGER.toLowerCase())).toBeNull();
    expect(verifiedContract(STELLAR_TEST, STELLAR_ASSET_MANAGER)).toBeNull();
  });

  it('verifiedContractOnAll needs the entry on every listed network', () => {
    expect(verifiedContractOnAll([STELLAR], STELLAR_ASSET_MANAGER)?.name).toBe('Sodax Asset Manager');
    expect(verifiedContractOnAll([STELLAR, STELLAR_TEST], STELLAR_ASSET_MANAGER)).toBeNull();
    expect(verifiedContractOnAll([], STELLAR_ASSET_MANAGER)).toBeNull();
  });
});

describe('nameCollision', () => {
  it('flags a partner name that reads as a verified name, on any chain, for another contract', () => {
    for (const name of ['Sodax Asset Manager', 'sodax asset-manager', 'SODAX  Asset  Manager', 'Sоdax Аsset Manager' /* Cyrillic о, А */, 'Ｓｏｄａｘ Asset Manager', 'Sodax Asset Manager ✓', 'S0dax Asset Manager']) {
      const c = nameCollision(name, [BASE], OTHER);
      expect(c?.kind, name).toBe('verified-name');
      expect(c?.kind === 'verified-name' && c.entry.name).toBe('Sodax Asset Manager');
    }
    // On a chain with no Sodax entries at all.
    expect(nameCollision('Sodax Asset Manager', [{ kind: 'evm', chainId: 999_999 }], BASE_ASSET_MANAGER)?.kind).toBe('verified-name');
  });

  it('flags a partner name that mentions a verified protocol', () => {
    expect(nameCollision('Sodax Router', [BASE], OTHER)).toEqual({ kind: 'protocol', protocol: 'Sodax' });
    expect(nameCollision('Official SODAX swap', [STELLAR], 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC')).toEqual({ kind: 'protocol', protocol: 'Sodax' });
  });

  it('leaves ordinary names alone', () => {
    for (const name of ['USDC', 'Example vault', 'Router', 'Asset Manager', 'Soda Pop', 'Uniswap Router']) expect(nameCollision(name, [BASE], OTHER), name).toBeNull();
    expect(nameCollision('✓', [BASE], OTHER)).toBeNull();
  });

  it("doesn't count the contract's own entry on a listed network", () => {
    // Verified on public but not on testnet: not verified on both, but its name is no imitation.
    expect(nameCollision('Sodax Asset Manager', [STELLAR, STELLAR_TEST], STELLAR_ASSET_MANAGER)).toBeNull();
    expect(nameCollision('Sodax spoke', [STELLAR, STELLAR_TEST], STELLAR_ASSET_MANAGER)).toBeNull();
    // Another verified name is still flagged.
    expect(nameCollision('Sodax bnUSD', [STELLAR, STELLAR_TEST], STELLAR_ASSET_MANAGER)?.kind).toBe('verified-name');
  });

  it('checks against the list it is given', () => {
    const list: VerifiedContract[] = [{ chain: BASE, address: OTHER, name: 'Acme Router', protocol: 'Acme', sources: ['https://acme.example/docs'], added: TODAY }];
    expect(nameCollision('acme router', [SONIC], OTHER, list)).toMatchObject({ kind: 'verified-name' });
    expect(nameCollision('Acme thing', [SONIC], OTHER, list)).toEqual({ kind: 'protocol', protocol: 'Acme' });
    expect(nameCollision('Sodax Router', [SONIC], OTHER, list)).toBeNull();
  });
});

describe('displayPartnerName', () => {
  it('removes check marks so only the verified badge carries one', () => {
    expect(displayPartnerName('✓ USDC')).toBe('USDC');
    expect(displayPartnerName('✔️ USDC ✅')).toBe('USDC');
    expect(displayPartnerName('☑ Pool')).toBe('Pool');
    expect(displayPartnerName('Example pool')).toBe('Example pool');
  });
});

describe('explorers', () => {
  it('links EVM contracts per chain, mainnets and test networks', () => {
    expect(explorerContractUrl(BASE, BASE_ASSET_MANAGER)).toBe(`https://basescan.org/address/${BASE_ASSET_MANAGER}`);
    expect(explorerContractUrl(SONIC, OTHER)).toBe(`https://sonicscan.org/address/${OTHER}`);
    expect(explorerContractUrl({ kind: 'evm', chainId: 1 }, OTHER)).toBe(`https://etherscan.io/address/${OTHER}`);
    expect(explorerContractUrl({ kind: 'evm', chainId: 295 }, OTHER)).toBe(`https://hashscan.io/mainnet/contract/${OTHER}`);
    expect(explorerContractUrl({ kind: 'evm', chainId: 11155111 }, OTHER)).toBe(`https://sepolia.etherscan.io/address/${OTHER}`);
    expect(explorerContractUrl({ kind: 'evm', chainId: 84532 }, OTHER)).toBe(`https://sepolia.basescan.org/address/${OTHER}`);
  });

  it('links Stellar contracts per network', () => {
    expect(explorerContractUrl(STELLAR, STELLAR_ASSET_MANAGER)).toBe(`https://stellar.expert/explorer/public/contract/${STELLAR_ASSET_MANAGER}`);
    expect(explorerContractUrl(STELLAR_TEST, STELLAR_ASSET_MANAGER)).toBe(`https://stellar.expert/explorer/testnet/contract/${STELLAR_ASSET_MANAGER}`);
  });

  it('has no link for an unknown chain or network', () => {
    expect(explorerContractUrl({ kind: 'evm', chainId: 999_999 }, OTHER)).toBeNull();
    expect(explorerContractUrl({ kind: 'evm', chainId: 31337 }, OTHER)).toBeNull();
    expect(explorerContractUrl({ kind: 'evm', chainId: 14601 }, OTHER)).toBeNull();
    expect(explorerContractUrl({ kind: 'stellar', networkPassphrase: 'Test SDF Future Network ; October 2022' }, STELLAR_ASSET_MANAGER)).toBeNull();
    // Prototype keys are not chains.
    expect(explorerContractUrl({ kind: 'stellar', networkPassphrase: 'toString' }, STELLAR_ASSET_MANAGER)).toBeNull();
  });

  it('has an https explorer for every chain on the verified list, and every explorer URL is https and ends in /', () => {
    for (const e of VERIFIED_CONTRACTS) expect(explorerContractUrl(e.chain, e.address), verifiedContractKey(e.chain, e.address)).not.toBeNull();
    for (const x of [...Object.values(EVM_EXPLORERS), ...Object.values(STELLAR_EXPLORERS)]) {
      expect(new URL(x.contractUrl).protocol).toBe('https:');
      expect(x.contractUrl.endsWith('/')).toBe(true);
      expect(x.name.length).toBeGreaterThan(0);
    }
    expect(Object.isFrozen(EVM_EXPLORERS) && Object.isFrozen(EVM_EXPLORERS[1])).toBe(true);
  });

  it('every test EVM chain with a public explorer has one', () => {
    const local = new Set([31337, 1337, 14601]);
    for (const id of Object.keys(TEST_EVM_CHAINS).map(Number)) if (!local.has(id)) expect(Object.hasOwn(EVM_EXPLORERS, id), String(id)).toBe(true);
  });
});

describe('shortAddress', () => {
  it('keeps the first and last four characters', () => {
    expect(shortAddress(BASE_ASSET_MANAGER)).toBe('0x348B…7Bc3');
    expect(shortAddress(STELLAR_ASSET_MANAGER)).toBe('CCGF…HCJ3');
    expect(shortAddress('0x1234')).toBe('0x1234');
  });
});
