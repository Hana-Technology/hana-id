// Google Identity Services: renders the sign-in button with the session nonce and returns the ID token.
// The token is handed straight to POST /v1/sessions; the page never displays, logs or stores it.
import { base64UrlDecode } from './bytes.ts';

let gisLoaded: Promise<void> | null = null;

function loadGoogle(): Promise<void> {
  gisLoaded ??= new Promise<void>((resolve, reject) => {
    if ((globalThis as { google?: { accounts?: { id?: unknown } } }).google?.accounts?.id) return resolve();
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      gisLoaded = null;
      reject(new Error('Couldn’t load Google sign-in (accounts.google.com/gsi/client)'));
    };
    document.head.appendChild(script);
  });
  return gisLoaded;
}

/** Renders Google's button for `clientId` with `nonce`; calls back with the ID token. */
export async function renderGoogleButton(el: HTMLElement, clientId: string, nonce: string, onToken: (jwt: string) => void): Promise<void> {
  await loadGoogle();
  el.replaceChildren();
  google.accounts.id.initialize({ client_id: clientId, nonce, callback: (r) => onToken(r.credential), auto_select: false });
  google.accounts.id.renderButton(el, { theme: 'outline', size: 'large', text: 'continue_with', width: 320 });
}

export interface TokenClaims {
  aud: string;
  sub: string;
  nonce: string | null;
}

/** Reads (does not verify) the claims the page checks before sending the token: aud and nonce. */
export function readClaims(jwt: string): TokenClaims {
  const part = jwt.split('.')[1];
  if (!part) throw new Error('Google returned a malformed ID token');
  const c = JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) as { aud?: unknown; sub?: unknown; nonce?: unknown };
  if (typeof c.aud !== 'string' || typeof c.sub !== 'string') throw new Error('Google returned an ID token without aud/sub');
  return { aud: c.aud, sub: c.sub, nonce: typeof c.nonce === 'string' ? c.nonce : null };
}
