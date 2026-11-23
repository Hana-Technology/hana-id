// Partner labels (D892): the format, the text rules, the matcher and the sentence's parts (piece 1), the preview with
// example values (piece 2, D894), what a document describes (piece 3, D896) and which code a request runs (piece 5,
// D900). Pure. Reached only through the `@hana-id/core/partner-labels` subpath, by the places core's dormancy test lists
// (the API's labels module, the vault's check of what `GET /v1/app` delivers, the approval window's rendering, and the
// partner console's Request labels tab).
export * from './words.ts';
export * from './text-rules.ts';
export * from './schema.ts';
export * from './match.ts';
export * from './context.ts';
export * from './code.ts';
