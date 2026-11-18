// What the anvil lane's global setup (setup/global.ts, Node) hands the Workers tests through `inject('anvil')` (D868).
export interface AnvilLane {
  /** The node's URL, or null when the lane is skipped (`skipped` says why). */
  url: string | null;
  skipped: string | null;
  /** How many blocks behind the head anvil's `safe` tag is (`--slots-in-an-epoch`). */
  safeDepth: number;
  delegate: string;
  checkIn: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    anvil: AnvilLane;
  }
}
