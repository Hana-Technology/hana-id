// Starts the vault in the browser (docs/batch-b-spec.md "Partner ↔ vault handshake" step 2): it does nothing when the
// page is top-level (`window.parent === window`) or when the inlined config is missing or malformed (a 403/503 vault
// page has none), so the SDK's handshake times out and raises `vault_unavailable`.
import type { HanaEnv } from '../hana-env.ts';
import { readInlinedConfig } from './config.ts';
import { domLauncherView } from './launcher.ts';
import { openRecordStore } from './record.ts';
import { type WindowRef, browserChannel, browserLocks } from './runtime.ts';
import { Vault, type VaultHost } from './vault.ts';

/** `scriptStart`: performance.now() when the bundle started (entry.ts), for the pk_test_ unlock timings. */
export function bootVault(win: Window, env: HanaEnv, scriptStart?: number): Vault | null {
  if (win.parent === win || win.parent === null) return null;
  const config = readInlinedConfig(win.document);
  if (!config) return null;
  const host: VaultHost = {
    parent: win.parent,
    ancestorOrigin: () => {
      const list = win.location.ancestorOrigins;
      return list && list.length > 0 ? (list.item(0) ?? undefined) : undefined;
    },
    onMessage: (listener) =>
      win.addEventListener('message', (e: MessageEvent) => listener({ data: e.data as unknown, origin: e.origin, source: e.source, ports: e.ports })),
    open: (url, name, features) => win.open(url, name, features) as WindowRef | null,
    navigationTiming: () => {
      const nav = win.performance?.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
      return nav ? { responseEnd: nav.responseEnd, loadEventEnd: nav.loadEventEnd } : null;
    },
  };
  return new Vault({
    env,
    config,
    host,
    openStore: () => openRecordStore(win.indexedDB),
    locks: browserLocks(win.navigator),
    channel: browserChannel,
    launcherView: domLauncherView(win.document),
    ...(win.performance ? { perfNow: () => win.performance.now() } : {}),
    ...(scriptStart !== undefined ? { boot: { scriptStart } } : {}),
  });
}
