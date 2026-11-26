// Where the vault's parent page sits (D934, pieces P11 and P12 of docs/partner-platform-spec.md), from what the browser
// itself tells the vault, never from anything a page or the SDK sends:
//
// - `parentIsTop`: whether the parent is the top-level page (`window.parent === window.top`). Every browser answers it
//   for a cross-origin parent (WindowProxy's `parent` and `top` are readable across origins); a frame where it can't
//   be read counts as top-level (the stricter reading for a frame-only parent).
// - `ancestors`: `location.ancestorOrigins`, parent first and the top-level page last, where the browser has it
//   (Chromium, WebKit, Firefox where it has shipped); undefined elsewhere. Every entry is one of the app's web
//   addresses (vault.ts `tryHello` refuses any other, sweep VAUL-6), and the vault page's `frame-ancestors` holds the
//   same for every ancestor in every browser.
//
// P12, `frameRuleAllows`: a web address the app marked frame-only (`config.frameOnly`) is never the top-level page:
// the vault refuses it as a parent that is top-level (every browser), and refuses any frame whose top-level page is
// frame-only (where `ancestors` tells). Without `ancestors`, a frame-only parent inside another frame is accepted: the
// page above it is one of the app's web addresses (`frame-ancestors`), but which one the browser doesn't say (the
// residual: a frame-only page framed by a page of a frame-only address of the same app).
//
// P11, `frameSiteOf`: what the windows say about where the person is (core protocol.ts FrameSite): nothing more when
// the parent is the top-level page; the top-level page's address when `ancestors` names it; else that the browser
// didn't say, with the one page the app lists to expect for a frame-only parent.
import type { FrameSite } from '@hana-id/core';
import { LOCALHOST_WILDCARD, type VaultConfig } from './config.ts';

export interface FrameFacts {
  parentOrigin: string;
  parentIsTop: boolean;
  ancestors: readonly string[] | undefined;
}

/** Whether the parent is the top-level page, by `ancestors` where there are some, else by `parentIsTop`; either says so. */
const parentOnTop = (f: FrameFacts): boolean => f.parentIsTop || (f.ancestors !== undefined && f.ancestors.length <= 1);

/** P12: whether the app's frame-only web addresses let this parent use the vault (see the header). */
export function frameRuleAllows(config: Pick<VaultConfig, 'frameOnly'>, f: FrameFacts): boolean {
  const frameOnly = new Set(config.frameOnly ?? []);
  if (frameOnly.size === 0) return true;
  if (frameOnly.has(f.parentOrigin) && parentOnTop(f)) return false;
  const top = f.ancestors?.[f.ancestors.length - 1];
  return top === undefined || !frameOnly.has(top);
}

/** P11: the window's FrameSite for this parent, or undefined when the parent is the top-level page (see the header). */
export function frameSiteOf(config: Pick<VaultConfig, 'origins' | 'frameOnly'>, f: FrameFacts): FrameSite | undefined {
  if (parentOnTop(f)) return undefined;
  if (f.ancestors !== undefined) {
    const top = f.ancestors[f.ancestors.length - 1];
    return top === undefined || top === f.parentOrigin ? undefined : { top };
  }
  const frameOnly = new Set(config.frameOnly ?? []);
  if (!frameOnly.has(f.parentOrigin)) return { top: null };
  const pages = config.origins.filter((o) => o !== LOCALHOST_WILDCARD && !frameOnly.has(o) && o !== f.parentOrigin);
  return pages.length === 1 ? { top: null, expected: pages[0]! } : { top: null };
}
