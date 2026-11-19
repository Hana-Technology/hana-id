// The staff admin portal's hand test on the local stack (D873; docs/operations.md "Trying the staff admin portal by
// hand"): puts the hand-test lane's relayer (src/server/admin-lane-worker.ts) in a state, so a person can see each page
// and use each tool in the browser. The stack must be running (`pnpm --filter @hana-id/e2e serve`).
//
//   pnpm --filter @hana-id/e2e staff-demo <state>      ready | working | low-money | waiting | past-deadline |
//                                                      out-of-money | refill | key-used-elsewhere |
//                                                      foreign-transactions | gap
//   pnpm --filter @hana-id/e2e staff-demo run          time passes for the relayer (it checks the network once)
//   pnpm --filter @hana-id/e2e staff-demo state        what the relayer holds now
//
// Only the local stack's hand-test lane: its controls (`/__e2e/lane/*`) exist nowhere else.
import './port-env.ts';
import { ADMIN_LANES } from './stack.ts';

const SCENARIOS = ['ready', 'working', 'low-money', 'waiting', 'past-deadline', 'out-of-money', 'refill', 'key-used-elsewhere', 'foreign-transactions', 'gap'];
const lane = ADMIN_LANES.demo;
const [what] = process.argv.slice(2);

interface State {
  nextSlot: number | null;
  halted: null | { reason: string; nonce?: number; code?: string };
  waiting: number;
  chain: { latest: number; pending: number; balanceWei: string };
  clockOffsetMs: number;
}

function usage(): never {
  console.error(`usage: staff-demo <${SCENARIOS.join(' | ')} | run | state>`);
  process.exit(2);
}

async function call(path: string, body?: Record<string, unknown>): Promise<State> {
  let res: Response;
  try {
    res = await fetch(`${lane}/__e2e/lane/${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  } catch {
    console.error(`The local stack isn't answering on ${lane}. Start it first: corepack pnpm --filter @hana-id/e2e serve`);
    process.exit(1);
  }
  const text = await res.text();
  if (res.status !== 200) {
    console.error(`The stack refused: ${text}`);
    process.exit(1);
  }
  return JSON.parse(text) as State;
}

if (!what) usage();
const s = what === 'state' ? await call('state') : what === 'run' ? await call('run', { times: 1 }) : SCENARIOS.includes(what) ? await call('scenario', { name: what }) : usage();
const eth = (wei: string) => `${Number(BigInt(wei) / 10n ** 14n) / 10_000} test ETH`;
console.log(s.halted ? `Paused: ${s.halted.reason}${s.halted.code ? ` (${s.halted.code})` : ''}${s.halted.nonce !== undefined ? `, slot ${s.halted.nonce}` : ''}` : 'Not paused');
console.log(`Waiting transactions: ${s.waiting} · next slot: ${s.nextSlot ?? 'none yet'} · the network counts ${s.chain.latest} (${s.chain.pending} with the waiting ones) · wallet: ${eth(s.chain.balanceWei)}`);
if (s.clockOffsetMs) console.log(`The lane's clock is ${Math.round(s.clockOffsetMs / 1000)} s ahead of real time.`);
console.log(`Open ${lane}/gas-sponsorship/31337 (sign in first: ${lane}/__e2e/access/sign-in?as=staff)`);
