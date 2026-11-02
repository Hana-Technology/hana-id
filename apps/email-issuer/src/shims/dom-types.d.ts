// A DOM type @hana-id/email's sources name (sub.ts checks its key's algorithm) that @cloudflare/workers-types doesn't
// declare. Type-level only.
interface HmacKeyAlgorithm {
  name: string;
  hash: { name: string };
  length: number;
}
