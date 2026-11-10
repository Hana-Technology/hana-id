// Shared pieces of the admin's Node-side ledger tests (batch C12): a fresh PGlite ledger with every migration and past
// months' partitions, the LedgerStore over it as the usage_admin role, events inserted as the owner, a fake NEAR
// reader, email sender and R2 bucket, and fake AdminRpc / StaffRpc clients. No network, no Neon.
import { type TestDb, freshDb } from '../../api/test-usage/db.ts';
import type { EmailMessage, EmailSender, SendResult } from '../src/email/sender.ts';
import { type LedgerStore, sqlLedger } from '../src/ledger.ts';
import type { FinalTx, NearReader, TxRead } from '../src/near.ts';

export const RELAYER = 'relayer.test.near';
export const SIGNER = 'signer.test.near';
export const PK_A = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';
export const PK_B = 'ed25519:9qQxjvB6qdb3vZ9bm2AFNQFTDhb6uGqfL63y3pTBMSRY';
/** The Home pool's key (POST /v1/home/login only). */
export const PK_HOME = 'ed25519:4kqyRk2KyNBUm2oWT7m8n3fESEFJr3vV3YdBSiHVpDWp';
export const POOL_KEYS = [
  { pool: 'session' as const, publicKey: PK_A },
  { pool: 'owner' as const, publicKey: PK_B },
  { pool: 'home' as const, publicKey: PK_HOME },
];
export const ALIAS = 'security@hana.example';

/** A fresh ledger with partitions for `months` ('YYYY_MM') besides the current ones, and its admin store. */
export async function ledgerDb(months: string[] = []): Promise<{ db: TestDb; store: LedgerStore }> {
  const db = await freshDb();
  for (const m of months) {
    const [y, mo] = m.split('_').map(Number) as [number, number];
    await db.exec(`CREATE TABLE IF NOT EXISTS usage.events_${m} PARTITION OF usage.events FOR VALUES FROM ('${new Date(Date.UTC(y, mo - 1, 1)).toISOString()}') TO ('${new Date(Date.UTC(y, mo, 1)).toISOString()}')`);
  }
  const store = sqlLedger((sql, params) => db.asRole('usage_admin', () => db.query(sql, params)));
  return { db, store };
}

let seq = 0;
/** A base58-shaped transaction hash, unique per call. */
export const txHash = (): string => {
  const n = (++seq).toString().replace(/0/gu, 'z');
  return `H${n}${'B'.repeat(43 - n.length)}`;
};

export interface Ev {
  rid?: string;
  at: number;
  received?: number;
  org?: string;
  app?: string | null;
  scope?: string;
  endpoint?: string;
  outcome?: 'ok' | 'rejected' | 'error';
  code?: string | null;
  latency?: number;
  relayed?: boolean;
  tx?: string;
  pk?: string;
  nonce?: bigint;
  uid?: number;
}

/** Inserts one event as the owner (as record_event would, with full control of received_at). */
export async function insertEvent(db: TestDb, e: Ev): Promise<{ rid: string; at: number; tx: string | null; pk: string | null; nonce: bigint | null; org: string }> {
  const rid = e.rid ?? `req_${++seq}_xxxxxxxx`;
  const relayed = e.relayed ?? false;
  const tx = relayed ? (e.tx ?? txHash()) : (e.tx ?? null);
  const pk = tx ? (e.pk ?? PK_A) : null;
  const nonce = tx ? (e.nonce ?? BigInt(1_000_000 + seq)) : null;
  const outcome = e.outcome ?? 'ok';
  const org = e.org ?? 'org_a';
  await db.query(
    `INSERT INTO usage.events (request_id, at, received_at, org_id, app_id, scope_id, endpoint, outcome, code, status, latency_ms, relayed, near_tx, relayer_pk, relayer_nonce, uid)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 200, $10, $11, $12, $13, $14, $15)`,
    [
      rid,
      new Date(e.at).toISOString(),
      new Date(e.received ?? e.at).toISOString(),
      org,
      e.app === undefined ? (e.endpoint === 'owner_action' || e.endpoint === 'home_login' ? null : 'app_1') : e.app,
      e.scope ?? 's1',
      e.endpoint ?? 'login',
      outcome,
      outcome === 'ok' ? null : (e.code ?? 'contract_rejected'),
      e.latency ?? 100,
      relayed,
      tx,
      pk,
      nonce === null ? null : nonce.toString(),
      e.uid === undefined ? null : Buffer.from(new Uint8Array(16).fill(e.uid)),
    ],
  );
  return { rid, at: e.at, tx, pk, nonce, org };
}

/** A fake NEAR RPC: transactions by hash, access key nonces by key; every call is recorded. */
export class FakeNear implements NearReader {
  readonly txs = new Map<string, TxRead>();
  readonly nonces = new Map<string, bigint | null | Error>();
  readonly calls: string[] = [];
  /** A transaction at FINAL as the relayer would have signed it, burning `gas` and `tokens`. */
  finalTx(hash: string, o: Partial<Omit<FinalTx, 'gas' | 'nonce'>> & { pk: string; nonce: bigint; gas?: bigint; tokens?: bigint }): void {
    this.txs.set(hash, { kind: 'final', tx: { hash, signerId: o.signerId ?? RELAYER, publicKey: o.publicKey ?? o.pk, nonce: o.nonce, receiverId: o.receiverId ?? SIGNER, gas: { gasBurnt: o.gas ?? 3_000_000_000_000n, tokensBurnt: o.tokens ?? 300_000_000_000_000_000_000n } } });
  }
  async txFinal(hash: string, senderId: string): Promise<TxRead> {
    this.calls.push(`tx:${hash}:${senderId}`);
    return this.txs.get(hash) ?? { kind: 'not_final', why: 'unknown_transaction' };
  }
  async accessKeyNonce(accountId: string, pk: string): Promise<bigint | null> {
    this.calls.push(`key:${accountId}:${pk}`);
    const v = this.nonces.get(pk);
    if (v instanceof Error) throw v;
    return v === undefined ? null : v;
  }
}

export class FakeEmail implements EmailSender {
  configured = true;
  readonly sent: EmailMessage[] = [];
  failFor = new Set<string>();
  async send(m: EmailMessage): Promise<SendResult> {
    if (this.failFor.has(m.to)) return { ok: false, error: 'HTTP 500' };
    this.sent.push(m);
    return { ok: true, id: `msg_${this.sent.length}` };
  }
}

/** An R2 bucket in memory (put with its sha256 checked, get), enough for STATEMENTS and EXPORTS. */
export class FakeBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  async put(key: string, value: string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream | null, opts?: R2PutOptions): Promise<R2Object> {
    if (!(typeof value === 'string' || value instanceof Uint8Array)) throw new Error('FakeBucket takes bytes or text');
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    if (this.objects.has(key)) throw new Error('locked: an object under this key already exists');
    if (opts?.sha256) {
      const got = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
      if (got !== opts.sha256) throw new Error('sha256 mismatch');
    }
    this.objects.set(key, { bytes, contentType: (opts?.httpMetadata as { contentType?: string } | undefined)?.contentType });
    return {} as R2Object;
  }
  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; body: ReadableStream } | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    return { arrayBuffer: async () => o.bytes.slice().buffer, body: new Blob([o.bytes]).stream() };
  }
}

export const STAFF = { actor: { kind: 'hana' as const, id: 'access-sub-1', email: 'staff@hana.example' }, requestId: 'req_staff_00000001', clientIp: '198.51.100.9' };

/** AdminRpc and StaffRpc as the statement and notice code calls them. */
export function fakeRpcs(o: { orgName?: string; billingEmail?: string; contacts?: string[]; apps?: { id: string; name: string; scopeId: string; environment: string }[]; kind?: 'partner' | 'internal' } = {}) {
  const audit: Record<string, unknown>[] = [];
  return {
    audit,
    api: {
      listApps: async () => ({ ok: true as const, apps: o.apps ?? [{ id: 'app_1', name: 'Acme web', scopeId: 's1', environment: 'live' }] }),
      getSecurityContacts: async () => ({ ok: true as const, emails: o.contacts ?? ['sec@partner.example'] }),
      relayerKeys: async () => ({ ok: true as const, keys: POOL_KEYS }),
    },
    console: {
      getOrg: async (c: { orgId: string }) => ({ ok: true as const, org: { id: c.orgId, name: o.orgName ?? 'Acme', kind: o.kind ?? ('partner' as const), status: 'active' as const, createdAt: 1, ...(o.billingEmail ? { billingEmail: o.billingEmail } : {}) }, members: [], invites: [] }),
      // Typed as the client's answer (its `Record<string, never>` body can't be written as a literal).
      recordStaffAction: async (c: Record<string, unknown>): Promise<never> => {
        if (audit.some((a) => a.requestId === c.requestId && a.action === c.action)) return { ok: false, code: 'already_applied' } as never;
        audit.push(c);
        return { ok: true } as never;
      },
    },
  };
}

export const DAY = 86_400_000;
export const utc = (s: string): number => Date.parse(s);
