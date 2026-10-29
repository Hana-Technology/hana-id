// Random names for the vault iframe and the Hana windows (`hana-vault-<32 hex>`, `hana-login-<32 hex>`): 128 bits
// from the platform CSPRNG, so another page can't guess a window name and target it.
import { toHex } from '@hana-id/core';

/** `bytes` random bytes as lowercase hex. */
export const randomHex = (bytes: number): string => toHex(crypto.getRandomValues(new Uint8Array(bytes)));
