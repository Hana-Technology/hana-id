// The server-corrected clock (docs/batch-b-spec.md "Clock"): `now() = Date.now() + offset`, with the offset taken from
// the API's `serverTimeMs` (GET /v1/app, relay reads). A device clock that is minutes or hours off then can't break
// token checks or produce a session expiry the contract refuses.

export class ServerClock {
  private offset = 0;

  constructor(private readonly deviceNow: () => number = () => Date.now()) {}

  /** Re-anchors on the server's time; ignores anything that isn't a plausible ms timestamp. */
  sync(serverTimeMs: unknown): void {
    if (typeof serverTimeMs === 'number' && Number.isSafeInteger(serverTimeMs) && serverTimeMs > 0) this.offset = serverTimeMs - this.deviceNow();
  }

  now(): number {
    return this.deviceNow() + this.offset;
  }
}
