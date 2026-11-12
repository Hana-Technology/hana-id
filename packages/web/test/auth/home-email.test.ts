// @vitest-environment happy-dom
// Passport Home's email code screens (home-email.ts) on the design system's fields (D765): the label above, the hint
// below, and a check when the field loses focus, never while the user types.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dom } from '../../src/auth/dom.ts';
import { HOME_EMAIL_TEXT, homeEmailStep } from '../../src/auth/home-email.ts';

beforeEach(() => {
  document.body.innerHTML = '';
});

function step() {
  const root = document.createElement('div');
  document.body.append(root);
  const start = vi.fn(async () => ({ challengeId: 'c'.repeat(43), expiresAtMs: Date.now() + 600_000, resendAfterMs: Date.now() + 30_000 }));
  const s = homeEmailStep({
    d: dom(document),
    root,
    isGesture: () => true,
    now: () => Date.now(),
    title: 'Sign in with email',
    intro: 'Intro',
    address: null,
    start,
    api: { resend: vi.fn(), verify: vi.fn() } as never,
    onToken: vi.fn(),
    onStop: vi.fn(),
    onCancel: vi.fn(),
    ids: 't',
  });
  return { root, s, start };
}

const blur = (el: HTMLElement) => el.dispatchEvent(new Event('blur'));
const type = (el: HTMLInputElement, v: string) => {
  el.value = v;
  el.dispatchEvent(new Event('input'));
};

describe('the email field', () => {
  it('has its label above and its hint below, joined to the input', () => {
    step();
    const input = document.getElementById('t-address') as HTMLInputElement;
    const field = input.closest('.jp-field')!;
    expect([...field.children].map((c) => c.className)).toEqual(['jp-label', 'jp-input', 'jp-hint', 'jp-error']);
    expect(field.querySelector('label')?.getAttribute('for')).toBe('t-address');
    expect(input.getAttribute('aria-describedby')).toBe('t-address-hint');
  });

  it('checks on blur, not on keystroke: typing never marks it, leaving with a bad address does, typing again clears it', () => {
    step();
    const input = document.getElementById('t-address') as HTMLInputElement;
    const field = input.closest('.jp-field')!;
    type(input, 'not-an-address');
    expect(field.classList.contains('is-invalid')).toBe(false);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    blur(input);
    expect(field.classList.contains('is-invalid')).toBe(true);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('t-address-error');
    expect(document.getElementById('t-address-error')?.textContent).toBe(HOME_EMAIL_TEXT.invalidEmail);
    type(input, 'not-an-address@');
    expect(field.classList.contains('is-invalid')).toBe(false);
    type(input, 'user@example.com');
    blur(input);
    expect(field.classList.contains('is-invalid')).toBe(false);
  });

  it('an empty field is left alone on blur', () => {
    step();
    const input = document.getElementById('t-address') as HTMLInputElement;
    blur(input);
    expect(input.closest('.jp-field')!.classList.contains('is-invalid')).toBe(false);
  });

  it('the code field checks for 6 digits on blur', async () => {
    const { start } = step();
    const input = document.getElementById('t-address') as HTMLInputElement;
    input.value = 'user@example.com';
    input.closest('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(document.getElementById('t-code')).not.toBeNull());
    expect(start).toHaveBeenCalledWith('user@example.com');
    const code = document.getElementById('t-code') as HTMLInputElement;
    type(code, '12a');
    expect(code.closest('.jp-field')!.classList.contains('is-invalid')).toBe(false);
    blur(code);
    expect(code.closest('.jp-field')!.classList.contains('is-invalid')).toBe(true);
    expect(document.getElementById('t-code-error')?.textContent).toBe(HOME_EMAIL_TEXT.typeCode);
    type(code, '123 456');
    blur(code);
    expect(code.closest('.jp-field')!.classList.contains('is-invalid')).toBe(false);
  });
});
