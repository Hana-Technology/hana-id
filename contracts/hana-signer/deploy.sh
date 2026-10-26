#!/usr/bin/env bash
# Deploys hana-signer to NEAR testnet and sets up the gas relayer.
#
#   bash contracts/hana-signer/deploy.sh            # build, create both accounts (faucet), deploy, relayer key
#   bash contracts/hana-signer/deploy.sh lock       # after testing: delete the contract's keys (immutable)
#
# Needs near-cli-rs and cargo-near (~/.cargo/bin). Full-access keys go to the legacy keychain
# (~/.near-credentials/testnet). The relayer's function-call key is written to .env (gitignored).
set -euo pipefail

export PATH="$HOME/.cargo/bin:$PATH"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CONTRACT="${CONTRACT:-hana-signer.testnet}"
RELAYER="${RELAYER:-hana-relayer.testnet}"
NET="network-config testnet"
WASM="$HERE/target/near/hana_signer.wasm"

exists() {
  curl -s https://rpc.testnet.near.org -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" |
    grep -q '"amount"'
}

create() {
  if exists "$1"; then
    echo "• $1 already exists"
  else
    echo "• Creating $1 from the testnet faucet"
    near account create-account sponsor-by-faucet-service "$1" autogenerate-new-keypair save-to-legacy-keychain $NET create
  fi
}

set_env() { # set_env KEY VALUE: replace or append in .env
  local file="$ROOT/.env"
  touch "$file"
  grep -v "^$1=" "$file" >"$file.tmp" || true
  echo "$1=$2" >>"$file.tmp"
  mv "$file.tmp" "$file"
}

if [[ "${1:-}" == "lock" ]]; then
  KEYS=$(curl -s https://rpc.testnet.near.org -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\"}}" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result.keys.map(k=>k.public_key).join(",")))')
  [[ -z "$KEYS" ]] && { echo "$CONTRACT has no keys left: already locked."; exit 0; }
  echo "• Deleting every key on $CONTRACT: $KEYS"
  near account delete-keys "$CONTRACT" public-keys "$KEYS" $NET sign-with-legacy-keychain send
  echo "✓ $CONTRACT is locked: nobody (including Hana) can change its code or config."
  exit 0
fi

echo "• Building"
(cd "$HERE" && cargo near build non-reproducible-wasm --no-abi >/dev/null)

create "$CONTRACT"
create "$RELAYER"

echo "• Deploying $CONTRACT"
near contract deploy "$CONTRACT" use-file "$WASM" with-init-call new \
  json-args '{"router":"jwt.fast-auth.testnet","mpc":"v1.signer-prod.testnet","secp256k1_domain":0,"ed25519_domain":1}' \
  prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' $NET sign-with-legacy-keychain send

echo "• Adding the relayer's function-call key (can only call $CONTRACT.sign, 1 NEAR gas allowance)"
KEYPAIR=$(cd "$ROOT" && node -e 'const {KeyPair}=require("@near-js/crypto");const k=KeyPair.fromRandom("ed25519");console.log(k.getPublicKey().toString()+" "+k.toString())')
PUBLIC="${KEYPAIR% *}"
SECRET="${KEYPAIR#* }"
near account add-key "$RELAYER" grant-function-call-access --allowance '1 NEAR' --contract-account-id "$CONTRACT" --function-names sign \
  use-manually-provided-public-key "$PUBLIC" $NET sign-with-legacy-keychain send
set_env NEAR_RELAYER_ACCOUNT_ID "$RELAYER"
set_env NEAR_RELAYER_PRIVATE_KEY "$SECRET"
set_env EMBED_SIGNER_CONTRACT "$CONTRACT"
set_env VITE_EMBED_SIGNER_CONTRACT "$CONTRACT"

echo
echo "✓ Deployed. Relayer key written to .env (NEAR_RELAYER_ACCOUNT_ID, NEAR_RELAYER_PRIVATE_KEY, EMBED_SIGNER_CONTRACT)."
echo "  Restart the dev server to pick it up. For Vercel, add the same three variables to the project."
echo "  After testing: bash contracts/hana-signer/deploy.sh lock"
