// The console SPA's local preview (dev only, never deployed): the SPA's own Vite config with the mocked `/api/*` of
// preview/mock-api.ts, served on 127.0.0.1 only. `pnpm --filter @hana-id/console preview:web`, then open
// http://127.0.0.1:5178/__preview/<scenario>?to=<path> (apps/console/README.md "Local preview").
import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config.ts';
import { mockApi } from './plugin.ts';

export default mergeConfig(
  base,
  defineConfig({
    plugins: [mockApi()],
    server: { host: '127.0.0.1', port: 5178, strictPort: true },
  }),
);
