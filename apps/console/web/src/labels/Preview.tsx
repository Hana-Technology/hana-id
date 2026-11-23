// The live preview of request labels (D899): the approval window as users would see it, with example values. For a
// classic payment it is the window itself: Journear's own `renderApproval` (packages/web, the code the approval window
// runs, imported, never copied, as the consent preview does, D352) over an example payment read by Journear's own
// decoder, with the document as the window's partner labels. So the box, its wording and the amber and red lines are
// exactly the window's. The partner switches between a payment that matches, one that doesn't (the amber line) and one
// to an account its list doesn't have (the red line), in light and dark, at a phone's width. Its DOM is built with
// text nodes only (packages/web dom.ts), mounted into a container React owns.
//
// D900: NEAR programs and Soroban contracts too, through the same renderer: a call that matches (the program runs the
// code the labels name) and the same call after a code change (the amber line), built and decoded as the window does,
// with the code hash as the vault would read it (NEAR) or as the transaction's footprint names it (Soroban).
import type { LabelDocument } from '@hana-id/core/partner-labels';
import { useEffect, useId, useRef, useState } from 'react';
import { dom } from '../../../../../packages/web/src/auth/dom.ts';
import { renderApproval } from '../../../../../packages/web/src/auth/render-approval.ts';
import { CONTRACT_EXAMPLE_TITLES, type ContractExampleKind, EXAMPLE_TITLES, EXAMPLE_USER, type ExampleKind, contractExample, paymentExample } from './examples.ts';
import { EXAMPLE_MARK, windowRoot } from '../window/frame.ts';

const KINDS: readonly ExampleKind[] = ['match', 'mismatch', 'not_listed'];
const CONTRACT_KINDS: readonly ContractExampleKind[] = ['match', 'code_changed'];

/** What each contract example shows (D900). */
const CONTRACT_NOTES: Readonly<Record<ContractExampleKind, string>> = Object.freeze({
  match: 'Your words show in their own box, under everything Journear says, while the program runs the code your labels name.',
  code_changed: 'After a code change Journear doesn’t show your words, and adds an amber line: the request doesn’t match your description.',
});

/** What each example shows, in a line under the switch. */
const EXAMPLE_NOTES: Readonly<Record<ExampleKind, string>> = Object.freeze({
  match: 'Your words show in their own box, under everything Journear says.',
  mismatch: 'Journear doesn’t show your words, and adds an amber line: the request doesn’t match your description.',
  not_listed: 'Journear adds a red line: the money goes to an account your list doesn’t have.',
});

/** A segmented switch (radio buttons): keyboard and screen readers get it as one group. */
function Segmented<T extends string>({ legend, name, value, options, onChange }: { legend: string; name: string; value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <fieldset className="segmented">
      <legend className="jp-label">{legend}</legend>
      <div className="segmented-options">
        {options.map((o) => (
          <label key={o.value} className={`segmented-option${value === o.value ? ' on' : ''}`}>
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * The window for one example request, built by the window's own renderer, inside a shadow root with the popup's
 * stylesheet (window/frame.ts): the frame in the chosen scheme, the example mark first, then the window's body.
 */
function WindowFrame({ doc, appName, example, environment, theme }: { doc: LabelDocument; appName: string; example: ExampleKind | ContractExampleKind; environment: 'test' | 'live'; theme: 'light' | 'dark' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [why, setWhy] = useState<string | null>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const root = windowRoot(host);
    const ex = doc.context.chain === 'stellar' ? paymentExample(doc, example as ExampleKind) : contractExample(doc, example as ContractExampleKind, environment);
    if (!ex.ok) {
      setWhy(ex.why);
      root.replaceChildren();
      return;
    }
    setWhy(null);
    const d = dom(document);
    try {
      const user = 'user' in ex ? ex.user : EXAMPLE_USER;
      const facts = 'labelFacts' in ex && ex.labelFacts ? { labelFacts: ex.labelFacts } : {};
      const body = renderApproval(d, ex.decoded, appName, { envNetwork: environment === 'test' ? 'testnet' : 'mainnet', testApp: environment === 'test', address: user, partnerLabels: [doc], ...facts, nowMs: Date.now() });
      root.replaceChildren(d.h('div', { class: `window-frame ${theme === 'dark' ? 'jp-dark' : 'jp-light'}`, attrs: { 'data-example': example } }, d.h('p', { class: 'example-mark' }, EXAMPLE_MARK), d.h('div', { class: 'window-preview' }, body)));
    } catch {
      setWhy('This example can’t be shown yet: fix the problems in the form.');
      root.replaceChildren();
    }
    return () => root.replaceChildren();
  }, [doc, appName, example, environment, theme]);
  return (
    <>
      {why && <p className="window-why muted">{why}</p>}
      <div className="window-host" ref={ref} data-theme-preview={theme} data-example={example} />
    </>
  );
}

/** The preview for a parsed document, or why there is none yet. */
export function LabelsPreview({ doc, appName, environment, problems }: { doc: LabelDocument | null; appName: string; environment: 'test' | 'live'; problems: number }) {
  const [example, setExample] = useState<ExampleKind>('match');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const id = useId();
  if (!doc) {
    return (
      <section className="labels-preview" aria-labelledby={`${id}-h`}>
        <h3 id={`${id}-h`}>What users see</h3>
        <p className="muted">{problems > 0 ? `Fix ${problems === 1 ? 'the problem' : `the ${problems} problems`} in the form to see the preview.` : 'Fill in the form to see the preview.'}</p>
      </section>
    );
  }
  if (doc.context.chain !== 'stellar') return <ContractPreview doc={doc} appName={appName} environment={environment} />;
  return (
    <section className="labels-preview" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>What users see</h3>
      <p className="muted small">The approval window as it shows your words, with made-up values, at a phone’s width.</p>
      <div className="preview-switches">
        <Segmented legend="Example" name={`${id}-example`} value={example} options={KINDS.map((k) => ({ value: k, label: EXAMPLE_TITLES[k] }))} onChange={setExample} />
        <Segmented
          legend="Theme"
          name={`${id}-theme`}
          value={theme}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
          onChange={setTheme}
        />
      </div>
      <p className="muted small" aria-live="polite">
        {EXAMPLE_NOTES[example]}
      </p>
      <WindowFrame doc={doc} appName={appName} example={example} environment={environment} theme={theme} />
    </section>
  );
}

/** D900: the window for a NEAR program's or a Soroban contract's first described request, matching or after a code change. */
function ContractPreview({ doc, appName, environment }: { doc: LabelDocument; appName: string; environment: 'test' | 'live' }) {
  const [example, setExample] = useState<ContractExampleKind>('match');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const id = useId();
  const first = Object.keys(doc.formats)[0];
  return (
    <section className="labels-preview" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>What users see</h3>
      <p className="muted small">The approval window as it shows your words{first ? ` for ${first}` : ''}, with made-up values, at a phone’s width.</p>
      <div className="preview-switches">
        <Segmented legend="Example" name={`${id}-example`} value={example} options={CONTRACT_KINDS.map((k) => ({ value: k, label: CONTRACT_EXAMPLE_TITLES[k] }))} onChange={setExample} />
        <Segmented
          legend="Theme"
          name={`${id}-theme`}
          value={theme}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
          onChange={setTheme}
        />
      </div>
      <p className="muted small" aria-live="polite">
        {CONTRACT_NOTES[example]}
      </p>
      <WindowFrame doc={doc} appName={appName} example={example} environment={environment} theme={theme} />
    </section>
  );
}
