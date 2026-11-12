// An app's overview: what needs attention (a suspension, changes waiting), the getting-started checklist (the partner
// guide's steps, docs/integration.md, with what the console can see ticked: origins, a key, a logo) and a summary of
// the app's settings with links to their sections.
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { duration } from '../../lib.tsx';
import { Badge, Callout, Panel, Snippet, Stats } from '../../ui.tsx';
import { suspension, useApp } from '../Apps.tsx';
import { PendingChanges, isWaiting } from './Changes.tsx';

type Done = 'done' | 'partly' | 'todo' | 'code';

function Step({ n, title, state, children }: { n: number; title: string; state: Done; children: ReactNode }) {
  const label = state === 'done' ? 'Done' : state === 'partly' ? 'Waiting' : state === 'code' ? 'In your code' : 'To do';
  const tone = state === 'done' ? 'ok' : state === 'partly' ? 'warn' : state === 'code' ? 'info' : 'neutral';
  return (
    <li className={`step-item step-${state}`}>
      <span className="check-n" aria-hidden="true">
        {state === 'done' ? '✓' : n}
      </span>
      <div className="check-body">
        <p className="check-title">
          {title}{' '}
          <span className="check-state">
            <Badge tone={tone}>{label}</Badge>
          </span>
        </p>
        {children}
      </div>
    </li>
  );
}

/** An environment name as the manifest names them; anything else (or none) gets the placeholder. */
const ENV_NAME_RE = /^[a-z0-9-]{1,64}$/u;

/**
 * Step 4's code: the app's newest key and this console's environment (`GET /api/me` `envName`, the name a partner
 * passes to `createHana`, docs/integration.md section 3). Without a usable name, the placeholder and where to find it.
 */
export function clientSnippet(key: string | undefined, envName: string | undefined): string {
  const environment = envName !== undefined && ENV_NAME_RE.test(envName) ? `'${envName}',` : `'…', // the environment name Journear gave you with the SDK`;
  return `import { createHana } from '@hana-id/web';

const hana = createHana({
  publishableKey: '${key ?? 'pk_…'}',
  environment: ${environment}
});

// In a click handler:
await hana.login();`;
}

export function Overview() {
  const ctl = useApp();
  const { app: a } = ctl;
  const base = `/orgs/${ctl.org}/apps/${a.id}`;
  const now = ctl.serverNow();
  const active = a.origins.filter((o) => o.activeFrom !== null && o.activeFrom <= now);
  const waiting = a.origins.filter((o) => o.activeFrom === null || o.activeFrom > now);
  const key = a.keys.filter((k) => k.revokedAt === undefined).sort((x, y) => y.createdAt - x.createdAt)[0];
  const s = a.settings;
  const susp = suspension(a.suspendedBy);
  const client = clientSnippet(key?.key, ctl.envName);
  const live = a.keys.filter((k) => k.revokedAt === undefined || k.revokedAt > now).length;
  const changes = a.changes.filter((c) => isWaiting(c, now)).length;
  return (
    <div className="stack">
      <Stats
        label="This app at a glance"
        items={[
          { label: 'Active origins', value: active.length, note: waiting.length ? `${waiting.length} waiting` : undefined },
          { label: 'Working keys', value: live },
          { label: 'Pending changes', value: changes },
        ]}
      />
      {susp && (
        <Callout tone="danger" title={`${susp}.`}>
          <p>
            Users can’t sign in or start sessions in this app while it is suspended. <Link to={`${base}/suspend`}>See why and what you can do</Link>.
          </p>
        </Callout>
      )}
      {a.changes.some((c) => isWaiting(c, now)) && (
        <Panel title="Changes waiting" description="These take effect on their own after the security delay unless someone cancels them.">
          <PendingChanges ctl={ctl} kinds={['origin_add', 'policy_set', 'raw_sign_on']} title={null} />
        </Panel>
      )}
      <Panel title="Getting started" description="The steps of the partner guide (integration.md, sent with the SDK). The console ticks what it can see.">
        <ol className="checklist">
          <Step n={1} title="Allow your app’s origins" state={active.length ? 'done' : waiting.length ? 'partly' : 'todo'}>
            <p>
              {active.length
                ? `${active.length} ${active.length === 1 ? 'origin is' : 'origins are'} active${waiting.length ? `, ${waiting.length} waiting` : ''}.`
                : waiting.length
                  ? `${waiting.length} waiting to take effect.`
                  : 'The wallet loads only on the exact origins you allow.'}{' '}
              <Link to={`${base}/origins`}>Manage origins</Link>
            </p>
          </Step>
          <Step n={2} title="Copy your publishable key" state={key ? 'done' : 'todo'}>
            <p>
              {key ? 'It is public: ship it in your page. Your origins are what protect it.' : 'The app has no active key.'} <Link to={`${base}/keys`}>Manage keys</Link>
            </p>
          </Step>
          <Step n={3} title="Install the SDK" state="code">
            <p>Install the tarballs Journear sent you (guide, section 2), with the version in their file names:</p>
            <Snippet label="install command" code="npm install ./hana-id-core-<version>.tgz ./hana-id-web-<version>.tgz" />
          </Step>
          <Step n={4} title="Create the client and log in from a click" state="code">
            <p>Guide, sections 3 and 4. {a.environment === 'test' ? 'This is a test app: use test networks only (section 12).' : ''}</p>
            <Snippet label="client code" code={client} />
          </Step>
          <Step n={5} title="Let your page frame the Journear vault" state="code">
            <p>Add the vault’s origin to your Content-Security-Policy <code>frame-src</code>, allow popups, and don’t send <code>Cross-Origin-Opener-Policy: same-origin</code> (guide, section 5).</p>
          </Step>
        </ol>
        <p className="muted small">
          Optional: a logo (<Link to={`${base}/branding`}>Branding</Link>), your own Google client (guide, section 6), an auto-approve policy (<Link to={`${base}/signing`}>Signing</Link>, section 9), and verifying the identity token on your backend (section 15).
        </p>
      </Panel>
      <div className="grid-2">
        <Panel
          title="Login & sessions"
          actions={
            <Link className="jp-btn jp-btn-ghost jp-btn-sm" to={`${base}/sessions`}>
              Change
            </Link>
          }
        >
          <dl className="facts">
            <dt>Stay signed in across reloads</dt>
            <dd>{s.persistence === 'session' ? 'Yes' : 'No: log in on every page load'}</dd>
            <dt>Session length</dt>
            <dd>{duration(s.sessionTtlMs)}</dd>
            <dt>Idle timeout</dt>
            <dd>{duration(s.idleTtlMs)}</dd>
            <dt>Google client</dt>
            <dd>{s.googleWebClientId ? <span className="mono small">{s.googleWebClientId}</span> : 'Journear’s shared client'}</dd>
          </dl>
        </Panel>
        <Panel
          title="Signing"
          actions={
            <Link className="jp-btn jp-btn-ghost jp-btn-sm" to={`${base}/signing`}>
              Change
            </Link>
          }
        >
          <dl className="facts">
            <dt>Auto-approve policy</dt>
            <dd>{s.policy ? `“${s.policy.label}”` : 'None: users approve every request'}</dd>
            <dt>Raw signing</dt>
            <dd>{s.rawSign === 'approval' ? <Badge tone="warn">On, with approval</Badge> : 'Off'}</dd>
            <dt>Environment</dt>
            <dd>{a.environment === 'live' ? 'Live' : 'Test: test networks only'}</dd>
          </dl>
        </Panel>
      </div>
    </div>
  );
}
