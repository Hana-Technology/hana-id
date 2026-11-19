// The hand-test browser on the local stack (D880; docs/operations.md "Trying sign-ins and NEAR actions by hand"): a
// headed Chromium with the suite's pretend Google and pretend NEAR relayer (src/hand-test.ts), opened on a start page
// that lists the local sites and the test Google accounts. The stack must be running
// (`corepack pnpm --filter @hana-id/e2e serve`, with the same HANA_E2E_PORT_BASE).
//
//   pnpm --filter @hana-id/e2e hand-browser [--tag <tag>]   open it; new accounts unless --tag names earlier ones;
//                                                          it runs until you close its window (or press Ctrl+C)
//   pnpm --filter @hana-id/e2e hand-browser expire <name>   the waiting link to <name>'s Google wallet takes effect now
//   pnpm --filter @hana-id/e2e hand-browser age <name> [days]   every sign-in added to <name>'s wallet started <days> ago
//                                                          (default 8: past the sign-in window's first 7 days, D875)
//   pnpm --filter @hana-id/e2e hand-browser code <name or address>   the latest code mailed there
//
// The start page's buttons do the same as the last three. <name> is one of the start page's accounts (ada, ben, cleo,
// dev, eve, finn) of the browser opened last on this port base. `--headless` is for checks only (nothing to see).
import './port-env.ts';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { stackFingerprint } from './fingerprint.ts';
import { AGED_LINK_DAYS, type HandAccount, HAND_START_URL, ageLinks, expireLinks, handAccounts, isHandTag, latestCode, openHandSession, restartCommand, stackHealth } from './hand-test.ts';
import { API_URL, portBase } from './stack.ts';

const BUILD = new URL('../.build/', import.meta.url);
/** The tag of the browser opened last on this port base (made-up accounts only: no key, no token). */
const SESSION = new URL(`hand-browser-${portBase()}.json`, BUILD);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function usage(): never {
  fail('usage: hand-browser [--tag <tag>] [--headless] | expire <name> | age <name> [days] | code <name or address>');
}

async function requireStack(): Promise<{ fingerprint: string | null }> {
  const h = await stackHealth();
  if (!h.ok) fail(`The local stack isn't answering on ${API_URL}. Start it first: corepack pnpm --filter @hana-id/e2e serve (with HANA_E2E_PORT_BASE=${portBase()} if you chose that base).`);
  return h;
}

function lastAccounts(): HandAccount[] {
  let tag: unknown;
  try {
    tag = (JSON.parse(readFileSync(SESSION, 'utf8')) as { tag?: unknown }).tag;
  } catch {
    fail(`No hand browser has been opened on port base ${portBase()} yet. Open it first: corepack pnpm --filter @hana-id/e2e hand-browser`);
  }
  if (typeof tag !== 'string' || !isHandTag(tag)) fail(`${SESSION.pathname} is unreadable: open the hand browser again.`);
  return handAccounts(tag);
}

function account(name: string | undefined): HandAccount {
  const accounts = lastAccounts();
  const a = accounts.find((x) => x.id === name?.toLowerCase());
  if (!a) fail(`Name one of: ${accounts.map((x) => x.id).join(', ')}.`);
  return a;
}

async function open(args: string[]): Promise<void> {
  const tagAt = args.indexOf('--tag');
  const tag = tagAt >= 0 ? args[tagAt + 1] : undefined;
  if (tagAt >= 0 && (!tag || !isHandTag(tag))) fail('--tag takes the tag the start page showed (lowercase letters or digits).');
  const headless = args.includes('--headless');
  const known = new Set(['--tag', '--headless', ...(tag ? [tag] : [])]);
  if (args.some((a) => !known.has(a))) usage();
  const h = await requireStack();
  if (h.fingerprint !== stackFingerprint()) {
    console.warn('[hand-browser] Note: the running stack was started from other code (another checkout, or before an edit). It still works if its pages match; if something looks wrong, restart the stack.');
  }
  // Ctrl+C and SIGTERM are this script's (below): it closes the browser itself and says so.
  const browser = await chromium.launch({ headless, handleSIGINT: false, handleSIGTERM: false });
  const session = await openHandSession(browser, { tag });
  mkdirSync(BUILD, { recursive: true });
  writeFileSync(SESSION, `${JSON.stringify({ tag: session.tag, portBase: portBase(), openedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  chmodSync(SESSION, 0o600);
  console.log(`[hand-browser] Open on ${HAND_START_URL} with accounts of tag ${session.tag}:`);
  for (const a of session.accounts) console.log(`  ${a.name.padEnd(5)} ${a.email}`);
  console.log(`[hand-browser] To use these accounts again later: ${restartCommand(session.tag)}`);
  console.log('[hand-browser] Close the browser window (or press Ctrl+C here) to end.');
  const stop = new Promise<'stopped'>((resolve) => {
    process.once('SIGINT', () => resolve('stopped'));
    process.once('SIGTERM', () => resolve('stopped'));
  });
  const why = await Promise.race([session.closed, stop]);
  await browser.close().catch(() => undefined);
  console.log(`[hand-browser] Ended (${why === 'stopped' ? 'stopped from the terminal' : 'the browser was closed'}).`);
}

const [what, ...rest] = process.argv.slice(2);
if (what === undefined || what.startsWith('--')) {
  await open(process.argv.slice(2));
  process.exit(0);
} else if (what === 'expire') {
  const a = account(rest[0]);
  await requireStack();
  const moved = await expireLinks(a.sub);
  console.log(moved ? `Done: ${a.name}'s waiting link works now.` : `Nothing changed: no link is waiting to join ${a.name}'s wallet.`);
} else if (what === 'age') {
  const a = account(rest[0]);
  const days = rest[1] === undefined ? AGED_LINK_DAYS : Number(rest[1]);
  if (!Number.isFinite(days) || days < 0 || days > 3650) fail('days is a number from 0 to 3650.');
  await requireStack();
  const moved = await ageLinks(a.sub, days);
  console.log(moved ? `Done: the sign-in added to ${a.name}'s wallet now opens it since ${days} days ago.` : `Nothing changed: no sign-in is added to ${a.name}'s wallet.`);
} else if (what === 'code') {
  const target = rest[0] ?? usage();
  const address = target.includes('@') ? target : account(target).email;
  await requireStack();
  const c = await latestCode(address);
  console.log(c ? `Latest code for ${address}: ${c.code} ("${c.subject}", sent ${new Date(c.atMs).toLocaleTimeString('en-GB')})` : `No code has been sent to ${address} yet.`);
} else {
  usage();
}
