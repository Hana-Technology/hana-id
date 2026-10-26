//! Shared setup for the sandbox tests: builds the wasm, starts a sandbox, deploys `hana-signer` with `mock-mpc`,
//! and mints test ID tokens.
//!
//! Tokens are signed by a throwaway RSA key generated per test run (kept in memory only). hana-signer's own
//! `src/test_fixture.json` can't be reused here: its private key is discarded and its tokens commit to session
//! expiries around a fixed 2027 timestamp, outside the 24 h window relative to the sandbox clock. The token format
//! and the byte layouts (session nonce, register proof, client proof, owner-action nonce, session message) are
//! re-implemented independently below from docs/contract-interface.md.

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

/// The methods the relayer's function-call keys may call (docs/batch-a-spec.md, deploy-contract.ts).
pub const RELAYER_METHODS: &[&str] = &[
    "create_session",
    "derive_key",
    "revoke_session",
    "prune_sessions",
    "register_scope",
    "propose_change",
    "cancel_change",
    "remove_client",
    "execute_change",
];
pub const KEYS_UPDATER_METHODS: &[&str] = &["set_issuer_key", "remove_issuer_key"];

/// Every change method of hana-signer (docs/batch-a-spec.md). The access-key test calls each one with each
/// function-call key, so a method added to the contract should be added here too.
pub const ALL_CHANGE_METHODS: &[&str] = &[
    "new",
    "set_owner",
    "set_sponsors",
    "set_console_audiences",
    "set_change_delay_ms",
    "enable_public_registration",
    "set_issuer",
    "set_issuer_key",
    "remove_issuer_key",
    "admin_register_scope",
    "register_scope",
    "propose_change",
    "execute_change",
    "cancel_change",
    "remove_client",
    "create_session",
    "derive_key",
    "revoke_session",
    "prune_sessions",
];

pub const GAS: Gas = Gas::from_tgas(300);

/// Gas create_session may burn (RS256 verification in wasm, plus pruning up to 3 sessions). The relayer attaches
/// 300 Tgas; this keeps a wide margin under it so a regression in the verifier shows up here, not on testnet.
pub const CREATE_SESSION_GAS_BUDGET: Gas = Gas::from_tgas(100);

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

pub fn session_nonce(pk: &[u8], expires_at_ms: u64, key_index: u32, salt: &[u8]) -> String {
    let mut m = pk.to_vec();
    m.extend_from_slice(&expires_at_ms.to_le_bytes());
    m.extend_from_slice(&key_index.to_le_bytes());
    m.extend_from_slice(salt);
    b64url(&sha256(&m))
}

pub fn register_nonce(owners: &[Value]) -> String {
    let mut m = b"hana-id/register/v1".to_vec();
    m.extend(borsh_owners(owners));
    b64url(&sha256(&m))
}

pub fn client_proof_nonce(scope_id: &str, action_nonce: u64) -> String {
    let mut m = b"hana-id/client-proof/v1".to_vec();
    m.extend_from_slice(scope_id.as_bytes());
    m.extend_from_slice(&action_nonce.to_le_bytes());
    b64url(&sha256(&m))
}

pub fn owner_action_nonce(scope_id: &str, method: &str, args_borsh: &[u8], action_nonce: u64) -> String {
    let mut m = b"hana-id/owner-action/v1".to_vec();
    m.extend_from_slice(scope_id.as_bytes());
    m.extend_from_slice(method.as_bytes());
    m.extend_from_slice(args_borsh);
    m.extend_from_slice(&action_nonce.to_le_bytes());
    b64url(&sha256(&m))
}

/// "hana-embed-session-v1:" ‖ counter u64 LE ‖ sha256(payload).
pub fn session_message(counter: u64, payload: &[u8]) -> Vec<u8> {
    let mut m = b"hana-embed-session-v1:".to_vec();
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
    pub expires_at_ms: u64,
    pub salt: Vec<u8>,
    pub key_index: u32,
    pub max_uses: u32,
    /// Last counter used.
    pub counter: u64,
}

impl TestSession {
    pub fn new(expires_at_ms: u64, key_index: u32, max_uses: u32) -> Self {
        let key = SigningKey::generate(&mut rand::rngs::OsRng);
        Self { key, expires_at_ms, salt: (0u8..16).map(|i| i * 7 + 3).collect(), key_index, max_uses, counter: 0 }
    }

    pub fn public_key(&self) -> Vec<u8> {
        self.key.verifying_key().to_bytes().to_vec()
    }

    pub fn nonce(&self) -> String {
        session_nonce(&self.public_key(), self.expires_at_ms, self.key_index, &self.salt)
    }

    pub fn create_args(&self, jwt: &str) -> Value {
        json!({
            "jwt": jwt,
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
    /// The relayer account (full key; tests use `relayer_fc` to act as the API does).
    pub relayer: Account,
    /// The relayer account signing with a function-call key limited to RELAYER_METHODS on the signer.
    pub relayer_fc: Account,
    /// The signer account signing with a function-call key limited to KEYS_UPDATER_METHODS on itself.
    pub keys_updater: Account,
    pub issuer: TestIssuer,
    /// Scope ids of the two admin-registered scopes: A = [APP_A] owned by alice, B = [APP_B] owned by bob.
    pub scope_a: String,
    pub scope_b: String,
}

async fn subaccount(root: &Account, name: &str, near: u128) -> Result<Account> {
    Ok(root.create_subaccount(name).initial_balance(NearToken::from_near(near)).transact().await?.into_result()?)
}

impl Env {
    pub async fn setup() -> Result<Self> {
        let (signer_wasm, mpc_wasm) = wasms()?;
        let worker = near_workspaces::sandbox().await?;
        let root = worker.root_account()?;

        let admin = subaccount(&root, "admin", 20).await?;
        let alice = subaccount(&root, "alice", 20).await?;
        let bob = subaccount(&root, "bob", 20).await?;
        let carol = subaccount(&root, "carol", 20).await?;
        let relayer = subaccount(&root, "relayer", 20).await?;

        let mpc = subaccount(&root, "mpc", 20).await?.deploy(&mpc_wasm).await?.into_result()?;
        mpc.call("new").transact().await?.into_result()?;

        let signer = subaccount(&root, "signer", 50).await?.deploy(&signer_wasm).await?.into_result()?;
        signer
            .call("new")
            .args_json(json!({"owner": admin.id(), "mpc": mpc.id(), "ckd_domain_id": CKD_DOMAIN_ID, "change_delay_ms": CHANGE_DELAY_MS}))
            .transact()
            .await?
            .into_result()?;

        // Relayer function-call key (as deploy-contract.ts sets it up).
        let relayer_sk = SecretKey::from_random(KeyType::ED25519);
        relayer
            .batch(relayer.id())
            .add_key(relayer_sk.public_key(), AccessKey::function_call_access(signer.id(), RELAYER_METHODS, Some(NearToken::from_near(1))))
            .transact()
            .await?
            .into_result()?;
        let relayer_fc = Account::from_secret_key(relayer.id().clone(), relayer_sk, &worker);
        assert_function_call_key(&worker, relayer.id(), &relayer_fc.secret_key().public_key(), signer.id(), RELAYER_METHODS).await?;

        // Keys-updater function-call key on the signer account itself.
        let updater_sk = SecretKey::from_random(KeyType::ED25519);
        signer
            .as_account()
            .batch(signer.id())
            .add_key(updater_sk.public_key(), AccessKey::function_call_access(signer.id(), KEYS_UPDATER_METHODS, Some(NearToken::from_millinear(250))))
            .transact()
            .await?
            .into_result()?;
        let keys_updater = Account::from_secret_key(signer.id().clone(), updater_sk, &worker);
        assert_function_call_key(&worker, signer.id(), &keys_updater.secret_key().public_key(), signer.id(), KEYS_UPDATER_METHODS).await?;

        let issuer = TestIssuer::generate()?;
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
        admin.call(signer.id(), "set_sponsors").args_json(json!({"sponsors": [relayer.id()]})).transact().await?.into_result()?;

        let mut env = Self { worker, signer, mpc, admin, alice, bob, carol, relayer, relayer_fc, keys_updater, issuer, scope_a: String::new(), scope_b: String::new() };
        let alice_owner = near_owner(env.alice.id());
        let bob_owner = near_owner(env.bob.id());
        env.scope_a = env.admin_register(vec![alice_owner], &[APP_A]).await?;
        env.scope_b = env.admin_register(vec![bob_owner], &[APP_B]).await?;
        Ok(env)
    }

    pub async fn admin_register(&self, owners: Vec<Value>, clients: &[&str]) -> Result<String> {
        let clients: Vec<(&str, &str)> = clients.iter().map(|c| (PROVIDER, *c)).collect();
        let res = self
            .admin
            .call(self.signer.id(), "admin_register_scope")
            .args_json(json!({"owners": owners, "clients": clients, "scope_id": null}))
            .gas(GAS)
            .transact()
            .await?;
        Ok(res.into_result()?.json()?)
    }

    /// Sandbox block time (ms).
    pub async fn now_ms(&self) -> Result<u64> {
        Ok(self.worker.view_block().await?.timestamp() / 1_000_000)
    }

    pub async fn jwt(&self, aud: &str, sub: &str, nonce: Option<&str>) -> Result<String> {
        Ok(self.issuer.jwt(aud, sub, nonce, self.now_ms().await?))
    }

    /// A new session expiring `ttl_ms` from now, and a token for `aud`/`sub` committing to it.
    pub async fn new_session(&self, aud: &str, sub: &str, key_index: u32, ttl_ms: u64) -> Result<(TestSession, String)> {
        let now = self.now_ms().await?;
        let session = TestSession::new(now + ttl_ms, key_index, 5);
        let jwt = self.issuer.jwt(aud, sub, Some(&session.nonce()), now);
        Ok((session, jwt))
    }

    pub async fn create_session(&self, caller: &Account, session: &TestSession, jwt: &str) -> Result<ExecutionFinalResult> {
        Ok(caller.call(self.signer.id(), "create_session").args_json(session.create_args(jwt)).gas(GAS).transact().await?)
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
