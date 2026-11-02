// Only in the workerd run (vitest.workerd.config.ts): proves that run is the Workers runtime, not Node.
import { expect, it } from 'vitest';

it('runs in workerd, not Node', () => {
  expect(typeof navigator !== 'undefined' && navigator.userAgent).toBe('Cloudflare-Workers');
});
