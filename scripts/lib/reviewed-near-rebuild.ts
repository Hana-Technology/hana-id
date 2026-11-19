// reviewed-near-rebuild (D885): rebuilds each of Journear's reviewed NEAR contracts from this checkout with the deploy
// tool's own command (`cargo near build non-reproducible-wasm --no-abi`, lib/demo-deploy.ts) and compares the wasm's
// NEAR code hash (base58 of its sha256) with every deployed copy core records (REVIEWED_NEAR_DEPLOYS[env][contract]
// .codeHash). It carries what the source pin (core's REVIEWED_NEAR_CONTRACTS[*].files: lib.rs, Cargo.toml,
// Cargo.lock, rust-toolchain.toml) can't hold: cargo-near's version and the host. Observed 2026-11-19 on two machines
// (the reviewer's, and an Apple-silicon Mac), Rust 1.85.1 and cargo-near 0.22.0: both hashes reproduce exactly; a build
// without `--no-abi` gives others. Other hosts are unverified.
//
// It builds into its own target directory (`target/reviewed-rebuild`), so the contract lane's wasm isn't touched, with
// the cargo and rustup variables of the calling process removed (as contracts/integration-tests does) so the crate's
// rust-toolchain.toml applies. Skips, saying why and exiting 0, when cargo-near or the toolchain isn't installed or
// cargo-near isn't the recorded version: a mismatch from another tool version would say nothing about the code. Run by
// `pnpm verify --full`.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { repoRoot } from '@hana-id/env';
import { REVIEWED_NEAR_BUILD, REVIEWED_NEAR_CONTRACTS, REVIEWED_NEAR_DEPLOYS, type ReviewedNearContract } from '@hana-id/core';
import { codeHashOf } from './near.ts';

export interface RunResult {
  status: number | null;
  stdout: string;
}
export type Runner = (cmd: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => RunResult;

/** The calling process's environment without cargo's and rustup's own variables (CARGO_HOME and RUSTUP_HOME kept). */
export function cleanCargoEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    const keep = k === 'CARGO_HOME' || k === 'RUSTUP_HOME';
    if (keep || !(k.startsWith('CARGO') || k.startsWith('RUSTUP_') || k.startsWith('RUSTC') || k.startsWith('RUSTFLAGS') || k === 'RUSTDOC')) out[k] = v;
  }
  out.PATH = `${join(homedir(), '.cargo', 'bin')}:${env.PATH ?? ''}`;
  return out;
}

const defaultRun: Runner = (cmd, args, cwd, env) => {
  const r = spawnSync(cmd, [...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  return { status: r.status, stdout: r.stdout ?? '' };
};

/** Every recorded code hash of `contract`, with the env it is deployed on. */
export const recordedHashes = (contract: ReviewedNearContract): { env: string; codeHash: string }[] =>
  Object.entries(REVIEWED_NEAR_DEPLOYS).flatMap(([env, r]) => (r[contract] ? [{ env, codeHash: r[contract].codeHash }] : []));

export interface RebuildDeps {
  run?: Runner;
  log?: (line: string) => void;
  root?: string;
  readWasm?: (path: string) => Uint8Array | null;
  /** NEAR's code hash of a wasm (default codeHashOf). */
  codeHash?: (wasm: Uint8Array) => string;
}

/** 0: every rebuilt hash is the recorded one, or the rebuild was skipped (said why); 1: a mismatch or a failed build. */
export function reviewedNearRebuild(deps: RebuildDeps = {}): number {
  const run = deps.run ?? defaultRun;
  const log = deps.log ?? ((l: string) => console.log(l));
  const root = deps.root ?? repoRoot;
  const readWasm = deps.readWasm ?? ((p: string) => (existsSync(p) ? new Uint8Array(readFileSync(p)) : null));
  const env = cleanCargoEnv();
  const version = run('cargo', ['near', '--version'], root, env);
  const found = /(\d+\.\d+\.\d+)/u.exec(version.stdout)?.[1];
  if (version.status !== 0 || found === undefined) {
    log(`SKIP reviewed NEAR rebuild: cargo-near is not installed (want ${REVIEWED_NEAR_BUILD.cargoNear}: \`cargo install cargo-near --version ${REVIEWED_NEAR_BUILD.cargoNear} --locked\`)`);
    return 0;
  }
  if (found !== REVIEWED_NEAR_BUILD.cargoNear) {
    log(`SKIP reviewed NEAR rebuild: cargo-near ${found} is installed, the records were built with ${REVIEWED_NEAR_BUILD.cargoNear}; another version may build other bytes`);
    return 0;
  }
  let failed = 0;
  for (const [contract, info] of Object.entries(REVIEWED_NEAR_CONTRACTS) as [ReviewedNearContract, (typeof REVIEWED_NEAR_CONTRACTS)[ReviewedNearContract]][]) {
    const dir = join(root, info.crate);
    const rustc = run('rustc', ['--version'], dir, env);
    if (rustc.status !== 0 || !rustc.stdout.includes(` ${REVIEWED_NEAR_BUILD.rust} `)) {
      log(`SKIP reviewed NEAR rebuild of ${contract}: Rust ${REVIEWED_NEAR_BUILD.rust} is not installed (\`rustup toolchain install ${REVIEWED_NEAR_BUILD.rust} --target wasm32-unknown-unknown\`)`);
      continue;
    }
    const target = join(dir, 'target', 'reviewed-rebuild');
    const [cmd, ...args] = REVIEWED_NEAR_BUILD.command.split(' ') as [string, ...string[]];
    log(`  ${contract}: ${REVIEWED_NEAR_BUILD.command} (in ${info.crate}, Rust ${REVIEWED_NEAR_BUILD.rust}, cargo-near ${found})`);
    const built = run(cmd, args, dir, { ...env, CARGO_TARGET_DIR: target });
    const wasm = built.status === 0 ? readWasm(join(target, 'near', `${basename(info.crate).replace(/-/gu, '_')}.wasm`)) : null;
    if (wasm === null) {
      log(`FAIL ${contract}: the build failed (exit ${String(built.status)})`);
      failed++;
      continue;
    }
    const hash = (deps.codeHash ?? codeHashOf)(wasm);
    log(`  ${contract}: code hash ${hash} (sha256 ${createHash('sha256').update(wasm).digest('hex')})`);
    for (const r of recordedHashes(contract)) {
      if (r.codeHash === hash) log(`  ${contract}: matches ${r.env}'s recorded deploy`);
      else {
        log(`FAIL ${contract}: ${r.env}'s recorded deploy is ${r.codeHash}, this checkout builds ${hash}`);
        failed++;
      }
    }
  }
  log(failed === 0 ? 'OK: reviewed NEAR rebuild' : `FAILED: ${failed} reviewed NEAR rebuild problem${failed === 1 ? '' : 's'}`);
  return failed === 0 ? 0 : 1;
}
