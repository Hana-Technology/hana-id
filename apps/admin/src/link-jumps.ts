// Which apps' link counts jumped today (spec "Links view": 5× the app's 7-day median, provisional): shared by the
// Account links page and the 15-minute alert (D448).
import { type LinkStatsRow, linkJump, linksMade } from '@hana-id/console-core';

/** One row per app with the links it made today and whether that jumped over its 7-day median. */
export function jumpsOf(rows: readonly LinkStatsRow[], today: string): { appId: string; appName: string; today: number; median: number; jumped: boolean }[] {
  const byApp = new Map<string, LinkStatsRow[]>();
  for (const r of rows) (byApp.get(r.appId) ?? byApp.set(r.appId, []).get(r.appId)!).push(r);
  const out: { appId: string; appName: string; today: number; median: number; jumped: boolean }[] = [];
  for (const [appId, list] of byApp) {
    const todayRow = list.find((x) => x.day === today);
    const count = todayRow ? linksMade(todayRow) : 0;
    const prior = list.filter((x) => x.day < today).sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 7).map(linksMade);
    const { median, jumped } = linkJump(count, prior);
    if (count > 0) out.push({ appId, appName: list[0]!.appName, today: count, median, jumped });
  }
  return out.sort((a, b) => Number(b.jumped) - Number(a.jumped) || b.today - a.today);
}

