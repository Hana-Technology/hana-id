//! OIDC ID token parsing and signature verification, done entirely on-chain.
//! Issuer keys come from the contract's own registry (`set_issuer_key`), never from the caller.
//!
//! Two serializations: the compact JWT (`header.payload.signature`) that Google and every other outside issuer uses,
//! and the JWS General JSON Serialization (RFC 7515 §7.2.1) that self-issued issuers use (email login,
//! `docs/email-login-spec.md` "The token"): one payload with up to `MAX_JWS_SIGNATURES` signatures, each over its own
//! protected header, so a co-signer only needs the payload. Only RS256 is accepted today; `check_rs256` is the single
//! place the algorithm is checked.

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use near_sdk::serde::Deserialize;
use num_bigint::BigUint;

pub const MAX_JWT_BYTES: usize = 7168;
/// Signatures a JWS JSON token may carry (one per signer of a self-issued issuer's policy, at most 3 signers).
pub const MAX_JWS_SIGNATURES: usize = 3;

/// ASN.1 DigestInfo prefix for SHA-256 (PKCS#1 v1.5).
const SHA256_PREFIX: [u8; 19] = [0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20];

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct Header {
    alg: String,
    kid: String,
}

/// The claims we use. Anything else in the token is ignored.
#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Claims {
    pub iss: String,
    pub aud: String,
    pub sub: String,
    pub exp: u64,
    pub nonce: Option<String>,
}

/// A JWT split into its parts. Nothing in it is trusted until `verify_signature` passes.
pub struct ParsedJwt {
    pub alg: String,
    pub kid: String,
    /// `header.payload`, the bytes the signature covers.
    pub signed: String,
    pub signature: Vec<u8>,
    pub claims: Claims,
}

/// The JWS General JSON Serialization, exactly: no top-level `protected`/`header`/`signature` (that is the flattened
/// form), no per-signature unprotected `header` (a `kid` there would be outside what the signature covers).
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct JwsJson {
    payload: String,
    signatures: Vec<JwsJsonSignature>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct JwsJsonSignature {
    protected: String,
    signature: String,
}

/// A JWS protected header. Other members (e.g. `typ`) are ignored, except `crit`: a critical extension the contract
/// doesn't implement (e.g. RFC 7797 `b64`, which changes what is signed) must make the token invalid.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct ProtectedHeader {
    alg: String,
    kid: String,
    crit: Option<near_sdk::serde_json::Value>,
}

/// One signature of a JWS JSON token.
pub struct JwsSignature {
    pub alg: String,
    pub kid: String,
    /// `protected.payload` (ASCII), the bytes this signature covers.
    pub signed: String,
    pub signature: Vec<u8>,
}

/// A JWS JSON token split into its parts. Nothing in it is trusted until its signatures pass.
pub struct ParsedJws {
    pub claims: Claims,
    pub signatures: Vec<JwsSignature>,
}

/// Key material for one `kid`. Big-endian bytes.
pub struct RsaPublicKey<'a> {
    pub n: &'a [u8],
    pub e: &'a [u8],
}

pub fn b64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn b64url_decode(text: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD.decode(text.trim_end_matches('=')).map_err(|_| "Malformed base64url".to_string())
}

pub fn parse(jwt: &str) -> Result<ParsedJwt, String> {
    if jwt.len() > MAX_JWT_BYTES {
        return Err("JWT too large".into());
    }
    let mut parts = jwt.split('.');
    let (Some(h), Some(p), Some(s), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return Err("JWT must have three parts".into());
    };
    let header: Header = near_sdk::serde_json::from_slice(&b64url_decode(h)?).map_err(|_| "Malformed JWT header")?;
    let claims: Claims = near_sdk::serde_json::from_slice(&b64url_decode(p)?).map_err(|_| "Malformed JWT claims")?;
    Ok(ParsedJwt { alg: header.alg, kid: header.kid, signed: format!("{}.{}", h, p), signature: b64url_decode(s)?, claims })
}

/// Whether `token` is in the JWS JSON form (it starts with `{`; a compact JWT starts with base64url).
pub fn is_json_form(token: &str) -> bool {
    token.starts_with('{')
}

/// Parses a JWS General JSON Serialization token: 1..=`MAX_JWS_SIGNATURES` signatures, each with a protected header
/// carrying `alg` and `kid`, no unprotected headers, no `crit`. Duplicate JSON members are malformed.
pub fn parse_json(token: &str) -> Result<ParsedJws, String> {
    if token.len() > MAX_JWT_BYTES {
        return Err("JWT too large".into());
    }
    let jws: JwsJson = near_sdk::serde_json::from_str(token).map_err(|_| "Malformed JWS")?;
    if jws.signatures.is_empty() {
        return Err("Malformed JWS".into());
    }
    if jws.signatures.len() > MAX_JWS_SIGNATURES {
        return Err("Too many signatures".into());
    }
    let claims: Claims = near_sdk::serde_json::from_slice(&b64url_decode(&jws.payload)?).map_err(|_| "Malformed JWT claims")?;
    let mut signatures = Vec::with_capacity(jws.signatures.len());
    for entry in jws.signatures {
        let header: ProtectedHeader = near_sdk::serde_json::from_slice(&b64url_decode(&entry.protected)?).map_err(|_| "Malformed JWS header")?;
        if header.crit.is_some() {
            return Err("Unsupported JWS header".into());
        }
        signatures.push(JwsSignature {
            alg: header.alg,
            kid: header.kid,
            signed: format!("{}.{}", entry.protected, jws.payload),
            signature: b64url_decode(&entry.signature)?,
        });
    }
    Ok(ParsedJws { claims, signatures })
}

/// Checks the token's signature with the issuer key named by its `kid`. Rejects every algorithm but RS256.
pub fn verify_signature(jwt: &ParsedJwt, key: RsaPublicKey) -> Result<(), String> {
    check_rs256(&jwt.alg, jwt.signed.as_bytes(), &jwt.signature, key)
}

/// Checks one signature of a JWS JSON token. Rejects every algorithm but RS256.
pub fn verify_jws_signature(sig: &JwsSignature, key: RsaPublicKey) -> Result<(), String> {
    check_rs256(&sig.alg, sig.signed.as_bytes(), &sig.signature, key)
}

fn check_rs256(alg: &str, signed: &[u8], signature: &[u8], key: RsaPublicKey) -> Result<(), String> {
    if alg != "RS256" {
        return Err("Unsupported JWT algorithm".into());
    }
    if verify_rs256(signed, signature, key.n, key.e) {
        Ok(())
    } else {
        Err("Invalid token signature".into())
    }
}

/// RSASSA-PKCS1-v1_5 with SHA-256. `n` and `e` are big-endian bytes.
pub fn verify_rs256(signed: &[u8], signature: &[u8], n: &[u8], e: &[u8]) -> bool {
    let k = n.len();
    if k < 256 || signature.len() != k {
        return false;
    }
    let modulus = BigUint::from_bytes_be(n);
    let s = BigUint::from_bytes_be(signature);
    if s >= modulus {
        return false;
    }
    let m = s.modpow(&BigUint::from_bytes_be(e), &modulus).to_bytes_be();
    // Encoded message: 0x00 0x01 FF..FF 0x00 DigestInfo(SHA-256(signed)). to_bytes_be drops the leading 0x00.
    let digest = near_sdk::env::sha256(signed);
    let mut expected = Vec::with_capacity(k);
    expected.push(0x01);
    expected.resize(k - 1 - SHA256_PREFIX.len() - 32 - 1, 0xff);
    expected.push(0x00);
    expected.extend_from_slice(&SHA256_PREFIX);
    expected.extend_from_slice(&digest);
    m == expected
}

/// Decodes a JWK component (base64url, as issuers publish it) or plain base64.
pub fn decode_jwk_part(text: &str) -> Result<Vec<u8>, String> {
    b64url_decode(text).or_else(|_| STANDARD.decode(text).map_err(|_| "Malformed key component".to_string()))
}
