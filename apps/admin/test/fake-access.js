// The email issuer's outbound fetches in the admin tests (vitest.config.ts `outboundService`): a fake Cloudflare Access
// team serving the suite's Access certs (the public half of the key the tests sign staff JWTs with), so the issuer's
// DirectoryRpc verifies each staff call for real. Nothing else is answered (502): no test reaches a real network.
export default {
  async fetch(request, env) {
    if (request.url === env.CERTS_URL) {
      return new Response(JSON.stringify({ keys: [JSON.parse(env.ACCESS_PUBLIC_JWK)] }), { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' } });
    }
    return new Response('fake access team: no such host', { status: 502 });
  },
};
