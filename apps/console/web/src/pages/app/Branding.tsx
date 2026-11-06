// An app's name and logo, as users see them in Hana's sign-in and approval popups. Both are immediate owner writes
// (not in a frozen org). The logo goes as the raw image (`application/octet-stream`) at the settings version; the page
// checks the type and size the console checks before sending, and previews the chosen file from a data: URL (the
// CSP's img-src allows data:, never blob:). Hana re-encodes it to a 256 × 256 PNG.
import { useEffect, useState } from 'react';
import { postBytes, postJson } from '../../api.ts';
import { useWrite } from '../../lib.tsx';
import { ConfirmButton, Panel, Why, WriteNote } from '../../ui.tsx';
import { AppTile, useApp } from '../Apps.tsx';

const TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_BYTES = 512 * 1024;

/** Why a chosen file can't be a logo (checked again by the console), or null. */
export function logoProblem(f: File): string | null {
  if (!TYPES.includes(f.type)) return 'Choose a PNG, JPEG or WebP image (not SVG or GIF).';
  if (f.size > MAX_BYTES) return `That file is ${Math.ceil(f.size / 1024)} KiB: the limit is 512 KiB.`;
  return null;
}

function usePreview(file: File | null): { src: string | null; size: string | null } {
  const [out, setOut] = useState<{ src: string | null; size: string | null }>({ src: null, size: null });
  useEffect(() => {
    setOut({ src: null, size: null });
    if (!file || logoProblem(file)) return;
    let live = true;
    const r = new FileReader();
    r.onload = () => {
      if (!live || typeof r.result !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/u.test(r.result)) return;
      const src = r.result;
      const img = new Image();
      img.onload = () => live && setOut({ src, size: `${img.naturalWidth} × ${img.naturalHeight} px` });
      img.onerror = () => live && setOut({ src: null, size: null });
      img.src = src;
    };
    r.readAsDataURL(file);
    return () => {
      live = false;
    };
  }, [file]);
  return out;
}

export function Branding() {
  const ctl = useApp();
  const { app, owner, frozen, org } = ctl;
  const w = useWrite();
  const [name, setName] = useState(app.name);
  const [file, setFile] = useState<File | null>(null);
  const base = `/api/orgs/${org}/apps/${app.id}`;
  const problem = file ? logoProblem(file) : null;
  const preview = usePreview(file);
  const can = owner && !frozen;
  return (
    <div className="stack">
      <Panel title="Name" description="Shown to users in Hana’s popups: “Signing in to {name} at {origin}”.">
        {!can ? (
          <>
            <p className="strong">{app.name}</p>
            <Why>{owner ? 'The name can’t be changed while Hana has frozen the organisation.' : 'Only owners can rename the app.'}</Why>
          </>
        ) : (
          <form
            className="form form-inline"
            onSubmit={(e) => {
              e.preventDefault();
              void w.run(async () => {
                await postJson(`${base}/profile`, { name, expectedVersion: app.settingsVersion });
                ctl.reload();
                return 'Renamed.';
              });
            }}
          >
            <label className="field">
              <span className="field-label">Name</span>
              <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
              <span className="field-hint">Up to 64 characters.</span>
            </label>
            <button type="submit" className="btn" disabled={w.busy || name.trim() === app.name || !name.trim()}>
              Save the name
            </button>
          </form>
        )}
      </Panel>
      <Panel title="Logo" description="Shown next to the name in Hana’s popups and on the apps list. A PNG, JPEG or WebP, at most 512 KiB, 128 to 2048 px a side and nearly square. Hana stores it as a 256 × 256 PNG.">
        <div className="logo-row">
          <figure className="logo-figure">
            <AppTile name={app.name} logoUrl={app.logoUrl} size="lg" />
            <figcaption className="muted small">{app.logoUrl ? 'Current logo' : 'No logo yet: the initial is shown'}</figcaption>
          </figure>
          {preview.src && (
            <figure className="logo-figure">
              <img className="app-tile app-tile-lg" src={preview.src} alt="Preview of the chosen logo" width={48} height={48} />
              <figcaption className="muted small">New: {preview.size}</figcaption>
            </figure>
          )}
        </div>
        {!can ? (
          <Why>{owner ? 'The logo can’t be changed while Hana has frozen the organisation.' : 'Only owners can change the logo.'}</Why>
        ) : (
          <div className="form">
            <label className="field">
              <span className="field-label">Logo file</span>
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
            {problem && <p className="field-error">{problem}</p>}
            <div className="form-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={w.busy || !file || problem !== null}
                onClick={() =>
                  void w.run(async () => {
                    const bytes = new Uint8Array(await file!.arrayBuffer());
                    await postBytes(`${base}/logo?expectedVersion=${app.settingsVersion}`, bytes);
                    ctl.reload();
                    setFile(null);
                    return 'Logo uploaded.';
                  })
                }
              >
                Upload the logo
              </button>
              {app.logoUrl && (
                <ConfirmButton
                  label="Remove the logo"
                  confirm="Remove it"
                  detail="Popups show the app’s initial instead."
                  busy={w.busy}
                  onConfirm={() =>
                    void w.run(async () => {
                      await postJson(`${base}/logo/remove`, { expectedVersion: app.settingsVersion });
                      ctl.reload();
                      return 'Logo removed.';
                    })
                  }
                />
              )}
            </div>
          </div>
        )}
        <WriteNote error={w.error} done={w.done} />
      </Panel>
    </div>
  );
}
