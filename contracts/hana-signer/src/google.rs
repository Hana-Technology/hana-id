//! Google ID token (RS256 JWT) verification, done entirely on-chain.
//! Google's public keys come from the contract's own registry (`set_google_key`), never from the caller.

use base64::engine::general_purpose::{URL_SAFE_NO_PAD, STANDARD};
use base64::Engine;
use near_sdk::serde::Deserialize;
use num_bigint::BigUint;

/// Google's documented issuers for ID tokens.
pub const GOOGLE_ISSUERS: [&str; 2] = ["https://accounts.google.com", "accounts.google.com"];
const MAX_JWT_BYTES: usize = 7168;

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

pub fn b64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn b64url_decode(text: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD.decode(text.trim_end_matches('=')).map_err(|_| "Malformed base64url".to_string())
}

/// Splits a JWT and returns (kid, signed part, signature, claims) after checking its shape and algorithm.
pub fn parse(jwt: &str) -> Result<(String, String, Vec<u8>, Claims), String> {
    if jwt.len() > MAX_JWT_BYTES {
        return Err("JWT too large".into());
    }
    let mut parts = jwt.split('.');
    let (Some(h), Some(p), Some(s), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return Err("JWT must have three parts".into());
    };
    let header: Header = near_sdk::serde_json::from_slice(&b64url_decode(h)?).map_err(|_| "Malformed JWT header")?;
    if header.alg != "RS256" {
        return Err("JWT must be RS256".into());
    }
    let claims: Claims = near_sdk::serde_json::from_slice(&b64url_decode(p)?).map_err(|_| "Malformed JWT claims")?;
    Ok((header.kid, format!("{}.{}", h, p), b64url_decode(s)?, claims))
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

/// Decodes a JWK component (base64url, as Google publishes it) or plain base64.
pub fn decode_jwk_part(text: &str) -> Result<Vec<u8>, String> {
    b64url_decode(text).or_else(|_| STANDARD.decode(text).map_err(|_| "Malformed key component".to_string()))
}
