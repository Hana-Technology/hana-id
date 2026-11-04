// Requests the contract refused for a state of the user's sign-in methods (batch 6 review M1): a pending member
// (`link_pending`) or a session whose path identity joined an account (`identity_linked`). The same request relayed
// again within PANIC_CACHE_MS would only panic again at the relayer's cost, so this isolate answers it from here. Keyed
// by sha256 of the method and its exact arguments (never logged); a changed request is a new key.
import { hex, sha256 } from './bytes.ts';
import { TtlCache } from './views.ts';

export const PANIC_CACHE_MS = 60_000;
/** The panics remembered: deterministic for the same arguments until the link state changes. */
export const CACHED_PANIC_CODES: ReadonlySet<string> = new Set(['link_pending', 'identity_linked']);

const cache = new TtlCache<{ status: number; code: string; error: string }>(PANIC_CACHE_MS, 2000);

export async function requestKey(method: string, args: Record<string, unknown>): Promise<string> {
  return hex(await sha256(new TextEncoder().encode(`${method}\n${JSON.stringify(args)}`)));
}

/** The refusal remembered for this request, if any. */
export const recalledPanic = (key: string): { status: number; code: string; error: string } | undefined => cache.get(key);

/** Remembers a refusal whose code is one of CACHED_PANIC_CODES. */
export function rememberPanic(key: string, answer: { status: number; code: string; error: string }): void {
  if (CACHED_PANIC_CODES.has(answer.code)) cache.set(key, answer);
}

/** Tests only. */
export function clearPanicCache(): void {
  cache.clear();
}
