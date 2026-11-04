import type { Env as FilesEnv } from '../src/env.ts';

declare global {
  namespace Cloudflare {
    interface Env extends FilesEnv {}
  }
}
