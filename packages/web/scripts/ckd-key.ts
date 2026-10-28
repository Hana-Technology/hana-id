// TODO(batch B, @hana-id/core): replace this stub with `ckdKeyProblem` and `isValidNetworkKey` from @hana-id/core
// (moved there from apps/smoke/src/config.ts and ckd.ts), which also check that the key decodes to a valid G2 point.
// Until then the build refuses only the UNSET placeholder and a key that isn't `bls12381g2:<base58>`.

/** Why the env's pinned CKD key can't be built into the pages, or null. */
export function ckdKeyProblem(env: { name: string; ckdNetworkKey: string }): string | null {
  if (env.ckdNetworkKey.includes('UNSET')) {
    return `envs/${env.name}.json ckdNetworkKey is still the UNSET placeholder. Pin it with \`pnpm --filter @hana-id/scripts fetch-ckd-key ${env.name}\`.`;
  }
  if (!/^bls12381g2:[1-9A-HJ-NP-Za-km-z]+$/u.test(env.ckdNetworkKey)) return `envs/${env.name}.json ckdNetworkKey is not a bls12381g2:<base58> key.`;
  return null;
}
