// The UI module's contract with the site (the shared spec, "The UI module contract"): pure rendering, no chain, SDK or
// network. Re-exported by index.ts.

export type StampId = 'arrival' | 'sponsored' | 'own_fare' | 'signature' | 'postcard' | 'layover';

/** The catalog order: the order of the slots on the page. */
export const STAMP_IDS: readonly StampId[] = Object.freeze(['arrival', 'sponsored', 'own_fare', 'signature', 'postcard', 'layover']);

export type StampState =
  | { id: StampId; status: 'collected'; atMs: number; sponsored: boolean; note?: string; txUrl?: string; fresh?: boolean }
  | { id: StampId; status: 'available' }
  /**
   * e.g. "Collect Arrival first", "In 1 min 40 s". Optional (D807), for a stamp the user can unlock themselves (Own
   * fare's testnet NEAR): `detail`, one line of what to do; `href` + `hrefLabel`, a link (kept only when http(s), opens
   * in a new tab); `copyAccount`, a Copy button for the full account id (the `copy-account` action).
   */
  | { id: StampId; status: 'locked'; reason: string; detail?: string; href?: string; hrefLabel?: string; copyAccount?: boolean }
  /** "Waiting for your approval…", "Sending…". */
  | { id: StampId; status: 'working'; stage: string }
  /**
   * D807: the next step needs the user's click (a second approval the browser wouldn't open by itself, or one the
   * user closed): `stage` says what it is, the slot's primary button reads `action` and calls `collect(id)`, even
   * while `busy` (it is the busy slot's own next step).
   */
  | { id: StampId; status: 'continue'; stage: string; action: string }
  | { id: StampId; status: 'failed'; message: string };

export interface PassportView {
  mode: 'cover' | 'mine' | 'public';
  /** 64-hex implicit account (shown shortened, full on demand). */
  accountId?: string;
  explorerUrl?: string;
  /** Mine only. */
  balanceNear?: string;
  /** Mine only (D807): a link shown beside the balance (how to get testnet NEAR); kept only when http(s). */
  balanceLink?: { href: string; label: string };
  /**
   * Optional, an addition to the spec's interface: the public passport's link (`/p/<account_id>`, absolute or a path),
   * shown on the identity page as the link to share. Left out, the line isn't shown.
   */
  shareUrl?: string;
  /** Always all six, catalog order. */
  stamps: StampState[];
  recent: { accountId: string; stamp: StampId; atMs: number; href: string }[];
  totals?: { passports: number; stamps: number };
  notice?: { kind: 'info' | 'error'; text: string; href?: string; hrefLabel?: string };
  busy?: boolean;
}

export interface PassportHandlers {
  signIn(): void;
  signOut(): void;
  /** `input.note` only for the postcard: the field's text, trimmed. */
  collect(id: StampId, input?: { note?: string }): void;
  copyAccount(): void;
  refresh(): void;
}
