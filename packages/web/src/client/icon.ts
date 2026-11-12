// The Journear mark and the product's name for wallet pickers (EIP-6963 `info`, SWK's `productName`/`productIcon`).
// EIP-6963 requires a data: URI (RFC 2397), square, at least 96×96, and SWK shows `productIcon` the same way. A
// self-contained SVG, so no request leaves the partner page to show it. It is @hana-id/brand's journear-mark.svg (D789:
// the teal card and the orange bracket) in its own colours (the logo rules: never recoloured, no gradient, no shadow)
// on a transparent ground, in its square viewBox with the mark centred. The published SDK can't import the private brand
// package, so the shapes, viewBox and colours are copied here; test/client/icon.test.ts checks them against it.
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="13.84 -0.1 102 102">' +
  '<path fill="#0F766E" d="M19 83 Q12 83 15 74 L26 38 Q28 31 35 28 L92 8 Q101 5 98 15 L89 55 Q87 64 79 67 L23 83 Q21 84 19 83 Z"/>' +
  '<path fill="#F97316" d="M31 94 Q24 96 23 90 Q22 85 29 83 L87 67 Q94 65 96 57 L105 24 Q107 18 112 20 Q117 22 115 29 L106 69 Q104 78 96 81 L34 94 Z"/>' +
  '</svg>';

/** The mark as a data: URI (the export keeps its old name: renaming an exported symbol would break partners). */
export const HANA_ID_ICON = `data:image/svg+xml,${encodeURIComponent(SVG)}`;
/** The name a wallet picker shows: `BRAND.product` (the ids, `rdns` and SWK's `productId`, are unchanged). */
export const HANA_ID_NAME = 'Journear Passport';
