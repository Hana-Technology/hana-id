// What apps/api imports from `cloudflare:workers` when its Worker runs in Node (the local stack and its unit tests):
// the Durable Object base class, which keeps the object's state and env as workerd's does. workers.ts maps the
// specifier here (a Node module hook for tsx, an alias in vitest.config.ts) and supplies the state.
//
// No TypeScript-only syntax beyond annotations: Node may load this file with its own type stripping.

export class DurableObject<Env = unknown> {
  protected readonly ctx: unknown;
  protected readonly env: Env;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
