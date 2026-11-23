// The staff admin portal's hand test on the local stack (D873; docs/operations.md "Trying the staff admin portal by
// hand"): puts the hand-test lane's relayer (src/server/admin-lane-worker.ts) in a state, so a person can see each page
// and use each tool in the browser. The stack must be running (`pnpm --filter @hana-id/e2e serve`).
//
//   pnpm --filter @hana-id/e2e staff-demo <state>      ready | working | low-money | waiting | past-deadline |
//                                                      out-of-money | money-arrives | refill |
//                                                      out-of-money-again | key-used-elsewhere |
//                                                      foreign-transactions | gap
//   pnpm --filter @hana-id/e2e staff-demo run          time passes for the relayer (it checks the network once)
//   pnpm --filter @hana-id/e2e staff-demo state        what the relayer holds now
//
// Partner labels (D894, src/server/lane-labels.ts): a partner's request labels in the staff feed, each state from a
// new partner org (the last one's labels removed by its owner):
//
//   pnpm --filter @hana-id/e2e staff-demo labels-waiting   proposed and announced: goes live in 24 h (Block it)
//   pnpm --filter @hana-id/e2e staff-demo labels-review    review required for the org, its 24 h passed: waiting for Allow
//   pnpm --filter @hana-id/e2e staff-demo labels-live      in force: users see it (Block takes it off at once)
//   pnpm --filter @hana-id/e2e staff-demo labels-update    one in force and a new version announced (the diff)
//   pnpm --filter @hana-id/e2e staff-demo labels-off       one in force, every partner label switched off
//   pnpm --filter @hana-id/e2e staff-demo labels-later     24 hours pass (the lane's clock), then the hourly job runs
//   pnpm --filter @hana-id/e2e staff-demo labels-state     the partner's label versions now
//
// Only the local stack's hand-test lane: its controls (`/__e2e/lane/*`) exist nowhere else.
import './port-env.ts';
import { ADMIN_LANES } from './stack.ts';

const SCENARIOS = ['ready', 'working', 'low-money', 'waiting', 'past-deadline', 'out-of-money', 'money-arrives', 'refill', 'out-of-money-again', 'key-used-elsewhere', 'foreign-transactions', 'gap'];
/** src/server/lane-labels.ts LABEL_SCENARIOS (not imported: that module runs in the lane's thread). */
const LABEL_SCENARIOS = ['labels-waiting', 'labels-review', 'labels-live', 'labels-update', 'labels-off'];
const LABEL_TOOLS = ['labels-later', 'labels-state'];
const lane = ADMIN_LANES.demo;
const [what] = process.argv.slice(2);
const SIGN_IN = `${lane}/__e2e/access/sign-in?as=staff`;
const HOUR = 3_600_000;

interface State {
  nextSlot: number | null;
  halted: null | { reason: string; nonce?: number; code?: string };
  waiting: number;
  chain: { latest: number; pending: number; balanceWei: string };
  clockOffsetMs: number;
}

interface LabelsState {
  orgId: string;
  scopeId: string;
  appId: string;
  appName: string;
  versions: { changeId: string; state: string; activeFrom: number | null; served: boolean; off: string | null; blockNote: string | null }[];
  controls: { all: { labelsOff: boolean; reviewRequired: boolean }; org: { labelsOff: boolean; reviewRequired: boolean } };
  nowMs: number;
  clockOffsetMs: number;
}

function usage(): never {
  console.error(`usage: staff-demo <${[...SCENARIOS, 'run', 'state', ...LABEL_SCENARIOS, ...LABEL_TOOLS].join(' | ')}>`);
  process.exit(2);
}

async function call<T = State>(path: string, body?: Record<string, unknown>): Promise<T> {
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
  return JSON.parse(text) as T;
}

const hours = (ms: number): string => `${Math.round(ms / HOUR)} h`;

/** One version in plain words. */
function versionLine(v: LabelsState['versions'][number], now: number): string {
  switch (v.state) {
    case 'proposed':
      return 'proposed · its notice isn’t sent yet';
    case 'announced':
      return `announced · goes live in ${hours((v.activeFrom ?? now) - now)} unless someone blocks it`;
    case 'waiting_review':
      return 'its 24 hours passed · waiting for a staff member to Allow (or Block) it';
    case 'in_force':
      return v.served ? 'in force · the app’s users see it' : `in force · switched off (${v.off === 'all' ? 'every partner label' : v.off === 'org' ? 'the organisation' : 'this entry'})`;
    case 'blocked':
      return `blocked${v.blockNote ? ` · “${v.blockNote}”` : ''}`;
    default:
      return v.state.replace('_', ' ');
  }
}

/** The partner's versions, the switches and what to open. */
function printLabels(s: LabelsState, scenario: string | null): void {
  console.log(`Partner labels of ${s.appName} (${s.appId}), organisation ${s.orgId}, scope ${s.scopeId}:`);
  if (s.versions.length === 0) console.log('  nothing proposed yet');
  for (const v of s.versions) console.log(`  ${v.changeId}  ${versionLine(v, s.nowMs)}`);
  const on: string[] = [];
  if (s.controls.all.labelsOff) on.push('every partner label is switched off');
  if (s.controls.all.reviewRequired) on.push('review is required for every organisation');
  if (s.controls.org.labelsOff) on.push('this organisation’s labels are switched off');
  if (s.controls.org.reviewRequired) on.push('review is required for this organisation');
  if (on.length) console.log(`Switches: ${on.join('; ')}.`);
  if (s.clockOffsetMs) console.log(`The lane's clock is ${hours(s.clockOffsetMs)} ahead of real time.`);
  const newest = s.versions.at(-1);
  if (scenario === 'labels-off') console.log(`Open ${lane}/status (the partner labels switch) and ${lane}/labels (sign in first: ${SIGN_IN})`);
  else if (newest) console.log(`Open ${lane}/labels/${newest.changeId} (the whole feed: ${lane}/labels; sign in first: ${SIGN_IN})`);
  else console.log(`Open ${lane}/labels (sign in first: ${SIGN_IN})`);
}

if (!what) usage();
if (LABEL_SCENARIOS.includes(what)) {
  printLabels((await call<{ state: LabelsState }>('labels', { action: 'scenario', name: what })).state, what);
} else if (what === 'labels-state') {
  printLabels((await call<{ state: LabelsState }>('labels', { action: 'state' })).state, null);
} else if (what === 'labels-later') {
  await call('clock', { advanceMs: 24 * HOUR });
  const r = await call<{ run: { activated: number; lapsed: number }; state: LabelsState }>('labels', { action: 'cron' });
  console.log(`24 hours passed. The hourly job recorded ${r.run.activated} version(s) going live and ${r.run.lapsed} lapsing.`);
  printLabels(r.state, null);
} else {
  const s = what === 'state' ? await call('state') : what === 'run' ? await call('run', { times: 1 }) : SCENARIOS.includes(what) ? await call('scenario', { name: what }) : usage();
  const eth = (wei: string) => `${Number(BigInt(wei) / 10n ** 14n) / 10_000} test ETH`;
  console.log(s.halted ? `Paused: ${s.halted.reason}${s.halted.code ? ` (${s.halted.code})` : ''}${s.halted.nonce !== undefined ? `, slot ${s.halted.nonce}` : ''}` : 'Not paused');
  console.log(`Waiting transactions: ${s.waiting} · next slot: ${s.nextSlot ?? 'none yet'} · the network counts ${s.chain.latest} (${s.chain.pending} with the waiting ones) · wallet: ${eth(s.chain.balanceWei)}`);
  if (s.clockOffsetMs) console.log(`The lane's clock is ${Math.round(s.clockOffsetMs / 1000)} s ahead of real time.`);
  console.log(`Open ${lane}/gas-sponsorship/31337 (sign in first: ${lane}/__e2e/access/sign-in?as=staff)`);
}
