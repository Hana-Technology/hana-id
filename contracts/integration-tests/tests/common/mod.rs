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
/// issuer_key_delay_ms of the sandbox deployment.
pub const ISSUER_KEY_DELAY_MS: u64 = 20_000;
/// governance_delay_ms of the sandbox deployment.
pub const GOVERNANCE_DELAY_MS: u64 = 30_000;
/// The commit whose hana-signer is the v2 contract (governance batch, contract 0.1.1, on sandbox-dev since
/// 2026-10-30): the last develop commit before the v3 merge (9a52058). Its contracts/hana-signer is the tree of the
/// sandbox-dev upgrade drill (90c39bd). The v2 → v3 upgrade tests build its wasm (`v2_wasm`).
pub const V2_COMMIT: &str = "26fb70a92eecc74592df886e16a109fa6ee19830";
/// sandbox-dev's v2 code hash (docs/context.md). `cargo near build non-reproducible-wasm --no-abi` of V2_COMMIT (what
/// deploy-contract runs) reproduces it on the machine that built the deployed code; elsewhere the wasm embeds other
/// cargo registry paths in its panic locations, so the hash differs and the tests only report it.
pub const V2_SANDBOX_DEV_CODE_HASH: &str = "3TSDwkMqPUhZtzFCvvaJ39nQWXUQK4LExPhsaS9tScoz";
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

/// The session pool's allowlist moves through three planned states (docs/batch-b-spec.md "Relayer allowlists"),
/// each a delete-and-re-add of every session-pool key: 1. at the batch B contract upgrade; 2. the ship gate passes
/// (create_session leaves the relayer); 3. the ship gate fails (create_session_and_derive leaves, and later the
/// contract).
pub const SESSION_ALLOWLIST_STATES: [&[&str]; 3] = [
    &["create_session", "create_session_and_derive", "derive_key", "revoke_session", "prune_sessions"],
    &["create_session_and_derive", "derive_key", "revoke_session", "prune_sessions"],
    &["create_session", "derive_key", "revoke_session", "prune_sessions"],
];
/// The state in force (index into SESSION_ALLOWLIST_STATES: state 1).
pub const SESSION_ALLOWLIST_STATE: usize = 0;
/// Session pool (`RELAYER_KEYS`): the methods its function-call keys may call now.
pub const SESSION_RELAYER_METHODS: &[&str] = SESSION_ALLOWLIST_STATES[SESSION_ALLOWLIST_STATE];
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
/// The methods of an updater key, the function-call key the contract installs on its own account with
/// `add_updater_key` (docs/governance-spec.md "Updater keys"; the contract's `UPDATER_METHODS`). Written out here
/// from the spec, not read from the contract, so the on-chain checks compare the contract with the spec.
pub const UPDATER_METHODS: &[&str] = &["set_issuer_key", "propose_issuer_key_removal", "execute_issuer_key_change"];

/// Every change method of hana-signer (docs/contract-interface.md: batch A, A.2, B, governance and the email-login
/// methods of v3). The access-key test calls each one with each function-call key, so a method added to
/// the contract should be added here too.
pub const ALL_CHANGE_METHODS: &[&str] = &[
    "new",
    "set_sponsors",
    "set_console_audiences",
    "set_change_delay_ms",
    "enable_public_registration",
    "set_shared_clients",
    "apply_pending_config",
    "set_issuer",
    "set_issuer_key",
    "propose_issuer_key_removal",
    "execute_issuer_key_change",
    "confirm_issuer_key_change",
    "cancel_issuer_key_change",
    "remove_issuer_key",
    "set_issuer_key_delay_ms",
    "set_governance_delay_ms",
    "add_watchdog",
    "remove_watchdog",
    "pause",
    "unpause",
    "set_sessions_valid_from_ms",
    "add_updater_key",
    "delete_updater_key",
    "on_updater_key_added",
    "propose_upgrade",
    "cancel_upgrade",
    "execute_upgrade",
    "migrate",
    "propose_owner",
    "cancel_owner_proposal",
    "accept_owner",
    "propose_withdrawal",
    "cancel_withdrawal",
    "execute_withdrawal",
    "admin_register_scope",
    "register_scope",
    "propose_change",
    "execute_change",
    "cancel_change",
    "remove_client",
    "disable_shared_login",
    "create_session",
    "create_session_and_derive",
    "derive_key",
    "revoke_session",
    "prune_sessions",
    "mark_self_issued",
    "accept_unrecorded_wallets",
    "link_identity",
    "cancel_link",
    "unlink_identity",
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

/// Reads `POOL_METHODS.<pool>: [ '...', ... ]` from apps/api/src/relayer-config.ts: the methods the API's relayer
/// Durable Objects will relay for that pool.
pub fn api_pool_methods(pool: &str) -> Result<Vec<String>> {
    let path = contracts_dir().parent().expect("repo root").join("apps").join("api").join("src").join("relayer-config.ts");
    let src = std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    let start = src.find("export const POOL_METHODS = {").with_context(|| format!("POOL_METHODS not found in {}", path.display()))?;
    let body = &src[start..];
    let entry = body.find(&format!("\n  {pool}: [")).with_context(|| format!("POOL_METHODS.{pool} not found"))?;
    let body = &body[entry..];
    let open = body.find('[').unwrap() + 1;
    let close = body.find(']').with_context(|| format!("unterminated POOL_METHODS.{pool}"))?;
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
    build_wasm_at(&contracts_dir().join(crate_dir), wasm_name, &Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("wasm"), &[])
}

/// `cargo near build non-reproducible-wasm <extra>` in `dir`, into `target`.
fn build_wasm_at(dir: &Path, wasm_name: &str, target: &Path, extra: &[&str]) -> Result<Vec<u8>> {
    let crate_dir = dir.display().to_string();
    let mut cmd = Command::new("cargo");
    cmd.args(["near", "build", "non-reproducible-wasm"]).args(extra).current_dir(dir);
    for (key, _) in std::env::vars() {
        let keep = key == "CARGO_HOME" || key == "RUSTUP_HOME";
        if !keep && (key.starts_with("CARGO") || key.starts_with("RUSTUP_") || key.starts_with("RUSTC") || key.starts_with("RUSTFLAGS") || key == "RUSTDOC") {
            cmd.env_remove(key);
        }
    }
    cmd.env("CARGO_TARGET_DIR", target);
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

static DEPLOY_WASM: OnceLock<std::result::Result<Vec<u8>, String>> = OnceLock::new();

/// The current hana-signer wasm exactly as `deploy-contract` builds what it deploys (`cargo near build
/// non-reproducible-wasm --no-abi`, scripts/lib/deploy-run.ts), into `target/wasm-deploy`. The upgrade tests run this
/// artifact; the other tests use `wasms()` (with the embedded ABI). `HANA_SIGNER_DEPLOY_WASM=<path>` overrides it.
pub fn deploy_wasm() -> Result<Vec<u8>> {
    DEPLOY_WASM
        .get_or_init(|| {
            if let Ok(path) = std::env::var("HANA_SIGNER_DEPLOY_WASM") {
                return std::fs::read(&path).map_err(|e| format!("reading HANA_SIGNER_DEPLOY_WASM={path}: {e}"));
            }
            let target = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("wasm-deploy");
            build_wasm_at(&contracts_dir().join("hana-signer"), "hana_signer.wasm", &target, &["--no-abi"]).map_err(|e| format!("{e:#}"))
        })
        .clone()
        .map_err(|e| anyhow!(e))
}

static V2_WASM: OnceLock<std::result::Result<Vec<u8>, String>> = OnceLock::new();

/// The v2 hana-signer wasm: `contracts/hana-signer` at `V2_COMMIT`, exported with `git archive` into
/// `target/v2-src/<commit>` and built there (its own Cargo.lock and toolchain). `HANA_SIGNER_V2_WASM=<path>`
/// overrides the build.
pub fn v2_wasm() -> Result<Vec<u8>> {
    V2_WASM
        .get_or_init(|| {
            if let Ok(path) = std::env::var("HANA_SIGNER_V2_WASM") {
                return std::fs::read(&path).map_err(|e| format!("reading HANA_SIGNER_V2_WASM={path}: {e}"));
            }
            build_v2().map_err(|e| format!("{e:#}"))
        })
        .clone()
        .map_err(|e| anyhow!(e))
}

fn build_v2() -> Result<Vec<u8>> {
    let target = Path::new(env!("CARGO_MANIFEST_DIR")).join("target");
    let src = target.join("v2-src").join(V2_COMMIT);
    let crate_dir = src.join("contracts").join("hana-signer");
    if !crate_dir.join("Cargo.toml").exists() {
        std::fs::create_dir_all(&src)?;
        let tar = target.join("v2-src").join(format!("{V2_COMMIT}.tar"));
        let repo = contracts_dir().parent().expect("repo root").to_path_buf();
        let out = Command::new("git").arg("-C").arg(&repo).args(["archive", "--format=tar", "-o"]).arg(&tar).arg(V2_COMMIT).arg("contracts/hana-signer").output()?;
        if !out.status.success() {
            bail!("git archive {V2_COMMIT} failed (is the commit in this clone?): {}", String::from_utf8_lossy(&out.stderr));
        }
        let out = Command::new("tar").arg("-xf").arg(&tar).arg("-C").arg(&src).output()?;
        if !out.status.success() {
            bail!("extracting {}: {}", tar.display(), String::from_utf8_lossy(&out.stderr));
        }
    }
    // The copy lives under this crate's directory, which is a workspace root: mark the copy as its own workspace
    // (as contracts/hana-signer effectively is: it has no parent workspace). Nothing else in it changes.
    let manifest = crate_dir.join("Cargo.toml");
    let text = std::fs::read_to_string(&manifest)?;
    if !text.lines().any(|l| l.trim() == "[workspace]") {
        std::fs::write(&manifest, format!("{text}\n# Added by the sandbox tests: a standalone copy (see tests/common/mod.rs build_v2).\n[workspace]\n"))?;
    }
    // `--no-abi`, as deploy-contract builds the code it deploys (scripts/lib/deploy-run.ts).
    build_wasm_at(&crate_dir, "hana_signer.wasm", &target.join("wasm-v2"), &["--no-abi"])
}

static SPUTNIK_WASM: OnceLock<std::result::Result<Vec<u8>, String>> = OnceLock::new();

fn sputnik_pin() -> Result<Value> {
    let path = contracts_dir().join("sputnik").join("pin.json");
    Ok(serde_json::from_str(&std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?)?)
}

/// The Sputnik DAO v2 wasm pinned in contracts/sputnik/pin.json: downloaded once from its pinned commit (curl),
/// checked against the pinned sha256 and cached in `target/sputnik/<sha256>.wasm`. `SPUTNIK_DAO_WASM=<path>`
/// supplies the file instead (offline runs); it must match the pin too.
pub fn sputnik_wasm() -> Result<Vec<u8>> {
    SPUTNIK_WASM.get_or_init(|| fetch_sputnik().map_err(|e| format!("{e:#}"))).clone().map_err(|e| anyhow!(e))
}

fn fetch_sputnik() -> Result<Vec<u8>> {
    let pin = sputnik_pin()?;
    let want = pin["sha256"].as_str().context("pin.json sha256")?.to_string();
    // scripts/lib/sputnik.ts sizes the factory deposit from `bytes` (the factory charges (bytes + 32) × storage cost).
    let want_len = pin["bytes"].as_u64().context("pin.json bytes")?;
    let check = |bytes: Vec<u8>, from: &str| -> Result<Vec<u8>> {
        let got: String = sha256(&bytes).iter().map(|b| format!("{b:02x}")).collect();
        if got != want {
            bail!("Sputnik wasm from {from} has sha256 {got}, pinned {want}");
        }
        if bytes.len() as u64 != want_len {
            bail!("Sputnik wasm from {from} has {} bytes, pin.json says {want_len}", bytes.len());
        }
        Ok(bytes)
    };
    if let Ok(path) = std::env::var("SPUTNIK_DAO_WASM") {
        return check(std::fs::read(&path).with_context(|| format!("reading SPUTNIK_DAO_WASM={path}"))?, &path);
    }
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("sputnik");
    let cached = dir.join(format!("{want}.wasm"));
    if let Ok(bytes) = std::fs::read(&cached) {
        return check(bytes, &cached.display().to_string());
    }
    std::fs::create_dir_all(&dir)?;
    let url = pin["url"].as_str().context("pin.json url")?;
    let partial = dir.join(format!("{want}.download"));
    let out = Command::new("curl").args(["-sSfL", "--max-time", "120", "-o"]).arg(&partial).arg(url).output().context("running curl")?;
    if !out.status.success() {
        bail!("downloading {url} failed ({}); set SPUTNIK_DAO_WASM to a local copy", String::from_utf8_lossy(&out.stderr).trim());
    }
    let bytes = check(std::fs::read(&partial)?, url)?;
    std::fs::rename(&partial, &cached)?;
    Ok(bytes)
}

/// contracts/sputnik/policy.json with `members` as the council.
pub fn sputnik_policy(members: &[&AccountId]) -> Result<Value> {
    let path = contracts_dir().join("sputnik").join("policy.json");
    let mut policy: Value = serde_json::from_str(&std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?)?;
    policy["roles"][0]["kind"]["Group"] = json!(members);
    Ok(policy)
}

/// NEAR's account `code_hash` of `code`: base58(sha256(code)).
pub fn code_hash(code: &[u8]) -> String {
    near_workspaces::types::CryptoHash(sha256(code).try_into().expect("32 bytes")).to_string()
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
pub fn session_nonce_preimage(signer: &str, scope_id: &str, pk: &[u8], expires_at_ms: u64, key_index: u32, max_uses: u32, salt: &[u8]) -> Vec<u8> {
    let mut m = b"hana-id/session/v1".to_vec();
    m.extend(borsh_str(signer));
    m.extend(borsh_str(scope_id));
    m.extend_from_slice(pk);
    m.extend_from_slice(&expires_at_ms.to_le_bytes());
    m.extend_from_slice(&key_index.to_le_bytes());
    m.extend_from_slice(&max_uses.to_le_bytes());
    m.extend_from_slice(salt);
    m
}

pub fn session_nonce(signer: &str, scope_id: &str, pk: &[u8], expires_at_ms: u64, key_index: u32, max_uses: u32, salt: &[u8]) -> String {
    b64url(&sha256(&session_nonce_preimage(signer, scope_id, pk, expires_at_ms, key_index, max_uses, salt)))
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

/// Off-chain vault message (docs/batch-b-spec.md "Vault message layout"), which hana-signer must never accept:
/// "hana-id-vault-v1:" ‖ borsh(signer) ‖ borsh(app_id) ‖ share_id (16) ‖ counter u64 LE ‖ sha256(payload).
pub fn vault_message(signer: &str, app_id: &str, share_id: &[u8; 16], counter: u64, payload: &[u8]) -> Vec<u8> {
    let mut m = b"hana-id-vault-v1:".to_vec();
    m.extend(borsh_str(signer));
    m.extend(borsh_str(app_id));
    m.extend_from_slice(share_id);
    m.extend_from_slice(&counter.to_le_bytes());
    m.extend(sha256(payload));
    m
}

pub fn ckd_payload(pk1: &str, pk2: &str) -> Vec<u8> {
    format!("hana-id-ckd-v1:{pk1}:{pk2}").into_bytes()
}

// Email login layouts (docs/email-login-spec.md "Byte layouts (new)", docs/contract-interface.md), written from the
// spec; tests/layouts.rs pins them to the JS implementation's worked examples (contracts/hana-signer/src/
// email_fixture.json, scripts/gen-email-fixtures.mjs).

/// Identity key: sha256("hana-id/identity/v1" ‖ borsh(scope_id) ‖ borsh(provider) ‖ borsh(sub)).
pub fn identity_key(scope_id: &str, provider: &str, sub: &str) -> [u8; 32] {
    let mut m = b"hana-id/identity/v1".to_vec();
    m.extend(borsh_str(scope_id));
    m.extend(borsh_str(provider));
    m.extend(borsh_str(sub));
    sha256(&m).try_into().expect("32 bytes")
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// link_new = "hana-id/link-new/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ root_ik ‖ borsh(new provider) ‖ epoch u64 LE ‖
/// salt.
pub fn link_new_preimage(signer: &str, scope_id: &str, root: &[u8; 32], new_provider: &str, epoch: u64, salt: &[u8]) -> Vec<u8> {
    let mut m = b"hana-id/link-new/v1".to_vec();
    m.extend(borsh_str(signer));
    m.extend(borsh_str(scope_id));
    m.extend_from_slice(root);
    m.extend(borsh_str(new_provider));
    m.extend_from_slice(&epoch.to_le_bytes());
    m.extend_from_slice(salt);
    m
}

/// link_account = "hana-id/link-account/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ root_ik ‖ new_ik ‖ epoch u64 LE ‖ salt.
pub fn link_account_preimage(signer: &str, scope_id: &str, root: &[u8; 32], new: &[u8; 32], epoch: u64, salt: &[u8]) -> Vec<u8> {
    let mut m = b"hana-id/link-account/v1".to_vec();
    m.extend(borsh_str(signer));
    m.extend(borsh_str(scope_id));
    m.extend_from_slice(root);
    m.extend_from_slice(new);
    m.extend_from_slice(&epoch.to_le_bytes());
    m.extend_from_slice(salt);
    m
}

/// link_change = "hana-id/link-change/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ borsh("cancel" | "unlink") ‖ root_ik ‖
/// member_ik ‖ epoch u64 LE ‖ salt.
pub fn link_change_preimage(signer: &str, scope_id: &str, action: &str, root: &[u8; 32], member: &[u8; 32], epoch: u64, salt: &[u8]) -> Vec<u8> {
    let mut m = b"hana-id/link-change/v1".to_vec();
    m.extend(borsh_str(signer));
    m.extend(borsh_str(scope_id));
    m.extend(borsh_str(action));
    m.extend_from_slice(root);
    m.extend_from_slice(member);
    m.extend_from_slice(&epoch.to_le_bytes());
    m.extend_from_slice(salt);
    m
}

/// `join` of the auto_link nonce: 1 = the session identity joins the link identity's account (case A), 2 = the link
/// identity joins the session identity's (cases B, C).
pub const JOIN_SESSION: u8 = 1;
pub const JOIN_LINK: u8 = 2;

/// auto_link = "hana-id/auto-link/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ sha256(session nonce preimage) ‖ session_ik ‖
/// join u8 ‖ joiner_ik ‖ target_root_ik ‖ target epoch u64 LE ‖ mode u8 (1 = link_immediate).
#[allow(clippy::too_many_arguments)]
pub fn auto_link_preimage(signer: &str, scope_id: &str, session_hash: &[u8], session_ik: &[u8; 32], join: u8, joiner: &[u8; 32], target_root: &[u8; 32], epoch: u64, immediate: bool) -> Vec<u8> {
    let mut m = b"hana-id/auto-link/v1".to_vec();
    m.extend(borsh_str(signer));
    m.extend(borsh_str(scope_id));
    m.extend_from_slice(session_hash);
    m.extend_from_slice(session_ik);
    m.push(join);
    m.extend_from_slice(joiner);
    m.extend_from_slice(target_root);
    m.extend_from_slice(&epoch.to_le_bytes());
    m.push(immediate as u8);
    m
}

/// Every link nonce is b64url(sha256(preimage)).
pub fn nonce_of(preimage: &[u8]) -> String {
    b64url(&sha256(preimage))
}

/// The linked CKD payload a combined login with `link_jwt` signs (counter 1): "hana-id-ckd-link-v1:" ‖ sha256(link_jwt)
/// ‖ mode u8 ‖ pk1 ‖ ":" ‖ pk2.
pub fn linked_ckd_payload(link_jwt: &str, immediate: bool, pk1: &str, pk2: &str) -> Vec<u8> {
    let mut m = b"hana-id-ckd-link-v1:".to_vec();
    m.extend(sha256(link_jwt.as_bytes()));
    m.push(immediate as u8);
    m.extend_from_slice(pk1.as_bytes());
    m.push(b':');
    m.extend_from_slice(pk2.as_bytes());
    m
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
    /// The kid its tokens carry.
    pub kid: String,
    pub n: String,
    pub e: String,
}

impl TestIssuer {
    /// A key under `KID`.
    pub fn generate() -> Result<Self> {
        Self::generate_with_kid(KID)
    }

    /// A fresh RSA key whose tokens carry `kid` (e.g. Google's next key in a rotation).
    pub fn generate_with_kid(kid: &str) -> Result<Self> {
        Self::generate_with_bits(kid, 2048)
    }

    /// A fresh RSA key of `bits` bits (the contract accepts 2048 to 4096) whose tokens carry `kid`.
    pub fn generate_with_bits(kid: &str, bits: usize) -> Result<Self> {
        let key = RsaPrivateKey::new(&mut rand::thread_rng(), bits)?;
        let n = b64url(&key.n().to_bytes_be());
        let e = b64url(&key.e().to_bytes_be());
        Ok(Self { signing: RsaSigningKey::<RsaSha256>::new(key), kid: kid.to_string(), n, e })
    }

    /// An RS256 token like Google's, valid for an hour from `now_ms` (sandbox time).
    pub fn jwt(&self, aud: &str, sub: &str, nonce: Option<&str>, now_ms: u64) -> String {
        self.compact_jwt(ISS, aud, sub, nonce, now_ms)
    }

    /// A compact RS256 token from issuer `iss`.
    pub fn compact_jwt(&self, iss: &str, aud: &str, sub: &str, nonce: Option<&str>, now_ms: u64) -> String {
        let now_s = now_ms / 1000;
        let header = json!({"alg": "RS256", "kid": self.kid, "typ": "JWT"});
        let mut claims = json!({"iss": iss, "azp": aud, "aud": aud, "sub": sub, "iat": now_s - 60, "exp": now_s + 3600});
        if let Some(n) = nonce {
            claims["nonce"] = json!(n);
        }
        let input = format!("{}.{}", b64url(header.to_string().as_bytes()), b64url(claims.to_string().as_bytes()));
        let sig = self.signing.sign(input.as_bytes()).to_vec();
        format!("{input}.{}", b64url(&sig))
    }

    /// An email token as Hana's email issuer mints it (docs/email-login-spec.md "The token"): JWS General JSON
    /// Serialization, one RS256 signature over `protected ‖ "." ‖ payload`, claims iss/aud/sub/iat/exp (+ 600 s)/
    /// nonce/jti.
    pub fn email_jws(&self, aud: &str, sub: &str, nonce: &str, now_ms: u64) -> String {
        let now_s = now_ms / 1000;
        let jti: [u8; 16] = rand::random();
        let claims = json!({"iss": EMAIL_ISS, "aud": aud, "sub": sub, "iat": now_s, "exp": now_s + 600, "nonce": nonce, "jti": b64url(&jti)});
        let payload = b64url(claims.to_string().as_bytes());
        let protected = b64url(json!({"alg": "RS256", "kid": self.kid}).to_string().as_bytes());
        let sig = self.signing.sign(format!("{protected}.{payload}").as_bytes()).to_vec();
        json!({"payload": payload, "signatures": [{"protected": protected, "signature": b64url(&sig)}]}).to_string()
    }
}

/// Hana's email issuer: the provider name in paths (frozen at the address freeze), its `iss` in the sandbox, the
/// signer id `mark_self_issued` lists and the kid of the sandbox key.
pub const EMAIL: &str = "email";
pub const EMAIL_ISS: &str = "https://api.sandbox.hana-id.test/v1/email";
pub const EMAIL_SIGNER: &str = "hana";
pub const EMAIL_KID: &str = "hana-email-sandbox-1";

/// An email `sub` of the issuer's shape ("e1." + 43 base64url characters) for a test name.
pub fn email_sub(name: &str) -> String {
    format!("e1.{}", b64url(&sha256(name.as_bytes())))
}

/// The email client audience of a scope: "email:" + scope_id.
pub fn email_aud(scope_id: &str) -> String {
    format!("email:{scope_id}")
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

    /// The session fields shared by create_session and create_session_and_derive.
    fn base_args(&self, jwt: &str) -> Value {
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

    /// create_session args for the deployment `signer`, with the session key's proof of possession (`signature`:
    /// session_message(0, "hana-id-create-v1:" ‖ sha256(session nonce preimage)), required since contract v3, D137;
    /// older contracts ignore the extra field).
    pub fn create_args(&self, signer: &AccountId, jwt: &str) -> Value {
        let preimage = session_nonce_preimage(signer.as_str(), &self.scope_id, &self.public_key(), self.expires_at_ms, self.key_index, self.max_uses, &self.salt);
        let mut payload = b"hana-id-create-v1:".to_vec();
        payload.extend_from_slice(&sha256(&preimage));
        let pop = self.key.sign(&session_message(0, &payload));
        let mut args = self.base_args(jwt);
        args["signature"] = json!(pop.to_bytes().to_vec());
        args
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

    /// create_session_and_derive args: create_args plus a derive signature for counter 1 (which it sets as the last
    /// counter used, as the call spends it).
    pub fn login_args(&mut self, jwt: &str, pk1: &str, pk2: &str) -> Value {
        self.counter = 1;
        let sig = self.key.sign(&session_message(1, &ckd_payload(pk1, pk2)));
        let mut args = self.base_args(jwt);
        args["signature"] = json!(sig.to_bytes().to_vec());
        args["pk1"] = json!(pk1);
        args["pk2"] = json!(pk2);
        args
    }

    /// sha256 of this session's nonce preimage on `signer` (what the auto_link nonce commits to).
    pub fn preimage_hash(&self, signer: &AccountId) -> Vec<u8> {
        sha256(&session_nonce_preimage(signer.as_str(), &self.scope_id, &self.public_key(), self.expires_at_ms, self.key_index, self.max_uses, &self.salt))
    }

    /// create_session_and_derive args with an automatic link: `link_jwt`, `link_immediate`, and the counter-1
    /// signature over the linked CKD payload (D133), as the vault signs it.
    pub fn linked_login_args(&mut self, jwt: &str, pk1: &str, pk2: &str, link_jwt: &str, immediate: Option<bool>) -> Value {
        self.counter = 1;
        let sig = self.key.sign(&session_message(1, &linked_ckd_payload(link_jwt, immediate.unwrap_or(false), pk1, pk2)));
        let mut args = self.base_args(jwt);
        args["signature"] = json!(sig.to_bytes().to_vec());
        args["pk1"] = json!(pk1);
        args["pk2"] = json!(pk2);
        args["link_jwt"] = json!(link_jwt);
        if let Some(immediate) = immediate {
            args["link_immediate"] = json!(immediate);
        }
        args
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
    /// The signer account signing with the updater key the owner had the contract install (`add_updater_key`:
    /// UPDATER_METHODS on itself, 1 NEAR allowance).
    pub keys_updater: Account,
    /// A watchdog account (full key) given to `new`, so it may confirm at once.
    pub watchdog: Account,
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

/// Deploys hana-signer to `root`/`name`, calls `new` (owner `admin`, `watchdog` as a watchdog that may confirm at
/// once), and configures the Google issuer with the test key (proposed by the owner, confirmed by the watchdog),
/// the console audience and the relayer as sponsor. `new` gets change_delay_ms = 0 so the console audience is in
/// force at once; the delay is then raised to CHANGE_DELAY_MS (increases apply at once).
async fn deploy_signer(root: &Account, name: &str, admin: &Account, watchdog: &Account, mpc: &AccountId, issuer: &TestIssuer, relayer: &AccountId) -> Result<Contract> {
    let (signer_wasm, _) = wasms()?;
    deploy_signer_code(root, name, &signer_wasm, admin, watchdog, mpc, issuer, relayer).await
}

/// `deploy_signer` with the given hana-signer code (the current one, or the v2 code of `v2_wasm`, whose `new`, Google
/// key flow and setters take the same arguments).
#[allow(clippy::too_many_arguments)]
pub async fn deploy_signer_code(root: &Account, name: &str, code: &[u8], admin: &Account, watchdog: &Account, mpc: &AccountId, issuer: &TestIssuer, relayer: &AccountId) -> Result<Contract> {
    let signer = subaccount(root, name, 50).await?.deploy(code).await?.into_result()?;
    signer
        .call("new")
        .args_json(json!({
            "owner": admin.id(), "mpc": mpc, "ckd_domain_id": CKD_DOMAIN_ID, "change_delay_ms": 0,
            "issuer_key_delay_ms": ISSUER_KEY_DELAY_MS, "governance_delay_ms": GOVERNANCE_DELAY_MS,
            "watchdogs": [watchdog.id()], "updater_keys": [],
        }))
        .transact()
        .await?
        .into_result()?;
    admin
        .call(signer.id(), "set_issuer")
        .args_json(json!({"provider": PROVIDER, "iss_values": [ISS, "accounts.google.com"]}))
        .transact()
        .await?
        .into_result()?;
    post_issuer_key(admin, watchdog, signer.id(), issuer).await?;
    admin
        .call(signer.id(), "set_console_audiences")
        .args_json(json!({"audiences": [[PROVIDER, CONSOLE]]}))
        .transact()
        .await?
        .into_result()?;
    admin.call(signer.id(), "set_sponsors").args_json(json!({"sponsors": [relayer]})).transact().await?.into_result()?;
    admin.call(signer.id(), "set_change_delay_ms").args_json(json!({"change_delay_ms": CHANGE_DELAY_MS})).transact().await?.into_result()?;
    Ok(signer)
}

/// Makes `issuer`'s key active on `signer`: `proposer` posts it (`set_issuer_key`), `watchdog` confirms it.
pub async fn post_issuer_key(proposer: &Account, watchdog: &Account, signer: &AccountId, issuer: &TestIssuer) -> Result<u64> {
    let id: u64 = proposer
        .call(signer, "set_issuer_key")
        .args_json(json!({"provider": PROVIDER, "kid": issuer.kid, "n": issuer.n, "e": issuer.e}))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()?
        .json()?;
    watchdog.call(signer, "confirm_issuer_key_change").args_json(json!({"id": id})).transact().await?.into_result()?;
    Ok(id)
}

/// `owner` proposes `key` as a key of Hana's email issuer (signer "hana"); returns the key change id. It waits at least
/// `governance_delay_ms` (self-issued keys are never confirmed early).
pub async fn post_email_key(owner: &Account, signer: &AccountId, key: &TestIssuer) -> Result<u64> {
    let outcome = owner
        .call(signer, "set_issuer_key")
        .args_json(json!({"provider": EMAIL, "kid": key.kid, "n": key.n, "e": key.e, "signer": EMAIL_SIGNER}))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?;
    report_gas("set_issuer_key (email, signer hana)", &outcome, Gas::from_tgas(30));
    Ok(outcome.into_result()?.json()?)
}

/// Gas burnt by the signer contract's receipts of `outcome` (not the MPC's, nor the transaction's conversion).
pub fn signer_receipts_gas(outcome: &ExecutionFinalResult, signer: &AccountId) -> Gas {
    Gas::from_gas(outcome.receipt_outcomes().iter().filter(|r| &r.executor_id == signer).map(|r| r.gas_burnt.as_gas()).sum())
}

/// Prints one line of the gas report (`cargo test -- --nocapture | grep '^GAS'`): the transaction's total gas burnt,
/// the part burnt in its first receipt (the called contract), and the gas attached.
pub fn report_gas(label: &str, outcome: &ExecutionFinalResult, attached: Gas) {
    let first = outcome.receipt_outcomes().first().map_or(0, |r| r.gas_burnt.as_gas());
    println!(
        "GAS {label}: {:.2} Tgas burnt in all, {:.2} Tgas in the called contract's receipt, {} Tgas attached{}",
        outcome.total_gas_burnt.as_gas() as f64 / 1e12,
        first as f64 / 1e12,
        attached.as_tgas(),
        if outcome.is_success() { "" } else { " (FAILED)" }
    );
}

/// The owner has the contract add a fresh updater key to `signer`; returns the signer account signing with it,
/// after checking on chain that it is limited to UPDATER_METHODS on `signer`.
pub async fn add_updater_key(worker: &Worker<Sandbox>, owner: &Account, signer: &AccountId) -> Result<Account> {
    let sk = SecretKey::from_random(KeyType::ED25519);
    let added: bool = owner
        .call(signer, "add_updater_key")
        .args_json(json!({"public_key": sk.public_key().to_string()}))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?
        .json()?;
    if !added {
        bail!("add_updater_key reported the AddKey failed");
    }
    assert_function_call_key(worker, signer, &sk.public_key(), signer, UPDATER_METHODS).await?;
    Ok(Account::from_secret_key(signer.clone(), sk, worker))
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
        let watchdog = subaccount(&root, "watchdog", 20).await?;

        let mpc = subaccount(&root, "mpc", 20).await?.deploy(&mpc_wasm).await?.into_result()?;
        mpc.call("new").transact().await?.into_result()?;

        let issuer = TestIssuer::generate()?;
        let signer = deploy_signer(&root, "signer", &admin, &watchdog, mpc.id(), &issuer, relayer.id()).await?;

        // The relayer's two key pools (as deploy-contract.ts sets them up).
        let relayer_fc = add_fc_key(&worker, &relayer, signer.id(), SESSION_RELAYER_METHODS, NearToken::from_near(1)).await?;
        let relayer_owner_fc = add_fc_key(&worker, &relayer, signer.id(), OWNER_RELAYER_METHODS, NearToken::from_millinear(500)).await?;
        // The updater key on the signer account itself, installed by the contract.
        let keys_updater = add_updater_key(&worker, &admin, signer.id()).await?;

        let mut env = Self {
            worker,
            signer,
            mpc,
            admin,
            alice,
            bob,
            carol,
            relayer,
            relayer_fc,
            relayer_owner_fc,
            keys_updater,
            watchdog,
            issuer,
            scope_a: String::new(),
            scope_b: String::new(),
        };
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
        deploy_signer(&root, name, &self.admin, &self.watchdog, self.mpc.id(), &self.issuer, self.relayer.id()).await
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

    /// admin_register_scope on the main deployment with `(provider, aud)` clients of any provider.
    pub async fn admin_register_clients(&self, owners: Vec<Value>, clients: &[(&str, &str)], allow_shared: bool) -> Result<String> {
        Ok(self
            .admin
            .call(self.signer.id(), "admin_register_scope")
            .args_json(json!({"owners": owners, "clients": clients, "scope_id": null, "allow_shared": allow_shared}))
            .gas(GAS)
            .transact()
            .await?
            .into_result()?
            .json()?)
    }

    /// The owner (admin) sets up Hana's email issuer as batch 6 does on sandbox-dev: `set_issuer("email", [EMAIL_ISS])`,
    /// `mark_self_issued("email")`, `set_issuer_key(..., signer: "hana")`, then, after `governance_delay_ms`, anyone
    /// executes the key change. Returns the issuer's key. Prints the gas of each call.
    pub async fn setup_email(&self) -> Result<TestIssuer> {
        self.setup_email_with(TestIssuer::generate_with_kid(EMAIL_KID)?).await
    }

    /// `setup_email` with the given issuer key.
    pub async fn setup_email_with(&self, key: TestIssuer) -> Result<TestIssuer> {
        let signer = self.signer.id();
        let outcome = self.admin.call(signer, "set_issuer").args_json(json!({"provider": EMAIL, "iss_values": [EMAIL_ISS]})).gas(GAS).transact().await?;
        report_gas("set_issuer (email)", &outcome, GAS);
        outcome.into_result()?;
        let outcome = self.admin.call(signer, "mark_self_issued").args_json(json!({"provider": EMAIL})).gas(GAS).transact().await?;
        report_gas("mark_self_issued", &outcome, GAS);
        outcome.into_result()?;
        let id = post_email_key(&self.admin, signer, &key).await?;
        let due = self.get_key_changes().await?.as_array().context("key changes")?.iter().find(|c| c["id"] == json!(id)).context("the email key change")?["executable_at_ms"]
            .as_u64()
            .context("executable_at_ms")?;
        self.advance_to(due).await?;
        let outcome = self.alice.call(signer, "execute_issuer_key_change").args_json(json!({"id": id})).gas(Gas::from_tgas(30)).transact().await?;
        report_gas("execute_issuer_key_change (email)", &outcome, Gas::from_tgas(30));
        outcome.into_result()?;
        Ok(key)
    }

    /// A new session in `scope_id` (key index 0, 5 uses) and an email token for `sub` committing to it.
    pub async fn new_email_session(&self, email: &TestIssuer, scope_id: &str, sub: &str, ttl_ms: u64) -> Result<(TestSession, String)> {
        let now = self.now_ms().await?;
        let session = TestSession::new(scope_id, now + ttl_ms, 0, 5);
        let jwt = email.email_jws(&email_aud(scope_id), sub, &session.nonce(self.signer.id()), now);
        Ok((session, jwt))
    }

    pub async fn get_identity(&self, scope_id: &str, provider: &str, sub: &str) -> Result<Value> {
        Ok(self.signer.view("get_identity").args_json(json!({"scope_id": scope_id, "provider": provider, "sub": sub})).await?.json()?)
    }

    pub async fn get_account(&self, scope_id: &str, provider: &str, sub: &str) -> Result<Value> {
        Ok(self.signer.view("get_account").args_json(json!({"scope_id": scope_id, "provider": provider, "sub": sub})).await?.json()?)
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
        self.new_session_with_uses(aud, sub, scope_id, key_index, 5, ttl_ms).await
    }

    /// As `new_session`, with `max_uses` uses.
    pub async fn new_session_with_uses(&self, aud: &str, sub: &str, scope_id: &str, key_index: u32, max_uses: u32, ttl_ms: u64) -> Result<(TestSession, String)> {
        let now = self.now_ms().await?;
        let session = TestSession::new(scope_id, now + ttl_ms, key_index, max_uses);
        let jwt = self.issuer.jwt(aud, sub, Some(&session.nonce(self.signer.id())), now);
        Ok((session, jwt))
    }

    pub async fn create_session(&self, caller: &Account, session: &TestSession, jwt: &str) -> Result<ExecutionFinalResult> {
        Ok(caller.call(self.signer.id(), "create_session").args_json(session.create_args(self.signer.id(), jwt)).gas(api_gas("create_session")).transact().await?)
    }

    /// Sends create_session_and_derive `args` (from `TestSession::login_args`) as `caller`, with the gas the API attaches.
    pub async fn login(&self, caller: &Account, args: &Value) -> Result<ExecutionFinalResult> {
        Ok(caller.call(self.signer.id(), "create_session_and_derive").args_json(args.clone()).gas(api_gas("create_session_and_derive")).transact().await?)
    }

    /// The mock MPC's answer for `path` and (pk1, pk2), as `derive_key` must return it.
    pub async fn expected_ckd(&self, path: &str, pk1: &str, pk2: &str) -> Result<CkdResponse> {
        let request = json!({"derivation_path": path, "app_public_key": {"AppPublicKeyPV": {"pk1": pk1, "pk2": pk2}}, "domain_id": CKD_DOMAIN_ID});
        Ok(self.mpc.view("expected_response").args_json(json!({"request": request})).await?.json()?)
    }

    /// Flips the mock MPC's failure switch (signed by the mock's own account).
    pub async fn set_mpc_fail(&self, fail: bool) -> Result<()> {
        self.mpc.call("set_fail").args_json(json!({"fail": fail})).transact().await?.into_result()?;
        Ok(())
    }

    pub async fn session_key_in_use(&self, session: &TestSession) -> Result<bool> {
        Ok(self.signer.view("session_key_in_use").args_json(json!({"session_public_key": session.public_key()})).await?.json()?)
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
        advance_to(&self.worker, target_ms).await
    }

    pub async fn get_governance(&self) -> Result<Value> {
        Ok(self.signer.view("get_governance").await?.json()?)
    }

    pub async fn get_key_changes(&self) -> Result<Value> {
        Ok(self.signer.view("get_key_changes").await?.json()?)
    }

    /// Active kids of the Google issuer.
    pub async fn kids(&self) -> Result<Vec<String>> {
        let issuer: Value = self.signer.view("get_issuer").args_json(json!({"provider": PROVIDER})).await?.json()?;
        Ok(issuer["kids"].as_array().context("kids")?.iter().map(|k| k.as_str().unwrap().to_string()).collect())
    }
}

/// Sandbox block time (ms).
pub async fn now_ms(worker: &Worker<Sandbox>) -> Result<u64> {
    Ok(worker.view_block().await?.timestamp() / 1_000_000)
}

/// Fast-forwards until the sandbox clock is at least `target_ms` (fast_forward advances height; the block timestamp
/// follows it).
pub async fn advance_to(worker: &Worker<Sandbox>, target_ms: u64) -> Result<()> {
    for _ in 0..200 {
        let now = now_ms(worker).await?;
        if now >= target_ms {
            return Ok(());
        }
        let blocks = ((target_ms - now) / 1000).clamp(5, 500);
        worker.fast_forward(blocks).await?;
    }
    bail!("sandbox clock did not reach {target_ms}")
}

/// The account's code hash (base58), as `view_account` shows it.
pub async fn account_code_hash(worker: &Worker<Sandbox>, account: &AccountId) -> Result<String> {
    match worker.view_account(account).await?.contract_state {
        near_workspaces::ContractState::LocalHash(hash) => Ok(hash.to_string()),
        other => bail!("{account} has no local contract: {other:?}"),
    }
}

/// Every NEP-297 event of `standard` hana-id in an outcome's logs (all receipts), as JSON.
pub fn hana_events(outcome: &ExecutionFinalResult) -> Vec<Value> {
    outcome.logs().iter().filter_map(|l| l.strip_prefix("EVENT_JSON:")).filter_map(|j| serde_json::from_str::<Value>(j).ok()).filter(|e| e["standard"] == "hana-id").collect()
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
