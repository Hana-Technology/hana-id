// Entry of the stamps site (index.html): the real partner client from @hana-id/web, the UI module (src/ui) and the
// configuration baked in at build time (vite.config.ts). The logic is in app.ts; the rendering is src/ui's.
import { createHana } from '@hana-id/web';
import { startStamps } from './app.ts';
import { mountPassport } from './ui/index.ts';
// Journear Passport's design system first (the UI's stylesheet imports nothing itself), then the passport's look.
import '@hana-id/brand/tokens.css';
import '@hana-id/brand/fonts.css';
import '@hana-id/brand/components.css';
import './ui.css';

const root = document.getElementById('passport');
if (!root) throw new Error('Missing #passport');
startStamps({ config: __HANA_STAMPS_CONFIG__, createClient: createHana, mount: mountPassport, root });
