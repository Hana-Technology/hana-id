// Partner labels (D892): the format, the text rules, the matcher and the sentence's parts (piece 1), and the preview
// with example values (piece 2, D894). Pure. Reached only through the `@hana-id/core/partner-labels` subpath, by exactly
// two places (a test in core holds the list): the API's labels module (apps/api/src/labels/: it parses every proposal
// and builds the preview) and the vault's check of what `GET /v1/app` delivers (packages/web/src/vault/partner-labels.ts,
// a pure helper nothing calls yet). No screen renders a label yet (piece 3).
export * from './words.ts';
export * from './text-rules.ts';
export * from './schema.ts';
export * from './match.ts';
