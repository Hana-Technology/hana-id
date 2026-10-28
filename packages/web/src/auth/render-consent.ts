// The auto-approve consent screen (docs/batch-b-spec.md "Consent"): the app name and verified origin, the label, every
// contract with its partner-supplied name and its address, the functions, the address rule (with a warning for any
// 'any'), the limits and the duration: the actual end time the vault sent (`expiresAtMs`, bound by the consent digest).
// Rendered from the policy the popup validated itself.
import type { AutoApprovePolicyV1, FunctionRule } from '@hana-id/core/policy';
import { type Child, type Dom, row, rows } from './dom.ts';
import { formatUnits } from './render-approval.ts';

const mono = (d: Dom, text: string) => d.h('code', { class: 'mono' }, text);

function rule(d: Dom, r: FunctionRule): HTMLElement {
  if (r.decoder !== undefined) return d.h('span', { class: 'muted' }, `checked by Hana's ${r.decoder} decoder`);
  return r.addressArgs === 'any'
    ? d.h('strong', { class: 'danger' }, 'can send to any address')
    : d.h('span', { class: 'muted' }, 'only to you or the contracts listed here');
}

/** "12 h", "1 h 30 min", "45 min". */
export function formatDuration(ms: number): string {
  const totalMin = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return [h > 0 ? `${h} h` : '', m > 0 ? `${m} min` : ''].filter(Boolean).join(' ');
}

function hasAny(policy: AutoApprovePolicyV1): boolean {
  const s = policy.stellar?.contracts.some((c) => c.functions.some((f) => f.addressArgs === 'any')) ?? false;
  const e = policy.evm?.chains.some((ch) => ch.contracts.some((c) => c.selectors.some((f) => f.addressArgs === 'any'))) ?? false;
  return s || e;
}

/** An absolute time in the user's locale, with the date: "28 Oct 2026, 21:30". */
export function formatEndTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export interface ConsentView {
  readonly policy: AutoApprovePolicyV1;
  readonly appName: string;
  readonly parentOrigin: string;
  /** When the consent would end (the vault's min(now + maxConsentMs, session expiry)). */
  readonly expiresAtMs: number;
  /** Now, for "about … from now". */
  readonly nowMs: number;
}

/** The consent body (everything above the Allow / Don't allow buttons). */
export function renderConsent(d: Dom, view: ConsentView): HTMLElement {
  const { policy, appName, parentOrigin } = view;
  const parts: Child[] = [
    d.h('h1', {}, 'Allow automatic signing?'),
    d.h('p', {}, d.h('strong', {}, appName), ' at ', d.h('span', { class: 'origin' }, parentOrigin), ' asks to sign some requests without asking you each time.'),
    d.h('p', { class: 'label' }, `“${policy.label}”`),
    d.h(
      'p',
      { class: 'warn' },
      'Requests that match the rules below are signed by Hana without a prompt. Anything else still asks you. You can stop this at any time from any Hana prompt.',
    ),
    hasAny(policy) ? d.h('p', { class: 'danger' }, 'Some functions below can send to any address. Only allow this if you trust this app completely.') : null,
  ];

  if (policy.stellar) {
    const s = policy.stellar;
    parts.push(
      d.h('h2', {}, 'Stellar'),
      rows(d, [
        row(d, s.networkPassphrases.length === 1 ? 'Network' : 'Networks', s.networkPassphrases.join(', ')),
        row(d, 'Maximum fee per transaction', `${formatUnits(s.maxFeeStroops, 7)} XLM`),
        s.changeTrustAssets && s.changeTrustAssets.length > 0 && row(d, 'May add trustlines for', ...s.changeTrustAssets.flatMap((a, i) => [i > 0 ? ', ' : '', mono(d, a)])),
        s.addresses && s.addresses.length > 0 && row(d, 'Also allowed as recipients', ...s.addresses.flatMap((a, i) => [i > 0 ? ', ' : '', mono(d, a)])),
      ]),
      d.h(
        'ul',
        { class: 'contracts' },
        ...s.contracts.map((c) =>
          d.h(
            'li',
            {},
            d.h('p', {}, d.h('strong', {}, c.name), ' ', mono(d, c.id)),
            d.h('ul', {}, ...c.functions.map((f) => d.h('li', {}, mono(d, f.name), ': ', rule(d, f)))),
          ),
        ),
      ),
    );
  }

  for (const ch of policy.evm?.chains ?? []) {
    parts.push(
      d.h('h2', {}, `EVM chain ${ch.chainId}`),
      rows(d, [
        row(d, 'Maximum value plus network fees, per transaction', `${formatUnits(ch.maxValueWei, 18)} (${ch.maxValueWei} wei)`),
        row(d, 'Maximum value plus network fees, per day', `${formatUnits(ch.maxValueWeiPerDay, 18)} (${ch.maxValueWeiPerDay} wei)`),
        row(d, 'Maximum network fee per transaction', `${formatUnits(ch.maxFeeWei, 18)} (${ch.maxFeeWei} wei)`),
        ch.addresses && ch.addresses.length > 0 && row(d, 'Also allowed as recipients', ...ch.addresses.flatMap((a, i) => [i > 0 ? ', ' : '', mono(d, a)])),
      ]),
      d.h(
        'ul',
        { class: 'contracts' },
        ...ch.contracts.map((c) =>
          d.h(
            'li',
            {},
            d.h('p', {}, d.h('strong', {}, c.name), ' ', mono(d, c.address)),
            d.h('ul', {}, ...c.selectors.map((f) => d.h('li', {}, mono(d, f.signature), ': ', rule(d, f)))),
          ),
        ),
      ),
      ch.typedData && ch.typedData.length > 0
        ? d.h('div', {}, d.h('p', {}, 'Typed-data signatures:'), d.h('ul', {}, ...ch.typedData.map((t) => d.h('li', {}, mono(d, t.primaryType), ' for ', mono(d, t.verifyingContract)))))
        : null,
    );
  }

  parts.push(
    d.h('h2', {}, 'Limits'),
    rows(d, [
      row(d, 'Requests per day', `at most ${policy.limits.perDayCount} (UTC day, on this device)`),
      row(
        d,
        'Until',
        `${formatEndTime(view.expiresAtMs)} (about ${formatDuration(view.expiresAtMs - view.nowMs)} from now), or earlier if you sign out or stop it`,
      ),
    ]),
  );
  return d.h('div', { class: 'consent' }, ...parts);
}
