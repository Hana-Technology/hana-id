// A small in-memory NEAR testnet for the governance script tests: accounts with access keys, a simulated hana-signer
// (the governance methods the scripts call, with the contract's owner / delay checks), a Sputnik DAO (add_proposal,
// act_proposal with the 2-of-3 threshold, executing FunctionCall proposals as the DAO), the testnet registrar's
// create_account and the factory's create. Nothing here talks to a network.
import type { Action } from '@near-js/transactions';
import { GOVERNANCE_DEFAULT } from './sim-fixtures.ts';
import type { GovernanceView, KeyChangeView } from '../lib/contract.ts';
import { type AccessKeyListEntry, type AccountView, codeHashOf, type TxSigner } from '../lib/near.ts';
import { type DaoProposal, type SputnikPolicy, votesNeeded } from '../lib/sputnik.ts';

export interface SentTx {
  signer: string;
  receiver: string;
  actions: Action[];
}

interface SimAccount {
  amount: bigint;
  codeHash: string;
  keys: AccessKeyListEntry[];
}

const EMPTY = '11111111111111111111111111111111';
const NEAR = 10n ** 24n;

export class SimChain {
  readonly accounts = new Map<string, SimAccount>();
  readonly sent: SentTx[] = [];
  now: number;
  /** hana-signer state (null = not initialised). */
  config: Record<string, unknown> | null = null;
  /** null = a v1 contract (no get_governance). */
  governance: GovernanceView | null = null;
  keyChanges: KeyChangeView[] = [];
  issuer: { iss_values: string[]; kids: string[] } | null = null;
  /** Issuers by provider, when a test seeds them: get_issuer and set_issuer use these first (else `issuer`). */
  issuersByProvider: Record<string, { iss_values: string[]; kids: string[] }> = {};
  globalScope: unknown = null;
  /** Other scopes by id (the console sink, D238); admin_register_scope adds `s<next>`. */
  scopes: Record<string, { id: string; owners: unknown[]; clients: [string, string][]; allow_shared: boolean }> = {};
  nextScope = 9;
  /** Clients removed from a scope: only that scope may take one back before `freeAt` (the contract's quarantine). */
  removedClients: Record<string, { scopeId: string; freeAt: number }> = {};
  /** DAO state by account. */
  readonly daos = new Map<string, { policy: SputnikPolicy; proposals: DaoProposal[] }>();
  /** When set, the next `migrate` after execute_upgrade panics (the deploy rolls back). */
  failMigrate = false;
  /** The factory's default code hash. */
  factoryCodeHash: string;

  constructor(
    readonly signer: string,
    readonly opts: { now: number; factory?: string; daoCodeHash: string; factoryRefuses?: boolean },
  ) {
    this.now = opts.now;
    this.factoryCodeHash = opts.daoCodeHash;
  }

  addAccount(id: string, keys: AccessKeyListEntry[] = [], amount = 50n * NEAR, codeHash = EMPTY): void {
    this.accounts.set(id, { amount, codeHash, keys: [...keys] });
  }

  keysOf(id: string): AccessKeyListEntry[] {
    return this.accounts.get(id)?.keys ?? [];
  }

  /** Installs a v2 hana-signer state (watchdogs/updater keys from `gov`). */
  initV2(config: Record<string, unknown>, gov: Partial<GovernanceView> = {}): void {
    this.config = { ...config };
    this.governance = structuredClone({ ...GOVERNANCE_DEFAULT, ...gov });
    const acct = this.accounts.get(this.signer);
    if (acct) acct.codeHash = 'V2CODE';
  }

  addDao(dao: string, policy: SputnikPolicy, codeHash = this.opts.daoCodeHash): void {
    this.addAccount(dao, [], 10n * NEAR, codeHash);
    this.daos.set(dao, { policy, proposals: [] });
  }

  rpc() {
    return {
      chainId: async () => 'testnet',
      account: async (id: string): Promise<AccountView | null> => {
        const a = this.accounts.get(id);
        return a ? { amount: a.amount.toString(), locked: '0', code_hash: a.codeHash, storage_usage: 1000 } : null;
      },
      accessKeys: async (id: string) => this.keysOf(id).map((k) => structuredClone(k)),
      view: (async (account: string, method: string, args: Record<string, unknown> = {}) => this.view(account, method, args)) as <T>(account: string, method: string, args?: unknown) => Promise<T>,
      sendTx: async (signer: TxSigner, receiver: string, actions: Action[]) => this.send(signer, receiver, actions),
    };
  }

  private view(account: string, method: string, args: Record<string, unknown>): unknown {
    const dao = this.daos.get(account);
    if (dao) {
      if (method === 'get_policy') return structuredClone(dao.policy);
      if (method === 'get_last_proposal_id') return dao.proposals.length;
      if (method === 'get_proposals') {
        const from = Number(args.from_index);
        return structuredClone(dao.proposals.slice(from, from + Number(args.limit)));
      }
      if (method === 'get_proposal') {
        const p = dao.proposals[Number(args.id)];
        if (!p) throw new Error('Smart contract panicked: ERR_NO_PROPOSAL');
        return structuredClone(p);
      }
    }
    if (this.opts.factory && account === this.opts.factory && method === 'get_default_code_hash') return this.factoryCodeHash;
    if (account !== this.signer) throw new Error('CodeDoesNotExist');
    if (!this.config) throw new Error('CodeDoesNotExist');
    switch (method) {
      case 'get_config':
        return structuredClone(this.config);
      case 'get_governance':
        if (!this.governance) throw new Error('MethodNotFound');
        return structuredClone({ ...this.governance, updater_methods: ['set_issuer_key', 'propose_issuer_key_removal', 'execute_issuer_key_change'] });
      case 'get_key_changes':
        if (!this.governance) throw new Error('MethodNotFound');
        return structuredClone(this.keyChanges);
      case 'get_issuer':
        return structuredClone(this.issuersByProvider[String(args.provider)] ?? this.issuer);
      case 'get_scope':
        return structuredClone(args.scope_id === 'global' ? this.globalScope : (this.scopes[String(args.scope_id)] ?? null));
      case 'scope_for_client': {
        const key = `${String(args.provider)}/${String(args.aud)}`;
        const has = (clients: unknown) => Array.isArray(clients) && clients.some((c) => Array.isArray(c) && `${c[0]}/${c[1]}` === key);
        if (has((this.globalScope as { clients?: unknown } | null)?.clients)) return 'global';
        return Object.values(this.scopes).find((sc) => has(sc.clients))?.id ?? null;
      }
      default:
        return null;
    }
  }

  private send(signer: TxSigner, receiver: string, actions: Action[]): { hash: string; value: unknown } {
    const from = this.accounts.get(signer.accountId);
    const pk = signer.keyPair.getPublicKey().toString();
    if (!from || !from.keys.some((k) => k.public_key === pk)) throw new Error(`Key ${pk} is not an access key of ${signer.accountId}`);
    this.sent.push({ signer: signer.accountId, receiver, actions });
    const hash = `hash${this.sent.length}`;
    let value: unknown = null;
    // Actions of one transaction are atomic: work on a copy, commit at the end.
    const snapshot = this.snapshot();
    try {
      for (const a of actions) value = this.apply(signer.accountId, receiver, a);
    } catch (err) {
      this.restore(snapshot);
      throw new Error(`Transaction ${hash} failed: ${(err as Error).message}`);
    }
    return { hash, value };
  }

  private snapshot() {
    return {
      accounts: structuredClone([...this.accounts.entries()]),
      config: structuredClone(this.config),
      governance: structuredClone(this.governance),
      registry: structuredClone({ globalScope: this.globalScope, scopes: this.scopes, removed: this.removedClients, next: this.nextScope }),
    };
  }

  private restore(s: ReturnType<SimChain['snapshot']>): void {
    this.accounts.clear();
    for (const [k, v] of s.accounts) this.accounts.set(k, v);
    this.config = s.config;
    this.governance = s.governance;
    this.globalScope = s.registry.globalScope;
    this.scopes = s.registry.scopes;
    this.removedClients = s.registry.removed;
    this.nextScope = s.registry.next;
  }

  private apply(predecessor: string, receiver: string, a: Action): unknown {
    if (a.deployContract) {
      const acct = this.accounts.get(receiver);
      if (!acct) throw new Error('AccountDoesNotExist');
      acct.codeHash = codeHashOf(a.deployContract.code);
      return null;
    }
    if (a.createAccount) {
      if (this.accounts.has(receiver)) throw new Error('AccountAlreadyExists');
      this.addAccount(receiver, [], 0n);
      return null;
    }
    if (a.transfer) {
      const acct = this.accounts.get(receiver);
      if (acct) acct.amount += a.transfer.deposit;
      return null;
    }
    if (a.addKey) {
      const acct = this.accounts.get(receiver)!;
      const fc = a.addKey.accessKey.permission.functionCall;
      if (acct.keys.some((k) => k.public_key === a.addKey!.publicKey.toString())) throw new Error('AddKeyAlreadyExists');
      acct.keys.push({
        public_key: a.addKey.publicKey.toString(),
        access_key: { nonce: 0, permission: fc ? { FunctionCall: { allowance: fc.allowance?.toString() ?? null, receiver_id: fc.receiverId, method_names: fc.methodNames } } : 'FullAccess' },
      });
      return null;
    }
    if (a.deleteKey) {
      const acct = this.accounts.get(receiver)!;
      const pk = a.deleteKey.publicKey.toString();
      if (!acct.keys.some((k) => k.public_key === pk)) throw new Error('DeleteKeyDoesNotExist');
      acct.keys = acct.keys.filter((k) => k.public_key !== pk);
      return null;
    }
    const fc = a.functionCall;
    if (!fc) throw new Error('Unsupported action');
    const raw = Buffer.from(fc.args);
    const args = (fc.methodName === 'execute_upgrade' ? {} : JSON.parse(raw.toString('utf8') || '{}')) as Record<string, unknown>;
    if (this.daos.has(receiver)) return this.daoCall(predecessor, receiver, fc.methodName, args, fc.deposit);
    if (this.opts.factory && receiver === this.opts.factory && fc.methodName === 'create') return this.factoryCreate(predecessor, args, fc.deposit);
    if (fc.methodName === 'create_account' && !receiver.includes('.')) {
      const id = String(args.new_account_id);
      if (this.accounts.has(id)) return false;
      this.addAccount(id, [{ public_key: String(args.new_public_key), access_key: { nonce: 0, permission: 'FullAccess' } }], fc.deposit);
      return true;
    }
    if (receiver === this.signer) return this.hana(predecessor, fc.methodName, args, raw);
    return null;
  }

  private factoryCreate(_predecessor: string, args: Record<string, unknown>, deposit: bigint): unknown {
    const init = JSON.parse(Buffer.from(String(args.args), 'base64').toString('utf8')) as { policy: SputnikPolicy };
    const dao = `${String(args.name)}.${this.opts.factory}`;
    if (deposit < 5_396_790n * 10n ** 18n) throw new Error('ERR_NOT_ENOUGH_DEPOSIT');
    // The testnet factory doesn't return its promise: the transaction's value is empty, and the `on_create` result
    // (false when the name is taken, deposit refunded) lands only in a callback receipt.
    if (this.accounts.has(dao) || this.opts.factoryRefuses) return null;
    this.addDao(dao, init.policy, this.factoryCodeHash);
    this.accounts.get(dao)!.amount = deposit;
    return null;
  }

  private daoCall(predecessor: string, dao: string, method: string, args: Record<string, unknown>, deposit: bigint): unknown {
    const d = this.daos.get(dao)!;
    const members = ((d.policy.roles[0]?.kind as { Group: string[] }).Group ?? []) as string[];
    if (!members.includes(predecessor)) throw new Error('ERR_PERMISSION_DENIED');
    if (method === 'add_proposal') {
      if (deposit < BigInt(d.policy.proposal_bond)) throw new Error('ERR_MIN_BOND');
      const input = args.proposal as { description: string; kind: unknown };
      const id = d.proposals.length;
      d.proposals.push({ id, proposer: predecessor, description: input.description, kind: input.kind, status: 'InProgress', votes: {}, submission_time: String(BigInt(this.now) * 1_000_000n) });
      return id;
    }
    if (method === 'act_proposal') {
      const p = d.proposals[Number(args.id)];
      if (!p) throw new Error('ERR_NO_PROPOSAL');
      if (p.status !== 'InProgress') throw new Error('ERR_PROPOSAL_NOT_READY_FOR_VOTE');
      if (p.votes[predecessor]) throw new Error('ERR_ALREADY_VOTED');
      const action = String(args.action);
      if (action !== 'VoteApprove' && action !== 'VoteReject') throw new Error(`Unsupported action ${action}`);
      p.votes[predecessor] = action === 'VoteApprove' ? 'Approve' : 'Reject';
      // The threshold comes from the group's size now (sputnik's proposal_status recomputes it at every vote).
      const needed = votesNeeded(d.policy.default_vote_policy.threshold, members.length);
      const count = (v: string) => Object.values(p.votes).filter((x) => x === v).length;
      if (count('Approve') >= needed) {
        const kind = p.kind as {
          FunctionCall?: { receiver_id: string; actions: { method_name: string; args: string }[] };
          AddMemberToRole?: { member_id: string; role: string };
          RemoveMemberFromRole?: { member_id: string; role: string };
        };
        const fc = kind.FunctionCall;
        try {
          if (fc) for (const act of fc.actions) this.apply(dao, fc.receiver_id, { functionCall: { methodName: act.method_name, args: Buffer.from(act.args, 'base64'), gas: 0n, deposit: 0n } } as unknown as Action);
          const change = kind.AddMemberToRole ?? kind.RemoveMemberFromRole;
          if (change) {
            // policy.rs add_member_to_role / remove_member_from_role: a missing role only logs ERR_ROLE_NOT_FOUND.
            const role = d.policy.roles.find((r) => r.name === change.role);
            const group = (role?.kind as { Group?: string[] } | undefined)?.Group;
            if (group) {
              const next = new Set(group);
              if (kind.AddMemberToRole) next.add(change.member_id);
              else next.delete(change.member_id);
              role!.kind = { Group: [...next] };
            }
          }
          p.status = 'Approved';
        } catch {
          p.status = 'Failed';
        }
      } else if (count('Reject') >= needed) p.status = 'Rejected';
      return null;
    }
    throw new Error(`MethodNotFound ${method}`);
  }

  private assertOwner(predecessor: string): void {
    if (predecessor !== this.config?.owner) throw new Error('Smart contract panicked: Only the owner can do this');
  }

  private hana(predecessor: string, method: string, args: Record<string, unknown>, raw: Buffer): unknown {
    const g = () => {
      if (!this.governance) throw new Error(`MethodNotFound ${method}`);
      return this.governance;
    };
    const G = () => Number(this.config?.governance_delay_ms ?? 0);
    switch (method) {
      case 'new':
        if (this.config) throw new Error('The contract has already been initialized');
        this.config = { owner: args.owner, mpc: args.mpc, ckd_domain_id: args.ckd_domain_id, change_delay_ms: args.change_delay_ms, issuer_key_delay_ms: args.issuer_key_delay_ms, governance_delay_ms: args.governance_delay_ms, sponsors: [], console_audiences: [], shared_clients: [], pending_shared_clients: [], paused: false };
        this.governance = { ...structuredClone(GOVERNANCE_DEFAULT), watchdogs: (args.watchdogs as string[]).map((account_id) => ({ account_id, confirm_from_ms: 0 })) };
        return null;
      case 'add_updater_key': {
        this.assertOwner(predecessor);
        if (g().updater_keys.length >= 2) throw new Error('Smart contract panicked: Too many updater keys');
        const pk = String(args.public_key);
        g().updater_keys.push(pk);
        this.accounts.get(this.signer)!.keys.push({
          public_key: pk,
          access_key: { nonce: 0, permission: { FunctionCall: { allowance: NEAR.toString(), receiver_id: this.signer, method_names: ['set_issuer_key', 'propose_issuer_key_removal', 'execute_issuer_key_change'] } } },
        });
        return true;
      }
      case 'delete_updater_key': {
        this.assertOwner(predecessor);
        const pk = String(args.public_key);
        g().updater_keys = g().updater_keys.filter((k) => k !== pk);
        const acct = this.accounts.get(this.signer)!;
        acct.keys = acct.keys.filter((k) => k.public_key !== pk);
        return null;
      }
      case 'add_watchdog':
        this.assertOwner(predecessor);
        g().watchdogs.push({ account_id: String(args.account_id), confirm_from_ms: this.now + G() });
        return null;
      case 'propose_upgrade':
        this.assertOwner(predecessor);
        g().pending_upgrade = { code_hash: String(args.code_hash), proposed_at_ms: this.now, executable_at_ms: this.now + G() };
        return null;
      case 'execute_upgrade': {
        const pending = g().pending_upgrade;
        if (!pending) throw new Error('Smart contract panicked: No pending upgrade');
        if (this.now < pending.executable_at_ms) throw new Error('Smart contract panicked: Upgrade is still delayed');
        if (codeHashOf(raw) !== pending.code_hash) throw new Error("Smart contract panicked: Code doesn't match the proposed hash");
        g().pending_upgrade = null;
        // Deploy + migrate are one receipt: a failing migrate keeps the old code (the execute receipt still commits).
        if (!this.failMigrate) this.accounts.get(this.signer)!.codeHash = pending.code_hash;
        return null;
      }
      case 'propose_owner':
        this.assertOwner(predecessor);
        g().pending_owner = { owner: String(args.owner), acceptable_at_ms: this.now + G() };
        return null;
      case 'accept_owner': {
        const p = g().pending_owner;
        if (!p || p.owner !== predecessor) throw new Error('Smart contract panicked: Not the proposed owner');
        if (this.now < p.acceptable_at_ms) throw new Error('Smart contract panicked: Owner change is still delayed');
        this.config = { ...this.config, owner: predecessor };
        g().pending_owner = null;
        return null;
      }
      case 'set_issuer_key':
      case 'propose_issuer_key_removal':
      case 'execute_issuer_key_change':
      case 'remove_issuer_key':
        return method === 'remove_issuer_key' ? true : 7;
      case 'set_issuer': {
        this.assertOwner(predecessor);
        const seeded = this.issuersByProvider[String(args.provider)];
        if (seeded) seeded.iss_values = [...(args.iss_values as string[])];
        return null;
      }
      case 'admin_register_scope': {
        this.assertOwner(predecessor);
        const clients = (args.clients ?? []) as [string, string][];
        for (const [p, a] of clients) {
          const key = `${p}/${a}`;
          if (this.view(this.signer, 'scope_for_client', { provider: p, aud: a }) !== null) throw new Error('Smart contract panicked: Client is already registered');
          const removed = this.removedClients[key];
          if (removed && this.now < removed.freeAt) throw new Error('Smart contract panicked: Client was recently removed from another scope');
        }
        const id = args.scope_id === 'global' ? 'global' : `s${this.nextScope++}`;
        const scope = { id, owners: (args.owners ?? []) as unknown[], clients, allow_shared: args.allow_shared === true };
        if (id === 'global') this.globalScope = scope;
        else this.scopes[id] = scope;
        for (const [p, a] of clients) delete this.removedClients[`${p}/${a}`];
        return id;
      }
      case 'remove_client': {
        // OwnerAuth::Near only here: the predecessor must be an Owner::Near of the scope.
        const id = String(args.scope_id);
        const scope = (id === 'global' ? this.globalScope : this.scopes[id]) as { owners: unknown[]; clients: [string, string][]; allow_shared: boolean } | null;
        if (!scope) throw new Error('Smart contract panicked: No such scope');
        if (args.auth !== 'Near' || !scope.owners.some((o) => (o as { Near?: { account_id?: string } }).Near?.account_id === predecessor)) {
          throw new Error('Smart contract panicked: Caller is not a NEAR owner of this scope');
        }
        const key = `${String(args.provider)}/${String(args.aud)}`;
        if (!scope.clients.some(([p, a]) => `${p}/${a}` === key)) throw new Error('Smart contract panicked: Client is not in this scope');
        if (scope.clients.length <= 1 && !scope.allow_shared) throw new Error('Smart contract panicked: Cannot remove the last client of a scope without shared login');
        scope.clients = scope.clients.filter(([p, a]) => `${p}/${a}` !== key);
        this.removedClients[key] = { scopeId: id, freeAt: this.now + Number(this.config?.change_delay_ms ?? 0) };
        return null;
      }
      default:
        if (method.startsWith('set_') || method === 'pause' || method === 'unpause') {
          this.assertOwner(predecessor);
          return null;
        }
        throw new Error(`MethodNotFound ${method}`);
    }
  }
}
