// The Journear mark and the product's name for wallet pickers (EIP-6963 `info`, SWK's `productName`/`productIcon`).
// EIP-6963 requires a data: URI (RFC 2397), square, at least 96×96, and SWK shows `productIcon` the same way. A
// self-contained SVG, so no request leaves the partner page to show it. It is @hana-id/brand's journear-mark.svg in its
// own colours (the logo rules: never recoloured, no gradient, no shadow) on a transparent ground, in a square viewBox
// that also holds the tail's round cap (the mark spans x 3 to 106), centred. The published SDK can't import the
// private brand package, so the geometry and colours are copied here; test/client/icon.test.ts checks them against it.
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="1.5 -3 106 106">' +
  '<rect x="8" y="8" width="84" height="84" rx="18" fill="none" stroke="#0F766E" stroke-width="10"/>' +
  '<path d="M38 30 L62 50 L38 70" fill="none" stroke="#F97316" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M62 50 L100 50" stroke="#F97316" stroke-width="12" stroke-linecap="round"/>' +
  '</svg>';

/** The mark as a data: URI (the export keeps its old name: renaming an exported symbol would break partners). */
export const HANA_ID_ICON = `data:image/svg+xml,${encodeURIComponent(SVG)}`;
/** The name a wallet picker shows: `BRAND.product` (the ids, `rdns` and SWK's `productId`, are unchanged). */
export const HANA_ID_NAME = 'Journear Passport';
