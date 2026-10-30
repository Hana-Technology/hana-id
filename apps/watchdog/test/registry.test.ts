// The registry in src/checks.ts is complete (D83, D126): every alert kind belongs to a known check and has a recovery
// playbook in @hana-id/playbooks, every playbook's alert kinds exist here, and a playbook covers its kinds at their
// highest severity. Adding an alert kind without its playbook fails here; the playbook's content is checked in
// packages/playbooks/test.
import { PLAYBOOKS, playbookForAlertKind } from '@hana-id/playbooks';
import { describe, expect, it } from 'vitest';
import { alertText } from '../src/alerts.ts';
import { ALERT_KIND_IDS, ALERT_KINDS, ALERT_KINDS_WITH_PLAYBOOKS, alertPlaybook, CHECK_IDS, type Severity } from '../src/checks.ts';

const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

describe('alert kind registry', () => {
  it('every alert kind belongs to a check of the run', () => {
    for (const k of ALERT_KIND_IDS) expect(CHECK_IDS, k).toContain(ALERT_KINDS[k].check);
  });

  it('every alert kind has exactly one playbook', () => {
    for (const k of ALERT_KIND_IDS) {
      const covering = PLAYBOOKS.filter((p) => p.alertKinds?.includes(k));
      expect(covering.map((p) => p.id), `${k} has no playbook in @hana-id/playbooks`).toHaveLength(1);
      expect(covering[0]!.kind).toBe('alert');
      expect(alertPlaybook(k)).toBe(covering[0]!.id);
    }
  });

  it("every playbook's alert kinds are kinds the watchdog raises", () => {
    for (const p of PLAYBOOKS) for (const k of p.alertKinds ?? []) expect(ALERT_KIND_IDS, `${p.id}: ${k}`).toContain(k);
  });

  it("a playbook's severity is the highest of its alert kinds", () => {
    for (const p of PLAYBOOKS.filter((x) => x.alertKinds?.length)) {
      const top = Math.max(...p.alertKinds!.map((k) => RANK[ALERT_KINDS[k as keyof typeof ALERT_KINDS].severity]));
      expect(RANK[p.severity], p.id).toBe(top);
    }
  });

  it('/status serves each kind with its playbook id', () => {
    for (const k of ALERT_KIND_IDS) {
      expect(ALERT_KINDS_WITH_PLAYBOOKS[k]).toEqual({ ...ALERT_KINDS[k], playbook: playbookForAlertKind(k)!.id });
    }
  });

  it("every alert text names the kind's playbook on one printable line", () => {
    for (const k of ALERT_KIND_IDS) {
      const text = alertText({ id: 1, kind: k, severity: ALERT_KINDS[k].severity, created_at: 0, details: {} }, 'e');
      const line = text.split('\n').find((l) => l.startsWith('Playbook: '));
      expect(line, k).toBe(`Playbook: ${alertPlaybook(k)} (admin portal "Security & monitoring" > Playbooks; docs/playbooks.md#${alertPlaybook(k)})`);
      expect(line).toMatch(/^[\x20-\x7e]+$/u);
    }
  });
});
