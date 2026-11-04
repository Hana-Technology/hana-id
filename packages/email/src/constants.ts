// Email identity v1 constants. FROZEN at the address freeze: every value here feeds the normalized address or `sub`,
// so changing one moves every email user's address (docs/email-login-spec.md "Address impact"). Guarded by
// test/vectors.test.ts (a hash of this object and the frozen vectors file).

/** The UTS #46 options (tr46 7.0.0, Unicode 18.0.0): non-transitional, every check on (D156). */
const IDNA_OPTIONS = Object.freeze({
  transitionalProcessing: false,
  checkHyphens: true,
  checkBidi: true,
  checkJoiners: true,
  useSTD3ASCIIRules: true,
  verifyDNSLength: false,
  ignoreInvalidPunycode: false,
});

export const EMAIL_V1 = Object.freeze({
  /** Provider name in the path: `{scope}#email#{sub}#{key_index}`. */
  provider: 'email',
  /** `sub` = subPrefix ‖ b64url(HMAC-SHA256(K_sub, subLabel ‖ 0x00 ‖ utf8(normalized))). */
  subPrefix: 'e1.',
  subLabel: 'hana-id/email-sub/v1',
  /** K_sub is 32 bytes. */
  subKeyBytes: 32,
  /** RFC 5321 limits, in UTF-8 bytes, on the trimmed input and again on the normalized address (D156). */
  maxAddressBytes: 254,
  maxLocalBytes: 64,
  /** DNS limits on the ASCII domain (no trailing dot). */
  maxDomainBytes: 253,
  maxLabelBytes: 63,
  /**
   * Gmail canonical form: these domains become `gmailCanonicalDomain`; dots are dropped from the username (the part
   * before the first `+`), a non-empty `+tag` is kept as typed, so each tag is its own identity (D159).
   */
  gmailDomains: Object.freeze(['gmail.com', 'googlemail.com'] as const),
  gmailCanonicalDomain: 'gmail.com',
  gmailPlusTag: 'kept',
  idna: Object.freeze({ library: 'tr46', version: '7.0.0', unicode: '18.0.0', options: IDNA_OPTIONS }),
  /**
   * Code points assigned after this Unicode version are refused anywhere in the address (src/unicode-age.ts), so the
   * runtime's own Unicode data (NFC inside tr46) can't change a result: every target runtime knows 15.0 (D156).
   */
  unicodeCutoff: '15.0',
});
