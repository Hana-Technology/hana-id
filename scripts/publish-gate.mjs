#!/usr/bin/env node
// The `gate` job of .github/workflows/publish-sdk.yml (security sweep OPER-4, D451): whether this run may build and
// publish. It runs in no GitHub environment, so `secrets.NPM_TOKEN` here can only be a repository or organisation
// secret, which every branch's workflow could read: that fails the run. The token belongs to the `npm-publish`
// environment, whose deployment-branch policy (main only) GitHub enforces before the publish job gets it, however the
// workflow file was edited on a branch. This gate only catches a setup that lost that protection. Node's standard
// library only: the job runs it before any install.
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLISH_ENVIRONMENT = 'npm-publish';
const SETUP = 'docs/operations.md, Releasing the SDK packages';

/**
 * @param {{ repoToken?: string, ref?: string, environment: unknown, branchPolicies: unknown }} o
 *   `environment`: GET …/environments/npm-publish, null when absent or unreadable; `branchPolicies`: its
 *   deployment-branch-policies, null when absent or unreadable.
 * @returns {{ ready: boolean, error?: string, notice?: string }} `error` fails the run; a `notice` alone skips publishing.
 */
export function publishGate({ repoToken, ref, environment, branchPolicies }) {
  if (repoToken) return { ready: false, error: `NPM_TOKEN is a repository or organisation secret: delete it and set it on the ${PUBLISH_ENVIRONMENT} environment only (${SETUP}).` };
  if (ref !== 'refs/heads/main') return { ready: false, error: `Publish from main only (this run is on ${ref}).` };
  if (!environment) return { ready: false, notice: `The ${PUBLISH_ENVIRONMENT} environment is not set up: nothing is published (${SETUP}).` };
  const policy = /** @type {{ deployment_branch_policy?: { custom_branch_policies?: boolean } | null }} */ (environment).deployment_branch_policy;
  const branches = /** @type {{ branch_policies?: { name?: string, type?: string }[] } | null} */ (branchPolicies)?.branch_policies;
  const mainOnly = policy?.custom_branch_policies === true && branches?.length === 1 && branches[0]?.name === 'main' && (branches[0]?.type ?? 'branch') === 'branch';
  if (!mainOnly) return { ready: false, error: `The ${PUBLISH_ENVIRONMENT} environment must allow deployments from the branch main only (${SETUP}).` };
  return { ready: true };
}

const parsed = (raw) => {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const e = process.env;
  const out = publishGate({ repoToken: e.REPO_NPM_TOKEN, ref: e.GITHUB_REF, environment: parsed(e.ENVIRONMENT_JSON), branchPolicies: parsed(e.BRANCH_POLICIES_JSON) });
  if (e.GITHUB_OUTPUT) appendFileSync(e.GITHUB_OUTPUT, `ready=${out.ready}\n`);
  if (out.notice) console.log(`::notice::${out.notice}`);
  if (out.error) {
    console.log(`::error::${out.error}`);
    process.exitCode = 1;
  }
}
