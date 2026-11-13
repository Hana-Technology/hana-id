// deploy-guestbook (D743): the hackathon demo contract `contracts/hana-guestbook` on the env's `near.demoGuestbook`
// account, through the demo contracts' shared deploy (lib/demo-deploy.ts, D796): a dry run by default, deploy and
// `new()` in one transaction, never a redeploy, `--lock` to delete every key. Run against a stub chain in
// test/guestbook-deploy.test.ts.
import { type DemoContract, type DemoDeps, type DemoRpc, DEMO_DRY_RUN_LINE, DEMO_INIT_GAS, defaultDemoDeps, demoMain, demoNeedYocto, demoUsage } from './demo-deploy.ts';

/**
 * Bytes the contract's state may grow to beyond the code: 50 messages of the largest size (64-byte account id, 200
 * four-byte characters) take 46 250 bytes on chain (the unit test `storage_stops_growing_at_fifty_messages`), plus
 * the contract struct; rounded up.
 */
export const GUESTBOOK_STATE_BYTES = 50_000n;
/** The wasm's size for a dry run's balance check before the build (the 0.1.0 build is 117 850 bytes), rounded up. */
export const GUESTBOOK_WASM_ESTIMATE_BYTES = 125_000;

export const GUESTBOOK: DemoContract = {
  command: 'deploy-guestbook',
  name: 'guestbook',
  crate: 'hana-guestbook',
  wasmName: 'hana_guestbook.wasm',
  manifestField: 'demoGuestbook',
  docsSection: 'Hackathon demo guestbook',
  stateBytes: GUESTBOOK_STATE_BYTES,
  stateText: `up to ${GUESTBOOK_STATE_BYTES} bytes of messages`,
  stateNoun: 'messages',
  wasmEstimateBytes: GUESTBOOK_WASM_ESTIMATE_BYTES,
  probe: {
    method: 'total_messages',
    summary: (total) => (typeof total === 'number' ? `${total} messages so far` : null),
    fresh: (total) => total === 0,
    freshText: '0',
  },
};

export const GUESTBOOK_USAGE = demoUsage(GUESTBOOK);
export const GUESTBOOK_DRY_RUN_LINE = DEMO_DRY_RUN_LINE;
export const GUESTBOOK_INIT_GAS = DEMO_INIT_GAS;
export type GuestbookRpc = DemoRpc;
export type GuestbookDeps = DemoDeps;
export const defaultGuestbookDeps = defaultDemoDeps;

/** Yocto the account needs before the deploy: storage for its current bytes, the code and the messages, plus gas money. */
export const guestbookNeedYocto = (storageUsage: number, wasmBytes: number): bigint => demoNeedYocto(GUESTBOOK, storageUsage, wasmBytes);

/** Runs deploy-guestbook with argv (without node and script path). Returns the exit code. */
export const guestbookMain = (argv: readonly string[], deps: DemoDeps = defaultDemoDeps()): Promise<number> => demoMain(GUESTBOOK, argv, deps);
