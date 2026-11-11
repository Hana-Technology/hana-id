// Imported first (before anything that imports stack.ts, whose PORTS are read at import): sets HANA_E2E_PORT_BASE to
// this checkout's default (checkout-port.ts) unless it is set. Playwright's config imports it, so its webServer, its
// workers and the build all inherit the same value; the stack's own entry point does too, for `pnpm serve`.
import { CHECKOUT_ROOT, checkoutPortBase } from './checkout-port.ts';

if (!process.env.HANA_E2E_PORT_BASE?.trim()) process.env.HANA_E2E_PORT_BASE = String(checkoutPortBase(CHECKOUT_ROOT));
