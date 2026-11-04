// console-code-flow-spike.ts <env> [--leg openid|login]
//
// Open question 1 of docs/batch-c-spec.md on real Google (batch C9, D295): runs the console client's authorization-code
// flow for `scope=openid` (the step-up and owner-action token) and `scope=openid email` (sign-in), and reports which
// claims each ID token carries, by name only. See lib/console-code-flow.ts and docs/operations.md "Console code-flow
// spike (open question 1)". Needs `.secrets/<env>/console-google-client.json` (the client's JSON from Google, 0600).
import { createInterface } from 'node:readline';
import { loadEnv } from '@hana-id/env';
import { CliError, parseCli, run } from './lib/cli.ts';
import { type LegReport, type SpikeScope, codeFrom, exchange, loadConsoleClient, newLeg, reportLeg } from './lib/console-code-flow.ts';

const USAGE = `usage: console-code-flow-spike <env> [--leg openid|login]

Runs Google's code flow with the console's own client and prints, for each leg, the ID token's claim names and
whether it passes (never a token, an address, a sub or a code).`;

/** Reads one line without echoing it (the callback address carries a live code). */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput?: (s: string) => void };
    process.stdout.write(prompt);
    out._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

run(async () => {
  const args = parseCli(process.argv.slice(2), { strings: ['leg'] });
  const envName = args.positionals[0];
  if (!envName) throw new CliError('an env is required');
  const legArg = args.str('leg');
  if (legArg !== undefined && legArg !== 'openid' && legArg !== 'login') throw new CliError('--leg is openid or login');
  const scopes: SpikeScope[] = legArg === 'openid' ? ['openid'] : legArg === 'login' ? ['openid email'] : ['openid', 'openid email'];
  const client = loadConsoleClient(loadEnv(envName));
  const reports: LegReport[] = [];
  for (const scope of scopes) {
    const leg = newLeg(client, scope);
    console.log(`\nLeg scope=${scope}: open this URL in a browser, choose the Google account and sign in:\n\n${leg.url}\n`);
    console.log(`Google then sends the browser to ${client.authOrigin}/callback. That page may fail to load or say "Sign-in didn't work": expected.`);
    const pasted = await readHidden('Paste the whole address from the browser (not shown), then Enter: ');
    const code = codeFrom(pasted, leg, client);
    const tokens = await exchange(code, leg, client);
    reports.push(await reportLeg(tokens, leg, client));
  }
  console.log(`\n${JSON.stringify({ env: envName, at: new Date().toISOString(), legs: reports }, null, 2)}`);
  if (reports.some((r) => !r.passes)) process.exitCode = 1;
}, USAGE);
