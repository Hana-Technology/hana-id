// Partner labels (D892): the format, the text rules, the matcher and the sentence's parts (piece 1), the preview with
// example values (piece 2, D894), and what a document describes (piece 3, D896). Pure. Reached only through the
// `@hana-id/core/partner-labels` subpath, by exactly three places (a test in core holds the list): the API's labels
// module (apps/api/src/labels/: it parses every proposal and builds the preview), the vault's check of what
// `GET /v1/app` delivers (packages/web/src/vault/partner-labels.ts) and the approval window's rendering of a label
// (packages/web/src/auth/render-labels.ts).
export * from './words.ts';
export * from './text-rules.ts';
export * from './schema.ts';
export * from './match.ts';
export * from './context.ts';
export * from './code.ts';
