// The console's previews of Journear Passport's popup (D899): each is drawn inside a shadow root of its own, with the
// popup's stylesheet (window.css) attached to that root only. The popup's CSS then styles the preview exactly as the
// popup is styled, and nothing outside it: a console page looks the same whether or not a preview was opened. The
// stylesheet is a constructed one (adoptedStyleSheets: same-origin script, no inline <style> for the CSP to refuse),
// made once and shared by every preview.
import css from './window.css?inline';

let sheet: CSSStyleSheet | null = null;

/** `host`'s shadow root, made the first time, with the popup's stylesheet attached. */
export function windowRoot(host: HTMLElement): ShadowRoot {
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  if ('adoptedStyleSheets' in root && typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype) {
    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
    }
    if (!root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [sheet];
  }
  return root;
}

/** The example mark (Journear's words, first in every preview frame). */
export const EXAMPLE_MARK = 'Example: not a real request';
