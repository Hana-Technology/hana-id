// The auto-approve consent screen (docs/batch-b-spec.md "Consent"): the app name and verified origin, the label, every
// contract with its name, short address and explorer link, the functions, the address rule (with a warning for any
// 'any'), the limits and the duration: the actual end time the vault sent (`expiresAtMs`, bound by the consent digest).
// Rendered from the policy the popup validated itself.
//
// Contract names (docs/decisions.md D44): a contract on Hana's verified list (@hana-id/core verified-contracts.ts,
// built into this bundle) shows "✓ {verified name}"; any other shows the partner's name as "{name} · named by {app}",
// with check marks removed from it, and flagged when it imitates a verified name or protocol.
import {
  type ContractChain,
  STELLAR_MAINNET_PASSPHRASE,
  STELLAR_TESTNET_PASSPHRASE,
  type NameCollision,
  displayPartnerName,
  evmChainInfo,
  evmNativeUnits,
  explorerContractUrl,
  explorerFor,
  nameCollision,
  shortAddress,
  verifiedContractOnAll,
} from '@hana-id/core';
import type { AutoApprovePolicyV1, FunctionRule } from '@hana-id/core/policy';
import { BRAND } from '@hana-id/brand';
import { type Child, type Dom, originText, row, rows, withoutEmptyLists } from './dom.ts';
import { formatUnits } from './format-units.ts';
import { alert } from './ui.ts';

const mono = (d: Dom, text: string) => d.h('code', { class: 'mono' }, text);
/** The policy's facts in the design system's key/value rows (D765). */
const facts = (d: Dom, entries: Parameters<typeof rows>[1]): HTMLDListElement => rows(d, entries, 'jp-kv facts');

function rule(d: Dom, r: FunctionRule): HTMLElement {
  if (r.decoder !== undefined) return d.h('span', { class: 'muted' }, `checked by ${BRAND.company} (${r.decoder})`);
  return r.addressArgs === 'any'
    ? d.h('strong', { class: 'danger' }, 'can send to anyone')
    : d.h('span', { class: 'muted' }, 'only to you or the programs listed here');
}

/** "12 h", "1 h 30 min", "45 min". */
export function formatDuration(ms: number): string {
  const totalMin = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return [h > 0 ? `${h} h` : '', m > 0 ? `${m} min` : ''].filter(Boolean).join(' ');
}

/** Shown after "named by {app}" when the partner's name imitates a verified one. */
export function collisionText(c: NameCollision): string {
  return c.kind === 'verified-name' ? `not the ${c.entry.name} ${BRAND.company} checked` : `not a ${c.protocol} program ${BRAND.company} checked`;
}

/** A partner-named contract whose name imitates a verified one, on these chains. */
const imitates = (chains: readonly ContractChain[], address: string, name: string): boolean =>
  verifiedContractOnAll(chains, address) === null && nameCollision(name, chains, address) !== null;

/**
 * A policy contract's name line: "✓ {verified name}", or "{partner name} · named by {app}" (flagged when it imitates a
 * verified name); then the short address (the full one in its title) and a link to each chain's explorer, if known.
 */
export function contractLine(d: Dom, chains: readonly ContractChain[], address: string, partnerName: string, appName: string): HTMLElement {
  const verified = verifiedContractOnAll(chains, address);
  let name: HTMLElement;
  if (verified) {
    name = d.h('strong', { class: 'verified', attrs: { title: `Checked by ${BRAND.company}` } }, `✓ ${verified.name}`);
  } else {
    const collision = nameCollision(partnerName, chains, address);
    name = d.h(
      'span',
      { class: 'partner-named' },
      d.h('strong', {}, displayPartnerName(partnerName) || 'Unnamed program'),
      d.h('span', { class: 'muted' }, ` · named by ${appName}`),
      collision ? d.h('strong', { class: 'danger name-warning' }, ` — ${collisionText(collision)}`) : null,
    );
  }
  const links: Child[] = [];
  for (const chain of chains) {
    const url = explorerContractUrl(chain, address);
    const explorer = explorerFor(chain);
    if (url && explorer) links.push(' · ', d.h('a', { class: 'explorer', attrs: { href: url, target: '_blank', rel: 'noopener noreferrer' } }, `View on ${explorer.name}`));
  }
  return d.h('p', { class: 'contract' }, name, ' ', d.h('code', { class: 'mono contract-address', attrs: { title: address } }, shortAddress(address)), ...links);
}

function hasAny(policy: AutoApprovePolicyV1): boolean {
  const s = policy.stellar?.contracts.some((c) => c.functions.some((f) => f.addressArgs === 'any')) ?? false;
  const e = policy.evm?.chains.some((ch) => ch.contracts.some((c) => c.selectors.some((f) => f.addressArgs === 'any'))) ?? false;
  return s || e;
}

function hasImitation(policy: AutoApprovePolicyV1): boolean {
  const s = policy.stellar;
  const stellarChains: ContractChain[] = (s?.networkPassphrases ?? []).map((p) => ({ kind: 'stellar', networkPassphrase: p }));
  return (
    (s?.contracts.some((c) => imitates(stellarChains, c.id, c.name)) ?? false) ||
    (policy.evm?.chains.some((ch) => ch.contracts.some((c) => imitates([{ kind: 'evm', chainId: ch.chainId }], c.address, c.name))) ?? false)
  );
}

/** Shown for the native coin of a chain Hana can't name. */
export const UNKNOWN_NATIVE_COIN = 'of this network’s own coin';

/**
 * A native amount with its unit: "0.001 ETH (1000000000000000 wei)", or, on a chain Hana can't name, "0.001 of this
 * chain’s native coin (1000000000000000 wei)". On Hedera the raw number is in weibars: "1.5 HBAR (1500000000000000000
 * weibars)".
 */
export function nativeAmount(chainId: number, wei: string): string {
  const info = evmChainInfo(chainId);
  // The chain's own unit name and decimals (`evmNativeUnits`, the same source as the approval window's details, D922):
  // Hedera's relay counts HBAR in weibars (18 decimals), not the tinybars (8) other tools show.
  const units = evmNativeUnits(chainId);
  return `${formatUnits(wei, units.decimals)} ${info ? info.nativeSymbol : UNKNOWN_NATIVE_COIN} (${wei} ${units.smallest})`;
}

/**
 * An EVM chain's heading: Hana's own name for it with the number beside it in small text ("Sepolia (testnet)" and
 * "EVM chain 11155111"), or the number alone for a chain Hana doesn't know. Never a name the app supplied.
 */
export function evmChainHeading(d: Dom, chainId: number): HTMLElement {
  const info = evmChainInfo(chainId);
  if (!info) return d.h('h2', {}, `Ethereum-style network no. ${chainId}`);
  return d.h('h2', {}, info.label, ' ', d.h('span', { class: 'muted chain-id' }, `network no. ${chainId}`));
}

/** A Stellar network's plain name in front of its passphrase (D853: the raw value stays, with a plain label). */
const stellarNetworkName = (passphrase: string): string =>
  passphrase === STELLAR_MAINNET_PASSPHRASE ? 'Stellar (real money)' : passphrase === STELLAR_TESTNET_PASSPHRASE ? 'Stellar (test network)' : `A Stellar network ${BRAND.company} doesn’t know`;

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

/**
 * Shown on every consent screen (sweep CORE-3, D116): stopping auto-approving can't take back signatures the app
 * already has.
 */
export const lingeringSignaturesNote = (appName: string): string =>
  `Approvals made under these rules go to ${appName}. Stopping doesn’t cancel the ones it already has. Each one stays usable until its own end time, which can be later than when you stop.`;

/** The consent body (everything above the Allow / Don't allow buttons). */
export function renderConsent(d: Dom, view: ConsentView): HTMLElement {
  const { policy, appName, parentOrigin } = view;
  const parts: Child[] = [
    d.h('h1', {}, 'Allow automatic approvals?'),
    d.h('p', {}, d.h('strong', {}, appName), ' at ', originText(d, parentOrigin), ` wants ${BRAND.company} to approve some requests without asking you each time.`),
    d.h('p', { class: 'label' }, `“${policy.label}”`),
    alert(
      d,
      'warning',
      { class: 'warn' },
      `${BRAND.product} will approve requests that match the rules below without asking you. Anything else still asks you. You can stop this at any time from any ${BRAND.product} window.`,
    ),
    hasAny(policy) ? alert(d, 'danger', { class: 'danger' }, 'Some actions below can send your money or tokens to anyone. Allow this only if you trust this app completely.') : null,
    hasImitation(policy)
      ? alert(d, 'danger', { class: 'danger' }, `${appName} gave some programs below names that look like ones ${BRAND.company} checked, but they are different programs. It may be a scam. Don’t allow this unless you know why.`)
      : null,
  ];

  if (policy.stellar) {
    const s = policy.stellar;
    const chains: ContractChain[] = s.networkPassphrases.map((p) => ({ kind: 'stellar', networkPassphrase: p }));
    parts.push(
      d.h('h2', {}, 'Stellar'),
      facts(d, [
        row(d, s.networkPassphrases.length === 1 ? 'Network' : 'Networks', ...s.networkPassphrases.flatMap((p, i) => [i > 0 ? '; ' : '', `${stellarNetworkName(p)}: `, mono(d, p)])),
        row(d, 'Most network fee each time', `${formatUnits(s.maxFeeStroops, 7)} XLM`),
        s.changeTrustAssets && s.changeTrustAssets.length > 0 && row(d, 'May let your account hold', ...s.changeTrustAssets.flatMap((a, i) => [i > 0 ? ', ' : '', mono(d, a)])),
        s.addresses && s.addresses.length > 0 && row(d, 'Can also send to', ...s.addresses.flatMap((a, i) => [i > 0 ? ', ' : '', mono(d, a)])),
      ]),
      d.h(
        'ul',
        { class: 'contracts' },
        ...s.contracts.map((c) =>
          d.h(
            'li',
            {},
            contractLine(d, chains, c.id, c.name, appName),
            d.h('ul', {}, ...c.functions.map((f) => d.h('li', {}, 'Action ', mono(d, f.name), ': ', rule(d, f)))),
          ),
        ),
      ),
    );
  }

  for (const ch of policy.evm?.chains ?? []) {
    parts.push(
      evmChainHeading(d, ch.chainId),
      facts(d, [
        row(d, 'Most it can send each time, fees included', nativeAmount(ch.chainId, ch.maxValueWei)),
        row(d, 'Most it can send a day, fees included', nativeAmount(ch.chainId, ch.maxValueWeiPerDay)),
        row(d, 'Most network fee each time', nativeAmount(ch.chainId, ch.maxFeeWei)),
        ch.addresses && ch.addresses.length > 0 && row(d, 'Can also send to', ...ch.addresses.flatMap((a, i) => [i > 0 ? ', ' : '', mono(d, a)])),
      ]),
      d.h(
        'ul',
        { class: 'contracts' },
        ...ch.contracts.map((c) =>
          d.h(
            'li',
            {},
            contractLine(d, [{ kind: 'evm', chainId: ch.chainId }], c.address, c.name, appName),
            d.h('ul', {}, ...c.selectors.map((f) => d.h('li', {}, 'Action ', mono(d, f.signature), ': ', rule(d, f)))),
          ),
        ),
      ),
      ch.typedData && ch.typedData.length > 0
        ? d.h('div', {}, d.h('p', {}, 'Signatures it may approve:'), d.h('ul', {}, ...ch.typedData.map((t) => d.h('li', {}, mono(d, t.primaryType), ' for the program ', mono(d, t.verifyingContract)))))
        : null,
    );
  }

  parts.push(
    d.h('h2', {}, 'Limits'),
    facts(d, [
      row(d, 'Requests a day', `at most ${policy.limits.perDayCount} (a day starts at midnight UTC; counted on this device)`),
      row(
        d,
        'Until',
        `${formatEndTime(view.expiresAtMs)} (about ${formatDuration(view.expiresAtMs - view.nowMs)} from now), or earlier if you sign out or stop it`,
      ),
    ]),
    alert(d, 'info', { class: 'note lingering' }, lingeringSignaturesNote(appName)),
  );
  return withoutEmptyLists(d.h('div', { class: 'consent' }, ...parts));
}
