// @hana-id/react's own test files (../test), run against React 18: `react`, `react-dom` and @testing-library/react
// resolve to this package's copies (React 18.3.1), for the package's source as well as for the tests. pnpm gives
// this package's @testing-library/react and react-dom their own React 18 peer, so nothing loads React 19.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = createRequire(import.meta.url);
const exact = (spec: string) => ({ find: new RegExp(`^${spec.replaceAll('/', '\\/')}$`, 'u'), replacement: here.resolve(spec) });

export default defineConfig({
  root: fileURLToPath(new URL('../', import.meta.url)),
  resolve: {
    alias: [
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-dom',
      'react-dom/client',
      'react-dom/server',
      'react-dom/test-utils',
      '@testing-library/react',
    ].map(exact),
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}', 'react18/test/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
