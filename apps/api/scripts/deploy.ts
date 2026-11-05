// `wrangler deploy <args…>` stamped with this checkout's build id (D384): the HANA_BUILD var, which GET /v1/health
// reports and `deploy-check <env>` compares across the env's Workers and page bundles. The package's `deploy` script
// (and, for the API, `deploy:pages`) runs this; a raw `wrangler deploy` leaves the Worker unstamped.
import { stampedDeploy } from '@hana-id/env/local-build';

process.exitCode = stampedDeploy(process.argv.slice(2));
