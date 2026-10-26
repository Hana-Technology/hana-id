// The derive step without the DOM, so tests can drive it against a simulated MPC:
// fresh BLS app key → session signature over the CKD payload → POST /v1/derive → decrypt + pairing check against the
// pinned network key → PROVISIONAL addresses. Only public results come back; the CKD secret is zeroed and every
// reference to it and to the ephemeral scalar is dropped when this returns.
import type { DeriveBody, HanaApi } from './api.ts';
import { toHex } from './bytes.ts';
import { ckdAppId, decryptCkd, newAppKey } from './ckd.ts';
import { deriveAddresses } from './chain-keys.ts';
import { jsonBytes, signDerive } from './session.ts';

export interface DeriveInput {
  api: Pick<HanaApi, 'derive'>;
  /** hana-signer account: the MPC caller, part of app_id. */
  signer: string;
  /** Pinned `bls12381g2:…` CKD network key. */
  ckdNetworkKey: string;
  privateKey: CryptoKey;
  sessionPublicKey: Uint8Array;
  /** The session's path as create_session returned it. */
  path: string;
  /** used + 1. */
  counter: number;
}

export interface DeriveOutcome {
  stellar: string;
  evm: `0x${string}`;
  appIdHex: string;
  nearTx: string | null;
  requestId: string | null;
  deriveMs: number;
  decryptVerifyMs: number;
  /** The exact request sent (public: session key, counter, signature, BLS public key), for the replay test. */
  body: DeriveBody;
}

const now = (): number => performance.now();

export async function deriveOnce(i: DeriveInput): Promise<DeriveOutcome> {
  let appKey: ReturnType<typeof newAppKey> | null = newAppKey();
  const { pk1, pk2 } = appKey.publicKey.AppPublicKeyPV;
  const signature = await signDerive(i.privateKey, i.counter, pk1, pk2);
  const body: DeriveBody = { sessionPublicKey: jsonBytes(i.sessionPublicKey), counter: i.counter, signature: jsonBytes(signature), pk1, pk2 };

  const t0 = now();
  const { result, nearTx, requestId } = await i.api.derive(body);
  const deriveMs = now() - t0;

  const t1 = now();
  const appId = ckdAppId(i.signer, i.path);
  let secret: Uint8Array | null = null;
  try {
    secret = decryptCkd(result, appKey.a, appId, i.ckdNetworkKey);
    const addresses = deriveAddresses(secret);
    return { ...addresses, appIdHex: toHex(appId), nearTx, requestId, deriveMs, decryptVerifyMs: now() - t1, body };
  } finally {
    secret?.fill(0);
    secret = null;
    appKey = null;
  }
}
