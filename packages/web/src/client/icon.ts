// The Hana ID mark for wallet pickers: EIP-6963 requires a data: URI (RFC 2397), square, at least 96×96, and SWK shows
// `productIcon` the same way. A self-contained SVG, so no request leaves the partner page to show it.
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">' +
  '<rect width="96" height="96" rx="22" fill="#111827"/>' +
  '<path d="M30 24h10v19h16V24h10v48H56V53H40v19H30z" fill="#f9fafb"/>' +
  '</svg>';

export const HANA_ID_ICON = `data:image/svg+xml,${encodeURIComponent(SVG)}`;
export const HANA_ID_NAME = 'Hana ID';
