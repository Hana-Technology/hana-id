// Partner requirements (docs/batch-b-spec.md "Partner requirements"), detected where the page can tell:
//
// | Requirement | Detected | How |
// |---|---|---|
// | CSP frame-src allows vaultOrigin | at mount | `securitypolicyviolation` for vaultOrigin (`vault_unavailable`, `csp_frame_src`), else the handshake timeouts (`no_answer`, vault-connection.ts) |
// | popups allowed | at login | window.open returns null → `popup_blocked` handling (the vault's launcher) |
// | COOP not same-origin | at login | the popup reports `closed` before it connects → `coop_blocks_popup` |
// | login() in a click | at login | as popups (the launcher fallback costs one more click) |
// | no Google Identity Services on the page | at creation | partnerPageIssues: `google_identity_services` |
// | not an in-app webview | at creation | partnerPageIssues: `in_app_webview` (Google refuses them with `disallowed_useragent`) |
//
// partnerPageIssues only reports; createHana logs each issue once with console.warn and carries on.

export type PartnerIssueCode = 'google_identity_services' | 'in_app_webview';

export interface PartnerIssue {
  code: PartnerIssueCode;
  message: string;
}

/** Known in-app browsers (Facebook, Instagram, LINE, WeChat, TikTok, Snapchat, X) and Android WebView (`; wv)`). */
const IN_APP_UA = /\bFBA[NV]\/|\bInstagram\b|\bLine\/|\bMicroMessenger\/|\bmusical_ly|\bBytedanceWebview\/|\bSnapchat\b|\bTwitter(?:Android)?\b|; wv\)/u;
/** iOS WKWebView: an iPhone/iPad WebKit UA without Safari's token. */
const IOS_WEBVIEW_UA = /\b(?:iPhone|iPad|iPod)\b(?!.*\bSafari\/).*\bAppleWebKit\b/u;

export function isInAppWebView(userAgent: string): boolean {
  if (IN_APP_UA.test(userAgent)) return true;
  // Chrome, Firefox and Edge on iOS carry CriOS/FxiOS/EdgiOS and are real browsers.
  return IOS_WEBVIEW_UA.test(userAgent) && !/\b(?:CriOS|FxiOS|EdgiOS)\//u.test(userAgent);
}

export function partnerPageIssues(win: Window): PartnerIssue[] {
  const issues: PartnerIssue[] = [];
  const g = (win as unknown as { google?: { accounts?: { id?: unknown } } }).google;
  const gsiScript = win.document?.querySelector?.('script[src*="accounts.google.com/gsi/"]');
  if (g?.accounts?.id !== undefined || gsiScript) {
    issues.push({
      code: 'google_identity_services',
      message: 'Google Identity Services is loaded on this page. Journear Passport signs in through its own window; GIS on the partner page is unsupported.',
    });
  }
  const ua = win.navigator?.userAgent ?? '';
  if (isInAppWebView(ua)) {
    issues.push({ code: 'in_app_webview', message: 'This looks like an in-app browser. Google refuses sign-in there (disallowed_useragent); open the page in the system browser.' });
  }
  return issues;
}
