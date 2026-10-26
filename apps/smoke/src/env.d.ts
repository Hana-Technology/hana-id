/// <reference types="vite/client" />

// Injected by vite.config.ts (public fields of envs/<VITE_HANA_ENV>.json).
declare const __HANA_SMOKE_ENV__: import('./config.ts').PageEnv;

// The slice of Google Identity Services (https://accounts.google.com/gsi/client) the page uses.
declare namespace google.accounts.id {
  interface CredentialResponse {
    credential: string;
  }
  function initialize(config: { client_id: string; nonce?: string; callback: (response: CredentialResponse) => void; auto_select?: boolean }): void;
  function renderButton(parent: HTMLElement, options: { theme?: string; size?: string; text?: string; width?: number }): void;
}
