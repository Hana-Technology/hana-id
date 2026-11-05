// A source check over apps/admin/src (D401 as amended): every purpose the Worker sends mail under is classified as
// bypassing SendGrid's suppression lists (an alert or a blocking notice) or keeping them (routine), so a new kind of
// mail can't slip in unclassified. The behaviour itself is tested in test/email.test.ts.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BYPASS_PURPOSES, ROUTINE_PURPOSES, purposeKind } from '../../src/mail.ts';

const srcDir = new URL('../../src/', import.meta.url);

describe('mail purposes', () => {
  it('every purpose passed to sendToAll or sendGroup is in BYPASS_PURPOSES or ROUTINE_PURPOSES, never both', () => {
    const files = readdirSync(srcDir, { recursive: true }).map(String).filter((f) => f.endsWith('.ts'));
    const kinds = new Set<string>();
    for (const f of files) {
      const src = readFileSync(new URL(f, srcDir), 'utf8');
      // The purpose argument: a template literal starting with its kind, inside the call.
      for (const m of src.matchAll(/\b(?:sendToAll|sendGroup)\((?:[^;]*?)`((?:feed:)?[a-z_]+):/gu)) kinds.add(purposeKind(`${m[1]}:x`));
    }
    expect(kinds.size).toBeGreaterThanOrEqual(15);
    for (const k of kinds) expect(BYPASS_PURPOSES.has(k) || ROUTINE_PURPOSES.has(k), k).toBe(true);
    for (const k of BYPASS_PURPOSES) expect(ROUTINE_PURPOSES.has(k), k).toBe(false);
    // The routine three are exactly these: an invitee's link, a statement's notice, the org audit digest.
    expect([...ROUTINE_PURPOSES].sort()).toEqual(['feed:audit_log', 'invite_link', 'statement_issued']);
  });
});
