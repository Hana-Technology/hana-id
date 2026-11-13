// The UI preview's dev server (dev only, never deployed): preview/index.html on http://127.0.0.1:5181, loopback only.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: { host: '127.0.0.1', port: Number(process.env.PORT ?? 5181), strictPort: true },
  logLevel: 'warn',
});
