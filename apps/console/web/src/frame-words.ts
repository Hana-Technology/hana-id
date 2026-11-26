// D934 (piece P12): the console's words for a web address the app may use only inside its other web addresses (a
// network's widget in an iframe on a partner's page). One place, so the tab, the waiting list, the fresh sign-in's
// review and the confirmation page say the same thing. The tab keeps its name, "Web addresses (origins)"; everything
// else says "web address".
export const FRAME_WORDS = {
  /** The badge beside such a web address. */
  badge: 'Only inside your pages',
  /** The add form's tick box, and its hint. */
  tick: 'Only inside your other web addresses (for a widget)',
  tickHint: 'Use this for a widget shown in an iframe on your pages. Opened on its own, the wallet won’t load there.',
  /** The tick box ticked: what it applies to. */
  tickAll: 'This applies to every web address in this request.',
  /** An owner's button on a web address usable anywhere, its confirm step and its result. */
  tighten: 'Use only inside your pages',
  tightenConfirm: 'Only inside my pages now',
  tightenDetail: (address: string): string => `Takes effect at once: pages that open ${address} on its own stop loading the wallet. To undo it, remove it and add it again.`,
  tightenDone: (address: string): string => `${address} now works only inside your other web addresses.`,
  /** Under such a web address in the list: the way back. */
  wayBack: 'Works only inside your other web addresses. To let it work on its own, remove it and add it again: that waits like any new web address.',
  /** In the fresh sign-in's review, after the web address. */
  review: ' (only inside your other web addresses)',
  reviewNote: 'A web address marked “only inside your other web addresses” works only when one of this app’s other web addresses shows it in an iframe, never when it is opened on its own.',
  /** On the confirmation page, under such a web address. */
  confirm: 'Works only inside this app’s other web addresses (for a widget), never when opened on its own.',
} as const;
