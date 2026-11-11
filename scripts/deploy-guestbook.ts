// deploy-guestbook.ts <env> [--yes] [--lock] [--wasm path] [--skip-build]
//
// Deploys the hackathon demo contract contracts/hana-guestbook to the env's near.demoGuestbook account (D743): the
// code and new() in one transaction. Prints the plan first and changes nothing without --yes; re-running plans only
// what is missing. The account must exist and be funded; its full-access key is read from the near CLI legacy
// keychain (~/.near-credentials/testnet/<account>.json). --lock deletes every access key on the account afterwards.
// The logic lives in lib/guestbook-deploy.ts (run against a stub chain in test/guestbook-deploy.test.ts).
import { run } from './lib/cli.ts';
import { GUESTBOOK_USAGE, guestbookMain } from './lib/guestbook-deploy.ts';

run(async () => {
  const code = await guestbookMain(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
}, GUESTBOOK_USAGE);
