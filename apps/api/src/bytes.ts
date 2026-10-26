// Byte helpers that don't need Node's Buffer.

export function base64Encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64Decode(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** base64url (no padding) → bytes. Throws on invalid input. */
export function base64UrlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(s)) throw new Error('Invalid base64url');
  const b64 = s.replace(/-/gu, '+').replace(/_/gu, '/');
  return base64Decode(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

export function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
