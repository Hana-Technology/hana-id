// Types for tr46 7.0.0 (pinned exactly in package.json; the package ships no types). Only what src/normalize.ts uses.
declare module 'tr46' {
  export interface ToASCIIOptions {
    checkHyphens?: boolean;
    checkBidi?: boolean;
    checkJoiners?: boolean;
    useSTD3ASCIIRules?: boolean;
    verifyDNSLength?: boolean;
    transitionalProcessing?: boolean;
    ignoreInvalidPunycode?: boolean;
  }
  /** UTS #46 ToASCII; `null` when the domain fails processing or validation. */
  export function toASCII(domainName: string, options?: ToASCIIOptions): string | null;
}
