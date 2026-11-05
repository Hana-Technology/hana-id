// d1-move.ts <env> --db api|issuer|watchdog|console --from-account <id> [--to-account <id>] [--step …] [--yes]
//
// Copies one of an env's D1 databases to a new, empty database of the same name on another Cloudflare account
// (export, import, row-count check; D404). Never prints a token or a row. See lib/d1-move.ts.
import { run } from './lib/cli.ts';
import { D1_MOVE_USAGE, d1Move, defaultD1MoveDeps } from './lib/d1-move.ts';

run(async () => d1Move(process.argv.slice(2), defaultD1MoveDeps()), D1_MOVE_USAGE);
