// admin.ts argument checks, and argument → contract-argument conversion for scope:register.
import { CliError } from './cli.ts';
import { GOOGLE_PROVIDER, type Owner } from './contract.ts';

/** Owners from --owner-near / --owner-google (Owner JSON per the contract's serde form). */
export function ownersFromArgs(near: string[], google: string[]): Owner[] {
  const owners: Owner[] = [
    ...near.map((account_id) => {
      if (!/^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/u.test(account_id)) throw new CliError(`Invalid NEAR account: ${account_id}`);
      return { Near: { account_id } };
    }),
    ...google.map((sub) => {
      // A Google `sub` is digits (up to 255): nothing else reaches the contract as a Google owner from here.
      if (!/^[0-9]{1,255}$/u.test(sub)) throw new CliError(`Invalid Google sub (digits only): ${sub}`);
      return { Oidc: { provider: GOOGLE_PROVIDER, sub } };
    }),
  ];
  if (owners.length < 1 || owners.length > 5) throw new CliError('A scope needs 1..5 owners (--owner-near / --owner-google)');
  return owners;
}

/**
 * Clients from --client. A scope needs at least one client unless it allows shared login (`--allow-shared`), and a
 * client ID can't be one of Hana's shared clients (the contract rejects it: use --allow-shared instead).
 */
export function clientsFromArgs(clients: string[], { allowShared = false, sharedClientIds = [] }: { allowShared?: boolean; sharedClientIds?: readonly string[] } = {}): [string, string][] {
  if (!clients.length && !allowShared) throw new CliError('At least one --client is required (or --allow-shared for a scope that logs in only through Hana\'s shared client)');
  for (const c of clients) if (!c || c.length > 255 || /\s/u.test(c)) throw new CliError(`Invalid client id: ${c}`);
  if (new Set(clients).size !== clients.length) throw new CliError('Duplicate --client');
  if (clients.length > 10) throw new CliError('A scope can have at most 10 clients');
  for (const c of clients) {
    if (sharedClientIds.includes(c)) throw new CliError(`${c} is Hana's shared Google client; don't register it as a client, pass --allow-shared instead`);
  }
  return clients.map((aud) => [GOOGLE_PROVIDER, aud]);
}

/** Commands that take exactly one positional after `<env> <command>`, and what it is. */
const ONE_POSITIONAL: Record<string, string> = { 'owner:call': '<method>', 'issuer:iss': '<provider>', 'console:remove-audience': '<aud>', 'owner:vote': '<proposal id>', 'app:changes:announce': '<change id>', 'support:lookup': '<HANA-XXXX-XXXX | u1_… | hu_… | ->' };

/**
 * Positionals after `<env> <command>`: app:settings takes its app (checked by settingsAppArg in admin-settings.ts),
 * owner:call its method and owner:vote a proposal id (exactly one each); any other command refuses them.
 */
export function assertCommandPositionals(command: string, rest: readonly string[]): void {
  const one = ONE_POSITIONAL[command];
  if (one) {
    if (rest.length !== 1) throw new CliError(`${command} takes exactly one ${one}`);
    return;
  }
  if (command !== 'app:settings' && rest.length > 0) throw new CliError(`Unexpected argument ${rest.join(' ')}`);
}
