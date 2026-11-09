// admin <env> watchdog:test-page [--yes] (D449, readiness 5.4): asks the deployed watchdog what a test critical page
// would do and, with --yes, has it send one. The Worker sends, with its own secrets and from its own network, because
// that is what a real page uses: sending from this machine would prove neither (the status token below is the only
// secret read here, and it goes only in the Authorization header of a call to the manifest's watchdog.url).
// Nothing printed comes from a secret: channel names, whether each is configured, a provider name, a recipient count.
import { join } from 'node:path';
import type { Manifest } from '@hana-id/env';
import { CliError } from './cli.ts';
import { readSecretJson, secretsDir } from './secrets.ts';

/** Above the Worker's own bound: three channels in parallel at 10 s each, plus D1. */
const REQUEST_TIMEOUT_MS = 30_000;

export interface TestPageDeps {
  fetch: typeof fetch;
  /** The env's WATCHDOG_STATUS_TOKEN, or undefined when the secrets file or the value is missing. */
  token: () => string | undefined;
  log: (line: string) => void;
}

export function statusTokenFromSecrets(envName: string, root?: string): string | undefined {
  return readSecretJson<{ WATCHDOG_STATUS_TOKEN?: string }>(join(secretsDir(envName, root), 'watchdog-secrets.json'))?.WATCHDOG_STATUS_TOKEN;
}

interface PlanChannel {
  channel: string;
  configured: boolean;
  provider?: string;
  recipients?: number;
}
interface Plan {
  env: string;
  network: string;
  title: string;
  text: string;
  channels: PlanChannel[];
  cooldown_ms: number;
  next_allowed_at: number | null;
}
interface SendResult {
  channel: string;
  provider?: string;
  ok: boolean;
  error?: string;
}

/** Printable ASCII only, bounded: an answer's strings can't move the cursor or fill the terminal. */
const clean = (v: unknown): string => String(v).replace(/[^\x20-\x7e]/gu, '?').slice(0, 200);

const channelName = (c: { channel: string; provider?: string }) => clean(c.provider ? `${c.channel} (${c.provider})` : c.channel).padEnd(16);

function planLines(m: Manifest, url: string, p: Plan, now: number): string[] {
  const channels = p.channels.map((c) => {
    if (!c.configured) return `  ${channelName(c)} NOT CONFIGURED (a send on it will fail)`;
    return `  ${channelName(c)} configured${c.recipients === undefined ? '' : `, ${c.recipients} recipient${c.recipients === 1 ? '' : 's'}`}`;
  });
  const wait = p.next_allowed_at === null ? 'allowed now' : `next allowed in ${Math.ceil((p.next_allowed_at - now) / 60_000)} min`;
  return [
    `Test page for ${m.name} (${clean(p.network)}), sent by the deployed watchdog at ${url}`,
    `Title: ${clean(p.title)}`,
    'Channels:',
    ...channels,
    'Message:',
    ...p.text.split('\n').map((l) => `  ${clean(l)}`),
    `One test page per ${Math.round(p.cooldown_ms / 60_000)} min (${wait}).`,
  ];
}

function isPlan(v: unknown): v is Plan {
  const p = v as Partial<Plan> | null;
  return !!p && typeof p.env === 'string' && typeof p.network === 'string' && typeof p.title === 'string' && typeof p.text === 'string' && Array.isArray(p.channels) && typeof p.cooldown_ms === 'number';
}

function isSent(v: unknown): v is { ok: boolean; results: SendResult[] } {
  const r = v as { ok?: unknown; results?: unknown } | null;
  return !!r && typeof r.ok === 'boolean' && Array.isArray(r.results);
}

/** Every failure as this command's own words: never the answer's body, the token or the request. */
function refusal(status: number, m: Manifest, send: boolean, body: unknown): Error {
  if (status === 404) return new Error(`The watchdog at ${m.watchdog!.url} has no /test-page route: it needs a redeploy from a branch with D449 (corepack pnpm --filter @hana-id/watchdog run deploy, on the watchdog's Cloudflare account).`);
  if (status === 401) return new Error(`The watchdog refused the token: .secrets/${m.name}/watchdog-secrets.json's WATCHDOG_STATUS_TOKEN isn't the deployed one.`);
  if (status === 503) return new Error('The deployed watchdog has no usable WATCHDOG_STATUS_TOKEN: set it on the Worker first.');
  if (status === 429 && send) {
    const ms = (body as { retry_after_ms?: unknown } | null)?.retry_after_ms;
    return new Error(`A test page went out less than ${typeof ms === 'number' ? `${Math.ceil(ms / 60_000)} min` : 'a few minutes'} ago; nothing was sent. Run it again after that.`);
  }
  return new Error(`The watchdog answered HTTP ${status}${send ? ': nothing is known to have been sent, check the phones before running it again' : ''}.`);
}

async function call(m: Manifest, token: string, send: boolean, deps: TestPageDeps): Promise<unknown> {
  let res: Response;
  try {
    // redirect: manual, so the bearer can't follow a redirect anywhere else; the answer is then not a 200 and refused.
    res = await deps.fetch(`${m.watchdog!.url}/test-page`, { method: send ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}` }, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new Error(`Could not reach the watchdog at ${m.watchdog!.url} (network error or timeout)${send ? ': the page may or may not have gone out, check the phones before running it again' : ''}.`);
  }
  const body = await res.json().catch(() => null);
  if (res.status !== 200) throw refusal(res.status, m, send, body);
  return body;
}

export async function watchdogTestPage(m: Manifest, send: boolean, deps: TestPageDeps): Promise<void> {
  const url = m.watchdog?.url;
  if (!url) throw new CliError(`envs/${m.name}.json has no watchdog.url: nothing to ask`);
  const token = deps.token();
  if (!token) throw new CliError(`No WATCHDOG_STATUS_TOKEN in .secrets/${m.name}/watchdog-secrets.json`);

  const plan = await call(m, token, false, deps);
  if (!isPlan(plan)) throw new Error('The watchdog answered something that is not a test page plan.');
  // A manifest's URL pointing at another env's Worker must not page that env's people.
  if (plan.env !== m.name) throw new Error(`The watchdog at ${url} is ${clean(plan.env)}, not ${m.name}: nothing sent. Check watchdog.url in envs/${m.name}.json.`);
  for (const line of planLines(m, url, plan, Date.now())) deps.log(line);
  if (!send) {
    deps.log('Dry run: nothing was sent. Add --yes to send it.');
    return;
  }

  const sent = await call(m, token, true, deps);
  if (!isSent(sent)) throw new Error('The watchdog answered something that is not a send report: check the phones before running it again.');
  deps.log('Sent. Each channel as its provider answered (accepted, not yet proof that anyone saw it):');
  for (const r of sent.results) deps.log(`  ${channelName(r)} ${r.ok ? 'ok' : `FAILED: ${clean(r.error ?? 'unknown')}`}`);
  deps.log('Nothing was opened: no alert to acknowledge, no re-sends. Pushover rings until acknowledged in the app (15 min at most); PagerDuty: resolve the incident there.');
  const failed = sent.results.filter((r) => !r.ok).length;
  if (!sent.ok || failed > 0) throw new Error(`${failed} of ${sent.results.length} channels failed: paging is not proven until every channel works (docs/operations.md "Test page").`);
  deps.log('Now confirm with both founders that it arrived on the phone, in Slack and in email: only that proves delivery (SendGrid and the paging app answer "accepted").');
}
