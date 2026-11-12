// The pending-upgrades page (D86 Q11, D333, D335; `GET /api/orgs/:org/governance/pending-upgrades`): what hana-signer's
// owner has queued that partners and their users can react to within the governance delay (for example by exporting
// keys, D41): a contract upgrade (its code hash, and the published release's version, source commit, reproducible-build
// command and diff to the release before it, or the "not a published release" warning), an owner transfer, a
// withdrawal, delay decreases and new console audiences, each with a countdown on the reader's clock (D374), and the
// pause state. Everything here is contract-wide and public on chain; nothing is any org's or any user's. Any member,
// frozen orgs included (a read).
import type { PendingUpgradesView } from '@hana-id/console-core';
import { countdown, duration, useApi, useNow, useOrg, when } from '../lib.tsx';
import { Callout, CopyButton, ErrorNote, Loading, PageHeader, Panel } from '../ui.tsx';
import { near } from '../units.ts';

const DELAY_LABEL: Record<PendingUpgradesView['delayDecreases'][number]['delay'], string> = {
  issuer_key: 'Issuer key changes',
  governance: 'Governance (upgrades, owner, withdrawals)',
  change: 'Scope changes and console audiences',
};

function When({ atMs, due, now, verb }: { atMs: number; due: boolean; now: number; verb: string }) {
  return (
    <>
      {due || atMs <= now ? <strong>Due: it can {verb} now</strong> : <>Can {verb} {countdown(atMs, now)}</>}
      <div className="muted small">{when(atMs)}</div>
    </>
  );
}

function Command({ text }: { text: string }) {
  return (
    <div className="snippet">
      <pre className="mono">{text}</pre>
      <CopyButton value={text} label="command" />
    </div>
  );
}

export function Upgrades() {
  const { org } = useOrg();
  const r = useApi<{ pendingUpgrades: PendingUpgradesView }>(`/api/orgs/${org}/governance/pending-upgrades`);
  const now = useNow(30_000);
  const head = <PageHeader title="Pending upgrades" description="Changes Journear has queued on the Journear Passport contract that every app depends on. Each one waits a public delay first, so you and your users can react before it applies." />;
  if (r.error)
    return (
      <>
        {head}
        <ErrorNote error={r.error} onRetry={r.reload} />
      </>
    );
  if (!r.data)
    return (
      <>
        {head}
        <Loading label="Reading the chain…" />
      </>
    );
  const p = r.data.pendingUpgrades;
  return (
    <>
      {head}
      <p className="muted">
        What the owner of the Journear Passport contract <span className="mono">{p.signer}</span> ({p.env}) has queued, read from the chain {when(p.readAtMs)}. Each change waits the governance delay ({duration(p.governanceDelayMs)}
        ) before it can take effect, so you and your users can react, for example by exporting keys. Countdowns run on your clock;{' '}
        <button type="button" className="link-btn" onClick={r.reload}>
          read the chain again
        </button>
        .
      </p>
      {p.paused && (
        <Callout tone="danger" role="alert">
          The contract is paused: logins, new sessions and key derivation are stopped until Journear unpauses it.
        </Callout>
      )}
      {!p.anyPending && (
        <Callout tone="ok" title="Nothing is pending.">
          <p>No upgrade, owner transfer, withdrawal or shorter delay is queued. Anything Journear queues shows here for the whole delay before it can apply.</p>
        </Callout>
      )}
      {p.upgrade && (
        <Panel>
          <h2>Contract upgrade</h2>
          <dl className="facts">
            <dt>New code hash</dt>
            <dd className="mono">{p.upgrade.codeHash}</dd>
            <dt>Proposed</dt>
            <dd>{when(p.upgrade.proposedAtMs)}</dd>
            <dt>Takes effect</dt>
            <dd>
              <When atMs={p.upgrade.executableAtMs} due={p.upgrade.due} now={now} verb="be executed" />
            </dd>
          </dl>
          {p.upgrade.release ? (
            <>
              <p>
                Release <strong>{p.upgrade.release.version}</strong>, built from source commit <code className="mono">{p.upgrade.release.commit}</code>. Rebuild it and compare the hash with the one above:
              </p>
              <Command text={p.upgrade.release.buildCommand} />
              {p.upgrade.release.diffCommand ? (
                <>
                  <p>The changes since the release before it:</p>
                  <Command text={p.upgrade.release.diffCommand} />
                </>
              ) : (
                <p className="muted">The first published release: there is no earlier release to compare against.</p>
              )}
            </>
          ) : (
            <Callout tone="warn" role="alert">
              <strong>Not a published release.</strong> No source commit or reproducible-build command is on record for this code hash. Treat the upgrade as unexplained until Journear publishes it, and ask Journear before it takes
              effect.
            </Callout>
          )}
        </Panel>
      )}
      {p.ownerTransfer && (
        <Panel>
          <h2>Owner transfer</h2>
          <dl className="facts">
            <dt>New owner</dt>
            <dd className="mono">{p.ownerTransfer.owner}</dd>
            <dt>Takes effect</dt>
            <dd>
              <When atMs={p.ownerTransfer.acceptableAtMs} due={p.ownerTransfer.due} now={now} verb="be accepted" />
            </dd>
          </dl>
        </Panel>
      )}
      {p.withdrawal && (
        <Panel>
          <h2>Withdrawal from the contract</h2>
          <dl className="facts">
            <dt>Receiver</dt>
            <dd className="mono">{p.withdrawal.receiver}</dd>
            <dt>Amount</dt>
            <dd>
              <span className="mono">{near(p.withdrawal.amountYocto)}</span> NEAR
            </dd>
            <dt>Takes effect</dt>
            <dd>
              <When atMs={p.withdrawal.executableAtMs} due={p.withdrawal.due} now={now} verb="be executed" />
            </dd>
          </dl>
        </Panel>
      )}
      {p.delayDecreases.length > 0 && (
        <Panel>
          <h2>Shorter delays</h2>
          <div className="jp-table-wrap">
          <table className="jp-table">
            <thead>
              <tr>
                <th>Delay</th>
                <th>Now</th>
                <th>Becomes</th>
                <th>Takes effect</th>
              </tr>
            </thead>
            <tbody>
              {p.delayDecreases.map((d) => (
                <tr key={d.delay}>
                  <td>{DELAY_LABEL[d.delay]}</td>
                  <td>{duration(d.currentMs)}</td>
                  <td>{duration(d.valueMs)}</td>
                  <td>
                    <When atMs={d.effectiveAtMs} due={false} now={now} verb="apply" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </Panel>
      )}
      {p.consoleAudienceAdditions.length > 0 && (
        <Panel>
          <h2>New console sign-in clients</h2>
          <p className="muted">Once in force, Google tokens for these clients can authorise on-chain owner actions.</p>
          <div className="jp-table-wrap">
          <table className="jp-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Client (audience)</th>
                <th>Takes effect</th>
              </tr>
            </thead>
            <tbody>
              {p.consoleAudienceAdditions.map((a) => (
                <tr key={`${a.provider}:${a.aud}`}>
                  <td>{a.provider}</td>
                  <td className="mono">{a.aud}</td>
                  <td>
                    <When atMs={a.effectiveAtMs} due={false} now={now} verb="apply" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </Panel>
      )}
    </>
  );
}
