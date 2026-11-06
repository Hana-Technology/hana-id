# Partner console (`apps/console`)

The partner console: one Worker (`hana-id-console-<env>`) on `console.origin` that serves the partner SPA and its
`/api/*` backend, with partner sign-in through console-auth. Routes, sessions, CSRF, fresh sign-in and the write paths
are in `docs/api.md` ("Console Worker"); the security properties in `docs/security.md` ("Console Worker").

Last verified: 2026-11-06 (branch `feat/console-ux-redesign`: the SPA's layout, error display and the local preview,
D421).

## Layout

| Path | What |
|---|---|
| `src/` | The Worker: host dispatch, headers and CSRF, sign-in, sessions, fresh sign-in (`actions.ts`), the read and write routes, StaffRpc, the hourly cron |
| `web/` | The SPA (React 18, React Router 6, Vite), built to `dist/` and served as the Worker's assets |
| `web/src/pages/` | One file per page; `pages/app/` holds an app's sections (overview, origins, keys, login and sessions, signing, branding, suspend) |
| `web/src/ui.tsx` | The UI kit: errors and notes, panels, badges, copy buttons, the in-page confirm, the fresh sign-in hint, the guarded-change timeline |
| `web/src/messages.ts` | Every API error code in plain language, with what to do next |
| `web/src/lib.tsx` | The data, write and fresh-sign-in hooks, the fragment-token reader, formatting |
| `preview/` | The local preview harness (dev only, below) |
| `test/`, `web/test/`, `scripts/test/` | Worker tests (workerd), SPA tests (happy-dom), build, source and harness checks (Node) |

## The SPA's rules

- **CSP** `script-src 'self'; style-src 'self'`: no inline script or style anywhere, no `style` prop, no external URL,
  no font file; every style is a class in `web/src/styles.css` (light, and dark through `prefers-color-scheme`).
- **No HTML injection, no browser storage, same origin only**: checked over `web/src` by `scripts/test/spa-build.test.ts`.
- **Requests**: every write is `postJson`/`postBytes` (`web/src/api.ts`) with the CSRF header; a change marked
  "fresh sign-in" is built by `POST /api/orgs/:org/actions` and confirmed on `/actions/:id`.
- **Errors**: shown with `ErrorNote` (plain text for the code, the server's detail when it adds something, the code and
  HTTP status small). A new error code gets its line in `web/src/messages.ts`.
- **No control that can't work**: where the console would refuse (a viewer, a frozen org, a limit), the page shows one
  line saying why (`Why`) instead of the control. Destructive immediate writes use `ConfirmButton` (a second click in
  the page, never a browser dialog).

## Commands

```sh
corepack pnpm --filter @hana-id/console test        # Worker, build/source/harness and SPA tests
corepack pnpm --filter @hana-id/console typecheck
corepack pnpm --filter @hana-id/console build       # vite build → dist/
```

## Local preview

A picture of the SPA for design review and screenshots, with no Worker, D1, session or Google. Dev only: the Vite
plugin in `preview/plugin.ts` runs only in `vite serve`, listens on 127.0.0.1, and nothing of it is built into `dist/`
(a build test). It answers `/api/*` with the fake data of `preview/fixtures.ts` (invented names, keys and hashes,
checked against console-core's schemas); writes answer success, or a typical refusal in the `errors` scenario, and
change nothing. It imitates none of the console's security checks.

```sh
corepack pnpm --filter @hana-id/console preview:web   # http://127.0.0.1:5178
```

Pick a scenario, then a page: `http://127.0.0.1:5178/__preview/<scenario>?to=<path>`. Scenarios: `owner` (the
default), `viewer`, `frozen`, `multi` (two organisations), `new-org` (no apps), `signed-out`, `errors`. The org is
`org_7Hq2Lm9Xc4`; its apps `app_Lm4Pq9Zs2v` (live, with changes waiting), `app_Ts6Ry1Hn8b` (test), `app_Rw2Bt7Kd5c`
(new, no origins), `app_Lg5Yn3Wq8d` (suspended). The fresh sign-in page's states: `/actions/act_demo_origin`,
`act_demo_policy`, `act_demo_settings`, `act_demo_invite`, `act_demo_owner`, `act_demo_ok`, `act_demo_failed`,
`act_demo_expired`. "Confirm with Google" in the preview marks the action done and comes straight back (no Google).
The invite and cancel pages: `/invite#t=<43 characters>`, `/cancel/gc_Ch4kq81Ns#t=<43 characters>`.
