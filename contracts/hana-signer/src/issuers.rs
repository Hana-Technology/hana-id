//! OIDC issuers (Google today): their `iss` values and signing keys, and token verification against them.

use std::collections::BTreeMap;

use near_sdk::{env, near};

use crate::oidc::{self, RsaPublicKey};
use crate::{assert_provider, events, HanaSigner, HanaSignerExt};

const MAX_ISS_VALUES: usize = 4;
const MAX_KEYS_PER_ISSUER: usize = 10;
const MAX_KID_BYTES: usize = 128;

/// An RSA public key (big-endian bytes, no leading zeros).
#[near(serializers = [borsh])]
pub struct RsaKey {
    pub n: Vec<u8>,
    pub e: Vec<u8>,
}

#[near(serializers = [borsh])]
pub struct Issuer {
    pub provider: String,
    pub iss_values: Vec<String>,
    /// kid → key.
    pub keys: BTreeMap<String, RsaKey>,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct IssuerView {
    pub provider: String,
    pub iss_values: Vec<String>,
    pub kids: Vec<String>,
}

/// What a verified token tells us.
#[derive(Debug, Clone)]
pub struct VerifiedToken {
    pub provider: String,
    pub aud: String,
    pub sub: String,
    pub nonce: Option<String>,
}

fn strip_leading_zeros(mut bytes: Vec<u8>) -> Vec<u8> {
    let first = bytes.iter().position(|&b| b != 0).unwrap_or(bytes.len());
    bytes.drain(..first);
    bytes
}

#[near]
impl HanaSigner {
    /// Creates or updates an issuer. Its keys are kept on update.
    pub fn set_issuer(&mut self, provider: String, iss_values: Vec<String>) {
        self.assert_owner();
        assert_provider(&provider);
        assert!(!iss_values.is_empty() && iss_values.len() <= MAX_ISS_VALUES, "An issuer needs 1 to 4 iss values");
        for (i, iss) in iss_values.iter().enumerate() {
            assert!(!iss.is_empty() && iss.len() <= 256, "Invalid iss value");
            assert!(!iss_values[..i].contains(iss), "Duplicate iss value");
            if let Some(other) = self.iss_index.get(iss) {
                assert!(*other == provider, "iss value already used by another provider");
            }
        }
        let issuer = match self.issuers.remove(&provider) {
            Some(mut existing) => {
                for old in &existing.iss_values {
                    self.iss_index.remove(old);
                }
                existing.iss_values = iss_values.clone();
                existing
            }
            None => Issuer { provider: provider.clone(), iss_values: iss_values.clone(), keys: BTreeMap::new() },
        };
        for iss in &iss_values {
            self.iss_index.insert(iss.clone(), provider.clone());
        }
        self.issuers.insert(provider, issuer);
    }

    /// Adds or replaces a signing key. `n` and `e` are JWK base64url. Callable by the owner or by the contract
    /// account itself (a function-call key limited to this method and `remove_issuer_key` rotates keys).
    pub fn set_issuer_key(&mut self, provider: String, kid: String, n: String, e: String) {
        self.assert_owner_or_self();
        assert!(!kid.is_empty() && kid.len() <= MAX_KID_BYTES, "Invalid kid");
        let n = strip_leading_zeros(oidc::decode_jwk_part(&n).unwrap_or_else(|err| env::panic_str(&err)));
        let e = strip_leading_zeros(oidc::decode_jwk_part(&e).unwrap_or_else(|err| env::panic_str(&err)));
        assert!((256..=512).contains(&n.len()), "RSA modulus must be 2048-4096 bits");
        assert!(!e.is_empty() && e.len() <= 8 && e[e.len() - 1] & 1 == 1 && e != [1], "Invalid RSA exponent");
        let issuer = self.issuers.get_mut(&provider).unwrap_or_else(|| env::panic_str("Unknown issuer"));
        assert!(issuer.keys.contains_key(&kid) || issuer.keys.len() < MAX_KEYS_PER_ISSUER, "Too many keys for this issuer");
        issuer.keys.insert(kid.clone(), RsaKey { n, e });
        events::emit("issuer_key_set", near_sdk::serde_json::json!({ "provider": provider, "kid": kid }));
    }

    /// Removes a signing key. Returns whether one was removed.
    pub fn remove_issuer_key(&mut self, provider: String, kid: String) -> bool {
        self.assert_owner_or_self();
        let issuer = self.issuers.get_mut(&provider).unwrap_or_else(|| env::panic_str("Unknown issuer"));
        let removed = issuer.keys.remove(&kid).is_some();
        if removed {
            events::emit("issuer_key_removed", near_sdk::serde_json::json!({ "provider": provider, "kid": kid }));
        }
        removed
    }

    pub fn get_issuer(&self, provider: String) -> Option<IssuerView> {
        self.issuers.get(&provider).map(|i| IssuerView { provider: i.provider.clone(), iss_values: i.iss_values.clone(), kids: i.keys.keys().cloned().collect() })
    }
}

impl HanaSigner {
    fn assert_owner_or_self(&self) {
        let caller = env::predecessor_account_id();
        assert!(caller == self.owner || caller == env::current_account_id(), "Only the owner or the contract account can do this");
    }

    pub(crate) fn has_issuer(&self, provider: &str) -> bool {
        self.issuers.contains_key(provider)
    }

    /// Verifies an ID token against the stored issuer keys. Panics on anything wrong. The caller checks the nonce.
    pub(crate) fn verify_token(&self, jwt: &str) -> VerifiedToken {
        let parsed = oidc::parse(jwt).unwrap_or_else(|err| env::panic_str(&err));
        let provider = self.iss_index.get(&parsed.claims.iss).unwrap_or_else(|| env::panic_str("Unknown token issuer"));
        let issuer = self.issuers.get(provider).unwrap_or_else(|| env::panic_str("Unknown token issuer"));
        let key = issuer.keys.get(&parsed.kid).unwrap_or_else(|| env::panic_str("Unknown signing key"));
        oidc::verify_signature(&parsed, RsaPublicKey { n: &key.n, e: &key.e }).unwrap_or_else(|err| env::panic_str(&err));
        let now = env::block_timestamp_ms();
        assert!(parsed.claims.exp.saturating_mul(1000) > now, "Token expired");
        assert!(crate::valid_sub(&parsed.claims.sub), "Invalid sub");
        crate::assert_aud(&parsed.claims.aud);
        VerifiedToken { provider: provider.clone(), aud: parsed.claims.aud, sub: parsed.claims.sub, nonce: parsed.claims.nonce }
    }
}
