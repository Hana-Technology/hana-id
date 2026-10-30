//! Self-issued issuers (email login, `docs/email-login-spec.md` "Self-issued issuers", D121): providers whose signing
//! keys Hana itself holds, so Hana could mint any user's token. The contract bounds that power:
//!
//! - one way (`mark_self_issued`): owner-posted keys only (never the updater key, "self"), each waiting at least
//!   `governance_delay_ms`, never confirmed early by a watchdog (it can only cancel);
//! - a **signer policy**: signer ids, each with its own keys (`key_signer`), and `required`, the number of distinct
//!   signers a token needs. Tokens are JWS General JSON Serialization with up to 3 signatures; two keys of one signer
//!   count once, and one RSA key can never belong to two signers (or be registered twice), so one stolen key never
//!   counts as two signers. 1-of-1 (`hana`) at launch;
//! - no method changes the signer list or `required`: only a governed upgrade's `migrate` does
//!   (`HanaSigner::set_signer_policy`), with a short overlap during which tokens valid under the previous policy
//!   still pass, so tokens minted just before the upgrade aren't lost.

use near_sdk::serde_json::json;
use near_sdk::{env, near};

use crate::issuers::{Issuer, KeyOp, RsaKey};
use crate::oidc::{self, JwsSignature, RsaPublicKey};
use crate::{assert_provider, events, valid_provider, HanaSigner, HanaSignerExt};

/// The providers that may be marked self-issued: Hana's email issuer only (its path provider name is frozen at the
/// address freeze). Another one needs a governed upgrade.
pub const SELF_ISSUABLE: [&str; 1] = ["email"];
/// Signers in one policy, at most (= `oidc::MAX_JWS_SIGNATURES`).
pub const MAX_SIGNERS: usize = 3;
/// Keys of a self-issued provider (all signers, active and pending additions together), at most.
pub const MAX_SELF_ISSUED_KEYS: usize = 8;
/// The signer `mark_self_issued` lists: Hana's email issuer.
pub const LAUNCH_SIGNER: &str = "hana";
/// How long tokens valid under the previous policy still pass after a policy change: the email token lifetime.
pub const POLICY_OVERLAP_MS: u64 = 600_000;

/// The signer policy of one self-issued provider.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct SelfIssued {
    pub provider: String,
    /// Signer ids, ≤ `MAX_SIGNERS`; `["hana"]` at launch; changed only by a governed upgrade's `migrate`.
    pub signers: Vec<String>,
    /// (kid, signer id) of every active key of the provider, ≤ `MAX_SELF_ISSUED_KEYS`. Pending additions carry their
    /// signer in their `KeyOp::AddForSigner`.
    pub key_signer: Vec<(String, String)>,
    /// Distinct signers a token needs; 1 at launch.
    pub required: u8,
    /// The previous (signers, required) and until when tokens that satisfy it still pass; set by the `migrate` that
    /// changes the policy.
    pub overlap: Option<(Vec<String>, u8, u64)>,
}

impl SelfIssued {
    fn signer_of(&self, kid: &str) -> Option<&str> {
        self.key_signer.iter().find(|(k, _)| k == kid).map(|(_, s)| s.as_str())
    }

    /// The previous policy while its overlap lasts.
    fn overlap_at(&self, now: u64) -> Option<(&[String], u8)> {
        self.overlap.as_ref().filter(|(_, _, until)| now < *until).map(|(signers, required, _)| (signers.as_slice(), *required))
    }

    /// Whether a signature of `signer` may count at `now`: the signer is listed, or listed in the previous policy
    /// while its overlap lasts.
    fn signer_counts(&self, signer: &str, now: u64) -> bool {
        self.signers.iter().any(|s| s == signer) || self.overlap_at(now).is_some_and(|(prev, _)| prev.iter().any(|s| s == signer))
    }
}

/// One signer of `get_self_issued`, with its active keys.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SignerView {
    pub id: String,
    pub kids: Vec<String>,
}

/// `get_self_issued(provider)`: what the watchdog pins.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SelfIssuedView {
    pub provider: String,
    pub signers: Vec<SignerView>,
    pub required: u8,
    /// While a policy change's overlap lasts: until when tokens valid under the previous policy still pass.
    pub overlap_until_ms: Option<u64>,
}

#[cfg_attr(not(test), allow(dead_code))]
fn valid_signer_id(id: &str) -> bool {
    valid_provider(id)
}

#[near]
impl HanaSigner {
    /// Owner, one way: makes `provider` self-issued with the policy `{signers: ["hana"], required: 1}`. Only the
    /// `email` provider (`SELF_ISSUABLE`, D134): marking an outside issuer such as Google would break its logins until
    /// a governed upgrade. The issuer must exist and have no keys yet, active or pending (its keys are then all posted
    /// under the self-issued rules, each with its signer).
    pub fn mark_self_issued(&mut self, provider: String) {
        self.assert_owner();
        assert_provider(&provider);
        assert!(SELF_ISSUABLE.contains(&provider.as_str()), "Only the email issuer can be self-issued");
        let issuer = self.issuers.get(&provider).unwrap_or_else(|| env::panic_str("Unknown issuer"));
        assert!(self.self_issued_of(&provider).is_none(), "Issuer is already self-issued");
        assert!(issuer.keys.is_empty() && !self.key_changes.iter().any(|c| c.provider == provider), "Issuer already has keys");
        self.self_issued.push(SelfIssued { provider: provider.clone(), signers: vec![LAUNCH_SIGNER.to_string()], key_signer: vec![], required: 1, overlap: None });
        events::emit("issuer_self_issued", json!({ "provider": provider }));
    }

    /// The signer policy of a self-issued provider, `null` for any other. Each signer lists its active kids.
    pub fn get_self_issued(&self, provider: String) -> Option<SelfIssuedView> {
        let now = env::block_timestamp_ms();
        self.self_issued_of(&provider).map(|si| SelfIssuedView {
            provider: si.provider.clone(),
            signers: si
                .signers
                .iter()
                .map(|id| SignerView { id: id.clone(), kids: si.key_signer.iter().filter(|(_, s)| s == id).map(|(k, _)| k.clone()).collect() })
                .collect(),
            required: si.required,
            overlap_until_ms: si.overlap.as_ref().map(|(_, _, until)| *until).filter(|until| now < *until),
        })
    }
}

impl HanaSigner {
    pub(crate) fn self_issued_of(&self, provider: &str) -> Option<&SelfIssued> {
        self.self_issued.iter().find(|s| s.provider == provider)
    }

    pub(crate) fn self_issued_mut(&mut self, provider: &str) -> Option<&mut SelfIssued> {
        self.self_issued.iter_mut().find(|s| s.provider == provider)
    }

    /// Checks a self-issued key proposal (`set_issuer_key` with `signer`): a listed signer, room for one more key, and
    /// key material that no active or pending key of the provider already has. Returns the queued operation.
    pub(crate) fn self_issued_key_op(&self, provider: &str, signer: Option<String>, n: Vec<u8>, e: Vec<u8>) -> KeyOp {
        let si = self.self_issued_of(provider).expect("self-issued");
        let signer = signer.filter(|s| si.signers.contains(s)).unwrap_or_else(|| env::panic_str("Unknown signer"));
        let issuer = self.issuers.get(provider).expect("issuer of a self-issued provider");
        // Moduli of the pending additions (one modulus is one private key, whatever the exponent).
        let pending: Vec<&Vec<u8>> = self
            .key_changes
            .iter()
            .filter(|c| c.provider == provider)
            .filter_map(|c| match &c.op {
                KeyOp::Add { n, .. } | KeyOp::AddForSigner { n, .. } => Some(n),
                KeyOp::Remove => None,
            })
            .collect();
        assert!(issuer.keys.len() + pending.len() < MAX_SELF_ISSUED_KEYS, "Too many keys for this issuer");
        assert!(!key_material_in_use(issuer, &n) && !pending.iter().any(|pn| **pn == n), "Key is already registered");
        KeyOp::AddForSigner { n, e, signer }
    }

    /// Verifies the signatures of a self-issued provider's JWS JSON token against its signer policy: distinct kids,
    /// each an active key of a signer that counts now, each RS256-valid (one bad signature fails the token), and at
    /// least `required` distinct current signers, or, while the overlap lasts, enough of the previous policy's.
    pub(crate) fn verify_self_issued_signatures(&self, provider: &str, issuer: &Issuer, signatures: &[JwsSignature]) {
        let si = self.self_issued_of(provider).expect("self-issued");
        let now = env::block_timestamp_ms();
        let mut seen: Vec<&str> = Vec::with_capacity(signatures.len());
        for (i, sig) in signatures.iter().enumerate() {
            assert!(!signatures[..i].iter().any(|s| s.kid == sig.kid), "Duplicate signature kid");
            let key = issuer.keys.get(&sig.kid).unwrap_or_else(|| env::panic_str("Unknown signing key"));
            let signer = si.signer_of(&sig.kid).filter(|s| si.signer_counts(s, now)).unwrap_or_else(|| env::panic_str("Unknown signing key"));
            oidc::verify_jws_signature(sig, RsaPublicKey { n: &key.n, e: &key.e }).unwrap_or_else(|err| env::panic_str(&err));
            if !seen.contains(&signer) {
                seen.push(signer);
            }
        }
        let distinct_in = |list: &[String]| seen.iter().filter(|s| list.iter().any(|l| l == *s)).count();
        let current = distinct_in(&si.signers) >= usize::from(si.required);
        let previous = si.overlap_at(now).is_some_and(|(prev, required)| distinct_in(prev) >= usize::from(required));
        assert!(current || previous, "Not enough signatures");
    }

    /// Records the signer of a self-issued key that just became active.
    pub(crate) fn note_key_signer(&mut self, provider: &str, kid: &str, signer: &str) {
        let si = self.self_issued_mut(provider).expect("self-issued");
        assert!(si.signers.iter().any(|s| s == signer), "Unknown signer");
        si.key_signer.retain(|(k, _)| k != kid);
        si.key_signer.push((kid.to_string(), signer.to_string()));
    }

    /// Forgets the signer of a self-issued key that left the active set (no-op for other providers).
    pub(crate) fn forget_key_signer(&mut self, provider: &str, kid: &str) {
        if let Some(si) = self.self_issued_mut(provider) {
            si.key_signer.retain(|(k, _)| k != kid);
        }
    }

    /// For a governed upgrade's `migrate` only (no method calls it, D121): replaces the signer policy of a self-issued
    /// provider and installs `new_keys` (kid, signer, key) as active at once. The upgrade itself was public for
    /// `governance_delay_ms` and the watchdog pins the new signer's keys before it executes. Panics on an invalid
    /// policy: 1..=3 distinct valid signer ids, `required` in 1..=signers, every key's signer listed, kids new, every
    /// key valid as `set_issuer_key` checks it (`issuers::checked_rsa_key`: no zero padding, 2048–4096 bits, a sane
    /// exponent) and its modulus new, ≤ `MAX_SELF_ISSUED_KEYS` keys.
    ///
    /// `overlap` (D136): `true` (adding a co-signer) keeps tokens that satisfy the previous policy valid for
    /// `POLICY_OVERLAP_MS`, so tokens minted just before the upgrade aren't lost; signers dropped from the policy keep
    /// their keys until the owner removes them (they can't count once the overlap ends). `false` (replacing a
    /// compromised signer) opens no overlap and removes the keys of every dropped signer at once; the replacement must
    /// come under a new signer id (`A replacing policy adds keys only for new signer ids`). Either way, pending key
    /// additions of signers that leave the policy are cancelled (D138).
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn set_signer_policy(&mut self, provider: &str, signers: Vec<String>, required: u8, new_keys: Vec<(String, String, RsaKey)>, overlap: bool) {
        assert!(!signers.is_empty() && signers.len() <= MAX_SIGNERS, "A policy needs 1 to 3 signers");
        for (i, s) in signers.iter().enumerate() {
            assert!(valid_signer_id(s), "Invalid signer id");
            assert!(!signers[..i].contains(s), "Duplicate signer");
        }
        assert!(required >= 1 && usize::from(required) <= signers.len(), "required must be 1 to the number of signers");
        let now = env::block_timestamp_ms();
        let mut issuer = self.issuers.get(provider).cloned().unwrap_or_else(|| env::panic_str("Unknown issuer"));
        let mut si = self.self_issued_of(provider).cloned().unwrap_or_else(|| env::panic_str("Not a self-issued issuer"));
        if !overlap {
            // A replacing upgrade gives a replacement signer a new id: keys added to an id the policy already lists
            // would leave that id's old (possibly compromised) keys counting (D138).
            assert!(new_keys.iter().all(|(_, signer, _)| !si.signers.contains(signer)), "A replacing policy adds keys only for new signer ids");
            // Drop the keys of every signer that leaves the policy, at once.
            let dropped: Vec<String> = si.key_signer.iter().filter(|(_, s)| !signers.contains(s)).map(|(k, _)| k.clone()).collect();
            for kid in &dropped {
                issuer.keys.remove(kid);
            }
            si.key_signer.retain(|(k, _)| !dropped.contains(k));
        }
        // Either way, pending additions for signers that leave the policy are dropped: they could otherwise revive (and
        // anyone could execute them) if a later upgrade listed the id again (D138).
        let stale: Vec<usize> = self
            .key_changes
            .iter()
            .enumerate()
            .filter(|(_, c)| c.provider == provider && matches!(&c.op, KeyOp::AddForSigner { signer, .. } if !signers.contains(signer)))
            .map(|(i, _)| i)
            .collect();
        for i in stale.into_iter().rev() {
            let change = self.key_changes.remove(i);
            events::emit("issuer_key_change_cancelled", json!({ "id": change.id, "provider": change.provider, "kid": change.kid, "by": env::current_account_id() }));
        }
        for (kid, signer, key) in new_keys {
            assert!(signers.contains(&signer), "Unknown signer");
            assert!(!kid.is_empty() && kid.len() <= 128 && !issuer.keys.contains_key(&kid), "Kid is already active");
            let key = crate::issuers::checked_rsa_key(key.n, key.e);
            assert!(!key_material_in_use(&issuer, &key.n), "Key is already registered");
            assert!(issuer.keys.len() < MAX_SELF_ISSUED_KEYS, "Too many keys for this issuer");
            issuer.keys.insert(kid.clone(), key);
            si.key_signer.push((kid, signer));
        }
        si.overlap = if overlap && (si.signers != signers || si.required != required) {
            Some((si.signers.clone(), si.required, now.saturating_add(POLICY_OVERLAP_MS)))
        } else {
            None
        };
        si.signers = signers;
        si.required = required;
        events::emit("signer_policy_set", json!({ "provider": provider, "signers": si.signers, "required": si.required, "overlap_until_ms": si.overlap.as_ref().map(|o| o.2) }));
        self.issuers.insert(provider.to_string(), issuer);
        *self.self_issued_mut(provider).expect("self-issued") = si;
    }
}

/// Whether an active key of `issuer` has this modulus (whatever its exponent: one modulus is one private key).
fn key_material_in_use(issuer: &Issuer, n: &[u8]) -> bool {
    issuer.keys.values().any(|k| k.n == n)
}
