// The files Worker's bindings (docs/batch-c-spec.md "Bindings": no secret, D1 or Hyperdrive), written by
// scripts/gen-wrangler.ts from the manifest's `files` block.

export interface Env {
  /** Manifest `files.origin`: the only origin this Worker answers on. */
  FILES_ORIGIN: string;
  /** The logo bucket (`files.logosBucket`). Read only by code: `get`, nothing else (a source test). */
  LOGOS: R2Bucket;
}
