// `wrangler deploy <args…>` stamped with this checkout's build id (D384): the HANA_BUILD var, which
// GET /v1/email/health reports and `deploy-check <env>` compares with the API's and the page Workers'. The package's
// `deploy` script runs this; a raw `wrangler deploy` leaves the Worker unstamped.
import { stampedDeploy } from '@hana-id/env/local-build';

process.exitCode = stampedDeploy(process.argv.slice(2));
