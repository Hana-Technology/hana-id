//! Shared setup for the sandbox tests: builds the wasm, starts a sandbox, deploys `hana-signer` with `mock-mpc`,
//! and mints test ID tokens.
//!
//! Tokens are signed by a throwaway RSA key generated per test run (kept in memory only). hana-signer's own
//! `src/test_fixture.json` can't be reused here: its private key is discarded and its tokens commit to session
//! expiries around a fixed 2027 timestamp, outside the 24 h window relative to the sandbox clock. The token format
//! and the byte layouts (session nonce, register proof, client proof, owner-action nonce, session message) are
//! re-implemented independently below from docs/batch-a2-shared-client.md (not from the contract code); tests/layouts.rs
//! pins them to vectors from a separate Python implementation.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signer as _, SigningKey};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use rsa::pkcs1v15::SigningKey as RsaSigningKey;
use rsa::sha2::Sha256 as RsaSha256;
use rsa::signature::SignatureEncoding;
use rsa::traits::PublicKeyParts;
use rsa::RsaPrivateKey;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const PROVIDER: &str = "google";
pub const ISS: &str = "https://accounts.google.com";
pub const KID: &str = "sandbox-test-kid";
pub const CKD_DOMAIN_ID: u64 = 2;
/// Small timelock so the tests can fast-forward past it.
pub const CHANGE_DELAY_MS: u64 = 20_000;
pub const APP_A: &str = "app-a.apps.googleusercontent.com";
pub const APP_B: &str = "app-b.apps.googleusercontent.com";
pub const APP_C: &str = "app-c.apps.googleusercontent.com";
pub const APP_D: &str = "app-d.apps.googleusercontent.com";
pub const APP_E: &str = "app-e.apps.googleusercontent.com";
pub const APP_X: &str = "app-x-unregistered.apps.googleusercontent.com";
pub const CONSOLE: &str = "console.apps.googleusercontent.com";
pub const USER_SUB: &str = "110248495921238986420";
pub const OWNER_SUB: &str = "owner-111";

/// Hana's shared Google login client (docs/batch-a2-shared-client.md).
pub const SHARED: &str = "hana-shared.apps.googleusercontent.com";
pub const SHARED_2: &str = "hana-shared-2.apps.googleusercontent.com";

/// Session pool (`RELAYER_KEYS`): the methods its function-call keys may call (docs/batch-a2-shared-client.md).
pub const SESSION_RELAYER_METHODS: &[&str] = &["create_session", "derive_key", "revoke_session", "prune_sessions"];
/// Owner pool (`OWNER_RELAYER_KEYS`): the methods its function-call keys may call.
pub const OWNER_RELAYER_METHODS: &[&str] = &[
    "propose_change",
    "cancel_change",
    "remove_client",
    "disable_shared_login",
    "execute_change",
    "register_scope",
    "apply_pending_config",
];
pub const KEYS_UPDATER_METHODS: &[&str] = &["set_issuer_key", "remove_issuer_key"];

/// Every change method of hana-signer (docs/batch-a-spec.md + docs/batch-a2-shared-client.md). The access-key test calls each one with each
/// function-call key, so a method added to the contract should be added here too.
pub const ALL_CHANGE_METHODS: &[&str] = &[
    "new",
    "set_owner",
    "set_sponsors",
    "set_console_audiences",
    "set_change_delay_ms",
    "enable_public_registration",
    "set_shared_clients",
    "apply_pending_config",
    "set_issuer",
    "set_issuer_key",
    "remove_issuer_key",
    "admin_register_scope",
    "register_scope",
    "propose_change",
    "execute_change",
    "cancel_change",
    "remove_client",
    "disable_shared_login",
    "create_session",
    "derive_key",
    "revoke_session",
    "prune_sessions",
];

/// Gas for calls a user or the admin signs with their own wallet (not relayed by the API), which choose their own
/// gas. Relayed calls (the session and owner pools) attach `api_gas(method)` instead, the gas the API attaches.
pub const GAS: Gas = Gas::from_tgas(300);

static API_GAS: OnceLock<std::result::Result<Vec<(String, u64)>, String>> = OnceLock::new();

/// Reads `DEFAULT_GAS_TGAS` from apps/api/src/gas.ts: the gas in Tgas the API attaches to each method it relays.
pub fn api_gas_table() -> Result<Vec<(String, u64)>> {
    API_GAS
        .get_or_init(|| parse_api_gas().map_err(|e| format!("{e:#}")))
        .clone()
        .map_err(|e| anyhow!(e))
}

fn parse_api_gas() -> Result<Vec<(String, u64)>> {
    let path = contracts_dir().parent().expect("repo root").join("apps").join("api").join("src").join("gas.ts");
    let src = std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    let start = src.find("export const DEFAULT_GAS_TGAS").with_context(|| format!("DEFAULT_GAS_TGAS not found in {}", path.display()))?;
    let body = &src[start..];
    let open = body.find("= {").context("DEFAULT_GAS_TGAS: no object literal")? + 3;
    let close = body[open..].find('}').context("unterminated DEFAULT_GAS_TGAS")? + open;
    let mut out = Vec::new();
    for entry in body[open..close].split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let (k, v) = entry.split_once(':').with_context(|| format!("DEFAULT_GAS_TGAS: bad entry {entry:?}"))?;
        let k = k.trim().trim_matches(|c| c == '\'' || c == '"').to_string();
        let v: u64 = v.trim().replace('_', "").parse().with_context(|| format!("DEFAULT_GAS_TGAS: bad value for {k}: {v:?}"))?;
        out.push((k, v));
    }
    if out.is_empty() {
        bail!("DEFAULT_GAS_TGAS in {} is empty", path.display());
    }
    Ok(out)
}

/// The gas the API attaches when it relays `method` (apps/api/src/gas.ts). Every call the sandbox sends through
/// `relayer_fc` / `relayer_owner_fc` attaches exactly this, so a method that outgrows its API budget fails here with
/// "Exceeded the prepaid gas" instead of on testnet. Panics if the API has no entry for `method`.
pub fn api_gas(method: &str) -> Gas {
    let table = api_gas_table().expect("apps/api/src/gas.ts DEFAULT_GAS_TGAS");
    let tgas = table.iter().find(|(m, _)| m == method).unwrap_or_else(|| panic!("apps/api/src/gas.ts has no gas for {method}")).1;
    Gas::from_tgas(tgas)
}

/// Gas create_session may burn (RS256 verification in wasm, plus pruning up to 3 sessions): the gas the API attaches
/// to it, so a regression in the verifier shows up here, not as failed logins on testnet.
pub fn create_session_gas_budget() -> Gas {
    api_gas("create_session")
}

/// Reads `export const <name> = [ '...', ... ]` from scripts/lib/contract.ts: the allowlists deploy-contract.ts
/// actually installs, so the sandbox keys can't drift from the deployed ones.
pub fn deploy_script_methods(name: &str) -> Result<Vec<String>> {
    let path = contracts_dir().parent().expect("repo root").join("scripts").join("lib").join("contract.ts");
    let src = std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    let start = src.find(&format!("export const {name} = [")).with_context(|| format!("{name} not found in {}", path.display()))?;
    let body = &src[start..];
    let open = body.find('[').unwrap() + 1;
    let close = body.find(']').with_context(|| format!("unterminated {name}"))?;
    Ok(body[open..close]
        .split(',')
        .map(|s| s.trim().trim_matches(|c| c == '\'' || c == '"').to_string())
        .filter(|s| !s.is_empty())
        .collect())
}

/// Asserts that `pk` on `account` is a function-call key for `receiver` limited to exactly `methods` (an empty
/// method list on chain means "any method", so it fails this check).
pub async fn assert_function_call_key(worker: &Worker<Sandbox>, account: &AccountId, pk: &near_workspaces::types::PublicKey, receiver: &AccountId, methods: &[&str]) -> Result<()> {
    let key = worker.view_access_key(account, pk).await?;
    let near_workspaces::types::AccessKeyPermission::FunctionCall(fc) = key.permission else {
        bail!("{pk} on {account} is a full-access key");
    };
    if fc.receiver_id != receiver.as_str() {
        bail!("{pk} on {account}: receiver {} != {receiver}", fc.receiver_id);
    }
    let mut got: Vec<&str> = fc.method_names.iter().map(String::as_str).collect();
    let mut want = methods.to_vec();
    got.sort_unstable();
    want.sort_unstable();
    if got != want {
        bail!("{pk} on {account}: method_names {got:?} != {want:?}");
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Wasm builds

fn contracts_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("contracts dir").to_path_buf()
}

/// Builds a contract crate with `cargo near build non-reproducible-wasm`, in that crate's directory so its own
/// `rust-toolchain.toml` applies (this crate's toolchain env vars are removed), into `target/wasm` of this crate.
/// `override_var` names an env var that, when set, points to a prebuilt wasm instead.
fn build_wasm(crate_dir: &str, wasm_name: &str, override_var: &str) -> Result<Vec<u8>> {
    if let Ok(path) = std::env::var(override_var) {
        return std::fs::read(&path).with_context(|| format!("reading {override_var}={path}"));
    }
    let dir = contracts_dir().join(crate_dir);
    let target = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("wasm");
    let mut cmd = Command::new("cargo");
    cmd.args(["near", "build", "non-reproducible-wasm"]).current_dir(&dir);
    for (key, _) in std::env::vars() {
        let keep = key == "CARGO_HOME" || key == "RUSTUP_HOME";
        if !keep && (key.starts_with("CARGO") || key.starts_with("RUSTUP_") || key.starts_with("RUSTC") || key.starts_with("RUSTFLAGS") || key == "RUSTDOC") {
            cmd.env_remove(key);
        }
    }
    cmd.env("CARGO_TARGET_DIR", &target);
    let out = cmd.output().with_context(|| format!("running cargo near build in {}", dir.display()))?;
    if !out.status.success() {
        bail!("wasm build of {} failed:\n{}\n{}", crate_dir, String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    }
    let wasm = target.join("near").join(wasm_name);
    std::fs::read(&wasm).with_context(|| format!("reading {}", wasm.display()))
}

static WASMS: OnceLock<std::result::Result<(Vec<u8>, Vec<u8>), String>> = OnceLock::new();

/// (hana-signer, mock-mpc) wasm, built once per test binary.
pub fn wasms() -> Result<(Vec<u8>, Vec<u8>)> {
    WASMS
        .get_or_init(|| {
            let signer = build_wasm("hana-signer", "hana_signer.wasm", "HANA_SIGNER_WASM").map_err(|e| format!("{e:#}"))?;
            let mpc = build_wasm("mock-mpc", "mock_mpc.wasm", "MOCK_MPC_WASM").map_err(|e| format!("{e:#}"))?;
            Ok((signer, mpc))
        })
        .clone()
        .map_err(|e| anyhow!(e))
}

// ---------------------------------------------------------------------------------------------------------------
// Encodings (docs/contract-interface.md)

pub fn b64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn sha256(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}

pub fn borsh_str(s: &str) -> Vec<u8> {
    let mut out = (s.len() as u32).to_le_bytes().to_vec();
    out.extend_from_slice(s.as_bytes());
    out
}

/// borsh(Owner) from its JSON form.
pub fn borsh_owner(owner: &Value) -> Vec<u8> {
    if let Some(near) = owner.get("Near") {
        let mut out = vec![0u8];
        out.extend(borsh_str(near["account_id"].as_str().unwrap()));
        out
    } else {
        let oidc = &owner["Oidc"];
        let mut out = vec![1u8];
        out.extend(borsh_str(oidc["provider"].as_str().unwrap()));
        out.extend(borsh_str(oidc["sub"].as_str().unwrap()));
        out
    }
}

pub fn borsh_owners(owners: &[Value]) -> Vec<u8> {
    let mut out = (owners.len() as u32).to_le_bytes().to_vec();
    for o in owners {
        out.extend(borsh_owner(o));
    }
    out
}

pub fn borsh_u64(v: u64) -> Vec<u8> {
    v.to_le_bytes().to_vec()
}

/// borsh(Vec<(String, String)>) of `(provider, aud)` pairs.
pub fn borsh_clients(clients: &[(&str, &str)]) -> Vec<u8> {
    let mut out = (clients.len() as u32).to_le_bytes().to_vec();
    for (provider, aud) in clients {
        out.extend(borsh_str(provider));
        out.extend(borsh_str(aud));
    }
    out
}

/// borsh(Change) from its JSON form: AddClient = 0, SetOwners = 1, SetAllowShared = 2 (declaration order).
pub fn borsh_change(change: &Value) -> Vec<u8> {
    if let Some(c) = change.get("AddClient") {
        let mut out = vec![0u8];
        out.extend(borsh_str(c["provider"].as_str().unwrap()));
        out.extend(borsh_str(c["aud"].as_str().unwrap()));
        out
    } else if let Some(c) = change.get("SetOwners") {
        let mut out = vec![1u8];
        out.extend(borsh_owners(c["owners"].as_array().unwrap()));
        out
    } else if let Some(c) = change.get("SetAllowShared") {
        vec![2u8, c["allow"].as_bool().unwrap() as u8]
    } else {
        panic!("unknown change {change}")
    }
}

pub fn borsh_opt_str(s: Option<&str>) -> Vec<u8> {
    match s {
        None => vec![0u8],
        Some(s) => {
            let mut out = vec![1u8];
            out.extend(borsh_str(s));
            out
        }
    }
}

/// Session nonce: "hana-id/session/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ pk (32) ‖ expires_at_ms u64 LE ‖
/// key_index u32 LE ‖ max_uses u32 LE ‖ salt.
#[allow(clippy::too_many_arguments)]
pub fn session_nonce(signer: &str, scope_id: &str, pk: &[u8], expires_at_ms: u64, key_index: u32, max_uses: u32, salt: &[u8]) -> String {
    let mut m = b"hana-id/session/v1".to_vec();
    m.extend(borsh_str(signer));
    m.extend(borsh_str(scope_id));
    m.extend_from_slice(pk);
    m.extend_from_slice(&expires_at_ms.to_le_bytes());
    m.extend_from_slice(&key_index.to_le_bytes());
    m.extend_from_slice(&max_uses.to_le_bytes());
    m.extend_from_slice(salt);
    b64url(&sha256(&m))
}

/// Register proof: "hana-id/register/v1" ‖ borsh(signer) ‖ borsh(owners) ‖ borsh(clients, in client_proofs order) ‖
/// allow_shared u8.
pub fn register_nonce(signer: &str, owners: &[Value], clients: &[(&str, &str)], allow_shared: bool) -> String {
    let mut m = b"hana-id/register/v1".to_vec();
    m.extend(borsh_str(signer));
    m.extend(borsh_owners(owners));
    m.extend(borsh_clients(clients));
    m.push(allow_shared as u8);
    b64url(&sha256(&m))
}

/// Client proof: "hana-id/client-proof/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ action_nonce u64 LE.
pub fn client_proof_nonce(signer: &str, scope_id: &str, action_nonce: u64) -> String {
    let mut m = b"hana-id/client-proof/v1".to_vec();
    m.extend(borsh_str(signer));
    m.extend(borsh_str(scope_id));
    m.extend_from_slice(&action_nonce.to_le_bytes());
    b64url(&sha256(&m))
}

/// Owner action: "hana-id/owner-action/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ borsh(method) ‖
/// borsh(args without auth) ‖ action_nonce u64 LE.
pub fn owner_action_nonce(signer: &str, scope_id: &str, method: &str, args_borsh: &[u8], action_nonce: u64) -> String {
    let mut m = b"hana-id/owner-action/v1".to_vec();
    m.extend(borsh_str(signer));
    m.extend(borsh_str(scope_id));
    m.extend(borsh_str(method));
    m.extend_from_slice(args_borsh);
    m.extend_from_slice(&action_nonce.to_le_bytes());
    b64url(&sha256(&m))
}

/// "hana-id-session-v1:" ‖ counter u64 LE ‖ sha256(payload).
pub fn session_message(counter: u64, payload: &[u8]) -> Vec<u8> {
    let mut m = b"hana-id-session-v1:".to_vec();
    m.extend_from_slice(&counter.to_le_bytes());
    m.extend(sha256(payload));
    m
}

pub fn ckd_payload(pk1: &str, pk2: &str) -> Vec<u8> {
    format!("hana-id-ckd-v1:{pk1}:{pk2}").into_bytes()
}

pub fn near_owner(account: &AccountId) -> Value {
    json!({"Near": {"account_id": account}})
}

pub fn oidc_owner(sub: &str) -> Value {
    json!({"Oidc": {"provider": PROVIDER, "sub": sub}})
}

// ---------------------------------------------------------------------------------------------------------------
// Test ID tokens

pub struct TestIssuer {
    signing: RsaSigningKey<RsaSha256>,
    pub n: String,
    pub e: String,
}

impl TestIssuer {
    pub fn generate() -> Result<Self> {
        let key = RsaPrivateKey::new(&mut rand::thread_rng(), 2048)?;
        let n = b64url(&key.n().to_bytes_be());
        let e = b64url(&key.e().to_bytes_be());
        Ok(Self { signing: RsaSigningKey::<RsaSha256>::new(key), n, e })
    }

    /// An RS256 token like Google's, valid for an hour from `now_ms` (sandbox time).
    pub fn jwt(&self, aud: &str, sub: &str, nonce: Option<&str>, now_ms: u64) -> String {
        let now_s = now_ms / 1000;
        let header = json!({"alg": "RS256", "kid": KID, "typ": "JWT"});
        let mut claims = json!({"iss": ISS, "azp": aud, "aud": aud, "sub": sub, "iat": now_s - 60, "exp": now_s + 3600});
        if let Some(n) = nonce {
            claims["nonce"] = json!(n);
        }
        let input = format!("{}.{}", b64url(header.to_string().as_bytes()), b64url(claims.to_string().as_bytes()));
        let sig = self.signing.sign(input.as_bytes()).to_vec();
        format!("{input}.{}", b64url(&sig))
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Browser-side session key

pub struct TestSession {
    pub key: SigningKey,
    /// The scope the session is opened in (`create_session`'s `scope_id`, committed to by the nonce).
    pub scope_id: String,
    pub expires_at_ms: u64,
    pub salt: Vec<u8>,
    pub key_index: u32,
    pub max_uses: u32,
    /// Last counter used.
    pub counter: u64,
}

impl TestSession {
    pub fn new(scope_id: &str, expires_at_ms: u64, key_index: u32, max_uses: u32) -> Self {
        let key = SigningKey::generate(&mut rand::rngs::OsRng);
        Self { key, scope_id: scope_id.to_string(), expires_at_ms, salt: (0u8..16).map(|i| i * 7 + 3).collect(), key_index, max_uses, counter: 0 }
    }

    pub fn public_key(&self) -> Vec<u8> {
        self.key.verifying_key().to_bytes().to_vec()
    }

    /// The session nonce for this session on the deployment `signer`.
    pub fn nonce(&self, signer: &AccountId) -> String {
        session_nonce(signer.as_str(), &self.scope_id, &self.public_key(), self.expires_at_ms, self.key_index, self.max_uses, &self.salt)
    }

    pub fn create_args(&self, jwt: &str) -> Value {
        json!({
            "jwt": jwt,
            "scope_id": self.scope_id,
            "session_public_key": self.public_key(),
            "expires_at_ms": self.expires_at_ms,
            "salt": self.salt,
            "key_index": self.key_index,
            "max_uses": self.max_uses,
        })
    }

    /// derive_key args for the next counter (fake BLS keys: the mock MPC doesn't check them).
    pub fn derive_args(&mut self, pk1: &str, pk2: &str) -> Value {
        self.counter += 1;
        let sig = self.key.sign(&session_message(self.counter, &ckd_payload(pk1, pk2)));
        json!({
            "session_public_key": self.public_key(),
            "counter": self.counter,
            "signature": sig.to_bytes().to_vec(),
            "pk1": pk1,
            "pk2": pk2,
        })
    }

    pub fn revoke_args(&mut self) -> Value {
        self.counter += 1;
        let sig = self.key.sign(&session_message(self.counter, b"revoke"));
        json!({"session_public_key": self.public_key(), "counter": self.counter, "signature": sig.to_bytes().to_vec()})
    }
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Clone)]
pub struct SessionView {
    pub path: String,
    pub scope_id: String,
    pub expires_at_ms: u64,
    pub max_uses: u32,
    pub used: u32,
}

#[derive(Debug, Deserialize, PartialEq, Clone)]
pub struct CkdResponse {
    pub big_y: String,
    pub big_c: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct RecordedCall {
    pub derivation_path: String,
    pub predecessor: AccountId,
    pub pk1: String,
    pub pk2: String,
    pub domain_id: u64,
    pub deposit: String,
}

// ---------------------------------------------------------------------------------------------------------------
// Sandbox environment

pub struct Env {
    pub worker: Worker<Sandbox>,
    pub signer: Contract,
    pub mpc: Contract,
    pub admin: Account,
    pub alice: Account,
    pub bob: Account,
    pub carol: Account,
    /// The relayer account (full key; tests use `relayer_fc` / `relayer_owner_fc` to act as the API does).
    pub relayer: Account,
    /// The relayer account signing with a session-pool key (SESSION_RELAYER_METHODS on the signer).
    pub relayer_fc: Account,
    /// The relayer account signing with an owner-pool key (OWNER_RELAYER_METHODS on the signer).
    pub relayer_owner_fc: Account,
    /// The signer account signing with a function-call key limited to KEYS_UPDATER_METHODS on itself.
    pub keys_updater: Account,
    pub issuer: TestIssuer,
    /// Scope ids of the two admin-registered scopes: A = [APP_A] owned by alice, B = [APP_B] owned by bob. Neither
    /// allows shared login at setup.
    pub scope_a: String,
    pub scope_b: String,
}

async fn subaccount(root: &Account, name: &str, near: u128) -> Result<Account> {
    Ok(root.create_subaccount(name).initial_balance(NearToken::from_near(near)).transact().await?.into_result()?)
}

/// Adds a function-call key on `account` for `receiver` limited to `methods`, checks it on chain, and returns the
/// account signing with that key.
async fn add_fc_key(worker: &Worker<Sandbox>, account: &Account, receiver: &AccountId, methods: &[&str], allowance: NearToken) -> Result<Account> {
    let sk = SecretKey::from_random(KeyType::ED25519);
    account
        .batch(account.id())
        .add_key(sk.public_key(), AccessKey::function_call_access(receiver, methods, Some(allowance)))
        .transact()
        .await?
        .into_result()?;
    let keyed = Account::from_secret_key(account.id().clone(), sk, worker);
    assert_function_call_key(worker, account.id(), &keyed.secret_key().public_key(), receiver, methods).await?;
    Ok(keyed)
}

/// Deploys hana-signer to `root`/`name`, calls `new`, and configures the Google issuer with the test key, the
/// console audience and the relayer as sponsor.
async fn deploy_signer(root: &Account, name: &str, admin: &Account, mpc: &AccountId, issuer: &TestIssuer, relayer: &AccountId) -> Result<Contract> {
    let (signer_wasm, _) = wasms()?;
    let signer = subaccount(root, name, 50).await?.deploy(&signer_wasm).await?.into_result()?;
    signer
        .call("new")
        .args_json(json!({"owner": admin.id(), "mpc": mpc, "ckd_domain_id": CKD_DOMAIN_ID, "change_delay_ms": CHANGE_DELAY_MS}))
        .transact()
        .await?
        .into_result()?;
    admin
        .call(signer.id(), "set_issuer")
        .args_json(json!({"provider": PROVIDER, "iss_values": [ISS, "accounts.google.com"]}))
        .transact()
        .await?
        .into_result()?;
    admin
        .call(signer.id(), "set_issuer_key")
        .args_json(json!({"provider": PROVIDER, "kid": KID, "n": issuer.n, "e": issuer.e}))
        .transact()
        .await?
        .into_result()?;
    admin
        .call(signer.id(), "set_console_audiences")
        .args_json(json!({"audiences": [[PROVIDER, CONSOLE]]}))
        .transact()
        .await?
        .into_result()?;
    admin.call(signer.id(), "set_sponsors").args_json(json!({"sponsors": [relayer]})).transact().await?.into_result()?;
    Ok(signer)
}

impl Env {
    pub async fn setup() -> Result<Self> {
        let (_, mpc_wasm) = wasms()?;
        let worker = near_workspaces::sandbox().await?;
        let root = worker.root_account()?;

        let admin = subaccount(&root, "admin", 20).await?;
        let alice = subaccount(&root, "alice", 20).await?;
        let bob = subaccount(&root, "bob", 20).await?;
        let carol = subaccount(&root, "carol", 20).await?;
        let relayer = subaccount(&root, "relayer", 20).await?;

        let mpc = subaccount(&root, "mpc", 20).await?.deploy(&mpc_wasm).await?.into_result()?;
        mpc.call("new").transact().await?.into_result()?;

        let issuer = TestIssuer::generate()?;
        let signer = deploy_signer(&root, "signer", &admin, mpc.id(), &issuer, relayer.id()).await?;

        // The relayer's two key pools (as deploy-contract.ts sets them up).
        let relayer_fc = add_fc_key(&worker, &relayer, signer.id(), SESSION_RELAYER_METHODS, NearToken::from_near(1)).await?;
        let relayer_owner_fc = add_fc_key(&worker, &relayer, signer.id(), OWNER_RELAYER_METHODS, NearToken::from_millinear(500)).await?;
        // Keys-updater function-call key on the signer account itself.
        let keys_updater = add_fc_key(&worker, signer.as_account(), signer.id(), KEYS_UPDATER_METHODS, NearToken::from_millinear(250)).await?;

        let mut env = Self { worker, signer, mpc, admin, alice, bob, carol, relayer, relayer_fc, relayer_owner_fc, keys_updater, issuer, scope_a: String::new(), scope_b: String::new() };
        let alice_owner = near_owner(env.alice.id());
        let bob_owner = near_owner(env.bob.id());
        env.scope_a = env.admin_register(vec![alice_owner], &[APP_A], false).await?;
        env.scope_b = env.admin_register(vec![bob_owner], &[APP_B], false).await?;
        Ok(env)
    }

    /// Deploys and configures another hana-signer (a second deployment in the same sandbox, same owner, MPC,
    /// issuer key, console audience and sponsor).
    pub async fn deploy_another_signer(&self, name: &str) -> Result<Contract> {
        let root = self.worker.root_account()?;
        deploy_signer(&root, name, &self.admin, self.mpc.id(), &self.issuer, self.relayer.id()).await
    }

    pub async fn admin_register(&self, owners: Vec<Value>, clients: &[&str], allow_shared: bool) -> Result<String> {
        self.admin_register_on(self.signer.id(), owners, clients, allow_shared).await
    }

    pub async fn admin_register_on(&self, signer: &AccountId, owners: Vec<Value>, clients: &[&str], allow_shared: bool) -> Result<String> {
        let res = self.try_admin_register_on(signer, owners, clients, allow_shared).await?;
        Ok(res.into_result()?.json()?)
    }

    pub async fn try_admin_register_on(&self, signer: &AccountId, owners: Vec<Value>, clients: &[&str], allow_shared: bool) -> Result<ExecutionFinalResult> {
        let clients: Vec<(&str, &str)> = clients.iter().map(|c| (PROVIDER, *c)).collect();
        Ok(self
            .admin
            .call(signer, "admin_register_scope")
            .args_json(json!({"owners": owners, "clients": clients, "scope_id": null, "allow_shared": allow_shared}))
            .gas(GAS)
            .transact()
            .await?)
    }

    /// Sets the shared clients (owner only) on the main deployment.
    pub async fn set_shared_clients(&self, auds: &[&str]) -> Result<ExecutionFinalResult> {
        let clients: Vec<(&str, &str)> = auds.iter().map(|c| (PROVIDER, *c)).collect();
        Ok(self.admin.call(self.signer.id(), "set_shared_clients").args_json(json!({"clients": clients})).gas(GAS).transact().await?)
    }

    pub async fn get_config(&self) -> Result<Value> {
        Ok(self.signer.view("get_config").await?.json()?)
    }

    /// Sandbox block time (ms).
    pub async fn now_ms(&self) -> Result<u64> {
        Ok(self.worker.view_block().await?.timestamp() / 1_000_000)
    }

    pub async fn jwt(&self, aud: &str, sub: &str, nonce: Option<&str>) -> Result<String> {
        Ok(self.issuer.jwt(aud, sub, nonce, self.now_ms().await?))
    }

    /// A new session in `scope_id` expiring `ttl_ms` from now, and a token for `aud`/`sub` committing to it on the
    /// main deployment.
    pub async fn new_session(&self, aud: &str, sub: &str, scope_id: &str, key_index: u32, ttl_ms: u64) -> Result<(TestSession, String)> {
        let now = self.now_ms().await?;
        let session = TestSession::new(scope_id, now + ttl_ms, key_index, 5);
        let jwt = self.issuer.jwt(aud, sub, Some(&session.nonce(self.signer.id())), now);
        Ok((session, jwt))
    }

    pub async fn create_session(&self, caller: &Account, session: &TestSession, jwt: &str) -> Result<ExecutionFinalResult> {
        Ok(caller.call(self.signer.id(), "create_session").args_json(session.create_args(jwt)).gas(api_gas("create_session")).transact().await?)
    }

    pub async fn get_session(&self, session: &TestSession) -> Result<Option<SessionView>> {
        Ok(self.signer.view("get_session").args_json(json!({"session_public_key": session.public_key()})).await?.json()?)
    }

    pub async fn mpc_calls(&self) -> Result<Vec<RecordedCall>> {
        Ok(self.mpc.view("get_calls").args_json(json!({"from_index": null, "limit": null})).await?.json()?)
    }

    pub async fn get_scope(&self, scope_id: &str) -> Result<Value> {
        Ok(self.signer.view("get_scope").args_json(json!({"scope_id": scope_id})).await?.json()?)
    }

    pub async fn scope_for_client(&self, aud: &str) -> Result<Option<String>> {
        Ok(self.signer.view("scope_for_client").args_json(json!({"provider": PROVIDER, "aud": aud})).await?.json()?)
    }

    /// Fast-forwards until the sandbox clock is at least `target_ms` (fast_forward advances height; the block
    /// timestamp follows it).
    pub async fn advance_to(&self, target_ms: u64) -> Result<()> {
        for _ in 0..200 {
            let now = self.now_ms().await?;
            if now >= target_ms {
                return Ok(());
            }
            let blocks = ((target_ms - now) / 1000).clamp(5, 500);
            self.worker.fast_forward(blocks).await?;
        }
        bail!("sandbox clock did not reach {target_ms}")
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Assertions

/// Asserts the call failed (either rejected before execution, e.g. by an access key, or panicked) and that the
/// error text contains `needle`. Returns the error text.
pub fn expect_failure(res: Result<ExecutionFinalResult>, needle: &str) -> String {
    let text = match res {
        Ok(outcome) => match outcome.into_result() {
            Ok(ok) => panic!("expected failure containing {needle:?}, but the call succeeded: {:?}", ok.json::<Value>().ok()),
            Err(e) => format!("{e:?}"),
        },
        Err(e) => format!("{e:?}"),
    };
    assert!(text.contains(needle), "expected failure containing {needle:?}, got: {text}");
    text
}

/// Wraps a `transact()` result so `expect_failure` accepts both transaction-level errors and failed outcomes.
pub fn tx<T>(res: near_workspaces::Result<T>) -> Result<T> {
    res.map_err(|e| anyhow!("{e:?}"))
}
