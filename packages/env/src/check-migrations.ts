// D931 (after PR 159's review, L2): the pre-deploy migration check's command (./require-migrations.ts). Run from an
// app's directory before the shared deploy wrapper; exits 1, deploying nothing, when the remote database lacks a
// migration the code needs or when it can't tell.
import { requireMigrations } from './require-migrations.ts';

const problem = requireMigrations(process.argv.slice(2));
if (problem) {
  console.log(`Deploy ${problem}`);
  process.exitCode = 1;
} else {
  console.log('Every migration this code needs is applied.');
}
