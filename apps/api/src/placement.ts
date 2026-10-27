// Where the shared Durable Objects live. Every login goes through a relayer key object and its app's limiter, so
// they are pinned to one region (DO_LOCATION_HINT) instead of wherever their first request happened to arrive. A hint
// only applies when an object is created, so the region is part of the object's name: changing it creates new
// objects there (a relayer key object re-reads its nonce from chain on first use). Per-IP limiters are not pinned:
// Cloudflare creates each near its client, which is already the best place.
import type { Env } from './env.ts';

const HINTS: ReadonlySet<string> = new Set(['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me']);

/** The configured location hint, or undefined when unset or not a known hint (then Cloudflare places objects). */
export function doLocation(env: Pick<Env, 'DO_LOCATION_HINT'>): DurableObjectLocationHint | undefined {
  const hint = env.DO_LOCATION_HINT;
  return hint && HINTS.has(hint) ? (hint as DurableObjectLocationHint) : undefined;
}

/** Object name for `base` in `location` (unchanged without a location, so existing objects keep their names). */
export const placedName = (base: string, location: DurableObjectLocationHint | undefined): string => (location ? `${base}@${location}` : base);

/** Stub for the shared object `base`, created in the configured region. */
export function placedStub<T extends Rpc.DurableObjectBranded | undefined>(env: Pick<Env, 'DO_LOCATION_HINT'>, ns: DurableObjectNamespace<T>, base: string): DurableObjectStub<T> {
  const location = doLocation(env);
  const id = ns.idFromName(placedName(base, location));
  return location ? ns.get(id, { locationHint: location }) : ns.get(id);
}
