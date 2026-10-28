// @vitest-environment happy-dom
// The vault ↔ approval popup contract (docs/batch-b-spec.md "Approval flow", "Consent"), end to end over the one
// @hana-id/core definition both sides use: messages built the way the vault builds them (src/vault/approvals.ts
// `send`: the subject's fields, an `autoApprove` note with the matcher's `reason`, the normalized policy as a plain
// object with its policyId and end time) and structured-cloned as postMessage does, parse and render in the popup, and
// the popup's answers verify the way the vault verifies them (`handleMessage`: the parsed result, `allowed` or
// `approved`, and digestsEqual against its own approvalDigest / consentDigest).
import {
  type ApprovalSubject,
  type AutoApproveNote,
  approvalDigest,
  consentDigest,
  digestsEqual,
  evmTxSigningPayload,
  newRequestId,
  parseEvmTxRequest,
  parseWindowMessage,
} from '@hana-id/core';
import { type AutoApprovePolicyV1, policyId, validateAutoApprovePolicy } from '@hana-id/core/policy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUARD_DELAY_MS } from '../../src/auth/approve-guard.ts';
import { AUTO_APPROVE_REASON_TEXT, autoApproveReasonText, startApprovePage } from '../../src/auth/approve-page.ts';
import { policyJson } from '../../../core/test/policy-fixtures.ts';
import { ENV, FakeWindow, PARTNER, type RemoteWindow, asWindow, pageText, remoteWindow, resetDom } from './helpers.ts';

const T0 = 1_800_000_000_000;
const EVM = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const TX = { chainId: '0xaa36a7', nonce: '0x1', gas: '0x5208', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', to: EVM, value: '0x1', data: '0x' };

const validated = validateAutoApprovePolicy(policyJson());
if (!validated.ok) throw new Error('fixture policy is invalid');
const POLICY: AutoApprovePolicyV1 = validated.policy;
const POLICY_ID = policyId(POLICY);

/** The vault's side of one popup: its pending item and how it builds and checks messages. */
class VaultSide {
  readonly appName = 'Partner App';
  readonly parentOrigin = PARTNER;
  constructor(private readonly position = 1, private readonly queued = 1) {}

  private common(id: string) {
    return { v: 1, id, appName: this.appName, parentOrigin: this.parentOrigin, position: this.position, queued: this.queued } as const;
  }

  approveRequest(id: string, subject: ApprovalSubject, note?: AutoApproveNote): Record<string, unknown> {
    return {
      ...this.common(id),
      t: 'hana:approve-request',
      kind: subject.kind,
      chain: subject.chain,
      address: subject.address,
      bytes: Uint8Array.from(subject.bytes),
      context: { ...subject.context },
      ...(note ? { autoApprove: { ...note } } : {}),
    };
  }

  consentRequest(id: string, policy: AutoApprovePolicyV1, pid: string, expiresAtMs: number): Record<string, unknown> {
    const plain = JSON.parse(JSON.stringify(policy)) as Record<string, unknown>;
    return { ...this.common(id), t: 'hana:consent-request', policy: plain, policyId: pid, expiresAtMs };
  }

  /** handleMessage's check of an approve-result for the sign item on show. */
  approved(data: unknown, id: string, subject: ApprovalSubject): boolean {
    const m = parseWindowMessage(data, ['hana:approve-result', 'hana:consent-result']);
    if (!m || m.t !== 'hana:approve-result' || m.id !== id) return false;
    return m.approved && digestsEqual(m.digest, approvalDigest({ ...subject, id, parentOrigin: this.parentOrigin }));
  }

  /** handleMessage's check of a consent-result for the consent item on show. */
  allowed(data: unknown, id: string, pid: string, expiresAtMs: number): boolean {
    const m = parseWindowMessage(data, ['hana:approve-result', 'hana:consent-result']);
    if (!m || m.t !== 'hana:consent-result' || m.id !== id) return false;
    return m.allowed && digestsEqual(m.digest, consentDigest({ id, policyId: pid, parentOrigin: this.parentOrigin, expiresAtMs }));
  }
}

const SUBJECT: ApprovalSubject = { kind: 'evm_tx', chain: 'evm', address: EVM, context: { chainId: 11155111 }, bytes: evmTxSigningPayload(parseEvmTxRequest(TX)) };

let win: FakeWindow;
let vaultWindow: RemoteWindow;
let page: ReturnType<typeof startApprovePage>;

const primary = () => document.querySelector<HTMLButtonElement>('button.primary');
/** Delivers a vault message as the browser would: a structured clone, from the opener, on vaultOrigin. */
const deliver = (m: unknown) => win.message(structuredClone(m), ENV.vaultOrigin, vaultWindow);
const answers = () => vaultWindow.received.filter((m) => (m as { t: string }).t !== 'hana:approve-hello');
const approveWithGuard = () => {
  vi.advanceTimersByTime(GUARD_DELAY_MS);
  win.dispatch('pointermove');
  win.dispatch('pointerdown');
  primary()?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
};

beforeEach(() => {
  resetDom();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  win = new FakeWindow('/approve');
  vaultWindow = remoteWindow();
  win.opener = asWindow(vaultWindow);
  page = startApprovePage({ win, env: ENV, isGesture: () => true });
  win.dispatch('focus');
});
afterEach(() => {
  page.stop();
  vi.useRealTimers();
});

describe('vault-built messages in the approval popup', () => {
  it('a consent-request parses and renders in the popup, and its Allow verifies in the vault', () => {
    const vault = new VaultSide();
    const id = newRequestId();
    const expiresAtMs = T0 + POLICY.maxConsentMs;
    deliver(vault.consentRequest(id, POLICY, POLICY_ID, expiresAtMs));
    expect(page.state).toBe('consent');
    expect(pageText()).toContain(POLICY.label);
    approveWithGuard();
    const [answer] = answers();
    expect(vault.allowed(answer, id, POLICY_ID, expiresAtMs)).toBe(true);
    // The vault refuses it for another end time, policy or id.
    expect(vault.allowed(answer, id, POLICY_ID, expiresAtMs - 1)).toBe(false);
    expect(vault.allowed(answer, id, 'f'.repeat(64), expiresAtMs)).toBe(false);
    expect(vault.allowed(answer, newRequestId(), POLICY_ID, expiresAtMs)).toBe(false);
  });

  it('an approve-request with an autoApprove note and the matcher’s reason parses, renders and verifies', () => {
    const vault = new VaultSide(2, 3);
    const id = newRequestId();
    deliver(vault.approveRequest(id, SUBJECT, { label: POLICY.label, active: true, reason: 'value_too_high' }));
    expect(page.state).toBe('request');
    expect(pageText()).toContain('Request 2 of 3');
    expect(pageText()).toContain('the amount is over the per-transaction limit');
    expect(document.querySelector('button.link')?.textContent).toBe('Stop auto-approving');
    approveWithGuard();
    expect(vault.approved(answers()[0], id, SUBJECT)).toBe(true);
  });

  it('every matcher reason the vault can send is accepted by the popup (none is dropped)', () => {
    const vault = new VaultSide();
    for (const reason of Object.keys(AUTO_APPROVE_REASON_TEXT)) {
      const id = newRequestId();
      deliver(vault.approveRequest(id, SUBJECT, { label: POLICY.label, active: true, reason }));
      // Each one replaces the last on screen (which is rejected), so each is shown with its own reason.
      expect(page.state).toBe('request');
      expect(pageText()).toContain(`Not signed automatically under “${POLICY.label}”: ${autoApproveReasonText(reason)}.`);
    }
  });

  it('a Decline and a Reject verify as refusals, and "Stop auto-approving" parses in the vault', () => {
    const vault = new VaultSide();
    const cid = newRequestId();
    deliver(vault.consentRequest(cid, POLICY, POLICY_ID, T0 + 60_000));
    document.querySelector<HTMLButtonElement>('button.secondary')?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    const declined = parseWindowMessage(answers()[0], ['hana:consent-result']);
    expect(declined).toMatchObject({ id: cid, allowed: false });
    expect(vault.allowed(answers()[0], cid, POLICY_ID, T0 + 60_000)).toBe(false);

    const id = newRequestId();
    deliver(vault.approveRequest(id, SUBJECT, { label: POLICY.label, active: true }));
    document.querySelector<HTMLButtonElement>('button.link')?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(parseWindowMessage(answers()[1], ['hana:auto-approve-stop'])).not.toBeNull();
    document.querySelector<HTMLButtonElement>('button.secondary')?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(parseWindowMessage(answers()[2], ['hana:approve-result'])).toMatchObject({ id, approved: false });
    expect(vault.approved(answers()[2], id, SUBJECT)).toBe(false);
  });
});
