#!/usr/bin/env bash
# POC Google key poster: copies Google's current ID-token signing keys (JWKS) into hana-signer.
# Run when Google rotates keys (every few weeks); safe to re-run. Production replaces this with 2-of-3
# independent posters and an activation delay.
#
#   bash contracts/hana-signer/post-google-keys.sh
set -euo pipefail

export PATH="$HOME/.cargo/bin:$PATH"
CONTRACT="${CONTRACT:-hana-signer.testnet}"
JWKS="https://www.googleapis.com/oauth2/v3/certs"

curl -fsS "$JWKS" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    for (const k of JSON.parse(s).keys) if (k.kty === "RSA" && k.alg === "RS256") console.log([k.kid, k.n, k.e].join(" "));
  });' | while read -r KID N E; do
  echo "• Posting Google key $KID"
  near contract call-function as-transaction "$CONTRACT" set_google_key \
    json-args "{\"kid\":\"$KID\",\"n\":\"$N\",\"e\":\"$E\"}" \
    prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' \
    sign-as "$CONTRACT" network-config testnet sign-with-legacy-keychain send </dev/null >/dev/null
done
echo "✓ Google keys posted to $CONTRACT"
