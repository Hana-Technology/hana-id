// The slice of Google Identity Services (https://accounts.google.com/gsi/client) Hana Embed uses.
declare namespace google.accounts.id {
  interface CredentialResponse {
    credential: string;
  }
  function initialize(config: { client_id: string; nonce?: string; callback: (response: CredentialResponse) => void; auto_select?: boolean }): void;
  function renderButton(parent: HTMLElement, options: { theme?: string; size?: string; text?: string; width?: number }): void;
}
