// GET /api/me's `scopeRegistration` (D651): the manifest's owner, council and shared clients from the SCOPE_REGISTRATION
// var, checked, for the organisation page's "Register a scope" panel, which writes the exact `admin <env>
// scope:register` command from them. Public values only; nothing here signs or sends anything.

/** The "Register a scope" panel's view of the manifest (D651): who signs `admin_register_scope` here. Public values. */
export interface ScopeRegistrationConfig {
  ownerKind: 'account' | 'sputnik';
  owner: string;
  councilMembers: string[];
  /** A dev env on testnet: the council's keys are in `.secrets/`, so `--member`/`--approve-with` cast both votes. */
  devCouncilKeys: boolean;
  sharedClientIds: string[];
}

const NEAR_ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/u;

/** SCOPE_REGISTRATION parsed and checked (every value ends up in a shell command the page shows), or null. */
export function scopeRegistrationOf(raw: string | undefined): ScopeRegistrationConfig | null {
  if (!raw) return null;
  let v: Partial<Record<keyof ScopeRegistrationConfig, unknown>>;
  try {
    v = JSON.parse(raw) as typeof v;
  } catch {
    return null;
  }
  const accounts = (x: unknown): x is string[] => Array.isArray(x) && x.length <= 10 && x.every((a) => typeof a === 'string' && NEAR_ACCOUNT_RE.test(a));
  const clients = (x: unknown): x is string[] => Array.isArray(x) && x.length <= 10 && x.every((a) => typeof a === 'string' && /^[A-Za-z0-9._-]{1,255}$/u.test(a));
  if ((v.ownerKind !== 'account' && v.ownerKind !== 'sputnik') || typeof v.owner !== 'string' || !NEAR_ACCOUNT_RE.test(v.owner) || !accounts(v.councilMembers) || typeof v.devCouncilKeys !== 'boolean' || !clients(v.sharedClientIds)) return null;
  if (v.ownerKind === 'sputnik' && v.councilMembers.length < 2) return null;
  return { ownerKind: v.ownerKind, owner: v.owner, councilMembers: v.councilMembers, devCouncilKeys: v.devCouncilKeys, sharedClientIds: v.sharedClientIds };
}
