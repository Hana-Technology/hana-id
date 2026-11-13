# The UI module's contract (`src/ui/index.ts`)

The site build (everything in `apps/stamps` but `src/ui/**` and `src/ui.css`) drives the page through this module; the
art build (D803, D804) owns the module and its stylesheet. The site's unit tests (`test/app.test.ts`, with the module
mounted for real) and the e2e spec (`apps/e2e/tests/stamps.spec.ts`) rely on the two parts below; a change to the
module must keep them.

## The interface

As the shared spec defines it (`mountPassport`, `PassportView`, `StampState`, `PassportHandlers`, `STAMP_LABELS`),
with one optional addition: `PassportView.shareUrl`, the public passport's absolute URL (`<origin>/p/<account_id>`),
which the site sets in `mine` and `public` modes. The rules the site relies on:

- Handlers are called synchronously inside the DOM event (no `await`, timer or animation frame first): `signIn` and
  `collect` open the Journear Passport window, which the browser allows only during the click.
- `collect('postcard', { note })` passes the note box's text (the module trims it); the site checks it again
  (1 to 140 characters, as the contract counts). Other stamps: `collect(id)`.
- `failed` offers the collect button again; `working` shows it disabled; `busy: true` disables every collect and the
  sign-in, except a `continue` slot's (D807): `{ status: 'continue', stage, action }` shows the stage and an enabled
  primary button reading `action` that calls `collect(id)`, synchronously in the click like the others (the site opens
  the Journear Passport window from it). The postcard's field is not shown in that state.
- `fresh: true` is set in exactly one `update`: the module inks the stamp then.
- Every string from the view goes into text nodes, never HTML (the page's CSP requires Trusted Types).
- Relative times in the recent list refresh on `update`: the site calls it at least every 15 s while the tab is
  visible (the poll), and every second during a layover countdown.
- The page imports `@hana-id/brand`'s `tokens.css`, `fonts.css` and `components.css` before `src/ui.css`
  (`src/main.ts`): the module's stylesheet imports nothing.
- A locked stamp may carry (D807) `detail` (one line of what to do), `href` + `hrefLabel` (a link, kept only when
  http(s), opened in a new tab) and `copyAccount` (a Copy button with the `copy-account` action): Own fare's faucet.
  The view's `balanceLink` (`href`, `label`) is shown beside the balance in `mine` mode. The notice may repeat the
  faucet link.

## The `data-*` hooks the site uses

| Hook | On |
|---|---|
| `data-mode` (`cover`, `mine`, `public`) | the passport's outer element (`.pp`) |
| `data-stamp="<id>"` + `data-status` | each of the six stamp slots (mine and public modes only) |
| `data-action="collect"` | the slot's button, present while the stamp is available, failed or working |
| `data-field="note"` | the postcard's note input, inside `data-stamp="postcard"` |
| `data-action` `sign-in`, `sign-out`, `copy-account`, `refresh` | the buttons (public mode's `sign-in` reads "Get your own passport") |
| `data-role="notice"` + `data-kind` (`info`, `error`) | the notice, always in the DOM, `hidden` when there is none |
| `data-role="share"` | the public passport link (`href` = `shareUrl`) |
| `data-role="explorer"` | the account's NearBlocks link |
| `data-role="stamp-link"`, `data-role="balance-link"` | a locked slot's link, the balance's link (D807) |
| `data-status="continue"` | a slot whose next step needs the user's click (D807) |
| `data-role="recent-item"` + `data-kind="<stamp id>"` | each recent stamp, with an `a` to that traveller's passport |

The site also listens for `pointerover` and `focusin` on the root, on `[data-action="collect"]` and
`[data-field="note"]`, to read NEAR (and activate a new account) before the click (D751).
