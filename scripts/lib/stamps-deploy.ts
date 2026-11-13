// deploy-stamps (D796): the Journear Passport stamps contract `contracts/hana-stamps` on the env's `near.demoStamps`
// account, through the demo contracts' shared deploy (lib/demo-deploy.ts): a dry run by default, deploy and `new()` in
// one transaction, never a redeploy, `--lock` to delete every key. Run against a stub chain in
// test/stamps-deploy.test.ts.
import { type DemoContract, type DemoDeps, defaultDemoDeps, demoMain, demoNeedYocto, demoUsage } from './demo-deploy.ts';

/**
 * Bytes of state the deploy's balance check reserves beyond the code (2 NEAR of storage). The stamps contract's state
 * isn't bounded in total (one passport per account): the ring of 100 recent stamps takes at most about 12 200 bytes,
 * each passport at most about 740 (six stamps, a 140-character note of four-byte characters, a 64-character account:
 * the unit test `storage_per_passport_and_ring_is_bounded`), a typical one about 200. 200 000 bytes is the ring and
 * about 250 of the largest passports (about 900 typical ones); contracts/hana-stamps/README.md "Storage" says what to
 * hold and how to top it up.
 */
export const STAMPS_STATE_BYTES = 200_000n;
/** The wasm's size for a dry run's balance check before the build (the 0.1.0 build is 148 704 bytes), rounded up. */
export const STAMPS_WASM_ESTIMATE_BYTES = 155_000;

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const totalsOf = (v: unknown): { passports: number; stamps: number } | null => {
  if (typeof v !== 'object' || v === null) return null;
  const { passports, stamps } = v as Record<string, unknown>;
  return isCount(passports) && isCount(stamps) ? { passports, stamps } : null;
};

export const STAMPS: DemoContract = {
  command: 'deploy-stamps',
  name: 'stamps contract',
  crate: 'hana-stamps',
  wasmName: 'hana_stamps.wasm',
  manifestField: 'demoStamps',
  docsSection: 'Hackathon demo stamps (NEAR)',
  stateBytes: STAMPS_STATE_BYTES,
  stateText: `${STAMPS_STATE_BYTES} bytes of passports to start with`,
  stateNoun: 'passports',
  wasmEstimateBytes: STAMPS_WASM_ESTIMATE_BYTES,
  probe: {
    method: 'totals',
    summary: (v) => {
      const t = totalsOf(v);
      return t ? `${t.passports} passports, ${t.stamps} stamps so far` : null;
    },
    fresh: (v) => {
      const t = totalsOf(v);
      return t !== null && t.passports === 0 && t.stamps === 0;
    },
    freshText: '{"passports":0,"stamps":0}',
  },
};

export const STAMPS_USAGE = demoUsage(STAMPS);

/** Yocto the account needs before the deploy: storage for its current bytes, the code and the first passports, plus gas money. */
export const stampsNeedYocto = (storageUsage: number, wasmBytes: number): bigint => demoNeedYocto(STAMPS, storageUsage, wasmBytes);

/** Runs deploy-stamps with argv (without node and script path). Returns the exit code. */
export const stampsMain = (argv: readonly string[], deps: DemoDeps = defaultDemoDeps()): Promise<number> => demoMain(STAMPS, argv, deps);
