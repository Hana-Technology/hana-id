// Stand-in for the `secp256k1` package that @near-js/crypto imports at load time. Hana ID only signs with ed25519
// keys; the real package is a CommonJS/native module that doesn't load in workerd (and pulls in elliptic).
// Wired up with `alias` in wrangler.jsonc (scripts/gen-wrangler.ts) and vitest.config.ts.
const unsupported = (): never => {
  throw new Error('secp256k1 is not available in the Hana ID API (ed25519 keys only)');
};

export default {
  privateKeyVerify: unsupported,
  publicKeyCreate: unsupported,
  publicKeyConvert: unsupported,
  ecdsaSign: unsupported,
  ecdsaVerify: unsupported,
  ecdsaRecover: unsupported,
};
