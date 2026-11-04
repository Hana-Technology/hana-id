// The consent screen as users will see it (docs/batch-c-spec.md "Policy and raw-signing input rules": the editor shows
// `render-consent.ts`, verified names and "named by {app}" labels included, D44). It is the Hana popup's own renderer,
// imported from packages/web, not a copy (D352): it builds DOM nodes with text only (no HTML string), mounted here
// into a container React owns. The policy shown is the one the console validated (the server's canonical form).
import type { AutoApprovePolicyV1 } from '@hana-id/core/policy';
import { useEffect, useRef } from 'react';
import { dom } from '../../../../../packages/web/src/auth/dom.ts';
import { renderConsent } from '../../../../../packages/web/src/auth/render-consent.ts';

export function ConsentPreview({ policy, appName, parentOrigin, sessionTtlMs }: { policy: unknown; appName: string; parentOrigin: string | null; sessionTtlMs: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const p = policy as AutoApprovePolicyV1;
    const now = Date.now();
    const node = renderConsent(dom(document), {
      policy: p,
      appName,
      parentOrigin: parentOrigin ?? 'your app’s origin',
      expiresAtMs: now + Math.min(typeof p.maxConsentMs === 'number' ? p.maxConsentMs : sessionTtlMs, sessionTtlMs),
      nowMs: now,
    });
    el.replaceChildren(node);
    return () => el.replaceChildren();
  }, [policy, appName, parentOrigin, sessionTtlMs]);
  return (
    <figure className="consent-preview">
      <figcaption className="muted">What users will see when the app asks them to allow automatic signing:</figcaption>
      <div ref={ref} />
    </figure>
  );
}
