// Entry of the demo page (index.html): the real partner client from @hana-id/web, with the configuration baked in at
// build time (vite.config.ts). The logic is in page.ts.
import { VERSION, createHana } from '@hana-id/web';
import { startDemo } from './page.ts';
import './style.css';

startDemo({ config: __HANA_DEMO_CONFIG__, createClient: createHana, sdkVersion: VERSION });
