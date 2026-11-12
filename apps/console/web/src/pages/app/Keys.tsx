// An app's publishable keys: the active ones (copy, Rotate, Revoke), the ones a rotation is retiring (working until
// their time; Revoke now), and the revoked ones folded away. Create, Rotate and Revoke are immediate writes behind a
// second click; Revoke is a kill switch (open in a frozen org). At most 5 unrevoked keys (the API's `key_limit`).
import type { KeyView } from '@hana-id/console-core';
import { postJson } from '../../api.ts';
import { relative, useNow, useWrite, when } from '../../lib.tsx';
import { Badge, ConfirmButton, CopyButton, Panel, Why, WriteNote } from '../../ui.tsx';
import { useApp } from '../Apps.tsx';

const MAX_UNREVOKED = 5;

export function Keys() {
  const ctl = useApp();
  const { app, owner, frozen, org } = ctl;
  const now = useNow(30_000);
  const w = useWrite();
  const base = `/api/orgs/${org}/apps/${app.id}/keys`;
  const unrevoked = app.keys.filter((k) => k.revokedAt === undefined);
  const retiring = app.keys.filter((k) => k.revokedAt !== undefined && k.revokedAt > now);
  const revoked = app.keys.filter((k) => k.revokedAt !== undefined && k.revokedAt <= now);
  const full = unrevoked.length >= MAX_UNREVOKED;
  const created = (k: KeyView) => `Created ${when(k.createdAt)}${k.createdBy === 'hana' ? ' by Journear' : ctl.nameOf(k.createdBy) ? ` by ${ctl.nameOf(k.createdBy)}` : ''}`;
  const revoke = (k: KeyView, last: boolean) => (
    <ConfirmButton
      label="Revoke"
      confirm={last ? 'Revoke the last key (the app stops working)' : 'Revoke now'}
      detail={last ? 'This is the app’s last working key: every page using it stops loading the wallet at once.' : 'It stops working at once. Pages still shipping it can’t load the wallet.'}
      busy={w.busy}
      onConfirm={() =>
        void w.run(async () => {
          await postJson(`${base}/${k.id}/revoke`, {});
          ctl.reload();
          return 'Revoked: the key no longer works.';
        })
      }
    />
  );
  return (
    <div className="stack">
      <Panel
        title="Publishable keys"
        description="Your page passes a key to createHana. Keys are public: ship them in your page. Your allowed origins are what protect them. A test key starts pk_test_, a live key pk_live_."
        actions={
          owner && !frozen ? (
            <button
              type="button"
              className="jp-btn jp-btn-primary"
              disabled={w.busy || full}
              onClick={() =>
                void w.run(async () => {
                  await postJson(base, {});
                  ctl.reload();
                  return 'Key created. Copy it into your page.';
                })
              }
            >
              Create a key
            </button>
          ) : undefined
        }
      >
        {owner && !frozen && full && <Why>An app can have at most {MAX_UNREVOKED} active keys. Revoke one you no longer ship to create another.</Why>}
        {owner && frozen && <Why>Creating and rotating keys is paused while Journear has frozen the organisation. Revoking still works.</Why>}
        {!owner && <Why>Only owners can create, rotate or revoke keys.</Why>}
        <ul className="key-list">
          {unrevoked.length === 0 && <li className="muted">No active key: the app can’t load the wallet until it has one.</li>}
          {unrevoked.map((k) => (
            <li key={k.id} className="key">
              <div className="key-main">
                <code className="key-value">{k.key}</code>
                <CopyButton value={k.key} label="publishable key" />
              </div>
              <div className="key-meta">
                <Badge tone="ok">Active</Badge>
                <span className="muted small">{created(k)}</span>
              </div>
              {owner && (
                <div className="key-actions">
                  {!frozen && (
                    <ConfirmButton
                      tone="primary"
                      label="Rotate"
                      confirm="Rotate (the old key works 24 h more)"
                      detail="You get a new key now. This one keeps working for 24 hours, so you can ship the new one first."
                      busy={w.busy}
                      onConfirm={() =>
                        void w.run(async () => {
                          await postJson(`${base}/${k.id}/rotate`, {});
                          ctl.reload();
                          return 'Rotated: ship the new key within 24 hours.';
                        })
                      }
                    />
                  )}
                  {revoke(k, unrevoked.length <= 1)}
                </div>
              )}
            </li>
          ))}
          {retiring.map((k) => (
            <li key={k.id} className="key key-retiring">
              <div className="key-main">
                <code className="key-value">{k.key}</code>
                <CopyButton value={k.key} label="retiring key" />
              </div>
              <div className="key-meta">
                <Badge tone="warn">Retiring</Badge>
                <span className="muted small">
                  Stops working {when(k.revokedAt)} ({relative(k.revokedAt!, now)}). {created(k)}
                </span>
              </div>
              {owner && <div className="key-actions">{revoke(k, false)}</div>}
            </li>
          ))}
        </ul>
        <WriteNote error={w.error} />
        {revoked.length > 0 && (
          <details className="revoked">
            <summary>
              {revoked.length} revoked {revoked.length === 1 ? 'key' : 'keys'}
            </summary>
            <ul className="key-list">
              {revoked.map((k) => (
                <li key={k.id} className="key key-revoked">
                  <code className="key-value">{k.key}</code>
                  <span className="muted small">
                    Revoked {when(k.revokedAt)}. {created(k)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Panel>
    </div>
  );
}
