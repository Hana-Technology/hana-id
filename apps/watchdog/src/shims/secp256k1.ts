// Stand-in for the `secp256k1` package that @near-js/crypto imports at load time (as in apps/api): the watchdog signs
// with one ed25519 key only, and the real package is a CommonJS/native module that doesn't load in workerd.
// Wired up with `alias` in the generated wrangler config (scripts/gen-wrangler.ts) and vitest.config.ts.
const unsupported = (): never => {
  throw new Error('secp256k1 is not available in the Journear Passport watchdog (ed25519 keys only)');
};

export default {
  privateKeyVerify: unsupported,
  publicKeyCreate: unsupported,
  publicKeyConvert: unsupported,
  ecdsaSign: unsupported,
  ecdsaVerify: unsupported,
  ecdsaRecover: unsupported,
};
