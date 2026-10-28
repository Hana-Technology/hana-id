// Per-day auto-approve counters (docs/batch-b-spec.md "Consent": `day, count, valueWeiByChain`). The vault keeps them
// inside the encrypted record and shares them across tabs; these pure helpers do the UTC-day rollover and the update
// after an auto-signed request, so the matcher and the vault agree on what "today" has used.

export interface AutoApproveUsage {
  /** UTC day number: floor(ms / 86 400 000). */
  readonly day: number;
  /** Auto-signed requests today. */
  readonly count: number;
  /**
   * Native spend auto-signed today per EVM chain ID (decimal keys), wei, decimal: each transaction's value plus its
   * maximum fee (match.ts `spend`), so fees count against maxValueWeiPerDay.
   */
  readonly valueWeiByChain: Readonly<Record<string, string>>;
}

const DAY_MS = 86_400_000;

export const utcDay = (nowMs: number): number => Math.floor(nowMs / DAY_MS);

/** Today's usage: `usage` if it is from today, otherwise zero. */
export function usageToday(usage: AutoApproveUsage | null | undefined, nowMs: number): AutoApproveUsage {
  const day = utcDay(nowMs);
  if (usage && usage.day === day) return usage;
  return Object.freeze({ day, count: 0, valueWeiByChain: Object.freeze({}) });
}

/** Usage after one more auto-signed request (with native spend `valueWei`, value + maximum fee, on EVM chain `chainId`). */
export function recordAutoApproveUse(
  usage: AutoApproveUsage | null | undefined,
  nowMs: number,
  spend?: { readonly chainId: number; readonly valueWei: bigint },
): AutoApproveUsage {
  const today = usageToday(usage, nowMs);
  const valueWeiByChain: Record<string, string> = { ...today.valueWeiByChain };
  if (spend) {
    const key = String(spend.chainId);
    valueWeiByChain[key] = (BigInt(valueWeiByChain[key] ?? '0') + spend.valueWei).toString();
  }
  return Object.freeze({ day: today.day, count: today.count + 1, valueWeiByChain: Object.freeze(valueWeiByChain) });
}
