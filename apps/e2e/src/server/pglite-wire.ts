// The usage ledger for an admin lane, without Docker (D873): PGlite (Postgres 18 in WASM, in process, as apps/api's
// ledger tests run it, D140) with apps/api's ledger migrations, behind a small Postgres wire-protocol listener on a
// loopback port, so the admin Worker's own `pg` client (ledger.ts, ops.ts) connects to it as to Hyperdrive's.
//
// The listener answers the start-up itself (no password: AuthenticationOk, then the session as the role Hyperdrive's
// config would use, `usage_admin`, with its real grants), then hands every frontend message to PGlite's
// `execProtocolRaw`, which is Postgres's own protocol code. PGlite is ONE session, so connections take turns: one at a
// time, in order (the admin opens one per request and closes it). Between two, any open transaction is rolled back and
// the role set again. Loopback only, a port the OS picks, gone with the stack.
import { type Server, type Socket, createServer } from 'node:net';

/** The slice of PGlite this needs. */
export interface PGliteLike {
  exec(sql: string): Promise<unknown>;
  execProtocolRaw(message: Uint8Array): Promise<Uint8Array>;
}

const SSL_REQUEST = 80877103;
const GSS_REQUEST = 80877104;
const CANCEL_REQUEST = 80877102;

function message(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

const cstr = (s: string): Buffer => Buffer.from(`${s}\0`, 'utf8');

/** What the backend says after a start-up: authenticated, its parameters, a key, ready. */
function startupAnswer(): Buffer {
  const params: [string, string][] = [
    ['server_version', '18.0'],
    ['server_encoding', 'UTF8'],
    ['client_encoding', 'UTF8'],
    ['DateStyle', 'ISO, MDY'],
    ['integer_datetimes', 'on'],
    ['standard_conforming_strings', 'on'],
    ['TimeZone', 'UTC'],
  ];
  const key = Buffer.alloc(8);
  key.writeInt32BE(process.pid, 0);
  key.writeInt32BE(1, 4);
  return Buffer.concat([message('R', Buffer.from([0, 0, 0, 0])), ...params.map(([k, v]) => message('S', Buffer.concat([cstr(k), cstr(v)]))), message('K', key), message('Z', Buffer.from('I'))]);
}

export class LedgerWire {
  private server: Server | null = null;
  private turn: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: PGliteLike,
    private readonly role: string,
  ) {}

  /** Listens on 127.0.0.1 at a port the OS picks; answers the connection string for the role. */
  async listen(): Promise<string> {
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    return `postgresql://${this.role}:local-stack@127.0.0.1:${port}/usage`;
  }

  close(): void {
    this.server?.close();
  }

  private accept(socket: Socket): void {
    socket.setNoDelay(true);
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const before = this.turn;
    this.turn = before.then(() => mine);
    let buf = Buffer.alloc(0);
    let started = false;
    let ready: Promise<void> | null = null;
    let work: Promise<void> = Promise.resolve();
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      // The next connection gets a clean session: no transaction left open, the role set again.
      void (ready ?? Promise.resolve())
        .then(() => this.db.exec('ROLLBACK').catch(() => undefined))
        .finally(() => release());
    };
    socket.on('close', done);
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      work = work.then(async () => {
        for (;;) {
          if (!started) {
            if (buf.length < 8) return;
            const len = buf.readInt32BE(0);
            if (buf.length < len) return;
            const code = buf.readInt32BE(4);
            buf = buf.subarray(len);
            if (code === SSL_REQUEST || code === GSS_REQUEST) {
              socket.write('N');
              continue;
            }
            if (code === CANCEL_REQUEST) {
              socket.end();
              return;
            }
            started = true;
            ready = before.then(async () => {
              await this.db.exec('ROLLBACK').catch(() => undefined);
              await this.db.exec(`RESET ROLE; SET ROLE ${this.role}`);
            });
            await ready;
            if (!socket.destroyed) socket.write(startupAnswer());
            continue;
          }
          if (buf.length < 5) return;
          const len = buf.readInt32BE(1) + 1;
          if (buf.length < len) return;
          const msg = buf.subarray(0, len);
          buf = buf.subarray(len);
          if (msg[0] === 0x58) {
            // Terminate.
            socket.end();
            return;
          }
          const out = await this.db.execProtocolRaw(Uint8Array.from(msg));
          if (!socket.destroyed && out.length) socket.write(Buffer.from(out));
        }
      }).catch((e: unknown) => {
        console.error('[e2e] ledger wire:', e instanceof Error ? e.message : e);
        socket.destroy();
      });
    });
  }
}
