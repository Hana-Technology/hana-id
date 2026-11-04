// Refusals with an RpcCode, thrown by the data path and answered `{ok: false, code, error}` by StaffRpc and the BFF
// (docs/batch-c-spec.md "RPC interfaces": every result is `{ok: true, …} | {ok: false, code, error?}`).
import type { RpcCode } from '@hana-id/console-core';

export class RpcRefusal extends Error {
  constructor(
    readonly code: RpcCode,
    message: string,
  ) {
    super(message);
    this.name = 'RpcRefusal';
  }
}

export const refuse = (code: RpcCode, message: string): never => {
  throw new RpcRefusal(code, message);
};
