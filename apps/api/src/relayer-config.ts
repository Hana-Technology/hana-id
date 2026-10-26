// Parsing of the RELAYER_KEYS secret. Kept free of Workers imports so scripts (Node) can check what they generate.

export function parseRelayerKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  let keys: unknown;
  try {
    keys = JSON.parse(raw);
  } catch {
    throw new Error('RELAYER_KEYS must be a JSON array of ed25519 secret keys');
  }
  if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string')) throw new Error('RELAYER_KEYS must be a JSON array of ed25519 secret keys');
  return keys as string[];
}
