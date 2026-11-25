// D929: a platform route's refusal with a code of the platform API's own (`PLATFORM_ERROR_STATUS`: an Idempotency-Key
// reused for another call, the org's app limit, a quota window), its extra fields and headers. The RpcCodes the reused
// writers throw (`RpcRefusal`, changes/cas.ts) keep their statuses (`RPC_HTTP_STATUS`); request.ts answers both.
import { PLATFORM_ERROR_STATUS, type PlatformErrorCode } from '@hana-id/console-core';

export class PlatformRefusal extends Error {
  readonly status: number;
  constructor(
    readonly code: PlatformErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'PlatformRefusal';
    this.status = PLATFORM_ERROR_STATUS[code];
  }
}
