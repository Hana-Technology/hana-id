// The SPA's build id (D384, D406): `vite build` writes `<meta name="hana-build" content="<id>">` into dist/index.html,
// this checkout's build id (@hana-id/env/local-build), so `deploy-check` confirms the assets the console serves, not
// only the Worker script that serves them (the vault's stale bundle of 2026-11-05 was the assets). `run deploy` is
// `vite build` and then the stamped `wrangler deploy` from the same tree, so the two ids agree; a dist/ built at
// another commit and shipped by a raw `wrangler deploy` shows as a mismatch (and an unstamped Worker).
//
// Only index.html carries it: the content-hashed scripts and styles under /assets don't change with each commit. The
// meta is markup, not script, so the console's CSP (`script-src 'self'`, no inline) is unaffected.
import { buildMeta } from '@hana-id/env/build-id';
import { localBuild } from '@hana-id/env/local-build';
import type { Plugin } from 'vite';

/** `html` with the build id's `<meta>` just before its one `</head>`; throws on any other shape, or a second stamp. */
export function stampIndexHtml(html: string, id: string): string {
  const at = html.indexOf('</head>');
  if (at < 0 || html.indexOf('</head>', at + 1) >= 0) throw new Error('index.html must have exactly one </head>');
  if (html.includes('name="hana-build"')) throw new Error('index.html already has a hana-build meta');
  return `${html.slice(0, at)}${buildMeta(id)}\n  ${html.slice(at)}`;
}

/** The Vite plugin (builds only; the dev server is never deployed): reads the build id once per build. */
export function buildStamp(build: () => { id: string } = localBuild): Plugin {
  let id: string | null = null;
  return {
    name: 'hana-build-stamp',
    apply: 'build',
    buildStart() {
      id = build().id;
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (id === null) throw new Error('hana-build-stamp: no build id (buildStart did not run)');
        return stampIndexHtml(html, id);
      },
    },
  };
}
