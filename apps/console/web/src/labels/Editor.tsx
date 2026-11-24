// The request labels editor (D899): one entry's `journear-labels/1` document, built from a form, never written by hand.
// A form per kind of request (a classic Stellar payment; a NEAR program and a Soroban contract, each tied to the
// program's code, D900, with how an upgrade affects them and, for NEAR, the code read from the network for the partner
// to confirm), the verb from Journear's list, the phrase, the values shown, the accounts and the
// limits; and an "Advanced" view of the document's text, which takes edits and round-trips with the form.
//
// Every problem is core's parser's and text rules' own answer (@hana-id/core/partner-labels, the code the API and the
// window run), shown beside the field that caused it as the partner types; the live preview is the approval window's
// own rendering (Preview.tsx). Partner text is always text: React text nodes, never HTML.
import { FORMAT_ARG_TYPES, type FieldFormat, LABEL_LIMITS, type LabelDocument, PARTNER_CONNECTORS, PARTNER_VERBS, addressBookLines, parseLabelDocument, previewLabelDocument } from '@hana-id/core/partner-labels';
import { type ReactNode, useId, useMemo, useRef, useState } from 'react';
import { Callout, ChoiceCards, Field } from '../ui.tsx';
import { type ArgDraft, ARG_TYPES, type Draft, type Environment, type FieldDraft, type FormatDraft, type LabelKind, type PartDraft, argFamily, emptyArg, emptyDraft, emptyField, emptyFormat, exampleDraft, exampleLeft, fromDocumentText, isEmptyDraft, toDocumentText } from './model.ts';
import { AccountLines } from './Diff.tsx';
import { LabelsPreview } from './Preview.tsx';
import { type Problem, problemsOf } from './problems.ts';
import { NEAR_DECIMALS, STELLAR_DECIMALS, TGAS_DECIMALS, toDisplay, toRaw } from './units.ts';

// ---- the sentences (D899, to confirm) ----

export const WARN_ADDRESS_BOOK = 'List only accounts that only you control, never a shared deposit address.';
export const WARN_MUXED = 'A muxed form (M…) of a listed account counts as that account.';
// D907 (to confirm): the name's field, true for each kind. A payment's name ends its sentence ("pay the fare to Coffee
// Club till") while Journear's own To line shows the address; a NEAR or Soroban account in the sentence shows as its
// name alone, and in a row as its name with the address under it.
export const BOOK_NAME_LABEL = 'Name shown to users';
export const BOOK_NAME_HINT: Readonly<Record<LabelKind, string>> = Object.freeze({
  stellar: 'Shown at the end of your sentence in place of the account’s address, as “pay the fare to Coffee Club till”. Journear’s own To line still shows the full address. Up to 32 characters.',
  near: 'Shown in your sentence in place of the account’s address, as “Coffee Club till”. In a row, the full address shows under it. Up to 32 characters.',
  soroban: 'Shown in your sentence in place of the account’s address, as “Coffee Club till”. In a row, the full address shows under it. Up to 32 characters.',
});
/** D908 (to confirm): the example button, what it does, the question before it replaces a typed form, and the note while the example is in the form. */
export const EXAMPLE_BUTTON = 'See an example';
export const EXAMPLE_INTRO = 'Fills the form with a made-up coffee shop, to show how it works. You then add your own account and replace the rest with your own.';
export const EXAMPLE_CONFIRM = 'This replaces what you’ve typed with the example. Replace it?';
export const EXAMPLE_NOTE = 'This is an example, not your labels. Add one of your own Stellar accounts, and replace the name, the phrase and the limits with yours, before you review.';
/** D908 (to confirm): the memo's row label, true in the window and its preview (a row only when the sentence doesn't show the memo). */
export const MEMO_LABEL_HINT = 'Shown to users as its own line, with the memo under it, when the memo isn’t in your sentence. Up to 24 characters, as “Order”.';
/** D907: under a payment's sentence parts, what Journear adds at the end. */
export const PAYMENT_NAME_NOTE = 'Journear ends the sentence with the name of the account the payment goes to, from your accounts, as “to Coffee Club till”.';
export const WARN_PAYMENT_RED =
  'With a payment description, every time a user’s money goes to an account that isn’t in your list, Journear shows your users a red warning: paying someone, a swap that pays someone else, creating an account for someone, closing the account into another one, and sending a claimable balance. If your app’s users also pay other people, think twice before adding one.';
export const SUGGEST_FEE = 'Set a highest network fee. Without one, a payment with an unusually high fee still shows your words (Journear’s own line always shows the fee).';
// D900 (to confirm): labels tied to a program's code.
export const CODE_TIED_TITLE = 'Tied to your program’s code';
export const CODE_TIED_NEAR =
  'Your words show only while the program at this account runs exactly the code hash below: Journear checks the code on the NEAR network when a user approves. If you change the program’s code, your users see an amber line instead of your words until new labels with the new code hash go live, after their wait. So propose the new labels first, and upgrade soon after they go live.';
export const CODE_TIED_SOROBAN =
  'Your words show only for a transaction your user signs in full, sent from their own account (not an account you pay from, and not wrapped in a fee bump), that runs only this contract’s Wasm code (Stellar’s built-in token contracts aside), as the transaction itself declares. A call your user only authorizes for someone else to send shows Journear’s plain window. If you change the contract’s code, your users see an amber line instead of your words until new labels with the new Wasm hash go live, after their wait. So propose the new labels first, and upgrade soon after they go live.';
/** Live apps only: a delegate action names no network the vault checks (D726, D729), so no label can match it. */
export const NEAR_LIVE_RELAYED = 'From a live app, a call someone else sends for your user always shows Journear’s plain window: your words show only on the user’s own transactions.';
export const SOROBAN_SOFT_VERBS = 'A verb that says nothing moves (such as join or vote) shows only when the transaction can change nothing but your contract’s own stored data.';
export const NEAR_CODE_HINT = 'The code deployed at the account now (base58). Read it from the network, check it is the code you deployed, then use it.';
export const WASM_HASH_HINT = '64 lowercase hex characters: the hash of the Wasm code your contract runs now, as shown when you uploaded it.';

/** What the console's own NEAR endpoint says of an account's code (GET …/near-code/:account, D900). */
export type NearCodeAnswer = { account: string; exists: false } | { account: string; exists: true; codeHash: string | null; sharedCode: boolean };

/** What the form needs from the page around it. */
export interface EditorProps {
  environment: Environment;
  /** The scope's live apps, to attach the labels to (1 to 8). */
  apps: readonly { id: string; name: string }[];
  initialApps: readonly string[];
  /** An entry's text to start from (its version in force or waiting), or none for a new entry. */
  initialText?: string | undefined;
  /** A new version of an existing entry keeps what it describes (another program is another entry). */
  existing: boolean;
  /** Proposing is offered (labels on here, an owner, not switched off): else `whyNot` says why. */
  canPropose: boolean;
  whyNot?: ReactNode;
  busy: boolean;
  onReview: (text: string, appIds: string[]) => void;
  onCancel: () => void;
  /** D900: reads a NEAR account's code from the console's own endpoint (absent: no read is offered). */
  readNearCode?: (account: string) => Promise<NearCodeAnswer>;
}

const FIELD_FORMAT_TEXT: Readonly<Record<FieldFormat, string>> = Object.freeze({
  enum: 'A word from one of your lists',
  tokenAmount: 'An amount of a token',
  nativeAmount: 'An amount of NEAR (the deposit)',
  account: 'An account',
  date: 'A date',
  duration: 'A length of time',
  count: 'A number of things',
  itemId: 'An item id',
  orderNumber: 'An order number',
});

const RELAY_TEXT: Readonly<Record<'either' | 'relayed' | 'direct', string>> = Object.freeze({ either: 'Either way', relayed: 'Only when someone else sends it for the user', direct: 'Only when the user sends it' });

/** The parser's messages for one control, as a list under it (or nothing). */
function messages(list: readonly Problem[]): ReactNode {
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0]!.message;
  return (
    <ul className="field-problems">
      {list.map((p, i) => (
        <li key={i}>{p.message}</li>
      ))}
    </ul>
  );
}

type Errs = (key: string) => ReactNode;

/** An amount typed in a unit (XLM, NEAR, TGas), held as the document's integer units. */
function AmountInput({ id, raw, decimals, unit, onChange, describedBy, invalid, placeholder }: { id: string; raw: string; decimals: number; unit: string; onChange: (raw: string) => void; describedBy?: string | undefined; invalid?: true | undefined; placeholder?: string }) {
  const [text, setText] = useState(() => toDisplay(raw, decimals));
  const [bad, setBad] = useState(false);
  // Follow the draft when it changes from elsewhere (the advanced text, a suggestion button).
  const shown = toRaw(text, decimals) === raw ? text : toDisplay(raw, decimals);
  return (
    <span className="amount-input">
      <input
        id={id}
        className="jp-input mono"
        inputMode="decimal"
        value={bad ? text : shown}
        placeholder={placeholder}
        aria-describedby={[describedBy, bad ? `${id}-unit-error` : ''].filter(Boolean).join(' ') || undefined}
        aria-invalid={invalid ?? (bad ? true : undefined)}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          const r = toRaw(v, decimals);
          setBad(r === null);
          if (r !== null) onChange(r);
        }}
      />
      <span className="amount-unit">{unit}</span>
      {bad && (
        <span className="jp-error" id={`${id}-unit-error`}>
          Write an amount such as 0.5, with at most {decimals} digits after the point.
        </span>
      )}
    </span>
  );
}

/** A list of short texts (allowed values, assets), one per line. */
function LinesInput({ id, value, onChange, describedBy, invalid, rows = 3 }: { id: string; value: readonly string[]; onChange: (v: string[]) => void; describedBy?: string | undefined; invalid?: true | undefined; rows?: number }) {
  return <textarea id={id} className="jp-input mono" rows={rows} value={value.join('\n')} aria-describedby={describedBy} aria-invalid={invalid} onChange={(e) => onChange(e.target.value.split('\n').map((s) => s.trim()).filter((s, i, all) => s !== '' || i < all.length - 1))} />;
}

// ---- the sections ----

function AddressBook({ d, set, errs }: { d: Draft; set: (f: (d: Draft) => void) => void; errs: Errs }) {
  const id = useId();
  return (
    <fieldset className="labels-section">
      <legend>Your accounts</legend>
      <p className="muted small">The accounts your app’s requests pay or name, each with the name users see for it. {d.kind === 'stellar' ? 'Your words show only for a payment to one of them.' : ''}</p>
      <Callout tone="warn" role="note">
        <p>{WARN_ADDRESS_BOOK}</p>
        {d.kind === 'stellar' && <p>{WARN_MUXED}</p>}
      </Callout>
      {errs('book') && <p className="jp-error section-error">{errs('book')}</p>}
      <ol className="labels-rows-edit">
        {d.addressBook.map((e, i) => (
          <li key={i} className="labels-row-edit">
            <Field label={`Account ${i + 1}`} error={errs(`book.${i}.account`)}>
              {(c) => <input {...c} className="jp-input mono" value={e.account} placeholder={d.kind === 'near' ? 'payments.example.testnet' : 'G…'} onChange={(ev) => set((x) => void (x.addressBook[i]!.account = ev.target.value.trim()))} />}
            </Field>
            <Field label={BOOK_NAME_LABEL} hint={BOOK_NAME_HINT[d.kind]} error={errs(`book.${i}.name`)}>
              {(c) => <input {...c} className="jp-input" value={e.name} onChange={(ev) => set((x) => void (x.addressBook[i]!.name = ev.target.value))} />}
            </Field>
            <button type="button" className="jp-btn jp-btn-ghost jp-btn-sm" aria-label={`Remove account ${i + 1}`} onClick={() => set((x) => void x.addressBook.splice(i, 1))}>
              Remove
            </button>
          </li>
        ))}
      </ol>
      {d.addressBook.length < LABEL_LIMITS.addressBook && (
        <button type="button" className="jp-btn jp-btn-secondary jp-btn-sm" aria-describedby={`${id}-add`} onClick={() => set((x) => void x.addressBook.push({ account: '', name: '' }))}>
          Add an account
        </button>
      )}
      <span id={`${id}-add`} className="visually-hidden">
        {WARN_ADDRESS_BOOK}
      </span>
    </fieldset>
  );
}

function Enums({ d, set, errs }: { d: Draft; set: (f: (d: Draft) => void) => void; errs: Errs }) {
  return (
    <fieldset className="labels-section">
      <legend>Lists of values</legend>
      <p className="muted small">A word for each exact value an argument can carry, as “fare_paid” → “Fare paid”. A value that isn’t listed means the request doesn’t match.</p>
      {errs('enums') && <p className="jp-error section-error">{errs('enums')}</p>}
      {d.enums.map((e, i) => (
        <div key={i} className="labels-enum">
          <div className="labels-row-edit">
            <Field label={`List ${i + 1}: its name`} hint="Letters, digits and underscores; only you see it." error={errs(`enum.${i}`)}>
              {(c) => <input {...c} className="jp-input mono" value={e.name} onChange={(ev) => set((x) => void (x.enums[i]!.name = ev.target.value.trim()))} />}
            </Field>
            <button type="button" className="jp-btn jp-btn-ghost jp-btn-sm" aria-label={`Remove list ${i + 1}`} onClick={() => set((x) => void x.enums.splice(i, 1))}>
              Remove list
            </button>
          </div>
          <ol className="labels-rows-edit">
            {e.values.map((v, j) => (
              <li key={j} className="labels-row-edit">
                <Field label={`Value ${j + 1}, exactly as the request carries it`} error={errs(`enum.${i}.v.${j}`)}>
                  {(c) => <input {...c} className="jp-input mono" value={v.raw} onChange={(ev) => set((x) => void (x.enums[i]!.values[j]!.raw = ev.target.value.trim()))} />}
                </Field>
                <Field label="Its word for users">{(c) => <input {...c} className="jp-input" value={v.label} onChange={(ev) => set((x) => void (x.enums[i]!.values[j]!.label = ev.target.value))} />}</Field>
                <button type="button" className="jp-btn jp-btn-ghost jp-btn-sm" aria-label={`Remove value ${j + 1} of list ${i + 1}`} onClick={() => set((x) => void x.enums[i]!.values.splice(j, 1))}>
                  Remove
                </button>
              </li>
            ))}
          </ol>
          <button type="button" className="jp-btn jp-btn-secondary jp-btn-sm" onClick={() => set((x) => void x.enums[i]!.values.push({ raw: '', label: '' }))}>
            Add a value
          </button>
        </div>
      ))}
      <button type="button" className="jp-btn jp-btn-secondary jp-btn-sm" onClick={() => set((x) => void x.enums.push({ name: `list${x.enums.length + 1}`, values: [{ raw: '', label: '' }] }))}>
        Add a list
      </button>
    </fieldset>
  );
}

function ArgEditor({ kind, a, i, fi, set, errs }: { kind: 'near' | 'soroban'; a: ArgDraft; i: number; fi: number; set: (f: (a: ArgDraft) => void) => void; errs: Errs }) {
  const fam = argFamily(a.type);
  return (
    <div className="labels-arg">
      <div className="labels-row-edit">
        <Field label={`Argument ${i + 1}: its name`} hint={kind === 'soroban' ? 'As the contract names it, in order.' : 'As the method’s JSON arguments name it.'} error={errs(`f.${fi}.arg.${i}`)}>
          {(c) => <input {...c} className="jp-input mono" value={a.name} onChange={(e) => set((x) => void (x.name = e.target.value.trim()))} />}
        </Field>
        <Field label="Its type">
          {(c) => (
            <select {...c} className="jp-input" value={a.type} onChange={(e) => set((x) => void Object.assign(x, emptyArg(x.name, e.target.value), { optional: x.optional }))}>
              {ARG_TYPES[kind].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <div className="labels-row-edit">
        {fam === 'text' && (
          <>
            <Field label="Longest length" optional>
              {(c) => <input {...c} className="jp-input mono" inputMode="numeric" value={a.maxLength} onChange={(e) => set((x) => void (x.maxLength = e.target.value.trim()))} />}
            </Field>
            <Field label="Only these values" optional hint="One per line.">
              {(c) => <LinesInput id={c.id} describedBy={c['aria-describedby']} value={a.oneOf} onChange={(v) => set((x) => void (x.oneOf = v))} />}
            </Field>
          </>
        )}
        {fam === 'account' && (
          <>
            <label className="jp-check">
              <input type="checkbox" checked={a.isSelf} onChange={(e) => set((x) => void (x.isSelf = e.target.checked))} /> Must be the user’s own account
            </label>
            <label className="jp-check">
              <input type="checkbox" checked={a.inAddressBook} onChange={(e) => set((x) => void (x.inAddressBook = e.target.checked))} /> Must be one of your accounts
            </label>
            <Field label="Only these accounts" optional hint="One per line.">
              {(c) => <LinesInput id={c.id} describedBy={c['aria-describedby']} value={a.oneOf} onChange={(v) => set((x) => void (x.oneOf = v))} />}
            </Field>
          </>
        )}
        {fam === 'decimal' && (
          <>
            <Field label="Least value" optional hint="In the contract’s own units.">
              {(c) => <input {...c} className="jp-input mono" inputMode="numeric" value={a.atLeast} onChange={(e) => set((x) => void (x.atLeast = e.target.value.trim()))} />}
            </Field>
            <Field label="Most value" optional hint="In the contract’s own units.">
              {(c) => <input {...c} className="jp-input mono" inputMode="numeric" value={a.atMost} onChange={(e) => set((x) => void (x.atMost = e.target.value.trim()))} />}
            </Field>
          </>
        )}
        {fam === 'int' && (
          <>
            <Field label="Least value" optional>
              {(c) => <input {...c} className="jp-input mono" inputMode="numeric" value={a.min} onChange={(e) => set((x) => void (x.min = e.target.value.trim()))} />}
            </Field>
            <Field label="Most value" optional>
              {(c) => <input {...c} className="jp-input mono" inputMode="numeric" value={a.max} onChange={(e) => set((x) => void (x.max = e.target.value.trim()))} />}
            </Field>
          </>
        )}
        {fam === 'bool' && (
          <Field label="Must be" optional>
            {(c) => (
              <select {...c} className="jp-input" value={a.equals} onChange={(e) => set((x) => void (x.equals = e.target.value as ArgDraft['equals']))}>
                <option value="">Either</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            )}
          </Field>
        )}
        {kind === 'near' && (
          <label className="jp-check">
            <input type="checkbox" checked={a.optional} onChange={(e) => set((x) => void (x.optional = e.target.checked))} /> The request may leave it out
          </label>
        )}
      </div>
    </div>
  );
}

/** The values a format can show: its arguments, NEAR's deposit, a payment's memo. */
function pathsOf(kind: LabelKind, f: FormatDraft): { path: string; type: string; text: string }[] {
  if (kind === 'stellar') return f.memo === 'none' ? [] : [{ path: 'memo', type: 'memo', text: 'The memo' }];
  return [...(kind === 'near' ? [{ path: 'deposit', type: 'deposit', text: 'The deposit' }] : []), ...f.args.filter((a) => a.name !== '').map((a) => ({ path: `args.${a.name}`, type: a.type, text: `The argument “${a.name}”` }))];
}

function formatsFor(kind: LabelKind, type: string): FieldFormat[] {
  if (type === 'memo') return ['orderNumber', 'itemId'];
  if (type === 'deposit') return ['nativeAmount'];
  return (Object.keys(FORMAT_ARG_TYPES) as FieldFormat[]).filter((f) => f !== 'nativeAmount' && FORMAT_ARG_TYPES[f].includes(type as never) && kind !== 'stellar');
}

function FieldEditor({ kind, d, f, fd, i, fi, set, errs }: { kind: LabelKind; d: Draft; f: FormatDraft; fd: FieldDraft; i: number; fi: number; set: (g: (x: FieldDraft) => void) => void; errs: Errs }) {
  const paths = pathsOf(kind, f);
  const type = paths.find((p) => p.path === fd.path)?.type ?? '';
  const formats = formatsFor(kind, type);
  return (
    <div className="labels-field">
      <div className="labels-row-edit">
        <Field label={`Shown value ${i + 1}`} error={errs(`f.${fi}.field.${i}`)}>
          {(c) => (
            <select
              {...c}
              className="jp-input"
              value={fd.path}
              onChange={(e) =>
                set((x) => {
                  const t = paths.find((p) => p.path === e.target.value)?.type ?? '';
                  Object.assign(x, emptyField(e.target.value, formatsFor(kind, t)[0] ?? 'itemId'), { label: x.label });
                })
              }
            >
              {!paths.some((p) => p.path === fd.path) && <option value={fd.path}>{fd.path || 'Choose a value'}</option>}
              {paths.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.text}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Shown as">
          {(c) => (
            <select {...c} className="jp-input" value={fd.format} onChange={(e) => set((x) => void Object.assign(x, emptyField(x.path, e.target.value as FieldFormat), { label: x.label }))}>
              {!formats.includes(fd.format) && <option value={fd.format}>{FIELD_FORMAT_TEXT[fd.format]}</option>}
              {formats.map((ff) => (
                <option key={ff} value={ff}>
                  {FIELD_FORMAT_TEXT[ff]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Its label for users" hint="Up to 24 characters, as “Order”.">
          {(c) => <input {...c} className="jp-input" value={fd.label} onChange={(e) => set((x) => void (x.label = e.target.value))} />}
        </Field>
      </div>
      <div className="labels-row-edit">
        {fd.format === 'enum' && (
          <Field label="Its list">
            {(c) => (
              <select {...c} className="jp-input" value={fd.enumName} onChange={(e) => set((x) => void (x.enumName = e.target.value))}>
                <option value="">Choose a list</option>
                {d.enums.map((e) => (
                  <option key={e.name} value={e.name}>
                    {e.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        {fd.format === 'tokenAmount' && (
          <>
            <Field label="Which token">
              {(c) => (
                <select {...c} className="jp-input" value={fd.tokenBy} onChange={(e) => set((x) => void (x.tokenBy = e.target.value as FieldDraft['tokenBy']))}>
                  <option value="token">Always this token</option>
                  <option value="tokenPath">The token another argument names</option>
                </select>
              )}
            </Field>
            {fd.tokenBy === 'token' ? (
              <Field label="The token’s id" hint={kind === 'near' ? 'Its NEAR account.' : 'Its contract (C…).'}>
                {(c) => <input {...c} className="jp-input mono" value={fd.token} onChange={(e) => set((x) => void (x.token = e.target.value.trim()))} />}
              </Field>
            ) : (
              <Field label="The argument that names it">
                {(c) => (
                  <select {...c} className="jp-input" value={fd.tokenPath} onChange={(e) => set((x) => void (x.tokenPath = e.target.value))}>
                    <option value="">Choose an argument</option>
                    {f.args
                      .filter((a) => argFamily(a.type) === 'account' && a.name !== '')
                      .map((a) => (
                        <option key={a.name} value={`args.${a.name}`}>
                          {a.name}
                        </option>
                      ))}
                  </select>
                )}
              </Field>
            )}
          </>
        )}
        {(fd.format === 'date' || fd.format === 'duration') && (
          <Field label="Its unit">
            {(c) => (
              <select {...c} className="jp-input" value={fd.unit} onChange={(e) => set((x) => void (x.unit = e.target.value as FieldDraft['unit']))}>
                <option value="seconds">seconds</option>
                <option value="milliseconds">milliseconds</option>
                <option value="nanoseconds">nanoseconds</option>
              </select>
            )}
          </Field>
        )}
        {fd.format === 'count' && (
          <>
            <Field label="Least">{(c) => <input {...c} className="jp-input mono" inputMode="numeric" value={fd.min} onChange={(e) => set((x) => void (x.min = e.target.value.trim()))} />}</Field>
            <Field label="Most">{(c) => <input {...c} className="jp-input mono" inputMode="numeric" value={fd.max} onChange={(e) => set((x) => void (x.max = e.target.value.trim()))} />}</Field>
          </>
        )}
      </div>
    </div>
  );
}

/** A sentence part as the builder names it. */
function partText(p: PartDraft, f: FormatDraft, kind: LabelKind): string {
  if (p.kind === 'verb') return f.verb === '' ? '(the verb)' : f.verb;
  if (p.kind === 'object') return f.object === '' ? '(your phrase)' : f.object;
  if (p.kind === 'word') return p.word;
  return pathsOf(kind, f).find((x) => x.path === p.path)?.text.replace(/^The /u, 'the ') ?? p.path;
}

/** The sentence, part by part: the verb first, then joining words, your phrase and values, each movable by keyboard. */
function SentenceBuilder({ kind, f, fi, set, errs }: { kind: LabelKind; f: FormatDraft; fi: number; set: (g: (x: FormatDraft) => void) => void; errs: Errs }) {
  const [word, setWord] = useState<string>(PARTNER_CONNECTORS[0]);
  const [value, setValue] = useState('');
  const shown = f.fields.map((x) => x.path).filter((p) => !f.sentence.some((s) => s.kind === 'field' && s.path === p));
  const move = (i: number, by: -1 | 1) =>
    set((x) => {
      const [p] = x.sentence.splice(i, 1);
      x.sentence.splice(i + by, 0, p!);
    });
  const error = errs(`f.${fi}.sentence`);
  const id = useId();
  return (
    <fieldset className="labels-sentence" aria-describedby={error ? `${id}-err` : undefined}>
      <legend>The sentence</legend>
      <p className="muted small">Journear writes the sentence from these parts, in this order: the verb first, then your phrase, joining words and values from the request.</p>
      {kind === 'stellar' && <p className="muted small">{PAYMENT_NAME_NOTE}</p>}
      <ol className="sentence-parts">
        {f.sentence.map((p, i) => (
          <li key={i} className={`sentence-part part-${p.kind}`}>
            <span className="part-text">{partText(p, f, kind)}</span>
            {i > 0 && (
              <span className="part-tools">
                <button type="button" className="jp-btn jp-btn-ghost jp-btn-sm" disabled={i <= 1} aria-label={`Move “${partText(p, f, kind)}” earlier`} onClick={() => move(i, -1)}>
                  ←
                </button>
                <button type="button" className="jp-btn jp-btn-ghost jp-btn-sm" disabled={i === f.sentence.length - 1} aria-label={`Move “${partText(p, f, kind)}” later`} onClick={() => move(i, 1)}>
                  →
                </button>
                <button type="button" className="jp-btn jp-btn-ghost jp-btn-sm" aria-label={`Take “${partText(p, f, kind)}” out`} onClick={() => set((x) => void x.sentence.splice(i, 1))}>
                  ×
                </button>
              </span>
            )}
          </li>
        ))}
      </ol>
      <div className="sentence-add">
        <label className="inline-field">
          <span>Joining word</span>
          <select className="jp-input" value={word} onChange={(e) => setWord(e.target.value)}>
            {PARTNER_CONNECTORS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="jp-btn jp-btn-secondary jp-btn-sm" onClick={() => set((x) => void x.sentence.push({ kind: 'word', word }))}>
          Add the word
        </button>
        {f.object !== '' && !f.sentence.some((p) => p.kind === 'object') && (
          <button type="button" className="jp-btn jp-btn-secondary jp-btn-sm" onClick={() => set((x) => void x.sentence.push({ kind: 'object' }))}>
            Add your phrase
          </button>
        )}
        {shown.length > 0 && (
          <>
            <label className="inline-field">
              <span>Value</span>
              <select className="jp-input" value={value || shown[0]} onChange={(e) => setValue(e.target.value)}>
                {shown.map((p) => (
                  <option key={p} value={p}>
                    {pathsOf(kind, f).find((x) => x.path === p)?.text ?? p}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="jp-btn jp-btn-secondary jp-btn-sm" onClick={() => set((x) => void x.sentence.push({ kind: 'field', path: shown.includes(value) ? value : shown[0]! }))}>
              Add the value
            </button>
          </>
        )}
      </div>
      {error && (
        <p className="jp-error" id={`${id}-err`}>
          {error}
        </p>
      )}
    </fieldset>
  );
}

/**
 * Which verbs the parser refuses for this format as it stands, disabled, each with why: a "no value moves" verb on a
 * request that can move value, or a verb that doesn't say the user sends money on a payment.
 */
function refusedVerbs(d: Draft, fi: number, env: Environment): Map<string, string> {
  const out = new Map<string, string>();
  for (const v of PARTNER_VERBS) {
    const copy = structuredClone(d);
    copy.formats[fi]!.verb = v;
    const r = parseLabelDocument(toDocumentText(copy, env));
    if (!r.ok && r.errors.some((e) => e.code === 'bad_verb' && e.path === `display.formats.${copy.formats[fi]!.key}.intent.verb`)) out.set(v, d.kind === 'stellar' ? 'not for a payment' : 'says nothing moves: not for this request');
  }
  return out;
}

function FormatEditor({ d, f, fi, env, set, errs, removable, appName }: { d: Draft; f: FormatDraft; fi: number; env: Environment; set: (g: (x: FormatDraft) => void) => void; errs: Errs; removable: (() => void) | null; appName: string }) {
  const kind = d.kind;
  const refused = useMemo(() => refusedVerbs(d, fi, env), [d, fi, env]);
  const { sentence, accounts } = useMemo(() => {
    const r = parseLabelDocument(toDocumentText(d, env));
    if (!r.ok) return { sentence: null, accounts: [] as string[] };
    return { sentence: previewLabelDocument(r.document, appName).find((x) => x.key === f.key)?.line ?? null, accounts: kind === 'stellar' ? addressBookLines(r.document) : [] };
  }, [d, env, f.key, appName, kind]);
  return (
    <fieldset className="labels-section labels-format">
      <legend>{kind === 'stellar' ? 'The payment' : `Request ${fi + 1}${f.key ? `: ${f.key}` : ''}`}</legend>
      {kind === 'stellar' && (
        <Callout tone="warn" role="note" title="Before you describe payments">
          <p>{WARN_PAYMENT_RED}</p>
        </Callout>
      )}
      {kind !== 'stellar' && (
        <div className="labels-row-edit">
          <Field label={kind === 'near' ? 'The method’s exact name' : 'The function’s exact name'} error={errs(`f.${fi}`)}>
            {(c) => <input {...c} className="jp-input mono" value={f.key} onChange={(e) => set((x) => void (x.key = e.target.value.trim()))} />}
          </Field>
          {removable && (
            <button type="button" className="jp-btn jp-btn-ghost jp-btn-sm" onClick={removable}>
              Remove this request
            </button>
          )}
        </div>
      )}
      <div className="labels-row-edit">
        <Field label="The verb" hint="From Journear’s list: Journear writes it, so it is always one of these." error={errs(`f.${fi}.verb`)}>
          {(c) => (
            <select {...c} className="jp-input" value={f.verb} onChange={(e) => set((x) => void (x.verb = e.target.value))}>
              {f.verb === '' && <option value="">Choose a verb</option>}
              {!(PARTNER_VERBS as readonly string[]).includes(f.verb) && f.verb !== '' && <option value={f.verb}>{f.verb}</option>}
              {PARTNER_VERBS.map((v) => (
                <option key={v} value={v} disabled={refused.has(v) && v !== f.verb}>
                  {refused.has(v) ? `${v} (${refused.get(v)})` : v}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Your phrase" optional hint="Up to 30 characters, as “order” or “the stamp”: plain words, no amounts, links or claims." error={errs(`f.${fi}.object`)}>
          {(c) => (
            <input
              {...c}
              className="jp-input"
              value={f.object}
              onChange={(e) =>
                set((x) => {
                  const had = x.object !== '';
                  x.object = e.target.value;
                  // The phrase and its place in the sentence come and go together.
                  if (!had && x.object !== '' && !x.sentence.some((p) => p.kind === 'object')) x.sentence.push({ kind: 'object' });
                  if (x.object === '') x.sentence = x.sentence.filter((p) => p.kind !== 'object');
                })
              }
            />
          )}
        </Field>
      </div>

      {kind === 'stellar' && (
        <fieldset className="labels-sub">
          <legend>When it matches</legend>
          <Field label="The memo" error={errs(`f.${fi}.memo`)} hint="What the payment carries to say what it is for.">
            {(c) => (
              <select
                {...c}
                className="jp-input"
                value={f.memo}
                onChange={(e) =>
                  set((x) => {
                    x.memo = e.target.value as FormatDraft['memo'];
                    if (x.memo === 'none') {
                      x.fields = [];
                      x.sentence = x.sentence.filter((p) => p.kind !== 'field');
                    } else if (x.fields.length === 0) {
                      x.fields = [{ ...emptyField('memo', 'orderNumber'), label: 'Order' }];
                      x.sentence.push({ kind: 'field', path: 'memo' });
                    }
                  })
                }
              >
                <option value="none">No memo</option>
                <option value="text">A text memo</option>
                <option value="id">A number memo</option>
              </select>
            )}
          </Field>
          <Field label="Only these assets" optional hint="One per line: native (XLM) or CODE:ISSUER. Empty: any asset." error={errs(`f.${fi}.assets`)}>
            {(c) => <LinesInput id={c.id} describedBy={c['aria-describedby']} invalid={c['aria-invalid']} value={f.assets} onChange={(v) => set((x) => void (x.assets = v))} />}
          </Field>
          <Field label="Highest amount" optional hint="In the asset’s units, as 100 or 2.5." error={errs(`f.${fi}.amount`)}>
            {(c) => <AmountInput id={c.id} describedBy={c['aria-describedby']} invalid={c['aria-invalid']} raw={f.amountAtMost} decimals={STELLAR_DECIMALS} unit="units" onChange={(r) => set((x) => void (x.amountAtMost = r))} />}
          </Field>
          <Field label="Highest network fee" optional hint="In XLM." error={errs(`f.${fi}.fee`)}>
            {(c) => <AmountInput id={c.id} describedBy={c['aria-describedby']} invalid={c['aria-invalid']} raw={f.feeAtMost} decimals={STELLAR_DECIMALS} unit="XLM" onChange={(r) => set((x) => void (x.feeAtMost = r))} />}
          </Field>
          {f.feeAtMost === '' && (
            <Callout tone="info" role="note">
              <p>{SUGGEST_FEE}</p>
              <button type="button" className="jp-btn jp-btn-secondary jp-btn-sm" onClick={() => set((x) => void (x.feeAtMost = '100000'))}>
                Use 0.01 XLM
              </button>
            </Callout>
          )}
        </fieldset>
      )}

      {kind === 'near' && (
        <fieldset className="labels-sub">
          <legend>When it matches</legend>
          <div className="labels-row-edit">
            <Field label="The NEAR it attaches" error={errs(`f.${fi}.deposit`)}>
              {(c) => (
                <select {...c} className="jp-input" value={f.depositKind} onChange={(e) => set((x) => void (x.depositKind = e.target.value as FormatDraft['depositKind']))}>
                  <option value="exactly">Exactly</option>
                  <option value="atMost">At most</option>
                </select>
              )}
            </Field>
            <Field label="Amount">{(c) => <AmountInput id={c.id} describedBy={c['aria-describedby']} raw={f.deposit} decimals={NEAR_DECIMALS} unit="NEAR" onChange={(r) => set((x) => void (x.deposit = r === '' ? '0' : r))} />}</Field>
            <Field label="Most gas" optional error={errs(`f.${fi}.gas`)}>
              {(c) => <AmountInput id={c.id} describedBy={c['aria-describedby']} invalid={c['aria-invalid']} raw={f.gasAtMost} decimals={TGAS_DECIMALS} unit="TGas" onChange={(r) => set((x) => void (x.gasAtMost = r))} />}
            </Field>
          </div>
          <Field label="Who sends it" error={errs(`f.${fi}.relayed`)}>
            {(c) => (
              <select {...c} className="jp-input" value={f.relayed} onChange={(e) => set((x) => void (x.relayed = e.target.value as FormatDraft['relayed']))}>
                {(['either', 'relayed', 'direct'] as const).map((r) => (
                  <option key={r} value={r}>
                    {RELAY_TEXT[r]}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </fieldset>
      )}

      {kind === 'soroban' && (
        <fieldset className="labels-sub">
          <legend>When it matches</legend>
          <Field label="Highest network fee" optional hint="In XLM." error={errs(`f.${fi}.fee`)}>
            {(c) => <AmountInput id={c.id} describedBy={c['aria-describedby']} invalid={c['aria-invalid']} raw={f.feeAtMost} decimals={STELLAR_DECIMALS} unit="XLM" onChange={(r) => set((x) => void (x.feeAtMost = r))} />}
          </Field>
          <Field label="Who sends it" error={errs(`f.${fi}.relayed`)}>
            {(c) => (
              <select {...c} className="jp-input" value={f.relayed} onChange={(e) => set((x) => void (x.relayed = e.target.value as FormatDraft['relayed']))}>
                {(['either', 'relayed', 'direct'] as const).map((r) => (
                  <option key={r} value={r}>
                    {RELAY_TEXT[r]}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </fieldset>
      )}

      {kind !== 'stellar' && (
        <fieldset className="labels-sub">
          <legend>Its arguments</legend>
          <p className="muted small">Every argument the request carries. A request with one you don’t list doesn’t match.</p>
          {errs(`f.${fi}.args`) && <p className="jp-error section-error">{errs(`f.${fi}.args`)}</p>}
          {f.args.map((a, i) => (
            <div key={i} className="labels-arg-wrap">
              <ArgEditor kind={kind} a={a} i={i} fi={fi} errs={errs} set={(g) => set((x) => g(x.args[i]!))} />
              <button type="button" className="jp-btn jp-btn-ghost jp-btn-sm" aria-label={`Remove argument ${i + 1}`} onClick={() => set((x) => void x.args.splice(i, 1))}>
                Remove argument
              </button>
            </div>
          ))}
          {f.args.length < LABEL_LIMITS.args && (
            <button type="button" className="jp-btn jp-btn-secondary jp-btn-sm" onClick={() => set((x) => void x.args.push(emptyArg(`arg${x.args.length + 1}`)))}>
              Add an argument
            </button>
          )}
        </fieldset>
      )}

      {kind !== 'stellar' && (
        <fieldset className="labels-sub">
          <legend>Values users see</legend>
          <p className="muted small">Each is the request’s own value, in the sentence or as a row under it. Accounts, amounts and tokens must be shown.</p>
          {errs(`f.${fi}.fields`) && <p className="jp-error section-error">{errs(`f.${fi}.fields`)}</p>}
          {f.fields.map((fd, i) => (
            <div key={i} className="labels-field-wrap">
              <FieldEditor kind={kind} d={d} f={f} fd={fd} i={i} fi={fi} errs={errs} set={(g) => set((x) => g(x.fields[i]!))} />
              <button
                type="button"
                className="jp-btn jp-btn-ghost jp-btn-sm"
                aria-label={`Remove shown value ${i + 1}`}
                onClick={() =>
                  set((x) => {
                    const [gone] = x.fields.splice(i, 1);
                    x.sentence = x.sentence.filter((p) => !(p.kind === 'field' && p.path === gone?.path));
                  })
                }
              >
                Remove value
              </button>
            </div>
          ))}
          {f.fields.length < LABEL_LIMITS.fields && pathsOf(kind, f).length > 0 && (
            <button
              type="button"
              className="jp-btn jp-btn-secondary jp-btn-sm"
              onClick={() =>
                set((x) => {
                  const free = pathsOf(kind, x).find((p) => !x.fields.some((y) => y.path === p.path)) ?? pathsOf(kind, x)[0]!;
                  x.fields.push(emptyField(free.path, formatsFor(kind, free.type)[0] ?? 'itemId'));
                })
              }
            >
              Add a value
            </button>
          )}
        </fieldset>
      )}

      {kind === 'stellar' && f.memo !== 'none' && f.fields[0] && (
        <div className="labels-row-edit">
          <Field label="The memo is" error={errs(`f.${fi}.field.0`)}>
            {(c) => (
              <select {...c} className="jp-input" value={f.fields[0]!.format} onChange={(e) => set((x) => void (x.fields[0]!.format = e.target.value as FieldFormat))}>
                <option value="orderNumber">An order number</option>
                <option value="itemId">An item id</option>
              </select>
            )}
          </Field>
          <Field label="Its label for users" hint={MEMO_LABEL_HINT}>
            {(c) => <input {...c} className="jp-input" value={f.fields[0]!.label} onChange={(e) => set((x) => void (x.fields[0]!.label = e.target.value))} />}
          </Field>
        </div>
      )}

      <SentenceBuilder kind={kind} f={f} fi={fi} set={set} errs={errs} />
      {sentence !== null && (
        <p className="sentence-now">
          <span className="muted small">Reads: </span>
          <span className="labels-line">{sentence}</span>
        </p>
      )}
      {sentence !== null && accounts.length > 1 && (
        <p className="muted small">The example pays your first account; a payment to another ends with that account’s name instead.</p>
      )}
      {sentence !== null && <AccountLines accounts={accounts} />}
    </fieldset>
  );
}

/**
 * D900: "Read it from the network": the console's own NEAR endpoint's answer for the account, shown for the partner to
 * check; the code hash is filled only when they press "Use this code hash". The approval window's vault reads the code
 * itself, from two providers, whatever is typed here.
 */
function NearCodeRead({ account, env, read, current, use }: { account: string; env: Environment; read: (account: string) => Promise<NearCodeAnswer>; current: string; use: (hash: string) => void }) {
  const [state, setState] = useState<{ for: string; answer: NearCodeAnswer } | { for: string; failed: true } | { for: string; busy: true } | null>(null);
  const network = env === 'test' ? 'the NEAR test network' : 'the NEAR main network';
  const shown = state && state.for === account ? state : null;
  return (
    <div className="near-code-read" aria-live="polite">
      <button
        type="button"
        className="jp-btn jp-btn-secondary jp-btn-sm"
        disabled={account === '' || (shown !== null && 'busy' in shown)}
        onClick={() => {
          const a = account;
          setState({ for: a, busy: true });
          read(a).then(
            (answer) => setState({ for: a, answer }),
            () => setState({ for: a, failed: true }),
          );
        }}
      >
        Read it from the network
      </button>
      {shown && 'failed' in shown && <p className="jp-error">Journear couldn’t read the network just now. Try again, or type the code hash.</p>}
      {shown && 'answer' in shown && (!shown.answer.exists || (!shown.answer.sharedCode && shown.answer.codeHash === null)) && <p>This account has no program on {network}.</p>}
      {shown && 'answer' in shown && shown.answer.exists && shown.answer.sharedCode && (
        <p>This account runs shared code another account publishes, so its code can change without it: Journear doesn’t show labels for it.</p>
      )}
      {shown && 'answer' in shown && shown.answer.exists && !shown.answer.sharedCode && shown.answer.codeHash !== null && (
        <div className="near-code-answer">
          <p>
            On {network} now: <code className="mono">{shown.answer.codeHash}</code>
          </p>
          <p className="muted small">Check it is the code you deployed before you use it.</p>
          {current === shown.answer.codeHash ? (
            <p className="muted small">The code hash above is this one.</p>
          ) : (
            <button type="button" className="jp-btn jp-btn-secondary jp-btn-sm" onClick={() => use((shown.answer as { codeHash: string }).codeHash)}>
              Use this code hash
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const KIND_CHOICES = [
  { value: 'stellar' as const, title: 'Payments to your accounts (Stellar)', detail: 'A user pays one of your Stellar accounts.' },
  { value: 'near' as const, title: 'A NEAR program', detail: 'Calls to your NEAR program’s methods, while it runs the code you name.' },
  { value: 'soroban' as const, title: 'A Soroban contract', detail: 'Calls to your Stellar smart contract’s functions, in transactions your users sign in full.' },
];

/** The scope's network in words (the one every document of this scope describes). */
export const networkWords = (kind: LabelKind, env: Environment): string =>
  kind === 'near' ? (env === 'test' ? 'the NEAR test network (testnet)' : 'the NEAR main network (mainnet)') : env === 'test' ? 'the Stellar test network' : 'the Stellar public network';
export const otherNetworkNote = (kind: LabelKind, env: Environment): string => `This text named another network. It will be saved for ${networkWords(kind, env)}.`;

/** The whole editor: the form (or the advanced text), its problems, the preview, and Review. */
export function LabelsEditor(p: EditorProps) {
  const env = p.environment;
  const start = useMemo(() => {
    if (p.initialText === undefined) return { draft: emptyDraft('stellar'), text: toDocumentText(emptyDraft('stellar'), env), blocked: null as string | null, network: false };
    const r = fromDocumentText(p.initialText, env);
    return r.ok ? { draft: r.draft, text: p.initialText, blocked: null, network: r.networkChanged } : { draft: null, text: p.initialText, blocked: r.reason, network: false };
    // The editor starts once per entry: the page gives it a new key for another one.
  }, []);
  const [draft, setDraft] = useState<Draft | null>(start.draft);
  const [text, setText] = useState(start.text);
  const [blocked, setBlocked] = useState<string | null>(start.blocked);
  const [advanced, setAdvanced] = useState(start.blocked !== null);
  const [appIds, setAppIds] = useState<string[]>([...p.initialApps]);
  /** The text names another network than the scope's: the form will write the scope's (said before it does). */
  const [otherNetwork, setOtherNetwork] = useState(start.network);
  /** "See an example" on a form with something typed: asked in the page first, never replaced without a yes. */
  const [askExample, setAskExample] = useState(false);
  /** The form was filled from the example (its note shows while any of the example is left). */
  const [fromExample, setFromExample] = useState(false);
  const exampleButton = useRef<HTMLButtonElement>(null);
  const firstField = useRef<HTMLDivElement>(null);
  const id = useId();
  /** After the question is answered, focus goes back to the button, or to the form's first account when it filled. */
  const focusAfter = (filled: boolean) =>
    requestAnimationFrame(() => {
      const account = filled ? firstField.current?.querySelector<HTMLInputElement>('input') : null;
      (account ?? exampleButton.current)?.focus();
    });
  const fillExample = (asked: boolean) => {
    const ex = draft ? exampleDraft(draft.kind) : null;
    if (!ex) return;
    setDraft(ex);
    setText(toDocumentText(ex, env));
    setOtherNetwork(false);
    setAskExample(false);
    setFromExample(true);
    if (asked) focusAfter(true);
  };

  const set = (f: (d: Draft) => void) => {
    if (!draft) return;
    const next = structuredClone(draft);
    f(next);
    setDraft(next);
    setText(toDocumentText(next, env));
    setOtherNetwork(false);
  };
  const onText = (t: string) => {
    setText(t);
    const r = fromDocumentText(t, env);
    if (r.ok) {
      setDraft(r.draft);
      setBlocked(null);
      setOtherNetwork(r.networkChanged);
    } else {
      setBlocked(r.reason);
      setOtherNetwork(false);
    }
  };
  /** What Review sends: the text as it is, or the form's (on the scope's network) when the text named another. */
  const review = () => {
    if (otherNetwork && draft) {
      const fixed = toDocumentText(draft, env);
      setText(fixed);
      setOtherNetwork(false);
      p.onReview(fixed, sortedApps);
    } else p.onReview(text, sortedApps);
  };

  const parsed = useMemo(() => parseLabelDocument(text), [text]);
  const doc: LabelDocument | null = parsed.ok ? parsed.document : null;
  const problems = useMemo(() => problemsOf(text, blocked ? null : draft), [text, draft, blocked]);
  const appProblem = appIds.length === 0 ? 'Choose at least one app.' : appIds.length > 8 ? 'At most 8 apps.' : null;
  const known = new Set(controlKeys(draft));
  const placed = (k: string) => (known.has(k) ? k : 'general');
  const errs: Errs = (k) => messages(problems.filter((x) => placed(x.key) === k));
  const general = problems.filter((x) => placed(x.key) === 'general');
  const count = problems.length + (appProblem ? 1 : 0);
  const sortedApps = [...appIds].sort();
  const appName = p.apps.find((a) => a.id === sortedApps[0])?.name ?? p.apps[0]?.name ?? 'Your app';

  return (
    <div className="labels-editor">
      <div className="labels-form" id={`${id}-form`}>
        <p className="labels-jump">
          <a href={`#${id}-preview`}>See the preview</a>
        </p>
        <p className="sr-status" role="status" aria-live="polite">
          {count === 0 ? 'No problems: ready to review.' : count === 1 ? '1 problem to fix.' : `${count} problems to fix.`}
        </p>
        {draft && !p.existing && (
          <ChoiceCards
            legend="What your labels describe"
            name={`${id}-kind`}
            value={draft.kind}
            options={KIND_CHOICES}
            onChange={(k) => {
              const next = emptyDraft(k);
              setDraft(next);
              setText(toDocumentText(next, env));
              setFromExample(false);
              setAskExample(false);
            }}
          />
        )}
        {draft && !p.existing && !blocked && exampleDraft(draft.kind) && (
          <div className="labels-example">
            <button ref={exampleButton} type="button" className="jp-btn jp-btn-secondary jp-btn-sm" aria-describedby={`${id}-example`} aria-expanded={askExample || undefined} onClick={() => (isEmptyDraft(draft) ? fillExample(false) : setAskExample(true))}>
              {EXAMPLE_BUTTON}
            </button>
            <span id={`${id}-example`} className="muted small">
              {' '}
              {EXAMPLE_INTRO}
            </span>
            {askExample && (
              <Callout tone="warn" role="alert">
                <p>{EXAMPLE_CONFIRM}</p>
                <p className="labels-example-choice">
                  <button type="button" className="jp-btn jp-btn-secondary jp-btn-sm" onClick={() => fillExample(true)}>
                    Replace with the example
                  </button>{' '}
                  <button
                    type="button"
                    className="jp-btn jp-btn-ghost jp-btn-sm"
                    onClick={() => {
                      setAskExample(false);
                      focusAfter(false);
                    }}
                  >
                    Keep what I typed
                  </button>
                </p>
              </Callout>
            )}
          </div>
        )}
        {draft && fromExample && exampleLeft(draft) && (
          <Callout tone="warn" role="note" title="An example">
            <p>{EXAMPLE_NOTE}</p>
          </Callout>
        )}
        {draft && draft.kind !== 'stellar' && (
          <Callout tone="info" title={CODE_TIED_TITLE}>
            <p>{draft.kind === 'near' ? CODE_TIED_NEAR : CODE_TIED_SOROBAN}</p>
            {draft.kind === 'near' && env === 'live' && <p>{NEAR_LIVE_RELAYED}</p>}
            {draft.kind === 'soroban' && <p>{SOROBAN_SOFT_VERBS}</p>}
          </Callout>
        )}

        <fieldset className="labels-section">
          <legend>Apps</legend>
          <p className="muted small">The apps whose requests these labels describe. Users see your words under the name of the app they’re using. This preview uses {appName}.</p>
          <div className="labels-apps" aria-describedby={appProblem ? `${id}-apps-err` : undefined}>
            {p.apps.map((a) => (
              <label key={a.id} className="jp-check">
                <input type="checkbox" checked={appIds.includes(a.id)} onChange={(e) => setAppIds((l) => (e.target.checked ? [...l, a.id] : l.filter((x) => x !== a.id)))} /> {a.name} <span className="muted mono small">{a.id}</span>
              </label>
            ))}
          </div>
          {appProblem && (
            <p className="jp-error" id={`${id}-apps-err`}>
              {appProblem}
            </p>
          )}
        </fieldset>

        {general.length > 0 && (
          <Callout tone="danger" title="Fix these first">
            <ul className="problems">
              {general.map((x, i) => (
                <li key={i}>{x.message}</li>
              ))}
            </ul>
          </Callout>
        )}

        {otherNetwork && draft && (
          <Callout tone="info" role="status">
            {otherNetworkNote(draft.kind, env)}
          </Callout>
        )}
        {blocked && (
          <Callout tone="warn" role="status" title="The form can’t show this text">
            <p>{blocked} Fix it in the text below, or start again from the form.</p>
            <button
              type="button"
              className="jp-btn jp-btn-secondary jp-btn-sm"
              onClick={() => {
                const d = draft ?? emptyDraft('stellar');
                setDraft(d);
                setText(toDocumentText(d, env));
                setBlocked(null);
              }}
            >
              Start again from the form
            </button>
          </Callout>
        )}

        {draft && !blocked && (
          <>
            {draft.kind === 'near' && (
              <fieldset className="labels-section">
                <legend>Your NEAR program</legend>
                <div className="labels-row-edit">
                  <Field label="Its account" error={errs('context.account')}>
                    {(c) => <input {...c} className="jp-input mono" value={draft.nearAccount} placeholder={env === 'test' ? 'stamps.example.testnet' : 'stamps.example.near'} onChange={(e) => set((x) => void (x.nearAccount = e.target.value.trim()))} />}
                  </Field>
                  <Field label="Its code hash" hint={NEAR_CODE_HINT} error={errs('context.hash')}>
                    {(c) => <input {...c} className="jp-input mono" value={draft.codeHash} onChange={(e) => set((x) => void (x.codeHash = e.target.value.trim()))} />}
                  </Field>
                </div>
                {p.readNearCode && <NearCodeRead account={draft.nearAccount} env={env} read={p.readNearCode} current={draft.codeHash} use={(h) => set((x) => void (x.codeHash = h))} />}
              </fieldset>
            )}
            {draft.kind === 'soroban' && (
              <fieldset className="labels-section">
                <legend>Your Soroban contract</legend>
                <div className="labels-row-edit">
                  <Field label="Its contract id" error={errs('context.account')}>
                    {(c) => <input {...c} className="jp-input mono" value={draft.contract} placeholder="C…" onChange={(e) => set((x) => void (x.contract = e.target.value.trim()))} />}
                  </Field>
                  <Field label="Its Wasm hash" hint={WASM_HASH_HINT} error={errs('context.hash')}>
                    {(c) => <input {...c} className="jp-input mono" value={draft.wasmHash} onChange={(e) => set((x) => void (x.wasmHash = e.target.value.trim()))} />}
                  </Field>
                </div>
              </fieldset>
            )}
            <div ref={firstField}>
              <AddressBook d={draft} set={set} errs={errs} />
            </div>
            {draft.kind !== 'stellar' && <Enums d={draft} set={set} errs={errs} />}
            {errs('formats') && <p className="jp-error section-error">{errs('formats')}</p>}
            {draft.formats.map((f, fi) => (
              <FormatEditor key={fi} d={draft} f={f} fi={fi} env={env} errs={errs} set={(g) => set((x) => g(x.formats[fi]!))} removable={draft.kind === 'stellar' ? null : () => set((x) => void x.formats.splice(fi, 1))} appName={appName} />
            ))}
            {draft.kind !== 'stellar' && draft.formats.length < LABEL_LIMITS.formats && (
              <button type="button" className="jp-btn jp-btn-secondary" onClick={() => set((x) => void x.formats.push(emptyFormat(x.kind)))}>
                Describe a{draft.formats.length ? 'nother' : ''} request
              </button>
            )}
          </>
        )}

        <details className="labels-advanced" open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
          <summary>Advanced: the document’s text</summary>
          <p className="muted small">The form writes this for you. You can edit it here instead; the form follows when it can show what you wrote.</p>
          <Field label="The document (journear-labels/1)">
            {(c) => <textarea {...c} className="jp-input mono labels-text" rows={18} spellCheck={false} value={text} onChange={(e) => onText(e.target.value)} />}
          </Field>
        </details>

        <div className="form-actions labels-actions">
          {p.canPropose ? (
            <button type="button" className="jp-btn jp-btn-primary" disabled={p.busy || count > 0} onClick={review}>
              Review the change
            </button>
          ) : null}
          <button type="button" className="jp-btn jp-btn-ghost" onClick={p.onCancel}>
            Back to the list
          </button>
        </div>
        {!p.canPropose && p.whyNot && <div className="labels-why">{p.whyNot}</div>}
        {p.canPropose && count > 0 && <p className="muted small">Fix the problems above to review the change.</p>}
      </div>
      <div className="labels-side" id={`${id}-preview`} tabIndex={-1}>
        <LabelsPreview doc={doc} appName={appName} environment={env} problems={problems.length} />
        <p className="labels-jump">
          <a href={`#${id}-form`}>Back to the form</a>
        </p>
      </div>
    </div>
  );
}

/** Every form control a problem can be placed beside, for this draft (anything else is a general problem). */
export function controlKeys(d: Draft | null): string[] {
  if (!d) return ['general'];
  const keys = ['general', 'book', 'formats'];
  if (d.kind !== 'stellar') keys.push('context.account', 'context.hash', 'enums');
  d.addressBook.forEach((_, i) => keys.push(`book.${i}.account`, `book.${i}.name`));
  if (d.kind !== 'stellar') d.enums.forEach((e, i) => keys.push(`enum.${i}`, ...e.values.map((_, j) => `enum.${i}.v.${j}`)));
  d.formats.forEach((f, i) => {
    const k = `f.${i}`;
    keys.push(`${k}.verb`, `${k}.object`, `${k}.sentence`);
    if (d.kind === 'stellar') {
      keys.push(`${k}.memo`, `${k}.assets`, `${k}.amount`, `${k}.fee`);
      if (f.memo !== 'none' && f.fields[0]) keys.push(`${k}.field.0`);
    } else {
      keys.push(k, `${k}.relayed`, `${k}.args`, `${k}.fields`, ...f.args.map((_, j) => `${k}.arg.${j}`), ...f.fields.map((_, j) => `${k}.field.${j}`));
      if (d.kind === 'near') keys.push(`${k}.deposit`, `${k}.gas`);
      else keys.push(`${k}.fee`);
    }
  });
  return keys;
}
